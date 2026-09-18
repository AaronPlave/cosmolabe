# Memory budget

Cosmolabe's largest fixed cost is not a texture or a model. It is the CSPICE
WebAssembly heap, and it is paid once per *instance* — so the number that
matters is the reservation times however many instances a scene happens to be
running.

This document is the budget that got written down after issue #88, where
mission examples such as Europa Clipper and Cassini stopped surviving on an
iPhone 12 mini: the page appeared to finish loading and then reloaded itself,
which is WebKit terminating the tab under memory pressure rather than any
exception a console would show.

## The reservation

`packages/cspice-wasm/wasm/cspice.wasm` reserves **112 MiB** at instantiation
and grows from there (`ALLOW_MEMORY_GROWTH=1`, 2 GiB ceiling).

Almost all of that is floor rather than working room. CSPICE is f2c-translated
Fortran, so the DAF/DAS buffer pools, the kernel pool and the GF workspaces are
COMMON blocks — static data, sized at compile time, sitting in linear memory
below `__heap_base`. That floor is ~100.5 MiB in the current build, which is why
the budget is where it is: the ~11 MiB above it is the working heap a
lightweight scene allocates into before the first `memory.grow`.

The number lives in `packages/cspice-wasm/src/wasm-memory.ts`, is passed by
`scripts/build-cspice.sh` as `INITIAL_MEMORY`, and is asserted against the
committed artifact by `wasm-memory.test.ts`. Changing it means changing all
three; `scripts/set-initial-memory.mjs` re-pins the committed artifact when a
full Emscripten rebuild is not wanted.

It was 160 MiB between the September 3 migration to `cspice-wasm` and issue #88.
The migration replaced a TimeCraftJS build whose `TOTAL_MEMORY` was ~101 MiB, so
the two always-on instances below went from ~202 MiB of reservation to ~320 MiB
without anything in the viewer changing — the regression the budget and its test
exist to prevent recurring.

## How many instances a scene runs

| Instance | When it exists | Kernels it holds |
| --- | --- | --- |
| Main thread | Whole session, from the first catalog with kernels | The catalog's full set |
| Trajectory-cache worker | Whole scene, when a catalog furnishes worker kernels | SPK + LSK + text PCK |
| Geometry-search worker | On demand, released 60 s after the last search | Narrowed to the search window |

So a desktop mission scene reserves ~224 MiB across two instances, briefly ~336
MiB during an event search, plus the kernels themselves — Cassini's full staged
set approaches 300 MB in one instance.

**On a memory-constrained device the viewer runs one instance, total.** Neither
worker is created; trajectory caches bake through
`UniverseRenderer.buildCacheSync` and event searches through the main thread's
own provider. Both are pre-existing paths — the no-worker fallbacks — so this
costs load jank and a blocking search, not correctness. The policy, its signals
and the `?spiceWorkers=0|1` override are in
`apps/viewer/src/lib/device-budget.ts`.

## Returning to baseline between scenes

A scene switch used to peak badly: the outgoing scene was not torn down until
the incoming one was ready to be built, so its renderer, its GPU targets and
both workers' CSPICE instances — with every kernel they had furnished — stayed
resident through the whole of the next catalog's download and furnish. Peak was
up to three instances and two kernel sets at once, reached during the phase that
allocates most.

`loader.ts` now calls `disposeScene()` as soon as the new catalog JSON is in
hand and before a single kernel is fetched, rather than at the top of
`initScene`. A terminated worker takes its whole heap with it, which is the only
way a wasm reservation is ever given back. It runs after the catalog fetch on
purpose: a catalog URL that 404s should leave the scene on screen.

That covers the workers. The main thread's own instance is a separate matter and
is handled separately, by the `KernelRegistry` from #70/#91: it unloads what the
previous catalog furnished (keeping what the user dropped in), which is a
correctness fix first — a scene resolving geometry against a replaced scene's
kernels answers wrongly and silently — and a memory one second.

The main-thread instance itself is kept across scenes either way. A wasm heap
never shrinks, so replacing it would not return the reservation; it would only
add a second live one until the first was collected. Unloading the kernels is
what frees memory.

## Rules of thumb for changes here

- A new long-lived CSPICE instance is a ~112 MiB decision. Prefer sharing one,
  or make it on-demand and released, as the geometry worker is.
- Anything furnished for the life of a scene must be dropped when that scene is
  — through the `KernelRegistry`, which is the one place that knows whose a
  kernel is.
- Keep `INITIAL_MEMORY`, the constant and the artifact in step, and let the test
  say so rather than a commit message.
- GPU memory (device pixel ratio, bloom render targets) is the secondary lever.
  It is worth reaching for only once measurement shows it dominating, which for
  the mission scenes in issue #88 it did not.
