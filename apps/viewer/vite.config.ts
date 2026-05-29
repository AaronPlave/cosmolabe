import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { gunzipSync } from 'zlib';

function normalizeBase(raw: string | undefined): string {
  if (!raw) return '/';
  let b = raw.startsWith('/') ? raw : `/${raw}`;
  if (!b.endsWith('/')) b = `${b}/`;
  return b;
}

// CTB-produced quantized-mesh `.terrain` files are gzipped on disk. The clean
// solution is to serve them with `Content-Encoding: gzip` and let the browser
// auto-decompress — but Vite's static handler's header sequencing trips up the
// loader's fetch path in practice (the QuantizedMeshLoader ends up parsing the
// gzip magic bytes as binary, throwing RangeError: Invalid typed array length).
//
// Workaround: intercept the request, gunzip the file in the dev-server process,
// and stream raw quantized-mesh bytes with no encoding header. Negligible CPU
// per tile (tiles are 2-50 KB) and removes the browser-decompression variable
// entirely.
const TERRAIN_TILE_DIR = path.resolve(__dirname, 'test-catalogs/data/mars-terrain');
const marsTerrainPlugin = {
  name: 'mars-terrain-serve-decompressed',
  configureServer(server: any) {
    server.middlewares.use((req: any, res: any, next: any) => {
      const url: string | undefined = req.url;
      if (!url || !url.includes('/mars-terrain/') || !url.endsWith('.terrain')) {
        return next();
      }
      // Strip query string + base path to derive the on-disk path.
      const cleanUrl = url.split('?')[0];
      const match = cleanUrl.match(/\/mars-terrain\/(.+\.terrain)$/);
      if (!match) return next();
      const filePath = path.join(TERRAIN_TILE_DIR, match[1]);
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

export default defineConfig({
  base: normalizeBase(process.env.VITE_BASE),
  plugins: [svelte(), tailwindcss(), marsTerrainPlugin],
  publicDir: 'test-catalogs',
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
      // Self-hosted Mars terrain has ~700k tile files; watching every one of
      // them blows past fsevents' per-process file descriptor limit on macOS
      // and stalls the dev server. The tiles are static; HMR isn't useful for
      // them. Same goes for the multi-GB source GeoTIFFs in scripts/.
      ignored: [
        '**/test-catalogs/data/mars-terrain/**',
        '**/scripts/build-mars-terrain/data/**',
      ],
    },
  },
  optimizeDeps: {
    // Don't pre-bundle workspace packages — use source directly for HMR
    exclude: ['@cosmolabe/core', '@cosmolabe/three', '@cosmolabe/spice'],
  },
});
