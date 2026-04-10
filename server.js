const https = require('https');
const http = require('http');

const BS_TOKEN_1 = process.env.BS_TOKEN_1;

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const tag = new URL(req.url, 'http://x').searchParams.get('tag') || '';
  if (!tag) { res.writeHead(400); res.end(JSON.stringify({error:'Missing tag'})); return; }

  const encoded = encodeURIComponent(tag.startsWith('#') ? tag : '#' + tag);
  https.get({
    hostname: 'proxy.royaleapi.dev',
    path: `/v1/players/${encoded}`,
    headers: { Authorization: `Bearer ${BS_TOKEN_1}`, Accept: 'application/json' }
  }, (r) => {
    let body = '';
    r.on('data', c => body += c);
    r.on('end', () => { res.writeHead(r.statusCode); res.end(body); });
  }).on('error', e => { res.writeHead(500); res.end(JSON.stringify({error: e.message})); });

}).listen(process.env.PORT || 3000);
