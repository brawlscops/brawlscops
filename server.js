'use strict';
/**
 * BrawlScops — server.js (Node >= 18, aucune dépendance)
 *
 * Variables d'environnement :
 *   BS_TOKEN (ou BS_TOKEN_1..3) : clé(s) API officielle Brawl Stars
 *   GROQ_API_KEY                : clé Groq (optionnelle, utilisée si l'utilisateur n'en fournit pas)
 *   (fichiers) meta-snapshot.json : tier list ranked de base (à mettre à jour) ; meta-override.json : tiers forcés
 *   NEW_BRAWLERS_COUNT          : nb de brawlers les plus récents considérés "nouveaux" (défaut 3)
 *   META_SAMPLE_PLAYERS         : nb de top joueurs échantillonnés pour la méta (défaut 40)
 *   META_MIN_GAMES              : nb min de parties pour noter un brawler (défaut 10)
 *
 * Routes :
 *   GET  /                                  -> IP publique du serveur (pour whitelister la clé BS)
 *   GET  /api/meta-recommendations/:tag     -> profil + méta + recommandations (route principale)
 *   GET  /api/meta                          -> tier list dynamique + catalogue
 *   GET  /player?tag=XXX | /?tag=XXX        -> (legacy) profil brut
 *   GET  /img?url=https://cdn.brawlify.com/ -> proxy d'images
 *   GET  /version, GET /health
 *   POST /api/ai                            -> proxy Groq (la clé n'est plus exposée côté client)
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const BS_API = 'https://api.brawlstars.com/v1';
const BRAWLIFY_API = 'https://api.brawlify.com/v1/brawlers';
const BS_TOKENS = [process.env.BS_TOKEN, process.env.BS_TOKEN_1, process.env.BS_TOKEN_2, process.env.BS_TOKEN_3].filter(Boolean);
const GROQ_ENV_KEY = process.env.GROQ_API_KEY || '';
const NEW_COUNT = parseInt(process.env.NEW_BRAWLERS_COUNT, 10) || 3;
const SAMPLE_PLAYERS = Math.min(parseInt(process.env.META_SAMPLE_PLAYERS, 10) || 40, 200);
const MIN_GAMES = parseInt(process.env.META_MIN_GAMES, 10) || 10;

const CATALOG_TTL = 60 * 60 * 1000;      // 1 h
const META_TTL = 6 * 60 * 60 * 1000;     // 6 h
const PROFILE_TTL = 60 * 1000;           // 1 min (protège le quota de l'API)

/* ───────────── Helpers ───────────── */
async function fetchJson(url, headers = {}, ms = 10000) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, ok: res.ok, json, text };
}

