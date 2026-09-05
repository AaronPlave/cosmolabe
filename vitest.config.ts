import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `apps/viewer` is included deliberately. It used to be in no gate at all —
    // not typechecked, not tested, not built on any PR (issue #20) — which is
    // how its `camera-view-io.ts` kept the noon-UTC J2000 constant through both
    // #3 and #22, the two changes whose whole purpose was removing it.
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
  },
});
