# Final Ask effect-policy and transcript pass

Addresses [November 3 feedback](https://github.com/AaronPlave/cosmolabe/pull/334#issuecomment-6606661294).

Ordinary Event Finder configuration uses the shared Analysis verb and a viewer
capability effect. Reversible measurements, annotations and session bookmarks
also use viewer effects. All still require the embed host's existing
`allowAuthoring`; Ask already supplies it. No permission is inferred from model
or catalog text. The registry marks these local writes explicitly, independently
of their presentation category. Explicit measurement replacement, annotation
feature deletion, other remove operations and whole-state restore still need
exact-call authoring confirmation. Export/recording retain separate protection.
Mixed edit verbs describe their destructive variant in help and enforce the
confirmation against the actual validated input. No search lifecycle or solver
was added.

Ask has one status location per turn: researching, useful current action,
approval needed, or terminal outcome. Action history is collapsed separately.
Only successful scene-mutating operations with non-partial receipts count as
viewer changes; reads, declined operations, waits and exports do not. User prompts
sit in compact right-aligned surfaces; answers remain left-aligned and primary.

## Loaded browser and provider acceptance

Ordinary Chrome, ANGLE Metal / Apple M4 Max, task-owned port 5797 verified against
this checkout. Fixed remains the default. Fresh public Psyche scenes:

- `show me all psyche flybys of earth`: six model calls, no approval. Nine local
  distance minima within the loaded 2023-10-13–2031-11-01 window, nearest about
  180 million km. The answer explicitly refuses to call these flybys and does
  not move the camera to a fictitious encounter. This is a truthful no-flyby
  outcome, rather than a positive Earth-flyby visualization acceptance.
- `show me the one where psyche is closest to mars`: six model calls, no
  approval. Existing Event Finder configured/run; ranked both local minima and
  presented the winner at ET 832145351.658457 (2026-05-15 19:28 UTC), range
  8008.353750004037 km. Independent full candidate, frozen epoch, pause, native
  rendering and projected central composition assertions passed.
- An actual second turn explains the range/reference-altitude distinction and
  search limits, retaining the exact selected result and epoch. Inspected
  [two-turn transcript](psyche-transcript.png) and [Earth outcome](psyche-earth.png).
  Tool-result payloads for options/pages were matched by call ID to provider
  requests. Raw traces stay outside the repository.

Deterministic loaded-panel fixtures separately cover idle, research, running
scene action, approval pending, complete, refusal and cancellation. One status per
turn, collapsed history, right-aligned nontransparent prompt surface and
full-width answer geometry are asserted. Inspected [running](permissions-running.png)
and [approval pending](permissions-pending.png) screenshots. These two screenshots
contain explicitly labeled fixture answers, not provider/solver acceptance.

## Repeat and checks

`ASK_MISSION_LIVE=1 ASK_MODES=fixed ASK_SCENARIOS=psyche-earth,psyche-mars node scripts/test-ask-modern-scene.mjs`
requires the already-authorized paid provider and a viewer configured for local
proxy port 8798. Voyager/Cassini and the existing geographic deletion/export
scenarios remain in that harness. `node scripts/test-ask-status-ui.mjs` uses no
provider. Compact public observations: [permissions-ux.json](permissions-ux.json).

Control and viewer regressions cover permission refusal without host grants,
routine no-confirmation calls, destructive/external decline, stale scenes,
exact UI approve/decline/cancel in both modes, read-only status counts and progress.
Validation covers 759 viewer cases (758-suite pass plus the final focused status
regression) and 196 control cases. All configured type/Svelte checks, changed-file lint, purity, 108-operation
coverage, production and embed/declaration builds pass. Build output retains its
existing large-chunk advisory. Native observations are not pixel guarantees;
search scope and loaded-kernel limits remain explicit. No merge or deployment.
