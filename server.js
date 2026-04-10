const http = require('http');
const https = require('https');

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  https.get('https://api.ipify.org?format=json', (r) => {
    let body = '';
    r.on('data', c => body += c);
    r.on('end', () => { res.writeHead(200); res.end(body); });
  });
}).listen(process.env.PORT || 3000);
