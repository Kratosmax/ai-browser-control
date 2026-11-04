import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const dir = path.dirname(fileURLToPath(import.meta.url));
import { fileURLToPath } from 'node:url';
http.createServer((req, res) => {
  const f = path.join(dir, req.url === '/' ? 'test-cursor.html' : req.url.split('?')[0]);
  try {
    const data = fs.readFileSync(f);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(f)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  } catch { res.writeHead(404); res.end('nf'); }
}).listen(17715, '127.0.0.1', () => console.log('test server on 17715'));
