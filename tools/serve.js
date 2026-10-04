/**
 * Tiny local HTTPS-capable dev server for testing the PWA.
 *
 * Usage:
 *   node tools/serve.js               -> http on 0.0.0.0:5173
 *   node tools/serve.js --https       -> https on 0.0.0.0:5173 (uses mkcert certs if available)
 *
 * Notes:
 *   - Service Workers require HTTP(S), not file://
 *   - getUserMedia/getDisplayMedia require HTTPS or localhost
 *   - For mobile testing, use ngrok/cloudflared tunnel on top
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 5173;
const ROOT = path.resolve(__dirname, '..');
const useHttps = process.argv.includes('--https');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':  'font/ttf',
  '.txt':  'text/plain; charset=utf-8',
};

function safeJoin(root, requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const resolved = path.normalize(path.join(root, decoded));
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

function serve(req, res) {
  const parsed = url.parse(req.url);
  let pathname = parsed.pathname || '/';
  if (pathname === '/') pathname = '/index.html';

  let filePath = safeJoin(ROOT, pathname);
  if (!filePath) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err) {
      res.writeHead(404); res.end('Not found: ' + pathname); return;
    }
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    fs.readFile(filePath, (e, content) => {
      if (e) { res.writeHead(500); res.end('Error: ' + e.message); return; }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Service-Worker-Allowed': '/',
      });
      res.end(content);
    });
  });
}

if (useHttps) {
  let certPath = path.join(ROOT, 'certs', 'cert.pem');
  let keyPath  = path.join(ROOT, 'certs', 'key.pem');
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    console.error('❌ No certs/cert.pem & certs/key.pem found.');
    console.error('   Generate with:');
    console.error('     mkcert -install && mkcert -cert-file certs/cert.pem -key-file certs/key.pem localhost 127.0.0.1');
    process.exit(1);
  }
  const options = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  https.createServer(options, serve).listen(PORT, '0.0.0.0', () => {
    console.log(`🔒 HTTPS server: https://localhost:${PORT}`);
    console.log(`   For mobile: run "ngrok http ${PORT}" or "cloudflared tunnel --url http://localhost:${PORT}"`);
  });
} else {
  http.createServer(serve).listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 HTTP server: http://localhost:${PORT}`);
    console.log(`   Note: Service Worker needs HTTPS in production. For mobile testing:`);
    console.log(`     1) ngrok http ${PORT}`);
    console.log(`     2) or cloudflared tunnel --url http://localhost:${PORT}`);
  });
}