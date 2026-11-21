# Contributing to Cosmolabe

Thanks for your interest. This project is in early development and contributions are welcome — ideas, bug reports, and pull requests.

## Ground rules

- Open an issue before starting non-trivial work, so we can discuss approach.
- Keep PRs focused. Feature + refactor in one PR is harder to review and revert.
- New rendering features need a screenshot or short clip in the PR description.
- Match the existing TypeScript style. No prettier config yet — follow the surrounding code.

## Development setup

This is an npm workspaces monorepo. Node 24+ required.

```bash
git clone https://github.com/AaronPlave/cosmolabe.git
cd cosmolabe
# Required by normal npm test: shared DE440s and two scientific oracles.
git lfs pull --include="apps/viewer/test-catalogs/kernels/de440s.bsp,kernels/test-data/de425s.bsp,kernels/test-data/cassini/04183_04185ra.bc"
bash scripts/fetch-lro-kernels.sh   # existing LRO/frame integration data
bash scripts/fetch-cosmographia-data.sh  # third-party catalog integration data
npm install
npm run build         # typecheck + build all packages
npm test              # run vitest
npm run lint          # eslint
```

To run the viewer:

```bash
cd apps/viewer && npm run dev
```

## Project layout

```
packages/
  cspice-wasm/      # CSPICE compiled to WASM + raw bindings — the runtime SPICE
  frames/           # The ADR M-0002 seam: StateProvider, FramesService, heritage adapter
  core/             # Universe model — pure TypeScript, no rendering deps
  control/          # ViewerControl port + script language — no renderer, no DOM
  interop/          # CCSDS (OEM, CDM, AEM), CSV and CZML parse/write — pure string transforms
  three/            # Three.js renderer
  cesium-adapter/   # CZML export + coordinate transforms — cesium is an optional peer dep
  cesium/           # CesiumJS renderer
apps/
  viewer/           # Three.js demo app (Svelte 5)
  cesium-viewer/    # CesiumJS demo app
```

`core` and `control` never import `three` or `cesium`. Renderer packages compose over `core`.
`core` also imports no SPICE package: it declares the narrow surface it calls (`SpiceInstance`, in
`packages/core/src/spice-injection.ts`) and takes an engine by injection, which `frames`' heritage
adapter satisfies. Keep that direction — a `cspice-wasm → frames → core` static chain would undo it.
That interface is transitional scaffolding, not `core`'s SPICE API: it holds only what `core`'s own
call sites use, and it shrinks as they migrate to the M-0002 contracts. If you need a SPICE
capability `core` does not already call, declare a narrow contract in the consumer that needs it
(`GeometryFinderProvider`, `InstrumentFovProvider`) rather than widening this one.
This is enforced, not just documented: their `tsconfig.json` files build without the `DOM` lib, so a `document` or `HTMLCanvasElement` in either is a typecheck error, and `npm run lint:purity` (a CI step) fails on an import of `three` or `cesium` — which tsc cannot catch, since the workspace hoists both to the root `node_modules`.

## Testing

```bash
npx vitest run                                  # all tests
npx vitest run packages/core                    # one package
npx vitest run --reporter=verbose <test-name>   # debug single test
```

The full normal suite needs shared DE440s and the two LFS oracles fetched above; they
are not optional tests. Other deterministic SPICE fixtures are ordinary Git blobs
under `kernels/fixtures/` and `kernels/test-data/`. The LRO and Cosmographia fetches
above remain required by their integration tests, just as in CI. See
[kernel fixtures and provenance](kernels/README.md).

Mission-specific viewer binary kernels are not in Git/LFS (shared DE440s remains): Vite uses versioned R2 pins
when local files are absent, or run the relevant `scripts/fetch-*-kernels.sh`
for full local mission data. `scripts/fetch-all.sh` is for demos/deployment, not
the normal test suite. Visual/browser checks may additionally need LFS models,
textures and maps; use `git lfs pull` for those assets.

## Adding a feature

- New trajectory type? See `packages/core/src/trajectories/Trajectory.ts` for the interface and existing implementations (Keplerian, TLE, FixedPoint, etc.) for patterns. To add one without touching this repo, pass `trajectoryFactories: { MyType: factory }` to `Universe` or `CatalogLoader` — catalog entries with that `type` are built by your factory, and a name already in the table is overridden.
- New rotation model? `packages/core/src/rotations/RotationModel.ts`.
- New renderer plugin? `packages/three/src/plugins/RendererPlugin.ts` and the stock plugins in `packages/three/src/plugins/stock/`.
- New script verb, or a new way to drive the viewer from a host? `packages/control/src/verbs.ts` is the one table the language, the port and the palette all read; see [docs/scripting.md](docs/scripting.md).
- A new way to navigate the camera, or a new surface that does? Call the shared verbs — Select, Track, Frame, Fly, Jump — rather than the camera directly; see [docs/navigation.md](docs/navigation.md).
- New mission catalog? Drop a [catalog JSON](docs/catalog-format.md) into `apps/viewer/test-catalogs/`. See existing catalogs (`iss.json`, `cassini-soi.json`) for examples.

## Opening a PR

1. Fork, branch from `main`
2. `npm run build && npm run lint && npm test` should pass
3. Describe what changed and why; screenshots for visual changes
4. By submitting, you agree your contribution is licensed under Apache-2.0

## License

By contributing, you agree your contributions are licensed under the [Apache License 2.0](LICENSE).
