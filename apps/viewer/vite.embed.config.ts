/**
 * The embeddable workspace build (`npm run build:embed`): `src/embed.ts` as
 * one self-contained ES module, `dist-embed/cosmolabe.js`, with its CSS
 * inlined for the shadow root, Svelte compiled in (hosts need no Svelte
 * plugin), and its workers and data assets beside it in `assets/`.
 *
 * A relative `base` makes every asset and worker URL resolve against the
 * module itself (`new URL(…, import.meta.url)`), so the directory works
 * wherever it is served. Asset names are unhashed so `assetBaseUrl` can
 * point at a copy of `assets/` elsewhere.
 */
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

const STABLE_ASSET = /\.(wasm|bin|woff2?)$/;
const assetFileNames = (info: { names?: string[] }) =>
  STABLE_ASSET.test(info.names?.[0] ?? '') ? 'assets/[name][extname]' : 'assets/[name]-[hash][extname]';

export default defineConfig({
  base: './',
  // Component styles go into the shadow root with the components.
  plugins: [svelte({ compilerOptions: { css: 'injected' }, emitCss: false }), tailwindcss()],
  publicDir: false,
  worker: {
    format: 'es',
    rollupOptions: { output: { assetFileNames, entryFileNames: 'assets/[name]-[hash].js', chunkFileNames: 'assets/[name]-[hash].js' } },
  },
  resolve: {
    alias: { $lib: path.resolve(__dirname, './src/lib') },
  },
  define: {
    // A library must not read the host page's Vite env; these are the app's.
    'import.meta.env.VITE_CESIUM_ION_TOKEN': 'undefined',
  },
  build: {
    outDir: 'dist-embed',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0,
    rollupOptions: {
      input: { cosmolabe: path.resolve(__dirname, 'src/embed.ts') },
      preserveEntrySignatures: 'strict',
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames,
      },
    },
  },
});
