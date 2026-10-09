// Shared fixtures for the data-hosting tests: a tiny terrain pyramid, a kernel
// directory, and an HTTP server that serves a local-directory store the way the
// real data host should (stored headers, CORS, plain 404).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export const tmp = (name) => mkdtempSync(join(tmpdir(), `data-hosting-${name}-`));

/** A valid 4-vertex, 2-triangle quantized-mesh-1.0 tile (a flat quad). */
export function quadTile() {
  const u = [0, 65534, 65533, 65534];
  const v = [0, 0, 65534, 0];
  const h = [0, 0, 0, 0];
  const idxCodes = [];
  let highest = 0;
  for (const idx of [0, 1, 2, 1, 3, 2]) {
    const code = highest - idx;
    idxCodes.push(code);
    if (code === 0) highest++;
  }
  const buf = Buffer.alloc(88 + 4 + 24 + 4 + 12);
  buf.writeFloatLE(0, 24);
  buf.writeFloatLE(10, 28);
  buf.writeUInt32LE(4, 88);
  let o = 92;
  for (const arr of [u, v, h]) for (const x of arr) { buf.writeUInt16LE(x, o); o += 2; }
  buf.writeUInt32LE(2, o); o += 4;
  for (const c of idxCodes) { buf.writeUInt16LE(c, o); o += 2; }
  return buf;
}

export function writePyramid(dir, { gzip = true, maxZoom = 3 } = {}) {
  const tile = quadTile();
  const body = gzip ? gzipSync(tile, { level: 6 }) : tile;
  let count = 0;
  for (let z = 0; z <= maxZoom; z++) {
    for (let x = 0; x < 2 ** (z + 1); x++) {
      for (let y = 0; y < 2 ** z; y++) {
        mkdirSync(join(dir, String(z), String(x)), { recursive: true });
        writeFileSync(join(dir, String(z), String(x), `${y}.terrain`), body);
        count++;
      }
    }
  }
  writeFileSync(join(dir, 'layer.json'), JSON.stringify({
    tilejson: '2.1.0', format: 'quantized-mesh-1.0', schema: 'tms', tiles: ['{z}/{x}/{y}.terrain'],
    projection: 'EPSG:4326', minzoom: 0, maxzoom: maxZoom,
  }));
  writeFileSync(join(dir, 'terrain-product.json'), JSON.stringify({
    generator: 'test', created: '2026-01-01T00:00:00Z', tileCount: count, sources: { canonical: { path: 'x.tif' } },
  }));
  return count;
}

/** DAF/SPK-looking and KPL-looking kernel files. */
export function writeKernels(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a.bsp'), Buffer.concat([Buffer.from('DAF/SPK '), Buffer.alloc(2000, 7)]));
  writeFileSync(join(dir, 'b.bc.gz'), gzipSync(Buffer.concat([Buffer.from('DAF/CK  '), Buffer.alloc(2000, 3)])));
  writeFileSync(join(dir, 'c.tls'), 'KPL/LSK\n\\begindata\nDELTET/DELTA_T_A = 32.184\n');
}

/**
 * Serve a local-directory store over HTTP. `opts` lets a test break the host on
 * purpose: { cors: false, html404: true, dropEncoding: true }.
 */
export function serveStore(storage, opts = {}) {
  const server = createServer(async (req, res) => {
    const key = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
    const origin = req.headers.origin;
    const headers = {};
    if (origin && opts.cors !== false) headers['Access-Control-Allow-Origin'] = origin;
    const meta = await storage.head(key);
    if (!meta) {
      res.writeHead(404, { ...headers, 'Content-Type': opts.html404 ? 'text/html' : 'text/plain' });
      res.end(opts.html404 ? '<html>not found</html>' : 'not found');
      return;
    }
    headers['Content-Type'] = meta.contentType ?? 'application/octet-stream';
    if (meta.cacheControl) headers['Cache-Control'] = meta.cacheControl;
    if (meta.contentEncoding && !opts.dropEncoding) headers['Content-Encoding'] = meta.contentEncoding;
    const body = await storage.get(key);
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}
