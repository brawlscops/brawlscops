const http = require('http');
const https = require('https');

const BS_TOKEN = process.env.BS_TOKEN;

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const url = new URL(req.url, 'http://x');

  console.log(`[HIT] ${req.method} ${req.url}`);

  // Route GET / sans tag → retourne l'IP publique du serveur
  if (url.pathname === '/' && !url.searchParams.get('tag')) {
    https.get('https://api.ipify.org?format=json', r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => res.end(b));
    }).on('error', e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  // Route GET /player?tag=XXXX ou /?tag=XXXX → retourne les infos du joueur Brawl Stars
  if (url.pathname === '/player' || url.pathname === '/') {
    const tag = url.searchParams.get('tag') || '';
    if (!tag) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing tag' })); return; }

    const cleanTag = tag.startsWith('#') ? tag : '#' + tag;
    const encoded = encodeURIComponent(cleanTag);

    console.log(`[REQUEST] tag="${cleanTag}" encoded="${encoded}"`);
    console.log(`[TOKEN] défini: ${!!BS_TOKEN}, longueur: ${BS_TOKEN ? BS_TOKEN.length : 0}`);

    https.get({
      hostname: 'api.brawlstars.com',
      path: `/v1/players/${encoded}`,
      headers: { Authorization: `Bearer ${BS_TOKEN}`, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }
    }, (r) => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => {
        console.log(`[RESPONSE] status=${r.statusCode} body=${body.substring(0, 300)}`);
        res.writeHead(r.statusCode);
        res.end(body);
      });
    }).on('error', e => {
      console.log(`[ERROR] ${e.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  // Route inconnue
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));

}).listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
  console.log(`BS_TOKEN défini: ${!!BS_TOKEN}`);
});
