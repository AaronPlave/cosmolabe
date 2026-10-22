# Named target and navigation UX review

Addresses [review 6348083645](https://github.com/AaronPlave/cosmolabe/pull/274#issuecomment-6348083645).

A named navigation action now adds the exact place reference/name to the existing shared surface-target presentation. The HUD uses the name, with resolved coordinates/conventions in its tooltip. Terrain refinement preserves it. Generic coordinates and actual picked-surface targets continue to display coordinates; the camera and resolver remain #270's implementation.

Active camera targets and informational selection are distinct. HUD × and the geographic Escape layer call the same release action: clear the active target association/highlight, release the pivot to the tracked body center, and preserve camera position/time/body tracking. An independent inspected place survives target release. Closing place information keeps an active target, indicated by the HUD. Escape retains existing modal, text-entry, pointer-tool/probe/measurement priorities, stops a flight first, dismisses inspectors, then releases geographic context before broader camera reset. Scene unbinding clears the target.

There is one Navigate rail tool, with Places and Coordinates modes. Places searches names directly with a body filter, while global Cmd/Ctrl-K remains available. Coordinates retains #270's form, conventions and presets. The selected summary prioritizes name/body/type, explicitly planetographic coordinates with correct hemisphere formatting, approximate diameter and actions. About and Source & technical details start collapsed; source details remain selectable/copyable. Visibility/dataset controls live under Display → Geographic names. Existing panel dock/float/minimize and compact behavior are retained.

## Evidence

[Continuous browser recording](navigation/navigation.mp4) · [Acceptance results](navigation/results.json) · [Arena Colles named target](navigation/arena-named-target.png) · [390×844 compact navigation](navigation/navigate-compact.png) · [Named target on real terrain](navigation/named-terrain.png).

Chrome/Metal on Apple M4 Max, 1440×900 desktop recording, with a 390×844 compact viewport segment. The uninterrupted recording includes actual name double-click/Fly, HUD release, search/selection, sequential Escape during flight and inspector display, generic/different-name/picked-surface/body replacement, popover Escape, float/minimize/dock, keyboard search, southern hemisphere formatting, scene reload, and a real Moon terrain sequence. **Shackleton's target identity survived eight terrain revisions** and the final physical probe returned `terrain`. Both provenance sections were asserted closed by default.

The same non-terrain acceptance sequence passes locally on SwiftShader and is a CI gate. Full Gazetteer workflow and label-motion regressions also pass. 125 focused state/shell/geometry tests pass; build, all type checks, Svelte (zero warnings), lint and production bundling pass. The broader local suite passed 219 files / 2,592 tests with the unchanged CSPICE progress-throttle timing flake and seven skipped tests. Final exact-head CI is reported in the PR.

The previous run's Build & Test job passed, but terrain fixtures hit the job deadline while installing raster packages on the moving Ubuntu image. That fixture job is now pinned to Ubuntu 24.04, matching the browser job. This does not convert the cancelled run into a pass.

Reproduce with the viewer at port 5194:

```sh
CL_VIEWER_URL=http://127.0.0.1:5194/ CL_GPU=hardware CL_RECORD=1 CL_TERRAIN=1 node scripts/test-place-targets.mjs
```

Physical-phone and human acceptance remain unclaimed.
