import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Two projects rather than one include glob, because `apps/viewer` needs a
    // plugin the packages do not: its `viewer-state.svelte.ts` and every module
    // that imports it are Svelte 5 rune modules, which only compile through
    // `@sveltejs/vite-plugin-svelte`. Without that, the app's own logic was
    // reachable from a test only by hoisting it out into a plain `.ts` file, or
    // by inventing a dependency-injection seam whose only purpose was to dodge
    // an untestable import.
    //
    // `apps/viewer` is in a gate deliberately. It used to be in no gate at all —
    // not typechecked, not tested, not built on any PR (issue #20) — which is
    // how its `camera-view-io.ts` kept the noon-UTC J2000 constant through both
    // #3 and #22, the two changes whose whole purpose was removing it.
    projects: [
      {
        test: {
          name: 'packages',
          include: ['packages/*/src/**/*.test.ts'],
        },
      },
      // The viewer brings its own config so the Svelte plugin is imported from
      // the workspace that actually declares it as a devDependency, rather than
      // from the root by way of the hoisted `node_modules` — the same resolution
      // accident `scripts/purity-lint.sh` exists to catch in `packages/core`.
      './apps/viewer',
    ],
  },
});
