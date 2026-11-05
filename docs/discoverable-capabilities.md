# Discoverable viewer capabilities (#328)

`createCapabilityTools(control, options)` binds discovery and receipts to the same `ViewerControl` used by the UI, scripts and hosts. Standalone and embedded Ask retain the fixed-tool default because the measured discovery workflow increased total input tokens. Hosts can opt embedded Ask into discovery with `ask: { transport, toolMode: 'discovery' }`. An embed exposes it as `viewer.capabilities`; `viewer.agentTools` retains #311's fixed-tool API. Existing script syntax, the interpreter and host methods are unchanged.

## Discovery and invocation

The model always sees five tools: `describeScene`, `listCapabilities`, `describeCapabilities`, `getOperationResult` and `invokeCapability`. The provider-facing schemas stay **identical throughout the conversation**. `listCapabilities` returns a bounded page of IDs/descriptions/availability. `describeCapabilities` returns detailed input and output-data schemas for requested IDs only. `invokeCapability` validates its input against that operation's selected schema before delegating to the existing agent facade and `execute`/`VERBS`.

```ts
const task = viewer.capabilities.begin();
await task.call('listCapabilities', { domain: 'surface', availableOnly: true });
await task.call('describeCapabilities', {
  ids: ['scene.select', 'surface.getSurfaceData'], version: 1,
});
const selection = await task.call('invokeCapability', {
  id: 'scene.select', version: 1, input: { object: 'Moon' },
});
const inventory = await task.call('invokeCapability', {
  id: 'surface.getSurfaceData', input: { object: 'Moon' },
});
const observed = await task.call('describeScene', {});
task.finish();
```

Use one task for a workflow. Top-level `call()` is a new one-call task, so it does not inherit previously described IDs. The typed host can also read `listCapabilities`, `describeCapabilities` and `getOperationResult` directly without starting or superseding work. Direct description is metadata inspection; the task's description call establishes that task's known IDs. Trusted task callers can retain existing operation tool names after describing them; models use the fixed invocation envelope.

IDs are `<domain>.<existingToolName>` at version 1. Writes are derived automatically from `VERBS`, including parameter schemas, host method and dispatch; bounded reads register alongside their existing implementations in `agent.ts`. There is no catalog-provided executable code, plugin loader, arbitrary JS, network or filesystem tool. Unknown versions, IDs, fields, enum values and invalid input types refuse before execution. Hosts lacking `getScene()` can read but cannot execute catalog writes.

