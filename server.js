cconst http = require('http');
const https = require('https');
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  https.get('https://api.ipify.org?format=json', (r) => {
    let b = ''; r.on('data', c => b += c);
    r.on('end', () => { res.end(b); });
  });
}).listen(process.env.PORT || 3000);
