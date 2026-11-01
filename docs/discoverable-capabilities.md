# Discoverable viewer capabilities (#328)

`createCapabilityTools(control, options)` binds discovery and receipts to the same `ViewerControl` used by the UI, scripts and hosts. Standalone and embedded Ask use it. An embed exposes it as `viewer.capabilities`; `viewer.agentTools` retains #311's fixed-tool API. Existing script syntax, the interpreter and host methods are unchanged.

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

## Truthful outcomes and ownership

Every operation result carries a receipt with operation/version, viewer/scene/reload identity, task and operation IDs, status, requested references, verified exact references, current observation, warnings, provenance and verification level. Reads retain their domain data envelope; nested scientific metadata follows the existing public projection. Raw dataset endpoints and unapproved provenance remain withheld. Receipt state uses compact activity/place identity, clock/playback, tracked object, flight and camera pose/reference; it is a point-in-time observation, not another state store.

Statuses are `accepted`, `running`, `completed`, `refused`, `partial`, `cancelled` and `stale`. A flight completes only after its own observed `flightEnd`. Selection, activity, clock/playback and imagery writes read their existing semantic state back. Where the port has no semantic readback, a successful host return produces **partial / host-return**, with an explicit #297 warning, rather than claiming verified UI parity. Ask presents these as **unverified**, not succeeded. Camera poses use the port's existing km/reference-frame convention; no coordinates are transformed.

`onReceipt` reports accepted/running/final progress to the trusted host. Use the returned ID with `getOperationResult`; unknown/evicted IDs return null, never inferred success. Receipts survive scene reload as historical observations and retain their original scope; observations taken in a replacement scene are separately scoped. Reload invalidates tasks and described references, including hosts which mistakenly reuse scene IDs. A late model response cannot issue writes in the replacement scene. Manual camera takeover prevents further camera writes in the task; cancellation stops only that task's flight. Previous successful steps remain in place after a later failure. Nothing automatically replays writes or rolls back the view. A host's already-running asynchronous implementation must still honor its own scene/cancellation contract; the facade cannot undo arbitrary late side effects inside host code.

## Permissions and coverage

Read operations need no confirmation. Reversible viewer changes use the existing control ownership rules. Missing host methods and trusted `omitted` reasons appear in discovery. In an embed, `MountOptions.capabilities` supplies the policy to both `viewer.capabilities` and embedded Ask.

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

The fixed discovery schema reduces starting input by about 54% for Sonnet and 44% for GPT in this fixture. **Total input increased for both**, and Sonnet took more rounds, time and estimated cost. Discovery provides capability inspection and bounded schemas; this change does not establish overall inference savings. OpenAI reported `gpt-5.1-2025-11-13`, which has no exact reviewed price entry in the proxy, so no cost was guessed. Earlier experiments and the corrected state-based acceptance criterion are recorded in the receipt limitations.

Validation also passed 378 control/viewer/shell/proxy regression tests, the control suite's 169 tests after the final unknown-field hardening, package build and declaration checks, viewer/test/Svelte typechecks, lint and purity lint, the packaged consumer browser checks and 37 embedded-host checks. The broader package run passed 2,465 tests plus seven skips when excluding the separately checked GF reporting file. That unchanged file reproduced its existing timing failure at `packages/cspice-wasm/src/gf-reporting.test.ts:183` (23 other tests in that file passed); no GF code or expectation was changed.
