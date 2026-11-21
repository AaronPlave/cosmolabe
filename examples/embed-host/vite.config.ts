// An ordinary Vite + TypeScript app: no Svelte plugin, no Cosmolabe build
// knowledge. `@cosmolabe/viewer` resolves to its built package (dist-embed).
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // Not pre-bundled: the package loads its workers and WASM relative to its
  // own module URL, which pre-bundling would move.
  optimizeDeps: { exclude: ['@cosmolabe/viewer'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
