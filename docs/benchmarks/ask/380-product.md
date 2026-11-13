# Ask discovery and investigation after product review

This report supersedes the guidance and final-case claims in [the earlier
review](379-review.md). Scientific source-boundary fixes and the original
Haiku/Sonnet comparison remain documented there. All implementation stays in
PR #380; no Research mode, second solver, planner or successor PR was added.

## What changed for the person using Ask

Opening “What can I do here?” now answers two questions in the compact panel.
Four short, capability-dependent actions explain the general scope: show views,
explain data, plot measurements and compare changes. A few scene-specific
choices follow. Existing results and visible profiles rank above presets;
selected/current activities, explicitly selected objects, finite source
coverage, current time and focus imagery determine relevance. Camera tracking
alone does not become an investigation. Choices are examples, not a complete
inventory of commands. Opening help makes local reads only; choosing fills the
editable composer and focuses it, without sending or moving the viewer.

The first expanded copy failed a developer comprehension walkthrough: the
person found too much robotic text, and would never write its generated
technical prompt. The revised Cassini choice is **“Cassini near Saturn”** and
fills **“How does Cassini’s distance from Saturn change? Show me.”** Other
starters use similarly short questions. ET bounds, native operation names and
scientific instructions remain internal evidence/guidance. This is a response
to observed comprehension friction, not a claim that an independent novice
study or a second approval of the final wording occurred.

The same shared scene read supplies ranked evidence to normal Ask requests.
The two unfamiliar-scene tasks use an identical open question, not a button or
mission-specific tool script: “I'm unfamiliar with this scene. Choose a question
the loaded data can answer, investigate it, and show me what you found.”

## Goal-level evidence

[Compact evidence](380-product-evidence.json) pins each case's actual runtime,
full camera/projection evidence, native results, answers, report hashes and
cost. The original frozen cases are unchanged. Two separately frozen product
cases add unfamiliar OEM and Clipper investigations. Individual observations
are not a statistical success rate.

| Case | Actual result and limit |
| --- | --- |
| OEM unfamiliar investigation | Chose Cassini–Saturn motion from loaded coverage, drew the native distance history, paused at its 12-sample minimum and showed Saturn/Cassini. The visible plot shows the approach/recession. Cassini is a point; the 4.4-hour sampled minimum is explicitly approximate, not a computed encounter or clearance. |
| Clipper unfamiliar investigation | Used the native search over loaded coverage, selected the 2031-10-23 Europa minimum (1,584.734 km center range), opened the native event lane and framed Europa/Clipper. The answer distinguishes range minimum from encounter classification and surface contact. The earlier independent point-state check agrees; kernel accuracy/classification remains unproven. |
| Earth–Moon continuity | Captured full before/after pose shows a real swing; ET and 5,211 km Moon range hold. The final screenshot shows a lit Moon limb and a separate Earth at upper left, outside Ask. Apparent diameters are 38.942° and 1.790°; the explanation separates apparent from physical size. The generic relative-action account still says unverified; independent pose/projection plus visual inspection establish this particular composition, rather than promoting that receipt to success. |
| OEM inbound/outbound | Both native range and signed-range-rate traces remain visible. The final answer distinguishes 32 covered range samples, two missing rate endpoints and 128 gaps on the wider 763-point display grid, with the actual intervals. Earlier cells needed a labeled host replacement in both models; the final model explanation improved, which does not establish that model composition is generally solved. |
| Clipper Europa/Ganymede | Both March queries are retained; Europa's smaller range is presented with matching clock/event/camera. Ganymede's roughly 442,173 km minimum is not renamed a flyby. |
| Two-date Earth imagery | Final rerun leaves the exact second epoch and Earth view, but explicitly cannot establish changed cloud/surface content. It reports that the second effective acquisition date was not confirmed, rather than inventing it. A truthful partial comparison. |
| Missing ice data | Explains that configured instruments and a base map do not supply ice-thickness measurements; full stable viewer state is unchanged. |

Screenshots were inspected as well as numerical state. The table uses actual
final case screenshots and independently captured render projections. Ask can
cover objects in some compositions; generic geometric in-frame evidence alone
is insufficient.

