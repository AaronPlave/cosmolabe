# Reference host: the Cosmolabe workspace in a plain TypeScript page

A framework-free host (Vite + TypeScript, no Svelte) that mounts the complete
Cosmolabe workspace from the built package and supplies, as a mission operations
tool would:

- two spacecraft from a telemetry archive and a live feed (`src/telemetry.ts`),
  each in different frames, units, time scales and quaternion conventions;
- closed-form truth for both, so every answer can be checked (`src/fixtures.ts`);
- host mission activities beside a catalog-owned one;
- a host clock and selection kept in sync with the viewer's, both ways.

`TelemetryArchive` is where a real ground-system adapter (for example Yamcs)
plugs in; nothing else changes.

```sh
npm run build:embed            # from the repository root
cd examples/embed-host && npx vite
node scripts/test-embed-host.mjs   # the acceptance test, from the root
```

See [docs/embedding.md](../../docs/embedding.md).
