const http = require('http');
const https = require('https');

const BS_TOKEN = process.env.BS_TOKEN;

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const url = new URL(req.url, 'http://x');

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
    if (!BS_TOKEN) { res.writeHead(500); res.end(JSON.stringify({ error: 'BS_TOKEN not configured on server' })); return; }

    const encoded = encodeURIComponent(tag.startsWith('#') ? tag : '#' + tag);
    https.get({
      hostname: 'api.brawlstars.com',
      path: `/v1/players/${encoded}`,
      headers: { Authorization: `Bearer ${BS_TOKEN}`, Accept: 'application/json' }
    }, (r) => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => { res.writeHead(r.statusCode); res.end(body); });
    }).on('error', e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    return;
  }


  // Route GET /version → retourne la version actuelle de l'app
  if (url.pathname === '/version') {
    const fs = require('fs');
    const path = require('path');
    try {
      const versionFile = path.join(__dirname, 'version.json');
      const data = fs.readFileSync(versionFile, 'utf8');
      res.setHeader('Cache-Control', 'no-cache');
      res.writeHead(200);
      res.end(data);
    } catch(e) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'version.json not found' }));
    }
    return;
  }

  // Route inconnue
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));

}).listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
