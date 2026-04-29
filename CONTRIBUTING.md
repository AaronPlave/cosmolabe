# Contributing to Cosmolabe

Thanks for your interest. This project is in early development and contributions are welcome — ideas, bug reports, and pull requests.

## Ground rules

- Open an issue before starting non-trivial work, so we can discuss approach.
- Keep PRs focused. Feature + refactor in one PR is harder to review and revert.
- New rendering features need a screenshot or short clip in the PR description.
- Match the existing TypeScript style. No prettier config yet — follow the surrounding code.

## Development setup

This is an npm workspaces monorepo. Node 20+ required.

```bash
git clone https://github.com/AaronPlave/cosmolabe.git
cd cosmolabe
git lfs pull          # required to fetch demo kernels, models, textures
npm install
npm run build         # typecheck + build all packages
npm test              # run vitest
```

To run the viewer:

```bash
cd apps/viewer && npm run dev
```

## Project layout

```
packages/
  spice/            # CSPICE WASM bindings (uses TimeCraftJS)
  core/             # Universe model — pure TypeScript, no rendering deps
  three/            # Three.js renderer
  cesium-adapter/   # CZML export + coordinate transforms
  cesium/           # CesiumJS renderer
apps/
  viewer/           # Three.js demo app (Svelte 5)
  cesium-viewer/    # CesiumJS demo app
```

`core` never imports `three` or `cesium`. Renderer packages compose over `core`.

## Testing

```bash
npx vitest run                                  # all tests
npx vitest run packages/core                    # one package
npx vitest run --reporter=verbose <test-name>   # debug single test
```

Tests that depend on SPICE kernels live under `packages/spice/test-kernels/` (LFS-tracked) and `apps/viewer/test-catalogs/kernels/` (LFS-tracked). If you skip `git lfs pull`, those tests will fail with "no such file or directory".

## Adding a feature

- New trajectory type? See `packages/core/src/trajectories/Trajectory.ts` for the interface and existing implementations (Keplerian, TLE, FixedPoint, etc.) for patterns.
- New rotation model? `packages/core/src/rotations/RotationModel.ts`.
- New renderer plugin? `packages/three/src/plugins/RendererPlugin.ts` and the stock plugins in `packages/three/src/plugins/stock/`.
- New mission catalog? Drop a [catalog JSON](docs/catalog-format.md) into `apps/viewer/test-catalogs/`. See existing catalogs (`iss.json`, `cassini-soi.json`) for examples.

## Opening a PR

1. Fork, branch from `main`
2. `npm run build && npm test` should pass
3. Describe what changed and why; screenshots for visual changes
4. By submitting, you agree your contribution is licensed under Apache-2.0

## License

By contributing, you agree your contributions are licensed under the [Apache License 2.0](LICENSE).