Bounds: 12 items per list page, 160 search characters (at most 24 search words), eight descriptions per call, 16,000 input JSON characters, 64 retained operation receipts, and 20 model rounds with discovery (the fixed #311 adapter retains ten). Search ranks matching keywords, including operation IDs; domains/effects can narrow it. Described IDs remain usable for their task. Each description is bounded; schema results have a separate 16,000-character result budget, while ordinary results retain 6,000. Oversized results explicitly report omission rather than returning invalid JSON or a misleading complete prefix.

## Test discovery in the regular development viewer

Keep the existing local Ask proxy and `VITE_ASK_ENDPOINT` setup. In `vite dev`, add `?askMode=discovery` to the viewer URL (or `&askMode=discovery` alongside `catalog`/`entry`). The Ask panel shows a discreet **Discovery** or **Fixed** indicator only in development. An ordinary URL, unrecognized mode or production build stays fixed. This URL flag neither configures a proxy nor enables Ask where no endpoint exists.

Changing mode cancels the old task, disposes its tools and starts fresh model history, since the offered provider schemas differ. Back/forward changes synchronize immediately; programmatic URL replacements synchronize before the next request. Existing transcript rows remain inspectable. Production ignores this override and omits the indicator; embedded hosts retain their explicit `ask.toolMode` option.

The bounded real-catalog smoke uses the regular panel and URL flag rather than embedding a host:

```sh
# Start this checkout with VITE_ASK_ENDPOINT=http://127.0.0.1:8798 on port 5298.
# With the configured Anthropic key, this launches the existing local proxy.
ASK_MISSION_LIVE=1 node scripts/test-ask-mission-smoke.mjs
```

It runs the review's Ingenuity and MoonFall prompts in fresh browser/scene/conversation sessions, fixed then discovery. It records observed state and factual answer for review, partial/refused outcomes, model rounds, elapsed time and uncached/cache/output token counts with the existing proxy's estimated costs. A $0.50 estimated process guard and 600,000 raw-token guard bound the smoke; in-flight work may overshoot. Provider cache may be warm, so this is not a statistical benchmark. Reports default to `/tmp/ask-mission-smoke.json`; do not commit raw provider traces. Broader model comparisons, reviewed cheaper-model pricing and correctness-first optimization are tracked in [#332](https://github.com/AaronPlave/cosmolabe/issues/332), under #315 with no hard blockers. Feature contracts remain in #297.

## Truthful outcomes and ownership

Every operation result carries a receipt with operation/version, viewer/scene/reload identity, task and operation IDs, status, requested references, verified exact references, current observation, warnings, provenance and verification level. Reads retain their domain data envelope; nested scientific metadata follows the existing public projection. Raw dataset endpoints and unapproved provenance remain withheld. Receipt state uses compact activity/place identity, clock/playback, tracked object, flight and camera pose/reference; it is a point-in-time observation, not another state store.

Statuses are `accepted`, `running`, `completed`, `refused`, `partial`, `cancelled` and `stale`. A flight completes only after its own observed `flightEnd`. Selection, activity, clock/playback and imagery writes read their existing semantic state back. Where the port has no semantic readback, a successful host return produces **partial / host-return**, with an explicit #297 warning, rather than claiming verified UI parity. Discovery-mode Ask presents these as **unverified**. If the resulting viewer observation fails, even a successful operation becomes partial / host-return and retains its underlying tool result with an explicit warning. Capability lookups are counted separately from viewer steps. Camera poses use the port's existing km/reference-frame convention; no coordinates are transformed.

`onReceipt` reports accepted/running/final progress to the trusted host. Use the returned ID with `getOperationResult`; unknown/evicted IDs return null, never inferred success. Receipts survive scene reload as historical observations and retain their original scope; observations taken in a replacement scene are separately scoped. Reload invalidates tasks and described references, including hosts which mistakenly reuse scene IDs. A late model response cannot issue writes in the replacement scene. Manual camera takeover prevents further camera writes in the task; cancellation stops only that task's flight. Previous successful steps remain in place after a later failure. Nothing automatically replays writes or rolls back the view. A host's already-running asynchronous implementation must still honor its own scene/cancellation contract; the facade cannot undo arbitrary late side effects inside host code.

## Permissions and coverage

Read operations need no confirmation. Reversible viewer changes use the existing control ownership rules. Missing host methods and trusted `omitted` reasons appear in discovery. In an embed, `MountOptions.capabilities` supplies the policy to `viewer.capabilities` and discovery-mode Ask. Fixed-mode Ask enforces the same operation omissions; captures remain unavailable in that mode.

Capture/record operations are classified as external and default to unavailable. Execution requires both `allowExternal: true` and a trusted `confirmExternal(operation, exactInput)` callback for each call. Model arguments cannot confirm anything. After approval, scene/task ownership is checked again. No authoring operation is currently registered: measurement/shape/bookmark mutations remain explicit gaps, rather than being exposed under a reversible-view effect. A future authoring contract requires its own declared permission policy before registration.

`capabilityCoverage()` is the machine-readable UI → semantic method → script verb → discovery matrix. Its registered rows derive from the same definitions. `UI_CAPABILITY_GAPS` lists shipped feature gaps: Event Finder, measurements, geographic shapes, instruments, bookmarks/view sharing, terrain appearance/readiness and surface planning. `CONTROL_CONTRACT_GAPS` classifies existing port methods without their own discovery operation, including methods observed through composites. Tests inspect the TypeScript interface and fail if a new method is neither registered nor explicitly classified. Every new verb appears automatically in the catalog and matrix; tests require its schema and method mapping.

#297 owns missing per-feature APIs/readiness. This issue does not implement those features. Scene reference checks and metadata projection remain shared with #311/#312; plugin operations are outside this catalog until a real installed consumer requires them.

## Providers and reproducible validation

Changing a provider's native tool list can invalidate Anthropic's signed thinking blocks and the cached prefix. The initial dynamic-schema experiment reproduced HTTP 400 with a message identifying the changed tools list. The final fixed five-tool surface preserves the list and append-only provider blocks; selected schemas are ordinary discovery results. See [Anthropic preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking) and [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

OpenAI receives `strict: false` because optional fields must stay optional and the invocation input is validated locally against the selected schema. Discovery permits multiple requested calls in one model round, but `runAgent` still executes them **sequentially**, checking permission/cancellation/scene ownership between operations. The legacy fixed adapter retains its previous single-call setting. See [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling). Anthropic uses its existing schema translation; neither adapter rewrites signed reasoning or retries writes.

Start this checkout's dev server on a dedicated unused port and verify its listener cwd, then run:

```sh
CL_VIEWER_URL=http://127.0.0.1:5298/ node scripts/test-capability-discovery.mjs
```

The harness loads the actual standalone viewer with the existing kernel-free Earth–Moon catalog and an explicitly synthetic activity. It checks activity/time/navigation and a surface-data read, an intentional missing-layer failure with state reconciliation, and actual Ask labels/unverified results on desktop and 390px layouts. Browser validation uses software WebGL; it makes no physical-GPU or terrain-quality claim. `scripts/test-embed-host.mjs` separately checks discovery/read receipts through the packaged embedded workspace.

With explicit permission for external inference, `CAPABILITY_LIVE=1` compares both configured providers against the #326 fixed-tool adapter. Only the synthetic fixture, capability schemas and resulting public viewer observations are sent; keys stay in Node. Every run reloads the scene. It checks selection, paused time, a surface read and the catalog's known 900,000 km viewpoint range, not just the model's reply. It records actual provider input/output/cache token counters, round trips, elapsed latency, reported model and reviewed estimated cost (null for unknown model pricing). Bounds: 20 rounds/run, 1,536 output tokens/round, a 300,000-processed-token process guard, a $1 estimated process guard and a 60-second per-call timeout. Guards are checked before a request; one in-flight request can overshoot. Reports default to `/tmp`; set `CAPABILITY_REPORT` explicitly to retain them. Smaller initial tool schemas do not establish lower total cost or latency.

### Measured comparison (2026-11-01)

The [retained receipt](validation/issue-328/capability-comparison.json) records one final run per adapter/provider against the synthetic loaded-viewer fixture, using the real provider APIs and their reported cache counters. All four reached the required observed state. Cache warmth and model planning differ; these are smoke measurements, not a statistical benchmark.

| Provider / adapter | Starting input tokens | Total input tokens, including cache | Model rounds | Elapsed | Estimated USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| Sonnet 5.5 / #326 fixed | 7,143 | 49,771 | 6 | 8.58 s | 0.03322 |
| Sonnet 5.5 / discovery | 3,319 | 106,505 | 11 | 17.02 s | 0.04953 |
| GPT-5.1 snapshot / #326 fixed | 3,153 | 36,313 | 10 | 9.89 s | unknown |
| GPT-5.1 snapshot / discovery | 1,754 | 42,248 | 10 | 9.65 s | unknown |

Ask therefore keeps fixed tools as its default. This synthetic-fixture table describes the original prompt at `72e4862`; see the real-mission follow-up below for the factored prompt and the development-only opt-in.

The fixed discovery schema reduces starting input by about 54% for Sonnet and 44% for GPT in this fixture. **Total input increased for both**, and Sonnet took more rounds, time and estimated cost. Discovery provides capability inspection and bounded schemas; this change does not establish overall inference savings. OpenAI reported `gpt-5.1-2025-11-13`, which has no exact reviewed price entry in the proxy, so no cost was guessed. Earlier experiments and the corrected state-based acceptance criterion are recorded in the receipt limitations.

Validation also passed 378 control/viewer/shell/proxy regression tests, the control suite's 169 tests after the final unknown-field hardening, package build and declaration checks, viewer/test/Svelte typechecks, lint and purity lint, the packaged consumer browser checks and 37 embedded-host checks. The broader package run passed 2,465 tests plus seven skips when excluding the separately checked GF reporting file. That unchanged file reproduced its existing timing failure at `packages/cspice-wasm/src/gf-reporting.test.ts:183` (23 other tests in that file passed); no GF code or expectation was changed.

### PR review follow-up

The Ask default was restored to the fixed adapter rather than spending additional provider tokens to justify discovery as the default. Discovery guidance now shares scientific/correctness rules with the fixed prompt without prescribing unavailable direct-tool calls; it asks for batched descriptions and reuse within a task. The real-mission follow-up below measures Ingenuity and MoonFall; broader navigation/mixed workflows and cheaper-model comparisons remain in #332. Discovery performance is not claimed improved.

Review validation covers successful writes with failed camera observation (the host result is preserved, the receipt is partial/unverified), fixed-mode host omissions, lookup counts, the default fixed Ask selection in two mock-transport rounds against the loaded viewer, and explicit discovery mode with an unverified grid result at desktop and 390px. These browser checks exercise the real viewer and local scripted responses, not provider inference.

### Real-mission release smoke (2026-11-01)

The [compact retained report](validation/issue-328/mission-smoke.json) records the regular viewer's development URL flag and real local proxy, with `claude-sonnet-5-5`, prompt caching enabled and one run per mode/task. Each run starts with fresh browser, scene and model history; provider cache warmth remains shared and fixed precedes discovery. Raw processed totals below include uncached input, cache reads/writes **and output**. The report retains these categories separately. Estimated USD is not actual billing.

| Task / mode | Model requests | Raw processed tokens | Elapsed | Estimated USD |
| --- | ---: | ---: | ---: | ---: |
| Ingenuity / fixed | 6 | 56,311 | 12.61 s | 0.02108 |
| Ingenuity / discovery | 10 | 108,856 | 20.93 s | 0.07160 |
| MoonFall / fixed | 4 | 39,210 | 9.53 s | 0.02297 |
| MoonFall / discovery | 7 | 71,502 | 12.82 s | 0.05354 |

All four reached the requested scene state: Flight 12 at its paused start (169.5 s catalog-estimated duration), tracking Ingenuity with the same final camera pose, or the synthetic MoonFall PSR landing waypoint, separate from Shackleton crater. Mars inventories contain four layers. MoonFall inventories show LOLA terrain, WAC/NAC imagery, configured/ready/loaded/drawn distinctions and unknown current-view coverage. The development indicator and actual offered schemas matched the URL, and the panel fit at 390px.

These state checks are **not full factual-answer acceptance**. Discovery marked Ingenuity framing partial because semantic readback is absent. MoonFall discovery recovered from one refused direct semantic-tool call. Its answer called withheld terrain attribution “not given”; fixed Ingenuity described layers as loading fine despite degraded fallback tiles, and neither Ingenuity answer reproduced full layer attributions. The compact report preserves these caveats rather than treating a successful final state as a perfect answer. Setup trials before this retained comparison failed before viewer writes and may have warmed cache. No model/default/routing changes follow from these single-run measurements; #332 owns further evaluation. Fixed Ask remains default.

Continuous timeline profiles (#359) map `AddProfile` / `ProfileConfig` / `ProfileRow` → `getProfileOptions`, `listProfiles`, `getProfile`, `upsertProfile`, `removeProfile` on the same instance-bound `ViewerControl` → script verbs `upsertProfile` / `removeProfile` → `profiles.*` discovery for Ask and embedded hosts. These reversible visualization edits require no authoring confirmation. IDs and scene guards are shared with the native UI. `getProfile` distinguishes configuration from current mounted timeline presence and sampled trace visibility; absent integration or samples yields partial/unavailable, never a claim of visual success.

The four shipped quantities are range (center-to-center km), relative speed (km/s), signed range rate (km/s), and phase angle (degrees at the target, default illuminator Sun). Samples use the existing `Universe.absolutePositionOf` display path, independent of SPICE GF certification. Missing positions remain gaps. Range is not irregular-body altitude/clearance; sampled minima do not certify contact. Unsupported clearance must not silently become a profile or closest-approach search.
