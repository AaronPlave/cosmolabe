#!/usr/bin/env node
// Local #137 storage with the same metadata/CORS/error behavior as hosted data.
// Used for browser acceptance; this is not a production service.
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createLocalStorage } from '../data-hosting/lib/storage.mjs';
const [directory, port = '5188'] = process.argv.slice(2);
if (!directory) throw new Error('Usage: serve-publication.mjs STORE_DIR [PORT]');
const store = createLocalStorage(resolve(directory));
createServer(async (req, res) => {
  try {
    const key = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1));
    if (key.split('/').some(part => part === '..' || part.startsWith('.')) || key.includes('\\')) {
      res.writeHead(400); res.end('Invalid object key'); return;
    }
    const meta = await store.head(key);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!meta) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Missing object'); return; }
    res.setHeader('Content-Type', meta.contentType ?? 'application/octet-stream');
    if (meta.cacheControl) res.setHeader('Cache-Control', meta.cacheControl);
    if (meta.contentEncoding) res.setHeader('Content-Encoding', meta.contentEncoding);
    res.setHeader('Content-Length', meta.size);
    res.end(req.method === 'HEAD' ? undefined : await store.get(key));
  } catch { res.writeHead(500); res.end('Object read failed'); }
}).listen(Number(port), '127.0.0.1', () => console.log(`Local publication: http://127.0.0.1:${port}`));
