import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { createReadStream, readFileSync, existsSync, cpSync, readdirSync, statSync, mkdirSync } from 'fs';
import { gunzipSync } from 'zlib';

function normalizeBase(raw: string | undefined): string {
  if (!raw) return '/';
  let b = raw.startsWith('/') ? raw : `/${raw}`;
  if (!b.endsWith('/')) b = `${b}/`;
  return b;
}

// Self-built quantized-mesh `.terrain` files are gzipped on disk. The clean
// solution is to serve them with `Content-Encoding: gzip` and let the browser
// auto-decompress — but Vite's static handler's header sequencing trips up the
// loader's fetch path in practice (the QuantizedMeshLoader ends up parsing the
// gzip magic bytes as binary, throwing RangeError: Invalid typed array length).
//
// Workaround: intercept the request, gunzip the file in the dev-server process,
// and stream raw quantized-mesh bytes with no encoding header. Negligible CPU
// per tile (tiles are 2-50 KB) and removes the browser-decompression variable
// entirely.
const TERRAIN_DATA_DIR = path.resolve(__dirname, 'test-catalogs/data');
const TEST_CATALOGS_DIR = path.resolve(__dirname, 'test-catalogs');
const fusedTerrainPlugin = {
  name: 'fused-terrain-serve-decompressed',
  configureServer(server: any) {
    server.middlewares.use((req: any, res: any, next: any) => {
      const url: string | undefined = req.url;
      if (!url || !url.includes('-terrain-fused/') || !url.endsWith('.terrain')) {
        return next();
      }
      // Strip query string + base path to derive the on-disk path.
      const cleanUrl = url.split('?')[0];
      const match = cleanUrl.match(/\/((?:mars|moon)-terrain-fused\/\d+\/\d+\/\d+\.terrain)$/);
      if (!match) return next();
      const filePath = path.join(TERRAIN_DATA_DIR, match[1]);
      if (!existsSync(filePath)) {
        res.statusCode = 404;
        res.end();
        return;
      }
      try {
        const gzipped = readFileSync(filePath);
        const decompressed = gunzipSync(gzipped);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(decompressed.length));
        res.setHeader('Cache-Control', 'no-cache');
        res.end(decompressed);
      } catch (err: any) {
        res.statusCode = 500;
        res.end(`Failed to serve terrain tile: ${err?.message ?? err}`);
      }
    });
  },
};

const testCatalogsPlugin = {
  name: 'test-catalogs-static-files',
  configureServer(server: any) {
    const route = `${server.config.base}test-catalogs/`.replace(/\\/g, '/');
    const contentTypes: Record<string, string> = {
      '.json': 'application/json; charset=utf-8',
      '.cosmo': 'text/plain; charset=utf-8',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.html': 'text/html; charset=utf-8',
      '.gz': 'application/gzip',
      '.terrain': 'application/octet-stream',
    };
    server.middlewares.use((req: any, res: any, next: any) => {
      if (!req.url) return next();
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      } catch {
        res.statusCode = 400;
        res.end('Bad request');
        return;
      }
      if (!pathname.startsWith(route)) return next();
      const filePath = path.resolve(TEST_CATALOGS_DIR, pathname.slice(route.length));
      if (!filePath.startsWith(`${TEST_CATALOGS_DIR}${path.sep}`)) {
        res.statusCode = 403;
        res.end('Forbidden');
        return;
      }
      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      if (!stat.isFile()) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      res.setHeader('Content-Type', contentTypes[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Cache-Control', 'no-cache');
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(filePath).pipe(res);
    });
  },
};

// Examples are development conveniences by default. A deployment that offers
// them opts in explicitly; hosted datasets are filtered from that optional copy.
const hostedData = process.env.HOSTED_DATA === '1';
const bundleTestCatalogs = process.env.BUNDLE_TEST_CATALOGS === '1';
const bundleTestCatalogsPlugin = {
  name: 'bundle-test-catalogs',
  apply: 'build' as const,
  async writeBundle(options: any) {
    const outDir = options.dir ?? path.resolve(__dirname, 'dist');
    const catalogsOutDir = path.join(outDir, 'test-catalogs');
    mkdirSync(catalogsOutDir, { recursive: true });
    let keep: (absolutePath: string) => boolean = () => true;
    if (hostedData) {
      const { loadDatasets } = await import('../../scripts/data-hosting/lib/datasets.mjs');
      const { publicDirCopyFilter } = await import('../../scripts/data-hosting/lib/public-dir-filter.mjs');
      // HOSTED_DATA_SKIP=id,id also skips datasets that are not pinned yet.
      const alsoSkip = (process.env.HOSTED_DATA_SKIP ?? '').split(',').filter(Boolean);
      keep = publicDirCopyFilter(loadDatasets().datasets, TEST_CATALOGS_DIR, alsoSkip);
    }
    for (const name of readdirSync(TEST_CATALOGS_DIR)) {
      const src = path.join(TEST_CATALOGS_DIR, name);
      if (keep(src)) cpSync(src, path.join(catalogsOutDir, name), { recursive: true, filter: keep });
    }
  },
};

export default defineConfig({
  base: normalizeBase(process.env.VITE_BASE),
  plugins: [
    svelte(),
    tailwindcss(),
    fusedTerrainPlugin,
    testCatalogsPlugin,
    ...(bundleTestCatalogs ? [bundleTestCatalogsPlugin] : []),
  ],
  publicDir: 'public',
  // The spice-cache relay worker pulls in further chunks (TimeCraftJS asm),
  // so it can't use the default IIFE format which forbids code-splitting.
  worker: { format: 'es' },
  resolve: {
    alias: {
      $lib: path.resolve(__dirname, './src/lib'),
    },
  },
  server: {
    fs: {
      // Allow serving files from the monorepo root (needed for workspace packages)
      allow: [path.resolve(__dirname, '../..')],
    },
    watch: {
      // Follow symlinks so chokidar watches the real package source files
      followSymlinks: true,
      // Self-hosted Mars and Moon terrain have ~700k–1.2M tile files each; watching every one of
      // them blows past fsevents' per-process file descriptor limit on macOS
      // and stalls the dev server. The tiles are static; HMR isn't useful for
      // them. Same goes for the multi-GB source GeoTIFFs in scripts/.
      ignored: [
        '**/test-catalogs/data/mars-terrain-fused/**',
        // Retired pre-#50 pyramid; existing checkouts may still hold its ~700k files.
        '**/test-catalogs/data/mars-terrain/**',
        '**/scripts/build-mars-terrain/data/**',
        '**/test-catalogs/data/moon-terrain-fused/**',
        '**/test-catalogs/data/moon-terrain-polar/**',
        '**/scripts/build-moon-terrain/data/**',
      ],
    },
  },
  optimizeDeps: {
    // Don't pre-bundle workspace packages — use source directly for HMR
    exclude: ['@cosmolabe/control', '@cosmolabe/core', '@cosmolabe/three'],
  },
});
