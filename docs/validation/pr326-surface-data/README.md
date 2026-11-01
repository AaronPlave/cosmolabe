# PR #326 surface-data acceptance

2026-10-31, Chrome headless with hardware ANGLE/Metal on Apple M4 Max. The actual MoonFall catalog loaded through the development asset fallback. No catalog coordinates, frame declarations or scientific source metadata were changed.

The Ask panel received “Show the Shackleton landing area and explain which surface datasets are available” through its input and Send button, using the example proxy and real Anthropic `claude-sonnet-5-5`. The proxy reported the same model for all four rounds. `receipt.json` records the actual tool trace, inventory, selected place, final answer and proxy usage; screenshots show the answer at 1440×1000 and 390×844. No page errors occurred. The compact screenshot checks answer layout after resizing, not a separate mobile model run.

Observed results:

- The model searched both “Shackleton” and “landing”, discovered the crater and overview as separate candidates, and navigated to `moon:mission:moonfall-sites/psr-landing`. It explicitly described this waypoint as fictional, not an observed landing.
- `getSurfaceData` reported the LOLA terrain identity/revision, declared `MOON_ME_DE421` frame and radial/reference-sphere datum; LROC WAC/NAC imagery identity, revision, attribution and declared cube layout; and base/normal/displacement textures. There were zero independently managed overlays.
- The answer named terrain and cube imagery despite zero overlays, reported their observed residency/drawing, and kept texture loading and complete view coverage unknown. It was 133 words; the prompt's 90-word preference is guidance, not enforced truncation.
- A separate browser run returned HTTP 404 for the cube-imagery manifest. The product remained configured while `ready` and `loaded` were false, `manifestFailed` was true, and drawing/coverage did not claim success. This deliberately produced one resource-404 console error, with no page exception. That failure case used the control directly, not a second model conversation.

`coversDrawnTiles` describes mandatory-base imagery over drawn terrain blocks only. It cannot establish complete view coverage when geometry may be missing. Static texture residency is not currently exposed by the renderer. Cube layout and the body's frame are reported separately without inferring a registration transform or accuracy.

Validation: build, embed build, viewer/test/Svelte typechecks, changed-file eslint and diff checks passed. The focused control, Ask, viewer-control and cube-imagery suites passed 252 tests; the proxy's scripted-provider suites passed 29 tests, including prompt-cache markers and separate read/write token accounting. Proxy tests require local socket permission in the sandbox. Full repository tests were not run for this focused change.
