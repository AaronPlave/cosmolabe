import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeQuantizedMesh } from '../../../packages/three/src/internal/quantized-mesh.ts';
import { CATALOG_ROOT, ROOT, loadDatasets, remotePrefix } from '../lib/datasets.mjs';
import { buildHostedCatalogs, matchDataset, resolveLocalPath, rewriteCatalog } from '../lib/hosted-catalogs.mjs';
import { kernelManifest, resolveUpstream, upstreamFromScript, validateKernelHeader } from '../lib/kernels.mjs';
import { objectMeta, publishDirectory } from '../lib/publish.mjs';
import { publicDirCopyFilter } from '../lib/public-dir-filter.mjs';
import { createLocalStorage, createS3Storage } from '../lib/storage.mjs';
import { terrainManifest, validateTerrain } from '../lib/terrain.mjs';
import { verifyBuild } from '../lib/verify.mjs';
import { serveStore, tmp, writePyramid, writeKernels } from './helpers.mjs';

const ORIGIN = 'https://pages.example.org';
const quiet = () => {};

async function publishTerrain({ storage, src, build = 'b1', failAfter, concurrency = 4 }) {
  const dataset = { kind: 'terrain', name: 'demo' };
  let puts = 0;
  const flaky = failAfter == null ? storage : {
    ...storage,
    head: storage.head, list: storage.list, get: storage.get,
    put: async (...a) => {
      if (++puts > failAfter) throw new Error('simulated network failure');
      return storage.put(...a);
    },
  };
  return publishDirectory({
    storage: flaky, srcDir: src, prefix: remotePrefix(dataset, build), deferred: ['layer.json'],
    concurrency, log: quiet, retry: { tries: 1 },
    validate: validateTerrain,
    buildManifest: (entries, inventorySha256) => terrainManifest({ dataset, build, entries, inventorySha256, srcDir: src }),
  });
}

