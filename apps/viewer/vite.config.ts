import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  publicDir: 'test-catalogs',
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
    exclude: ['@spicecraft/core', '@spicecraft/three', '@spicecraft/spice'],
  },
});
