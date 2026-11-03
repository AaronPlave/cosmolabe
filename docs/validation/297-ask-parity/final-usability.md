# Final usability review (#334)

This pass addresses [the November 3 manual UI review](https://github.com/AaronPlave/cosmolabe/pull/334#issuecomment-6595716446).

- Renderer unload clears body inspection with a selection notification, together
  with the old probe pin, instrument choice and scene note. Existing geographic,
  measurement and event unload handlers retain ownership of their state. Probe
  mode and within-scene selection behavior are preserved.
- Selecting an authored geographic feature verifies its exact selected reference,
  resolves the owning layer's body, and returns its body-scoped native drawing
  observation through the public metadata projection. A ground point under
  Ingenuity is checked on Mars. Missing drawing is distinguished from failed
  selection; no pixel visibility is inferred from group counts. The existing
  geographic selection action reveals hidden layers through the normal renderer.
- Event Finder configuration still changes saved scene definitions and retains
  exact-call authoring approval. Ask presents participants, dates and the scene
  change in plain words. Its secondary parameter view decodes the definition for
  inspection; approval remains bound to the original exact arguments. No new
  search lifecycle, solver or agent-only computational query was introduced.
- The answer leads; a quiet status opens action details. Capability lookup counts,
  raw errors and partial receipts stay in diagnostics. Newly exposed action names
  come from existing registry help, rather than another UI action-name list.
- Event hover measurements now include their metric label, distinguishing altitude
  from range. The persistent scene encounter callout is a compact anchor; the
  inspector owns numerical detail. Callout background contrast is stronger.
  Distant unresolved body representation remains [#337](https://github.com/AaronPlave/cosmolabe/issues/337);
  this change does not enlarge physical bodies or add another marker subsystem.

## Loaded browser acceptance

The ordinary viewer at an owned port 5797 was checked with Chrome on Apple M4 Max
(ANGLE Metal). Cassini → Ingenuity removed the old Mimas info panel, emitted a
null selection, and allowed a new Mars selection. Screenshots were inspected.
This tests scene selection lifecycle, not terrain readiness or accuracy.

Real default Fixed Ask/provider checks retain the literal Voyager and Cassini
prompts and independently verify result reference, paused epoch, ranked result,
tracked target, camera pose and projected composition. Both passed in six model
calls. These searches used deepest-only scope; their one result is not a census
of local minima. The existing deterministic multiple-minima regression and earlier
484-candidate acceptance remain intact. The actual approval and final answer
screenshots were inspected; exact parameters and diagnostics remain collapsed.

The natural Ingenuity follow-up is tested without a third coaching prompt or a
second point. Selection receipts must report Mars and the selected layer's native
drawing group, with call-ID-matched delivery to the provider. A first harness
assertion incorrectly required a separate explicit spatial read in addition to
that receipt; it was corrected to accept the already-delivered native readback.

Replay (live provider runs require the existing explicit opt-in):

```sh
node scripts/test-ask-review-ui.mjs
ASK_MISSION_LIVE=1 ASK_SCENARIOS=voyager,cassini ASK_MODES=fixed node scripts/test-ask-modern-scene.mjs
ASK_MISSION_LIVE=1 ASK_SPATIAL_CASE=ground-pin node scripts/test-ask-spatial-points.mjs
```

Compact current observations are in `final-usability.json`; full provider payloads
remain outside the repository. Provider cost estimates are not billing. Native
projected centers and enabled draw groups do not establish unoccluded pixels.
Current-head CI remains required before merge. No merge or deployment is part of
this pass.

Validation: 56 viewer files / 757 tests, 14 control files / 195 tests and
7 native EventCallout tests pass. All configured type/Svelte checks (zero
warnings), changed-file ESLint, purity, 108-operation coverage, production and
embed/declaration builds pass.

Screenshot inspection also caught an inaccurate model inference that an absent
feature name meant its label might not have saved: the label is visibly present
but withheld by the public metadata projection. The feature-read summary now
explains that distinction; the metadata regression preserves the privacy boundary.
An extra paid repeat after that small summary correction did not execute: automatic
approval review returned a model-capacity error twice. The successful native
point/selection/drawing run above precedes that final wording change.
