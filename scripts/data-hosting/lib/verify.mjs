// HTTP verification of a published build through its public URL (issue #137).
// Used by the publisher before it pins a build, and by the CI smoke test.
//
// What it asserts is what the browser loaders depend on: status codes, CORS for
// the allowed origins, `Content-Encoding: gzip` on gzip tiles (and a body that is
// raw quantized-mesh once the client has inflated it — not gzip twice),
// immutable cache headers, a plain 404 (not an HTML page) for a missing object,
// and byte-exact kernels.
import { createHash } from 'node:crypto';
import { joinUrl } from './datasets.mjs';
import { mapLimit } from './publish.mjs';
import { hasMagic } from './cube.mjs';

const QM_HEADER_BYTES = 88;

export async function verifyBuild({
  baseUrl, prefix, origins = [], deepKernels = false, concurrency = 16, fetchImpl = fetch, log = () => {},
}) {
  const problems = [];
  const bad = (msg) => { problems.push(msg); };
  const url = (key) => joinUrl(baseUrl, prefix + key);
  const get = (key, headers = {}) => fetchImpl(url(key), { headers });

  const mres = await get('manifest.json');
  if (mres.status !== 200) {
    bad(`manifest.json: HTTP ${mres.status}`);
    return { ok: false, problems };
  }
  let manifest;
  try { manifest = await mres.json(); } catch { bad('manifest.json is not JSON'); return { ok: false, problems }; }

  // A response to a non-credentialed request from `origin` must allow it (or all).
  const checkCors = (res, what, origin = origins[0]) => {
    if (!origin) return;
    const allow = res.headers.get('access-control-allow-origin');
    if (allow !== '*' && allow !== origin) bad(`${what}: Access-Control-Allow-Origin is ${JSON.stringify(allow)} for origin ${origin}`);
  };
  const origin = origins[0];
  const withOrigin = origin ? { Origin: origin } : {};

  // Every allowed origin gets the manifest; the rest of the checks use the first.
  for (const o of origins) checkCors(await get('manifest.json', { Origin: o }), 'manifest.json', o);

  if (manifest.kind === 'terrain') {
    const layerRes = await get('layer.json', withOrigin);
    if (layerRes.status !== 200) bad(`layer.json: HTTP ${layerRes.status}`);
    else {
      checkCors(layerRes, 'layer.json');
      try {
        const layer = await layerRes.json();
        if (layer.format !== 'quantized-mesh-1.0') bad(`layer.json format is ${layer.format}`);
      } catch { bad('layer.json is not JSON'); }
    }
    for (const tile of manifest.sampleTiles ?? []) {
      const res = await get(tile, withOrigin);
      if (res.status !== 200) { bad(`${tile}: HTTP ${res.status}`); continue; }
      checkCors(res, tile);
      const enc = res.headers.get('content-encoding');
      if (manifest.tileEncoding === 'gzip' && enc !== 'gzip') bad(`${tile}: Content-Encoding is ${JSON.stringify(enc)}, expected "gzip"`);
      if (manifest.tileEncoding !== 'gzip' && enc) bad(`${tile}: unexpected Content-Encoding ${enc}`);
      const cc = res.headers.get('cache-control') ?? '';
      if (!/immutable/.test(cc)) bad(`${tile}: Cache-Control ${JSON.stringify(cc)} is not immutable`);
      const body = new Uint8Array(await res.arrayBuffer());
      if (body[0] === 0x1f && body[1] === 0x8b) bad(`${tile}: body is still gzip after client decoding (double compression, or the Content-Encoding header was dropped)`);
      else if (body.length < QM_HEADER_BYTES) bad(`${tile}: ${body.length} bytes, too short for quantized-mesh`);
    }
    const missing = await get('__missing__/0/0.terrain', withOrigin);
    if (missing.status !== 404) bad(`missing tile returned HTTP ${missing.status}, expected 404`);
    else if (/html/i.test(missing.headers.get('content-type') ?? '')) bad('missing tile 404 is an HTML page; the loader would try to decode it');
  } else if (manifest.kind === 'cube-terrain' || manifest.kind === 'cube-imagery') {
    // Entry points name the manifest's revision: a geometry, grid or imagery
    // build can't be swapped under a pinned build id.
    const cube = manifest.kind === 'cube-terrain';
    const entry = async (key, revisionOf) => {
      const res = await get(key, withOrigin);
      if (res.status !== 200) return bad(`${key}: HTTP ${res.status}`);
      checkCors(res, key);
      try {
        const revision = revisionOf(await res.json());
        if (revision !== manifest.revision) bad(`${key} names revision ${revision}, the build is ${manifest.revision}`);
      } catch { bad(`${key} is not JSON`); }
    };
    if (cube) {
      await entry('tileset.json', (t) => t.asset?.tilesetVersion);
      await entry('cpu-grids.json', (g) => g.source?.version);
    } else await entry('imagery.json', (m) => m.source?.version);
    const encoding = cube ? 'glb' : manifest.encoding;
    const samples = [...(manifest.sampleTiles ?? []).map((key) => [key, encoding]), ...(manifest.sampleGrids ?? []).map((key) => [key, 'f32'])];
    for (const [key, kind] of samples) {
      const res = await get(key, withOrigin);
      if (res.status !== 200) { bad(`${key}: HTTP ${res.status}`); continue; }
      checkCors(res, key);
      const cc = res.headers.get('cache-control') ?? '';
      if (!/immutable/.test(cc)) bad(`${key}: Cache-Control ${JSON.stringify(cc)} is not immutable`);
      const type = res.headers.get('content-type') ?? '';
      const expected = { glb: 'model/gltf-binary', f32: 'application/octet-stream', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[kind];
      if (!type.startsWith(expected)) bad(`${key}: Content-Type ${JSON.stringify(type)}, expected ${expected}`);
      const body = new Uint8Array(await res.arrayBuffer());
      if (kind === 'f32' ? body.length !== manifest.gridBytes : !hasMagic(body, kind)) bad(`${key}: body is not a ${kind} ${kind === 'f32' ? `grid of ${manifest.gridBytes} bytes` : 'file'}`);
    }
    // Every cube loader rejects on status, so a 404 body (r2.dev serves an HTML page) is harmless.
    const missing = await get(`__missing__/0/0/0.${encoding}`, withOrigin);
    if (missing.status !== 404) bad(`missing tile returned HTTP ${missing.status}, expected 404`);
  } else if (manifest.kind === 'kernels') {
    await mapLimit(manifest.files, concurrency, async (f) => {
      const key = f.filename;
      if (deepKernels) {
        const res = await get(key, { ...withOrigin, 'Accept-Encoding': 'identity' });
        if (res.status !== 200) return bad(`${key}: HTTP ${res.status}`);
        checkCors(res, key);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length !== f.sizeBytes) bad(`${key}: ${buf.length} bytes, manifest says ${f.sizeBytes}`);
        else if (createHash('sha256').update(buf).digest('hex') !== f.sha256) bad(`${key}: SHA-256 mismatch`);
      } else {
        const res = await fetchImpl(url(key), { method: 'HEAD', headers: { ...withOrigin, 'Accept-Encoding': 'identity' } });
        if (res.status !== 200) return bad(`${key}: HTTP ${res.status}`);
        checkCors(res, key);
        const len = Number(res.headers.get('content-length'));
        if (len !== f.sizeBytes) bad(`${key}: Content-Length ${len}, manifest says ${f.sizeBytes}`);
      }
    });
    const missing = await get('__missing__.bsp', withOrigin);
    if (missing.status !== 404) bad(`missing kernel returned HTTP ${missing.status}, expected 404`);
  } else {
    bad(`unknown manifest kind ${JSON.stringify(manifest.kind)}`);
  }
  log(`  verified ${prefix}: ${problems.length ? `${problems.length} problem(s)` : 'ok'}`);
  return { ok: problems.length === 0, problems, manifest };
}
