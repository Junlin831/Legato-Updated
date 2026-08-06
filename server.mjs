import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
const port = Number(process.env.PORT || 8000);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.otf': 'font/otf', '.woff2': 'font/woff2' };

createServer(async (request, response) => {
  try {
    const pathname = request.url === '/' ? '/index.html' : decodeURIComponent(request.url.split('?')[0]);
    const path = normalize(join(root, pathname));
    if (!path.startsWith(root)) throw Object.assign(new Error('Forbidden'), { status: 403 });
    const data = await readFile(path);
    response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' }); response.end(data);
  } catch (error) {
    const status = error.code === 'ENOENT' ? 404 : error.status || 500;
    response.writeHead(status, { 'Content-Type': request.url.startsWith('/api/') ? 'application/json' : 'text/plain' });
    response.end(request.url.startsWith('/api/') ? JSON.stringify({ error: error.message }) : `${ status } ${ error.message }`);
  }
}).listen(port, () => console.log(`LEGATO running at http://localhost:${ port }`));
