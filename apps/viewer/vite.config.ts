import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

function normalizeBase(raw: string | undefined): string {
  if (!raw) return '/';
  let b = raw.startsWith('/') ? raw : `/${raw}`;
  if (!b.endsWith('/')) b = `${b}/`;
  return b;
}

export default defineConfig({
  base: normalizeBase(process.env.VITE_BASE),
  plugins: [svelte(), tailwindcss()],
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
    },
  },
  optimizeDeps: {
    // Don't pre-bundle workspace packages — use source directly for HMR
    exclude: ['@cosmolabe/core', '@cosmolabe/three', '@cosmolabe/spice'],
  },
});
