import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };
const server = http.createServer((req, res) => {
  const file = files[req.url];
  if (req.method !== 'GET' || !file) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'" });
  res.end(fs.readFileSync(path.join(root, file[0])));
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(17654, '127.0.0.1', () => console.log('验收页面：http://127.0.0.1:17654/\n关闭此窗口停止验收服务。'));
