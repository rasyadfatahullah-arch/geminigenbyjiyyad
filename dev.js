'use strict';
// Server lokal untuk uji coba:  node dev.js   ->  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');

// muat .env sederhana (jika ada)
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* tidak ada .env */ }

const routes = {
  '/api/generate': require('./api/generate'),
  '/api/admin': require('./api/admin'),
};
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

function start(port = Number(process.env.PORT || 3000)) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (routes[url.pathname]) return routes[url.pathname](req, res);
    let file = url.pathname === '/' ? '/index.html' : url.pathname === '/admin' ? '/admin.html' : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(__dirname, 'public', file);
    if (!full.startsWith(path.join(__dirname, 'public'))) { res.statusCode = 403; return res.end('Forbidden'); }
    fs.readFile(full, (err, buf) => {
      if (err) { res.statusCode = 404; return res.end('Not found'); }
      res.setHeader('Content-Type', types[path.extname(full)] || 'application/octet-stream');
      res.end(buf);
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (require.main === module) {
  start().then((s) => console.log('Berjalan di http://localhost:' + s.address().port));
}
module.exports = { start };
