'use strict';
/**
 * BrawlScops — server.js (Node >= 18, aucune dépendance)
 *
 * Variables d'environnement :
 *   BS_TOKEN (ou BS_TOKEN_1..3) : clé(s) API officielle Brawl Stars
 *   GROQ_API_KEY                : clé Groq (optionnelle, utilisée si l'utilisateur n'en fournit pas)
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
  'trophy road': 'common', 'common': 'common', 'rare': 'rare', 'super rare': 'super-rare',
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

/* ───────────── Méta dynamique ─────────────
 * On échantillonne les battle logs des meilleurs joueurs du classement mondial
 * puis on calcule win rate (lissé) + popularité par brawler -> tiers S/A/B/C/D.
 * Un nouveau brawler apparaît automatiquement dès qu'il est joué.
 * Optionnel : meta-override.json  ex: { "SHELLY": "A" }  pour forcer un tier.
 */
let metaCache = { at: 0, data: null, building: false };

function loadOverrides() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'meta-override.json'), 'utf8')); }
  catch (_) { return {}; }
}

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

    const percentile = (arr, key) => {
      const sorted = [...arr].sort((a, b) => a[key] - b[key]);
      const m = new Map();
      sorted.forEach((x, idx) => m.set(x.id, sorted.length > 1 ? idx / (sorted.length - 1) : 0.5));
      return m;
    };
    const pw = percentile(rated, 'wr'), pg = percentile(rated, 'games');
    rated.forEach(x => { x.score = pw.get(x.id) * 0.6 + pg.get(x.id) * 0.4; });
    rated.sort((a, b) => b.score - a.score);

    const tierById = {}, info = {};
    rated.forEach((x, idx) => {
      const p = idx / rated.length;
      tierById[x.id] = p < 0.12 ? 'S' : p < 0.35 ? 'A' : p < 0.70 ? 'B' : p < 0.92 ? 'C' : 'D';
      info[x.id] = { games: x.games, winRate: Math.round(x.wr * 1000) / 10 };
    });

    const overrides = loadOverrides();
    for (const [k, v] of Object.entries(overrides)) {
      const c = Object.values(catalog).find(c => c.name === k.toUpperCase() || String(c.id) === k);
      if (c && 'SABCD'.includes(v)) tierById[c.id] = v;
    }

    if (rated.length < 10 && metaCache.data) throw new Error('échantillon trop faible, ancienne méta conservée');
    metaCache = {
      at: Date.now(), building: false,
      data: { tierById, info, ready: rated.length >= 10, sampleBattles: battles, samplePlayers: tags.length,
              updatedAt: new Date().toISOString(), source: 'top-players-battlelogs' }
    };
    console.log(`[meta] OK — ${rated.length} brawlers notés, ${battles} parties`);
  } catch (e) {
    metaCache.building = false;
    console.error('[meta] échec :', e.message);
    setTimeout(buildMeta, 10 * 60 * 1000); // nouvel essai dans 10 min
  }
}

function getTiers(catalog) {
  const t = metaCache.data?.tierById || {};
  const tierById = {}, tiers = { S: [], A: [], B: [], C: [], D: [] };
  for (const c of Object.values(catalog)) {
    const tier = t[c.id] || 'B'; // inconnu = neutre
    tierById[c.id] = tier;
    tiers[tier].push(c.name);
  }
  return { tierById, tiers };
}

function metaPublicInfo() {
  const d = metaCache.data;
  return { ready: !!d?.ready, updatedAt: d?.updatedAt || null, sampleBattles: d?.sampleBattles || 0,
           samplePlayers: d?.samplePlayers || 0, source: d?.source || null, building: metaCache.building };
}

