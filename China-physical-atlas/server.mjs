/* 本地静态服务器：为天地图浏览器密钥提供正确的 http Referer，并托管 Cesium 资源 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';

const ROOT = process.cwd();
const ENTRY = process.env.APP_ENTRY || '中国地理互动地图.html';
const NO_OPEN = process.argv.includes('--no-open');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8'
};

function serveFile(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400); res.end('Bad request'); return;
  }
  let relative = pathname.replace(/^\/+/, '');
  if (!relative) relative = ENTRY;
  if (relative.endsWith('/')) relative += ENTRY;

  const absolute = path.resolve(ROOT, relative);
  if (absolute !== ROOT && !absolute.startsWith(ROOT + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(absolute, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + relative);
      return;
    }
    const headers = {
      'Content-Type': MIME[path.extname(absolute).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Cross-Origin-Resource-Policy': 'cross-origin'
    };
    res.writeHead(200, headers);
    fs.createReadStream(absolute).pipe(res);
  });
}

const server = http.createServer(serveFile);
let port = Number(process.env.PORT || 8123);
let attempts = 0;

function listen() {
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && attempts < 20) {
      attempts += 1;
      port += 1;
      setTimeout(listen, 80);
    } else {
      console.error('服务器启动失败：', error.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + port + '/';
    console.log('');
    console.log('  中国地理互动地图已启动');
    console.log('  地址：' + url);
    console.log('  按 Ctrl+C 停止服务器');
    console.log('');
    if (!NO_OPEN) {
      const opener = process.platform === 'win32'
        ? 'start "" "' + url + '"'
        : process.platform === 'darwin' ? 'open "' + url + '"' : 'xdg-open "' + url + '"';
      exec(opener, () => {});
    }
  });
}
listen();