describe('S3/R2 storage backend', () => {
  it('sends the stored headers with a streamed body, reads 404 as absent, and lists by prefix', async () => {
    const seen = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, bodyLength: Buffer.concat(chunks).length });
        if (req.url.includes('list-type=2')) {
          res.writeHead(200, { 'content-type': 'application/xml' });
          res.end('<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>p/a</Key><Size>3</Size></Contents></ListBucketResult>');
        } else if (req.method === 'HEAD') { res.writeHead(404); res.end(); } else { res.writeHead(200); res.end(); }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const s3 = createS3Storage({ accountId: 'a', accessKeyId: 'k', secretAccessKey: 's', bucket: 'b', endpoint: `http://127.0.0.1:${server.address().port}` });
      const file = join(tmp('s3'), 'tile.terrain');
      writeFileSync(file, Buffer.alloc(300, 1));
      await s3.put('p/x.terrain', { path: file, size: 300 }, { contentType: 'application/vnd.quantized-mesh', contentEncoding: 'gzip', cacheControl: 'public, max-age=31536000, immutable' });
      expect(await s3.head('p/none')).toBeNull();
      expect([...(await s3.list('p/'))]).toEqual([['p/a', 3]]);
      const put = seen[0];
      expect(put).toMatchObject({ method: 'PUT', url: '/b/p/x.terrain?x-id=PutObject', bodyLength: 300 });
      expect(put.headers).toMatchObject({ 'content-encoding': 'gzip', 'cache-control': 'public, max-age=31536000, immutable', 'content-type': 'application/vnd.quantized-mesh' });
      // R2 rejects the SDK's default checksum trailers on streamed bodies.
      expect(Object.keys(put.headers).filter((h) => h.includes('checksum') && h !== 'x-amz-content-sha256')).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('names every missing credential', () => {
    // The factory defaults to process.env; make sure a developer's real R2_* values don't leak in.
    for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENDPOINT']) vi.stubEnv(k, '');
    try {
      expect(() => createS3Storage({ accessKeyId: 'k' })).toThrow(/R2_SECRET_ACCESS_KEY.*R2_BUCKET.*R2_ACCOUNT_ID/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('objectMeta', () => {
  it('marks gzip terrain tiles as Content-Encoding gzip with an immutable cache policy', () => {
    expect(objectMeta('3/4/5.terrain', true)).toEqual({
      contentType: 'application/vnd.quantized-mesh', cacheControl: 'public, max-age=31536000, immutable', contentEncoding: 'gzip',
    });
  });
  it('leaves raw terrain and .gz kernels without a Content-Encoding', () => {
    expect(objectMeta('3/4/5.terrain', false).contentEncoding).toBeUndefined();
    expect(objectMeta('lro.bsp.gz', true).contentEncoding).toBeUndefined();
    expect(objectMeta('layer.json', false).contentType).toBe('application/json');
  });
});

describe('terrain publishing', () => {
  const servers = [];
  afterEach(async () => { while (servers.length) await servers.pop().close(); });

  it('uploads a pyramid, writes layer.json and manifest.json last, and the public URL verifies', async () => {
    const src = tmp('src'); const store = createLocalStorage(tmp('store'));
    const count = writePyramid(src);
    const order = [];
    const spy = { ...store, put: async (k, s, m) => { order.push(k); return store.put(k, s, m); } };
    const r = await publishTerrain({ storage: spy, src });
    const prefix = 'terrain/demo/b1/';
    expect(r.uploaded).toBe(count + 1); // tiles + terrain-product.json; layer.json is deferred
    expect(order.slice(-3)).toEqual([`${prefix}inventory.jsonl.gz`, `${prefix}layer.json`, `${prefix}manifest.json`]);

    const manifest = JSON.parse((await store.get(`${prefix}manifest.json`)).toString());
    expect(manifest).toMatchObject({ kind: 'terrain', build: 'b1', tileCount: count, tileEncoding: 'gzip' });
    expect(manifest.sampleTiles.length).toBeGreaterThanOrEqual(2);

    const host = await serveStore(store); servers.push(host);
    const v = await verifyBuild({ baseUrl: host.url, prefix, origins: [ORIGIN, 'http://localhost:5173'] });
    expect(v.problems).toEqual([]);
  });

  it('serves tiles the real quantized-mesh decoder reads through ordinary fetch (gzip handled by the client)', async () => {
    const src = tmp('src'); const store = createLocalStorage(tmp('store'));
    writePyramid(src);
    await publishTerrain({ storage: store, src });
    const host = await serveStore(store); servers.push(host);
    const res = await fetch(`${host.url}/terrain/demo/b1/2/3/1.terrain`, { headers: { Origin: ORIGIN } });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const mesh = decodeQuantizedMesh(await res.arrayBuffer());
    expect(mesh.u.length).toBe(4);
    expect(mesh.indices.length).toBe(6);
  });

  it('works with raw (uncompressed) pyramids too', async () => {
    const src = tmp('src'); const store = createLocalStorage(tmp('store'));
    writePyramid(src, { gzip: false });
    await publishTerrain({ storage: store, src });
    const host = await serveStore(store); servers.push(host);
    const v = await verifyBuild({ baseUrl: host.url, prefix: 'terrain/demo/b1/', origins: [ORIGIN] });
    expect(v.problems).toEqual([]);
  });

  it('resumes an interrupted upload without re-sending finished objects', async () => {
    const src = tmp('src'); const store = createLocalStorage(tmp('store'));
    const count = writePyramid(src);
    await expect(publishTerrain({ storage: store, src, failAfter: 10, concurrency: 1 })).rejects.toThrow(/upload/);
    expect(await store.head('terrain/demo/b1/manifest.json')).toBeNull();
    const r = await publishTerrain({ storage: store, src });
    expect(r.skipped).toBe(10);
    expect(r.uploaded).toBe(count + 1 - 10);
    expect(await store.head('terrain/demo/b1/manifest.json')).not.toBeNull();
  }, 30000);

  it('refuses to overwrite a completed build with different content, but accepts identical content for verify/pin', async () => {
    const src = tmp('src'); const store = createLocalStorage(tmp('store'));
    writePyramid(src, { maxZoom: 1 });
    await publishTerrain({ storage: store, src });
    const again = await publishTerrain({ storage: store, src });
    expect(again).toMatchObject({ alreadyPublished: true, uploaded: 0 });
    writeFileSync(join(src, '1', '0', '0.terrain'), gzipSync(Buffer.alloc(300, 9)));
    await expect(publishTerrain({ storage: store, src })).rejects.toThrow(/different content/);
  });

  it('rejects a pyramid with a missing tile before uploading anything', async () => {
    const src = tmp('src'); const store = createLocalStorage(tmp('store'));
    writePyramid(src, { maxZoom: 2 });
    const { rmSync } = await import('node:fs');
    rmSync(join(src, '2', '0', '0.terrain'));
    await expect(publishTerrain({ storage: store, src })).rejects.toThrow(/lists \d+ tiles/);
    expect((await store.list('')).size).toBe(0);
  });

  it('rejects mixed gzip/raw tiles and an absolute tiles template', async () => {
    const src = tmp('src'); const store = createLocalStorage(tmp('store'));
    writePyramid(src, { maxZoom: 1 });
    writeFileSync(join(src, '1', '0', '0.terrain'), readFileSync(join(src, '0', '0', '0.terrain')).length ? Buffer.alloc(200) : Buffer.alloc(0));
    writeFileSync(join(src, 'terrain-product.json'), '{}');
    await expect(publishTerrain({ storage: store, src })).rejects.toThrow(/mixed tile encodings/);
    writePyramid(src, { maxZoom: 1 });
    writeFileSync(join(src, 'layer.json'), JSON.stringify({ format: 'quantized-mesh-1.0', tiles: ['/abs/{z}/{x}/{y}.terrain'] }));
    await expect(publishTerrain({ storage: store, src })).rejects.toThrow(/relative/);
  });

  it('flags a host that drops Content-Encoding, omits CORS, or answers 404 with HTML', async () => {
    const src = tmp('src'); const store = createLocalStorage(tmp('store'));
    writePyramid(src, { maxZoom: 1 });
    await publishTerrain({ storage: store, src });
    const check = async (opts) => {
      const host = await serveStore(store, opts); servers.push(host);
      return (await verifyBuild({ baseUrl: host.url, prefix: 'terrain/demo/b1/', origins: [ORIGIN] })).problems.join('\n');
    };
    expect(await check({ dropEncoding: true })).toMatch(/Content-Encoding/);
    expect(await check({ cors: false })).toMatch(/Access-Control-Allow-Origin/);
    expect(await check({ html404: true })).toMatch(/HTML page/);
  });
});

describe('kernel publishing', () => {
  const servers = [];
  afterEach(async () => { while (servers.length) await servers.pop().close(); });

  it('validates headers, writes a manifest with checksums, and byte-checks through the public URL', async () => {
    const src = tmp('k'); const store = createLocalStorage(tmp('store'));
    writeKernels(src);
    const dataset = { kind: 'kernels', name: 'demo', localDir: 'nonexistent-dir', fetchScripts: [] };
    const r = await publishDirectory({
      storage: store, srcDir: src, prefix: remotePrefix(dataset, '2026-10-02'), log: quiet,
      validate: async (entries) => { for (const e of entries) await validateKernelHeader(join(src, e.path)); },
      buildManifest: (entries, sha) => kernelManifest({ dataset, build: '2026-10-02', entries, inventorySha256: sha, srcDir: src, root: ROOT }),
    });
    expect(r.manifest.files.map((f) => f.filename)).toEqual(['a.bsp', 'b.bc.gz', 'c.tls']);
    expect(r.manifest.files.find((f) => f.filename === 'b.bc.gz')).toMatchObject({ kernelType: 'CK', gzip: true });
    expect(r.manifest.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    const host = await serveStore(store); servers.push(host);
    for (const deepKernels of [false, true]) {
      const v = await verifyBuild({ baseUrl: host.url, prefix: 'kernels/demo-2026-10-02/', origins: [ORIGIN], deepKernels });
      expect(v.problems).toEqual([]);
    }
    // Corrupt one object on the host: size is the same, hash differs.
    const key = 'kernels/demo-2026-10-02/a.bsp';
    const bad = Buffer.from(await store.get(key)); bad[100] ^= 0xff;
    await store.put(key, { body: bad }, await store.head(key));
    const deep = await verifyBuild({ baseUrl: host.url, prefix: 'kernels/demo-2026-10-02/', origins: [ORIGIN], deepKernels: true });
    expect(deep.problems.join()).toMatch(/SHA-256 mismatch/);
  });

  it('rejects files that are not the kernel they claim to be', async () => {
    const dir = tmp('k');
    writeFileSync(join(dir, 'x.bsp'), '<html>404</html>');
    writeFileSync(join(dir, 'y.tf'), 'version https://git-lfs.github.com/spec/v1\n');
    writeFileSync(join(dir, 'z.bc'), 'DAF/SPK padding');
    writeFileSync(join(dir, 'old.bc'), Buffer.concat([Buffer.from('NAIF/DAF'), Buffer.alloc(8)]));
    await expect(validateKernelHeader(join(dir, 'old.bc'))).resolves.toBeUndefined();
    await expect(validateKernelHeader(join(dir, 'x.bsp'))).rejects.toThrow(/DAF/);
    await expect(validateKernelHeader(join(dir, 'y.tf'))).rejects.toThrow(/KPL/);
    await expect(validateKernelHeader(join(dir, 'z.bc'))).rejects.toThrow(/extension implies CK/);
  });
});

describe('upstream resolution from the real fetch scripts', () => {
  it('includes every hosted kernel fetch script in fetch-all', () => {
    const datasets = loadDatasets().datasets;
    const fetchAll = readFileSync(join(ROOT, 'scripts/fetch-all.sh'), 'utf8');
    for (const dataset of Object.values(datasets).filter((d) => d.kind === 'kernels')) {
      for (const script of dataset.fetchScripts) {
        expect(fetchAll, `fetch-all.sh must run ${script}`).toContain(`$HERE/${script.split('/').pop()}`);
      }
    }
  });

  it('resolves each fetched kernel a catalog references, and the rest are tracked in git', () => {
    const datasets = loadDatasets().datasets;
    const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n'));
    const catalogs = readdirSync(join(ROOT, CATALOG_ROOT)).filter((f) => f.endsWith('.json'));
    const problems = [];
    let resolved = 0;
    for (const f of catalogs) {
      const text = readFileSync(join(ROOT, CATALOG_ROOT, f), 'utf8');
      for (const [, set, file] of text.matchAll(/"kernels\/([a-z-]+)\/([^"/]+)"/g)) {
        const ds = datasets[`kernels/${set}`];
        const texts = ds.fetchScripts.map((s) => readFileSync(join(ROOT, s), 'utf8'));
        const url = resolveUpstream(file, texts);
        if (url) { resolved++; expect(url).toMatch(/^https:\/\/naif\.jpl\.nasa\.gov\/pub\/naif\//); continue; }
        if (!tracked.has(`${ds.localDir}/${file.replace(/\.gz$/, '')}`) && !tracked.has(`${ds.localDir}/${file}`)) problems.push(`${set}/${file}`);
      }
    }
    expect(problems).toEqual([]);
    expect(resolved).toBeGreaterThan(50);
  });

  it('parses each shape of fetch script', () => {
    const m = upstreamFromScript(`
NAIF="https://example.org/k"
KERNELS=(
  "lsk/a.tls"   # comment
  "spk/b.bsp"
)
for kernel in "\${KERNELS[@]}"; do curl -fSL "$NAIF/$kernel" -o x; done
`);
    expect(m.get('a.tls')).toBe('https://example.org/k/lsk/a.tls');
    expect(m.get('b.bsp')).toBe('https://example.org/k/spk/b.bsp');
    const pairs = upstreamFromScript(`
BASE="https://example.org/v"
K=(
  "fk|one.tf"
  "spk|two.bsp"
)
curl -fSL "$BASE/$subdir/$filename" -o x
`);
    expect(pairs.get('two.bsp')).toBe('https://example.org/v/spk/two.bsp');
  });
});

describe('publicDir copy filter', () => {
  it('skips published datasets (and only direct files of a non-recursive one), keeps the rest', () => {
    const pub = tmp('pub');
    for (const d of ['data/mars', 'data/other', 'kernels/cassini', 'kernels/unpub', 'textures']) mkdirSync(join(pub, d), { recursive: true });
    writeFileSync(join(pub, 'kernels/de440s.bsp'), 'x');
    const keep = publicDirCopyFilter({
      a: { catalogPrefix: 'data/mars/', build: 'v1' },
      b: { catalogPrefix: 'kernels/', recursive: false, build: 'v1' },
      c: { catalogPrefix: 'kernels/cassini/', build: 'v1' },
      d: { catalogPrefix: 'kernels/unpub/', build: null },
    }, pub);
    const k = (p) => keep(join(pub, p));
    expect([k('data/mars'), k('data/mars/layer.json'), k('kernels/de440s.bsp'), k('kernels/cassini'), k('kernels/cassini/x.bsp')]).toEqual([false, false, false, false, false]);
    const keepMore = publicDirCopyFilter({ d: { catalogPrefix: 'kernels/unpub/', build: null } }, pub, ['d']);
    expect(keepMore(join(pub, 'kernels/unpub'))).toBe(false);
    expect([k('data/other'), k('kernels'), k('kernels/unpub'), k('textures'), k('index.json')]).toEqual([true, true, true, true, true]);
  });
});

describe('hosted catalog rewriting', () => {
  const datasets = {
    'terrain/mars': { kind: 'terrain', name: 'mars', catalogPrefix: 'data/mars/', build: 'v1' },
    'kernels/generic': { kind: 'kernels', name: 'generic', catalogPrefix: 'kernels/', recursive: false, build: '2026-10-02' },
    'kernels/cassini': { kind: 'kernels', name: 'cassini', catalogPrefix: 'kernels/cassini/', build: '2026-10-02' },
    'kernels/psyche': { kind: 'kernels', name: 'psyche', catalogPrefix: 'kernels/psyche/', build: null },
  };
  const base = 'https://data.example.org';

  it('resolves paths the way the viewer does', () => {
    expect(resolveLocalPath('kernels/a.bsp', 'x.json')).toBe('kernels/a.bsp');
    expect(resolveLocalPath('../kernels/a.bsp', 'base/x.json')).toBe('kernels/a.bsp');
    expect(resolveLocalPath('/test-catalogs/data/mars/', 'x.json')).toBe('data/mars/');
    expect(resolveLocalPath('https://trek.nasa.gov/k/x.jpg', 'x.json')).toBeNull();
    expect(resolveLocalPath('A sentence about kernels/x', 'x.json')).toBeNull();
    expect(resolveLocalPath('../../escape', 'x.json')).toBeNull();
  });

  it('matches the most specific dataset and only direct children for non-recursive ones', () => {
    expect(matchDataset('kernels/de440s.bsp', datasets).id).toBe('kernels/generic');
    expect(matchDataset('kernels/cassini/a.bsp.gz', datasets).id).toBe('kernels/cassini');
    expect(matchDataset('kernels/other/a.bsp', datasets)).toBeUndefined();
  });

  it('rewrites managed datasets only, leaving external URLs, other assets and unpublished sets alone', () => {
    const cat = {
      spice: ['kernels/de440s.bsp', { url: 'kernels/cassini/x.bsp.gz', size: 1 }, 'kernels/psyche/p.bsp'],
      terrain: { url: '/test-catalogs/data/mars/', imagery: [{ url: 'https://trek.nasa.gov/{z}/{y}/{x}.jpg' }] },
      baseMap: 'textures/mars.dds',
    };
    const r = rewriteCatalog(cat, 'c.json', datasets, base);
    expect(r.json.spice).toEqual([
      `${base}/kernels/generic-2026-10-02/de440s.bsp`,
      { url: `${base}/kernels/cassini-2026-10-02/x.bsp.gz`, size: 1 },
      'kernels/psyche/p.bsp',
    ]);
    expect(r.json.terrain.url).toBe(`${base}/terrain/mars/v1/`);
    expect(r.json.terrain.imagery[0].url).toBe(cat.terrain.imagery[0].url);
    expect(r.json.baseMap).toBe('textures/mars.dds');
    expect(r.unpublished).toEqual(['kernels/psyche']);
    expect(cat.spice[0]).toBe('kernels/de440s.bsp'); // input not mutated
  });

  it('rewrites a built dist, prunes hosted data, records dependencies, and is strict about unpublished sets', async () => {
    const dist = tmp('dist');
    mkdirSync(join(dist, 'kernels/cassini'), { recursive: true });
    mkdirSync(join(dist, 'data/mars'), { recursive: true });
    mkdirSync(join(dist, 'base'), { recursive: true });
    writeFileSync(join(dist, 'kernels/de440s.bsp'), 'x');
    writeFileSync(join(dist, 'kernels/cassini/x.bsp.gz'), 'x');
    writeFileSync(join(dist, 'data/mars/layer.json'), '{}');
    writeFileSync(join(dist, 'c.json'), JSON.stringify({ k: ['kernels/de440s.bsp'], t: '/test-catalogs/data/mars/' }));
    writeFileSync(join(dist, 'base/b.json'), JSON.stringify({ k: ['../kernels/cassini/x.bsp.gz'] }));
    writeFileSync(join(dist, 'index.json'), JSON.stringify({ catalogs: [{ catalog: './c.json' }] }));
    const hosted = { ...datasets, 'kernels/psyche': { ...datasets['kernels/psyche'], build: null } };
    const rec = await buildHostedCatalogs({ dist, baseUrl: `${base}/`, datasets: hosted, strict: true, log: quiet });
    expect(rec.rewritten.map((r) => r.file).sort()).toEqual(['base/b.json', 'c.json']);
    expect(JSON.parse(readFileSync(join(dist, 'base/b.json'), 'utf8')).k[0]).toBe(`${base}/kernels/cassini-2026-10-02/x.bsp.gz`);
    expect(existsSync(join(dist, 'kernels/de440s.bsp'))).toBe(false);
    expect(existsSync(join(dist, 'kernels/cassini'))).toBe(false);
    expect(existsSync(join(dist, 'data/mars'))).toBe(false);
    expect(Object.keys(rec.datasets).sort()).toEqual(['kernels/cassini', 'kernels/generic', 'terrain/mars']);
    expect(JSON.parse(readFileSync(join(dist, 'hosted-data.json'), 'utf8')).baseUrl).toBe(base);

    writeFileSync(join(dist, 'p.json'), JSON.stringify({ k: ['kernels/psyche/p.bsp', 'kernels/cassini/y.bsp'] }));
    const before = readFileSync(join(dist, 'p.json'), 'utf8');
    await expect(buildHostedCatalogs({ dist, baseUrl: base, datasets: hosted, strict: true, log: quiet })).rejects.toThrow(/kernels\/psyche/);
    expect(readFileSync(join(dist, 'p.json'), 'utf8')).toBe(before);
    await expect(buildHostedCatalogs({ dist, baseUrl: base, datasets: hosted, strict: true, allow: ['kernels/other'], log: quiet })).rejects.toThrow(/kernels\/psyche/);
    await expect(buildHostedCatalogs({ dist, baseUrl: base, datasets: hosted, strict: true, allow: ['kernels/psyche'], log: quiet })).resolves.toBeTruthy();
  });
});

describe('the checked-in catalogs and datasets manifest', () => {
  it('every dataset localDir sits under the catalog root at its catalogPrefix', () => {
    for (const [id, ds] of Object.entries(loadDatasets().datasets)) {
      expect(ds.localDir, id).toBe(`${CATALOG_ROOT}/${ds.catalogPrefix.replace(/\/$/, '')}`);
      expect(ds.kind).toBe(id.split('/')[0]);
      expect(ds.name).toBe(id.split('/')[1]);
    }
  });

  it('every kernel and terrain path in the example catalogs belongs to exactly one managed dataset', () => {
    const datasets = loadDatasets().datasets;
    const unmanaged = [];
    const walk = (dir, rel = '') => {
      for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!['kernels', 'data', 'models', 'textures', 'draco', 'ephemerides'].includes(e.name)) walk(dir, r);
        } else if (e.name.endsWith('.json')) {
          const visit = (v) => {
            if (typeof v === 'string') {
              const p = resolveLocalPath(v, r);
              if (p && /^(kernels\/|data\/mars-terrain)/.test(p) && !matchDataset(p, datasets)) unmanaged.push(`${r}: ${v}`);
            } else if (Array.isArray(v)) v.forEach(visit);
            else if (v && typeof v === 'object') Object.values(v).forEach(visit);
          };
          visit(JSON.parse(readFileSync(join(dir, r), 'utf8')));
        }
      }
    };
    walk(join(ROOT, CATALOG_ROOT));
    expect(unmanaged).toEqual([]);
  });
});