## Specific correctness repairs

Imagery facts retain every inspected epoch instead of discarding all but the
last body snapshot. Drawing at both dates does not establish changed content.
Checks reject positive cloud/content change and exclusive “only thing changed”
claims, including claims followed by a caveat in another clause. Tests include
two fully drawn dates. No image-analysis framework or visual-change fact is
invented. Acquisition dates, request state, drawing and baked illumination
remain separate evidence. This remains a bounded language check, not a general
natural-language truth engine.

Camera reads now publish horizontal field of view, viewport aspect, projected
coordinates and both apparent radius/diameter. This prevents using vertical
FOV as a horizontal cutoff or confusing radius with diameter. Guidance avoids
mixing an active animated relative move with an instantaneous composition.
Final framing claims are checked against the latest viewer goal evidence;
an intermediate failed move does not establish the final object is invisible.

History facts distinguish each sampled quantity's gaps from the native plot's
interval/gaps, including intentionally clipped profiles. A safe replacement
retains closing/opening and both counts. Output-limit stops can show measured
facts instead of an empty reply, with a visible explanation that the model
stopped and the host account is shown. The original failure status remains;
a host summary does not certify completion of the requested view.

## External research decision

**Not yet warranted for this slice.** The demonstrated obstacles are native
composition and factual/source handling, or absent scientific inputs. Public
mission documentation would not repair an OEM coverage boundary, put Earth
in frame, measure wind, supply ice thickness or register hull/particle contact
geometry. The existing numerical and scene sources can answer the two
exploratory questions without retrieval. No concrete task demonstrated added
value from a documentation prototype, so no external retrieval or arbitrary
execution surface ships. A future user-invoked contextual question could
justify narrowly cited public retrieval; it must not silently export private
scene data or become numerical evidence.

The help tells the person: “Ask uses the data loaded here. Missing measurements
stay unknown; mission background cannot fill them in.” This keeps external
background separate from authoritative scene facts without exposing a new mode.

## Validation and reproduction

Focused package/benchmark/Ask-session checks passed (429 tests before the final
imagery-only clause regression; its focused suite passes 53). The earlier full
viewer run passed 857 tests. Package build, test/viewer/Svelte typechecks,
lint, purity and diff checks pass. Four loaded catalogs verify short-prompt
prefill/focus, no provider calls or viewer mutation on help, actual OEM source
endpoints and display-only holding, and Stop rejecting a late mutation. CI at
the final remote head is reported on the PR.

Five original regression cases and two unfamiliar-scene cases ran at
`dba5081b`. The imagery-only exclusive-claim guard was tightened afterward;
that affected frozen case was rerun at `9fe937bc`. A final correction limits
plot observations to mounted rows and clarifies display-grid counts and
intentional clipping; the focused regression suite passes at that source.
The evidence records per-case revisions and the final production fingerprint.
All new provider cells use fixed Haiku with no model fallback; the earlier
matched Haiku/Sonnet comparison remains evidence of fallback limitations.
Cumulative estimated cost, including the original assessment and every
rerun, is recorded in the evidence and remains below the approved $2 cap.
Actual billing is unavailable. Browser rendering uses software WebGL.

```sh
ASK_GUIDANCE_EVIDENCE=/tmp/ask-help node scripts/test-ask-guidance.mjs
ASK_BENCHMARK_LIVE=1 ASK_BENCHMARK_SUITE=product ASK_BENCHMARK_MODELS=claude-haiku-5-5 ASK_BENCHMARK_MAX_USD=0.30 node scripts/benchmark-ask.mjs
ASK_BENCHMARK_LIVE=1 ASK_BENCHMARK_SUITE=exploration ASK_BENCHMARK_CASES=em-context,iss-appearance,oem-compare,clipper-compare,clipper-science ASK_BENCHMARK_MODELS=claude-haiku-5-5 ASK_BENCHMARK_MAX_USD=0.30 node scripts/benchmark-ask.mjs
```

Use the dedicated checkout server/catalog URL documented in the earlier report.
Keep aggregate authorization across invocations; a sub-cap is not new approval.
