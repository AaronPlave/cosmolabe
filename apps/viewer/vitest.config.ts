import path from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

/**
 * Test config for the viewer app.
 *
 * Separate from `vite.config.ts` on purpose: the app's build config carries
 * Tailwind, a `publicDir` of several hundred thousand terrain tiles and a
 * dev-server middleware, none of which a unit test needs. What a test does need
 * is the Svelte plugin, so `*.svelte.ts` rune modules — `viewer-state.svelte.ts`
 * above all — compile like they do in the app.
 */
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      $lib: path.resolve(import.meta.dirname, './src/lib'),
    },
  },
  test: {
    name: 'viewer',
    include: ['src/**/*.test.ts'],
  },
});