/* ───────────── Recommandations ───────────── */
function buildRecommendations(player, catalog, tierById) {
  const owned = new Map((player.brawlers || []).map(b => [b.id, b]));
  const info = metaCache.data?.info || {};
  const newIds = new Set(Object.keys(catalog).map(Number).sort((a, b) => b - a).slice(0, NEW_COUNT));
  const TW = { S: 5, A: 4, B: 3, C: 2, D: 1 };
  const ownedRecos = [], unownedRecos = [];

  for (const c of Object.values(catalog)) {
    const tier = tierById[c.id] || 'B';
    const isNew = newIds.has(c.id);
    const b = owned.get(c.id);
    const wr = info[c.id]?.winRate;
    const wrTxt = wr != null ? ` · WR ${wr}%` : '';
    const image = '/img?url=' + encodeURIComponent(c.image);

    if (b) {
      if (b.power >= 11) continue;
      const levelGap = (11 - b.power) / 10;
      const missSP = (2 - (b.starPowers?.length || 0)) / 2;
      const missGad = (2 - (b.gadgets?.length || 0)) / 2;
      let score = TW[tier] + levelGap * 1.2 + missSP * 0.8 + missGad * 0.6;
      if (isNew) score += 1;
      const t = b.trophies || 0;
      score += t < 100 ? 1.0 : t < 300 ? 0.6 : t < 500 ? 0.4 : 0;
      let reason;
      if (isNew) reason = mk(`Nouveau brawler — niveau ${b.power}/11, à monter vite`, `New brawler — power ${b.power}/11, level it up fast`, `Brawler nuevo — nivel ${b.power}/11, súbelo rápido`);
      else if (tier === 'S' || tier === 'A') reason = mk(`Fort dans la méta (tier ${tier})${wrTxt} — niveau ${b.power}/11`, `Strong in the meta (tier ${tier})${wrTxt} — power ${b.power}/11`, `Fuerte en la meta (tier ${tier})${wrTxt} — nivel ${b.power}/11`);
      else reason = mk(`Niveau ${b.power}/11 — tier ${tier}${wrTxt}`, `Power ${b.power}/11 — tier ${tier}${wrTxt}`, `Nivel ${b.power}/11 — tier ${tier}${wrTxt}`);
      ownedRecos.push({ id: c.id, name: c.name, owned: true, power: b.power, trophies: t, tier, isNew,
                        rarity: c.rarity, className: c.className, score: Math.round(Math.min(10, score) * 10) / 10, reason, image });
    } else if (isNew || tier === 'S' || tier === 'A') {
      const score = TW[tier] * 0.8 + (isNew ? 2 : 0);
      const reason = isNew
        ? mk('Nouveau brawler — pas encore débloqué', 'New brawler — not unlocked yet', 'Brawler nuevo — aún sin desbloquear')
        : mk(`Fort dans la méta (tier ${tier})${wrTxt} — non débloqué`, `Strong in the meta (tier ${tier})${wrTxt} — not unlocked`, `Fuerte en la meta (tier ${tier})${wrTxt} — sin desbloquear`);
      unownedRecos.push({ id: c.id, name: c.name, owned: false, power: 0, trophies: 0, tier, isNew,
                          rarity: c.rarity, className: c.className, score: Math.round(Math.min(10, score) * 10) / 10, reason, image });
    }
  }
  const bySc = (a, b) => b.score - a.score;
  return [...ownedRecos.sort(bySc).slice(0, 20), ...unownedRecos.sort(bySc).slice(0, 5)].sort(bySc);
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

  const { tierById, tiers } = getTiers(catalog);
  const payload = {
    player,
    recommendations: buildRecommendations(player, catalog, tierById),
    tiers, tierById,
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
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';

  try {
    // IP publique (utile pour whitelister la clé Brawl Stars)
    if (p === '/' && !url.searchParams.get('tag')) {
      const r = await fetchJson('https://api.ipify.org?format=json');
      return send(res, 200, r.json || { error: 'ip lookup failed' });
    }

    if (p === '/health') return send(res, 200, { ok: true, meta: metaPublicInfo() });

    // Route principale : profil + méta + recommandations
    const m = p.match(/^\/api\/meta-recommendations(?:\/(.+))?$/);
    if (m) {
      const tag = normalizeTag(m[1] ? decodeURIComponent(m[1]) : url.searchParams.get('tag'));
      if (!tag) return send(res, 400, { error: 'Invalid or missing tag' });
      return send(res, 200, await buildPayload(tag));
    }

    if (p === '/api/meta') {
      const catalog = await getCatalog();
      const { tierById, tiers } = getTiers(catalog);
      if (!metaCache.data && !metaCache.building) buildMeta();
      return send(res, 200, { tiers, tierById, meta: metaPublicInfo(),
        catalog: Object.fromEntries(Object.values(catalog).map(c => [c.id, { name: c.name, rarity: c.rarity, className: c.className }])) });
    }

    // Legacy : profil brut
    if (p === '/player' || p === '/') {
      const tag = normalizeTag(url.searchParams.get('tag'));
      if (!tag) return send(res, 400, { error: 'Missing or invalid tag' });
      const r = await bsGet('/players/' + encodeURIComponent(tag));
      res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(r.text);
    }

    if (p === '/version') {
      try {
        const data = fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        return res.end(data);
      } catch (_) { return send(res, 404, { error: 'version.json not found' }); }
    }

    if (p === '/img') return proxyImage(req, res, url.searchParams.get('url'));

    if (p === '/api/ai' && req.method === 'POST') return handleAI(req, res);

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error('[error]', req.url, e.message);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  setTimeout(buildMeta, 2000);                 // calcul initial de la méta
  setInterval(buildMeta, META_TTL).unref();    // puis toutes les 6 h
});
