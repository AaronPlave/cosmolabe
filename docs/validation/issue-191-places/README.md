# Named-place validation evidence

This directory keeps concise findings, compact results and selected screenshots for PR #274 / #191. Generated frame traces, temporary diagnostics, duplicate captures and recordings are not committed. This cleanup changes no runtime code, catalogs, fixtures, tests or CI behavior.

## Evidence index

- [Labels, motion and terrain findings](label-review.md), including [summarized hardware/SwiftShader motion](label-motion-review/summary.json).
- [Navigate, inspector, sources and mission findings](navigation-review.md), including [inspector results](final-framing/results.json), [shared navigation results](final-framing/navigation-results.json) and [six-scene results](inspector-missions/mission-results.json).
- [Initial importer summary](import-summary.json): catalog-relative, HTTPS/CORS, flat multi-file/directory loading and diagnostic optional failures. These historical measurements precede subsequent label-policy changes.

The original import loaded **11,139** places (11,138 USGS records plus one explicitly synthetic user site), without importer skips. Initial geographic import took **479.5 ms** within the shared 15-second deadline; index construction took **24.8 ms**. Initial JS heap was **92.7 MiB**, including viewer and imported records, not isolated retained or GPU memory. Worker timings include startup, parsing and structured cloning. Cross-origin HTTPS used a temporary local TLS fixture, not a public deployment.

## CI evidence

[CI run 40026754690](https://github.com/AaronPlave/cosmolabe/actions/runs/40026754690) passed all five jobs at `43db339e39b549fa6f2b0f23c317b04f07feebbe`: full fast checks, changed-path detection, terrain fixtures, StarField and geographic/Places acceptance. The [geographic job log](https://github.com/AaronPlave/cosmolabe/actions/runs/40026754690/job/120664845214) confirms inspector/source/framing completed before label-motion, both with no browser errors. Its [uploaded artifact](https://github.com/AaronPlave/cosmolabe/actions/runs/40026754690/artifacts/12533346911) contains the full CI traces and captures.

Artifacts have finite retention. Regenerate them with the commands below when expired; historical local hardware recordings were removed rather than represented as permanent hosted evidence. The committed summaries preserve findings, not every original frame. Later cleanup-head check results are recorded on the PR.

## Reproduce

The scripts, fixtures, assertions, thresholds and existing CI output paths are unchanged. From the repository root, start the ordinary viewer:

```sh
DEV_DATA_MODE=local npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5194 --strictPort
```

In another shell, write full raw output to the ignored working directory:

```sh
export CL_VIEWER_URL=http://127.0.0.1:5194/
export CL_SMOKE=1
CL_OUTPUT=work/issue-191-places/import node scripts/test-planetary-places.mjs
CL_OUTPUT=work/issue-191-places/inspector node scripts/test-place-inspector.mjs
CL_OUTPUT=work/issue-191-places/motion node scripts/test-place-label-motion.mjs
CL_OUTPUT=work/issue-191-places/navigation node scripts/test-place-targets.mjs
```

For full physical-GPU motion and video on macOS with Chrome installed:

```sh
env -u CL_SMOKE CL_VIEWER_URL=http://127.0.0.1:5194/ CL_GPU=hardware CL_RECORD=1 CL_OUTPUT=work/issue-191-places/motion-metal node scripts/test-place-label-motion.mjs
```

That command unsets `CL_SMOKE` for the full 240 orbit / 180 sweep / 20 FOV samples. SwiftShader PR smoke uses 90 / 60 / 6 samples of the same complete path.

Local terrain and mission acceptance require the existing scene assets/terrain pyramids:

```sh
CL_VIEWER_URL=http://127.0.0.1:5194/ CL_GPU=hardware CL_OUTPUT=work/issue-191-places/terrain node scripts/test-place-label-terrain.mjs
CL_VIEWER_URL=http://127.0.0.1:5194/ CL_GPU=hardware CL_RECORD=1 CL_OUTPUT=work/issue-191-places/missions node scripts/test-place-mission-scenes.mjs
```

The shared CI harness is `bash scripts/ci/run-viewer-smoke.sh geographic pr` (or `full`), which starts its own server on port 5188 and uploads `/tmp` results through the existing workflows. Do not start a second server on that port. Hardware video and expensive mission/terrain sequences remain local/manual acceptance; they are not newly added PR gates.

Only deliberately selected screenshots and compact summaries belong here. Keep complete generated output in `work/issue-191-places/` or `/tmp`; do not copy capture directories wholesale into documentation. Source Gazetteers, mission catalogs, fixtures and test goldens are outside these ignore rules. Physical-phone and independent human acceptance remain unclaimed.
