import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'vite';
import { ROOT, loadDatasets } from '../lib/datasets.mjs';
import { createDevCatalogResolver } from '../lib/dev-catalogs.mjs';

let server;
let cacheDir;
afterEach(async () => {
  await server?.close();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it.each(['auto', 'local'])('serves the unchanged catalog route in Vite with %s selection and correct GET/HEAD headers', async (mode) => {
  const baseUrl = 'https://configured.example/data';
  vi.stubEnv('DEV_DATA_MODE', mode);
  vi.stubEnv('DATA_BASE_URL', baseUrl);
  cacheDir = mkdtempSync(join(tmpdir(), 'dev-catalogs-vite-'));
  server = await createServer({
    root: join(ROOT, 'apps/viewer'),
    configFile: join(ROOT, 'apps/viewer/vite.config.ts'),
    base: '/development/',
    cacheDir,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/development/test-catalogs/moonfall-shackleton.json`;
  const original = readFileSync(join(ROOT, 'apps/viewer/test-catalogs/moonfall-shackleton.json'), 'utf8');
  const resolver = createDevCatalogResolver({ datasets: loadDatasets().datasets, mode, baseUrl, log: () => {} });
  const expected = await resolver(JSON.parse(original), 'moonfall-shackleton.json');
  const response = await fetch(`${url}?unchanged=1`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  expect(response.headers.get('cache-control')).toBe('no-cache');
  const body = await response.text();
  expect(Buffer.byteLength(body)).toBe(Number(response.headers.get('content-length')));
  expect(JSON.parse(body)).toEqual(expected);
  const head = await fetch(url, { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(head.headers.get('content-length')).toBe(response.headers.get('content-length'));
  expect(await head.text()).toBe('');
  expect(readFileSync(join(ROOT, 'apps/viewer/test-catalogs/moonfall-shackleton.json'), 'utf8')).toBe(original);
}, 30000);
