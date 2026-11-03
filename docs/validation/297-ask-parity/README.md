# Default Ask access to #297 controls

PR #334 uses the same capability adapter in ordinary Fixed Ask and development
Discovery Ask. Fixed offers four small direct read schemas plus the four registry tools.
The invocation tool includes a compact index of all operation IDs. Schema
hydration/validation is automatic; prior list/describe calls are optional.
Malformed input returns the exact expected schema for immediate correction.
The compact index includes required and optional parameter names. A failed
ordered model batch stops later changes until replanning, while reads remain
available and native cancellation/scene ownership still apply. There is no second mutation
allowlist, solver, editor or script evaluator. The generated
[capability matrix](capability-matrix.json) records each script, typed method,
capability ID, default Ask route and effect/permission class, alongside explicit
trusted-host projections and transport exclusions.

`getEventSearchOptions` reads the built-in registry and the same loaded-kernel
coverage assessment as Event Finder. It suggests only a coverage/catalog overlap;
the catalog interval alone does not prove coverage. Search definitions use the
existing saved-query model: Ask requests exact-call UI approval before creating
one, and the definition remains in session snapshots. Searches and result focus
reuse native Event Finder. Results are restricted to the searched interval and
loaded kernels, and step size limits completeness. Model result pages default to
one event, allow up to five, and preserve `nextOffset` rather than increasing every
provider result budget. Timeline/native-draw readiness retains its explicit
partial-state and no-unoccluded-pixels limits.

Read/navigation/display operations run directly. Persistent definitions and edits
open an approval card in the ordinary Ask panel; export/recording opens a separate
external-action card. Each card shows the exact operation and input and approves
only that call. Decline, Stop, panel close, scene change, supersession and host
policy replacement cannot reuse an earlier approval. Embedded hosts retain their
own policy and confirmation callbacks. After a readiness wait has been requested,
exports cannot bypass its failure; readiness is checked again after export
approval to catch a changed scene/time/view.

Measurement reads project semantic participants and approved frames without
free-form labels, resource locations or terrain-source metadata. A rendered surface
anchor is not evidence of physical terrain clearance. Geographic reads retain
stable feature/source IDs and type/count while withholding unapproved imported
properties. Synthetic instrument pointing remains separate from calibrated data.
Raw snapshots, portable local resources and arbitrary file/network exports remain
trusted-host operations; the matrix states these exclusions. Ask can use the
supported saved-view and approved state-restore operations.

Validation:

- Control: 13 files / 191 tests; viewer: 54 files / 737 tests.
  Proxy: 3 files / 34 deterministic tests, including budget/rate counters and
  unknown/Haiku prompt-length pricing.
- Tests cover default/discovery routing, every registered verb and every port
  method, host omissions/revocation, exact-call approve/decline/Stop, private
  metadata, bounded event pages, failed-wait export refusal and freshness changes
  during export approval.
- Configured type checks and Svelte checks, production and embed/declaration
  builds, changed-file lint, purity and diff checks pass.
- Provider-backed evidence is recorded in [acceptance.json](acceptance.json).
  Public test fixtures only; no user catalog or credentials are recorded.

Reproduce the machine matrix after `npm run build`:

```sh
node scripts/check-ask-capability-coverage.mjs
# Intentionally update it after registry changes:
node scripts/check-ask-capability-coverage.mjs --write
```

Live tests require explicit paid-inference authorization and a configured key.
Start a dedicated viewer with `VITE_ASK_ENDPOINT=http://127.0.0.1:8798`, then:

```sh
ASK_MISSION_LIVE=1 CL_VIEWER_URL=http://127.0.0.1:5797/ \
  node scripts/test-ask-modern-scene.mjs
```

Each case uses a fresh ordinary scene and the real Ask panel, model planner and
HTTP transport. The harness approves only actions on its public synthetic/test
fixtures through the visible approval card. It checks call-ID-matched provider
payloads, tool trace, public viewer readback and actual downloaded PNGs. Fixed
uses no mode URL flag. Discovery uses the development override. Complete raw
reports/images stay in `/tmp`; only compact evidence is committed. Costs are proxy
estimates with uncontrolled cache warmth, not billing or a broad #332 benchmark.
The trace records per-request uncached input, cache reads/writes, output, schema
bytes, tool calls/refusals and final state. Model transport omits repeated generic
camera observations from unrelated domain receipts; full typed receipts remain
available through `getOperationResult`, and final scene/camera observations remain
model-visible. Writes are never replayed automatically. Budget failures pause the
conversation; rate failures enforce a local cooldown. Both retain the action list
and state accounting without suggesting raw budget-knob changes.

The review's Haiku failure trace processed 245,856 cumulative tokens over eight
rounds without an answer. A fresh final default-Ask run of the exact same prompt
completed in six calls and 60,520 raw processed tokens under a 150,000-token
process cap, with no description-gate refusal. This is a single release smoke,
not a controlled model benchmark. The earlier supplied trace is not attributed to
a verified remote build. The observed estimate was $0.00321179; it is not billing.
Haiku rates and its >100,000-token *per-request prompt* tier were checked against
[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) on
2026-11-02. Cumulative process tokens do not select the long-context price tier.
Current remote-head CI remains required before merge.

The additional semantic-point review is covered by [spatial-points.md](spatial-points.md) and [compact live evidence](spatial-acceptance.json). The generated matrix now covers 107 operations. The final expanded-catalog Haiku smoke completed in 12 calls / 166,692 tokens with four corrected schema/coverage refusals; the earlier six-call result above is historical evidence, not a fixed token or round guarantee.

The latest [acceptance corrections](review-followup.md) supersede the initial two-point and palette-only checks. Current evidence covers immediate natural follow-up selection without duplicates, equivalent Fixed/Discovery elevation mode, complete-candidate range ranking, and reusable native encounter presentation for Voyager/Jupiter and Cassini/Mimas. The registry now contains 108 operations.
