import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: __dirname,
  publicDir: 'test-catalogs',
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