// Essaie chaque token : un 403 peut venir d'une clé liée à une autre IP
async function bsGet(p) {
  if (!BS_TOKENS.length) { const e = new Error('BS_TOKEN not configured on server'); e.status = 500; throw e; }
  let last = null;
  for (const token of BS_TOKENS) {
    last = await fetchJson(BS_API + p, { Authorization: `Bearer ${token}`, Accept: 'application/json' });
    if (last.status !== 403) return last;
  }
  return last;
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function normalizeTag(raw) {
  let t = String(raw || '').trim().toUpperCase().replace(/O/g, '0');
  if (!t) return null;
  if (!t.startsWith('#')) t = '#' + t;
  return /^#[0289PYLQGRJCUV]{3,14}$/.test(t) ? t : null;
}

const mk = (fr, en, es) => ({ fr, en, es });

/* ───────────── Catalogue Brawlify (liste globale à jour) ───────────── */
const RARITY_MAP = {
  'starting brawler': 'common', 'trophy road': 'common', 'common': 'common', 'rare': 'rare', 'super rare': 'super-rare',
  'epic': 'epic', 'mythic': 'mythic', 'legendary': 'legendary', 'ultra legendary': 'ultra-legendary'
};
let catalogCache = { at: 0, data: null, pending: null };

async function getCatalog() {
  const now = Date.now();
  if (catalogCache.data && now - catalogCache.at < CATALOG_TTL) return catalogCache.data;
  if (catalogCache.pending) return catalogCache.pending;
  catalogCache.pending = (async () => {
    try {
      const r = await fetchJson(BRAWLIFY_API);
      const list = r.json && (r.json.list || r.json);
      if (!r.ok || !Array.isArray(list) || !list.length) throw new Error('Brawlify HTTP ' + r.status);
      const byId = {};
      for (const b of list) {
        const id = Number(b.id);
        if (!id || !b.name) continue;
        byId[id] = {
          id,
          name: String(b.name).toUpperCase(),
          rarity: RARITY_MAP[String(b.rarity?.name || '').toLowerCase()] || 'rare',
          className: b.class?.name || 'Fighter',
          image: `https://cdn.brawlify.com/brawlers/borderless/${id}.png`
        };
      }
      catalogCache = { at: Date.now(), data: byId, pending: null };
      return byId;
    } catch (e) {
      catalogCache.pending = null;
      if (catalogCache.data) return catalogCache.data; // on garde l'ancien cache si Brawlify est down
      throw e;
    }
  })();
  return catalogCache.pending;
}

// Secours si Brawlify est injoignable : on reconstruit un mini-catalogue depuis le profil
function catalogFromPlayer(player) {
  const byId = {};
  for (const b of player.brawlers || []) {
    byId[b.id] = { id: b.id, name: String(b.name).toUpperCase(), rarity: 'rare', className: 'Fighter',
                   image: `https://cdn.brawlify.com/brawlers/borderless/${b.id}.png` };
  }
  return byId;
}

/* ───────────── Méta : snapshot ranked + échantillon live ─────────────
 * 1) meta-snapshot.json : tier list issue des stats "ranked" (SeeMeta) — base fiable, à mettre à jour
 * 2) live : win rate / popularité dans les battle logs des top joueurs (recalculé toutes les 6 h)
 * Score final = 75 % snapshot + 25 % live. Un brawler absent du snapshot (ex : nouveau brawler)
 * est noté uniquement par le live -> il apparaît dans la méta sans toucher au code.
 * meta-override.json (optionnel) : { "SHELLY": "A" } pour forcer un tier.
 */
const TIER_VALUE = { S: 0.9, A: 0.7, B: 0.5, C: 0.3, D: 0.1 };
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const readJson = (file, fb) => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8')); } catch (_) { return fb; } };
const SNAPSHOT = readJson('meta-snapshot.json', null);
let metaCache = { at: 0, data: null, building: false };

async function buildMeta() {
  if (metaCache.building) return;
  metaCache.building = true;
  try {
    const catalog = await getCatalog();
    const rank = await bsGet(`/rankings/global/players?limit=${SAMPLE_PLAYERS}`);
    if (!rank.ok || !rank.json?.items) throw new Error('rankings HTTP ' + rank.status);
    const tags = rank.json.items.map(p => p.tag);

    const stats = {};
    const seen = new Set();
    let battles = 0, i = 0;

    async function worker() {
      while (i < tags.length) {
        const tag = tags[i++];
        try {
          const r = await bsGet(`/players/${encodeURIComponent(tag)}/battlelog`);
          if (!r.ok || !r.json?.items) continue;
          for (const it of r.json.items) {
            const b = it.battle;
            if (!b || !Array.isArray(b.teams) || b.result == null || b.result === 'draw') continue;
            const own = b.teams.findIndex(t => t.some(p => p.tag === tag));
            if (own < 0) continue;
            const key = it.battleTime + '|' + b.teams.flat().map(p => p.tag).sort().join(',');
            if (seen.has(key)) continue;
            seen.add(key); battles++;
            const win = b.result === 'victory';
            b.teams.forEach((team, idx) => {
              const won = idx === own ? win : !win;
              for (const p of team) {
                const id = p.brawler?.id;
                if (!id) continue;
                const s = stats[id] || (stats[id] = { games: 0, wins: 0 });
                s.games++; if (won) s.wins++;
              }
            });
          }
        } catch (_) { /* un joueur en échec ne bloque pas le reste */ }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);

    const rated = Object.entries(stats)
      .filter(([id, s]) => catalog[id] && s.games >= MIN_GAMES)
      .map(([id, s]) => ({ id: +id, games: s.games, wr: (s.wins + 5) / (s.games + 10) })); // lissage bayésien

    if (rated.length < 10 && metaCache.data?.live) throw new Error('échantillon trop faible, ancien live conservé');

    const percentile = (arr, key) => {
      const sorted = [...arr].sort((a, b) => a[key] - b[key]);
      const m = new Map();
      sorted.forEach((x, idx) => m.set(x.id, sorted.length > 1 ? idx / (sorted.length - 1) : 0.5));
      return m;
    };
    const pw = percentile(rated, 'wr'), pg = percentile(rated, 'games');
    rated.forEach(x => { x.score = pw.get(x.id) * 0.7 + pg.get(x.id) * 0.3; });
    rated.sort((a, b) => b.score - a.score);
    const live = {};
    rated.forEach((x, idx) => {
      live[x.id] = { pct: rated.length > 1 ? 1 - idx / (rated.length - 1) : 0.5, games: x.games, winRate: Math.round(x.wr * 1000) / 10 };
    });

    metaCache = {
      at: Date.now(), building: false,
      data: { live, liveReady: rated.length >= 10, sampleBattles: battles, samplePlayers: tags.length, updatedAt: new Date().toISOString() }
    };
    console.log(`[meta] live OK — ${rated.length} brawlers notés, ${battles} parties`);
  } catch (e) {
    metaCache.building = false;
    console.error('[meta] échec :', e.message);
    setTimeout(buildMeta, 10 * 60 * 1000); // nouvel essai dans 10 min
  }
}

const tierFromScore = v => v >= 0.8 ? 'S' : v >= 0.6 ? 'A' : v >= 0.4 ? 'B' : v >= 0.2 ? 'C' : 'D';

function computeMeta(catalog) {
  const byName = new Map(Object.values(catalog).map(c => [norm(c.name), c.id]));
  const snap = {};
  if (SNAPSHOT?.tiers) {
    for (const [tier, names] of Object.entries(SNAPSHOT.tiers)) {
      for (const n of names) { const id = byName.get(norm(n)); if (id && TIER_VALUE[tier] != null) snap[id] = TIER_VALUE[tier]; }
    }
  }
  const live = metaCache.data?.liveReady ? metaCache.data.live : {};
  const forced = {};
  for (const [k, v] of Object.entries(readJson('meta-override.json', {}))) {
    const id = byName.get(norm(k)) || (catalog[k] ? Number(k) : null);
    if (id && TIER_VALUE[v] != null) forced[id] = v;
  }
  const metaScore = {}, tierById = {}, info = {};
  for (const c of Object.values(catalog)) {
    const s = snap[c.id], l = live[c.id];
    let v = s != null && l ? 0.75 * s + 0.25 * l.pct
          : s != null ? s
          : l ? 0.1 + 0.8 * l.pct
          : 0.5; // inconnu = neutre
    if (forced[c.id]) v = TIER_VALUE[forced[c.id]];
    metaScore[c.id] = Math.round(v * 100) / 100;
    tierById[c.id] = tierFromScore(v);
    if (l) info[c.id] = { winRate: l.winRate, games: l.games };
  }
  return { metaScore, tierById, info };
}

function getTiers(catalog) {
  const m = computeMeta(catalog);
  const tiers = { S: [], A: [], B: [], C: [], D: [] };
  for (const c of Object.values(catalog)) tiers[m.tierById[c.id]].push(c.name);
  return { ...m, tiers };
}

function metaPublicInfo() {
  const d = metaCache.data;
  const hasSnap = !!SNAPSHOT?.tiers, hasLive = !!d?.liveReady;
  return {
    ready: hasSnap || hasLive,
    source: hasSnap && hasLive ? 'snapshot+live' : hasSnap ? 'snapshot' : hasLive ? 'live' : 'none',
    snapshotDate: SNAPSHOT?.updatedAt || null,
    snapshotSource: SNAPSHOT?.source || null,
    liveUpdatedAt: d?.updatedAt || null,
    sampleBattles: d?.sampleBattles || 0,
    building: metaCache.building
  };
}

/* ───────────── Recommandations (la méta pilote la priorité) ─────────────
 * score /10 = 10 × ( 0.55 × méta  +  0.15 × niveaux restants  +  0.10 × gadgets/SP manquants
 *                    + 0.12 × rentabilité (peu de pièces restantes)  +  0.08 × brawler réellement joué )
 *             (+0.8 si nouveau brawler)
 * -> un brawler S de niveau 9 passe avant un brawler D de niveau 3.
 */
const LEVEL_COINS = { 1: 20, 2: 35, 3: 75, 4: 140, 5: 290, 6: 480, 7: 800, 8: 1250, 9: 1875, 10: 2800 };
const MAX_COINS = 7765;
const coinsToMax = p => { let c = 0; for (let l = p; l < 11; l++) c += LEVEL_COINS[l] || 0; return c; };
const joinR = (...parts) => ({ fr: parts.map(p => p.fr).join(' · '), en: parts.map(p => p.en).join(' · '), es: parts.map(p => p.es).join(' · ') });

function milestone(p) {
  if (p < 7) return mk(`Gadget au niv. 7 (niv. ${p}/11)`, `Gadget at power 7 (power ${p}/11)`, `Gadget al nivel 7 (nivel ${p}/11)`);
  if (p < 9) return mk(`Star Power au niv. 9 (niv. ${p}/11)`, `Star Power at power 9 (power ${p}/11)`, `Star Power al nivel 9 (nivel ${p}/11)`);
  return mk(`Plus que ${11 - p} niv. pour maxer`, `${11 - p} level(s) left to max`, `Faltan ${11 - p} nivel(es) para el máximo`);
}

function buildRecommendations(player, catalog, meta) {
  const owned = new Map((player.brawlers || []).map(b => [b.id, b]));
  const newIds = new Set(Object.keys(catalog).map(Number).sort((a, b) => b - a).slice(0, NEW_COUNT));
  const ownedRecos = [], unownedRecos = [];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const r1 = v => Math.round(clamp(v, 0, 10) * 10) / 10;

  for (const c of Object.values(catalog)) {
    const tier = meta.tierById[c.id] || 'B';
    const m = meta.metaScore[c.id] ?? 0.5;
    const wr = meta.info[c.id]?.winRate;
    const metaPts = clamp(m + (wr != null ? clamp((wr - 50) / 50, -0.1, 0.1) : 0), 0, 1);
    const isNew = newIds.has(c.id);
    const b = owned.get(c.id);
    const image = '/img?url=' + encodeURIComponent(c.image);
    const wrTxt = wr != null ? ` (WR ${wr}%)` : '';
    const metaTxt = mk(`Méta tier ${tier}${wrTxt}`, `Meta tier ${tier}${wrTxt}`, `Meta tier ${tier}${wrTxt}`);
    const lowNote = (tier === 'C' || tier === 'D') ? mk('méta faible : à garder pour plus tard', 'weak meta: can wait', 'meta débil: puede esperar') : null;
    const newTxt = isNew ? mk('🆕 Nouveau brawler', '🆕 New brawler', '🆕 Brawler nuevo') : null;
    const base = { id: c.id, name: c.name, tier, metaScore: Math.round(metaPts * 100) / 100, isNew, rarity: c.rarity, className: c.className, image };

    if (b) {
      const sp = b.starPowers?.length || 0, gad = b.gadgets?.length || 0;
      const play = Math.min((b.trophies || 0) / 1000, 1);
      if (b.power < 11) {
        const levelNeed = (11 - b.power) / 10;
        const build = ((2 - sp) + (2 - gad)) / 4;
        const roi = 1 - coinsToMax(b.power) / MAX_COINS;
        const raw = 0.55 * metaPts + 0.15 * levelNeed + 0.10 * build + 0.12 * roi + 0.08 * play;
        const parts = [newTxt, metaTxt, milestone(b.power), lowNote].filter(Boolean);
        ownedRecos.push({ ...base, kind: 'level', owned: true, power: b.power, trophies: b.trophies || 0,
                          score: r1(raw * 10 + (isNew ? 0.8 : 0)), reason: joinR(...parts) });
      } else {
        const missing = (2 - sp) + (2 - gad);
        if (missing > 0 && metaPts >= 0.6) { // P11 fort en méta mais build incomplet
          const raw = 0.55 * metaPts + 0.10 * (missing / 4) + 0.08 * play;
          const parts = [metaTxt, mk(`Niv. max — il manque ${missing} Gadget/Star Power`, `Maxed — ${missing} Gadget/Star Power missing`, `Máximo — faltan ${missing} Gadget/Star Power`)];
          ownedRecos.push({ ...base, kind: 'complete', owned: true, power: 11, trophies: b.trophies || 0,
                            score: r1(raw * 10 - 0.5), reason: joinR(...parts) });
        }
      }
    } else if (isNew || tier === 'S' || tier === 'A') {
      const raw = 0.55 * metaPts + (isNew ? 0.2 : 0);
      const parts = [newTxt, metaTxt, mk('non débloqué', 'not unlocked', 'sin desbloquear')].filter(Boolean);
      unownedRecos.push({ ...base, kind: 'unlock', owned: false, power: 0, trophies: 0,
                          score: r1(raw * 9), reason: joinR(...parts) });
    }
  }
  const bySc = (a, b) => b.score - a.score;
  return [...ownedRecos, ...unownedRecos.sort(bySc).slice(0, 5)].sort(bySc);
}

/* ───────────── Payload principal ───────────── */
const profileCache = new Map();

async function buildPayload(tag) {
  const hit = profileCache.get(tag);
  if (hit && Date.now() - hit.at < PROFILE_TTL) return hit.payload;

  const [pr, catalogMaybe] = await Promise.all([
    bsGet('/players/' + encodeURIComponent(tag)),
    getCatalog().catch(e => { console.error('[catalog]', e.message); return null; })
  ]);
  if (!pr.ok || !pr.json) {
    const e = new Error(pr.status === 404 ? 'Player not found'
      : pr.status === 403 ? 'API access denied (vérifie la clé et l\'IP whitelistée)'
      : pr.status === 429 ? 'Rate limited, réessaie dans quelques secondes'
      : 'Brawl Stars API error ' + pr.status);
    e.status = pr.status === 404 ? 404 : (pr.status === 403 || pr.status === 429 || pr.status === 503) ? pr.status : 502;
    throw e;
  }
  const player = pr.json;
  const catalog = catalogMaybe || catalogFromPlayer(player);
  if (!metaCache.data && !metaCache.building) buildMeta();

  const meta = getTiers(catalog);
  const { tierById, tiers, metaScore } = meta;
  const payload = {
    player,
    recommendations: buildRecommendations(player, catalog, meta),
    tiers, tierById, metaScore,
    catalog: Object.fromEntries(Object.values(catalog).map(c => [c.id, { name: c.name, rarity: c.rarity, className: c.className }])),
    meta: metaPublicInfo()
  };
  if (profileCache.size > 200) profileCache.clear();
  profileCache.set(tag, { at: Date.now(), payload });
  return payload;
}

/* ───────────── Proxy images ───────────── */
function proxyImage(req, res, imgUrl) {
  let u;
  try { u = new URL(imgUrl); } catch (_) { u = null; }
  if (!u || u.protocol !== 'https:' || u.hostname !== 'cdn.brawlify.com') {
    res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('Bad request');
  }
  https.get(u, { headers: { Referer: 'https://brawlify.com', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (r) => {
    res.writeHead(r.statusCode, {
      'Content-Type': r.headers['content-type'] || 'image/png',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    });
    r.pipe(res);
  }).on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Proxy error');
  });
}

/* ───────────── Proxy Groq ───────────── */
function readBody(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > limit) { reject(Object.assign(new Error('Payload too large'), { status: 413 })); req.destroy(); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

async function handleAI(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (_) { return send(res, 400, { error: { message: 'Invalid JSON' } }); }
  const msg = body?.messages?.[0]?.content;
  if (typeof msg !== 'string' || !msg || msg.length > 4000) return send(res, 400, { error: { message: 'Invalid prompt' } });
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const key = bearer.startsWith('gsk_') ? bearer : GROQ_ENV_KEY;
  if (!key) return send(res, 503, { error: { message: 'IA non configurée (GROQ_API_KEY manquante côté serveur)' } });
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: Math.min(parseInt(body.max_tokens, 10) || 900, 1000), messages: [{ role: 'user', content: msg }] }),
      signal: AbortSignal.timeout(30000)
    });
    res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(await r.text());
  } catch (e) {
    send(res, 502, { error: { message: 'Groq unreachable' } });
  }
}

/* ───────────── Serveur HTTP ───────────── */
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req
