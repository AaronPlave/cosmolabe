# ISS articulation and live telemetry (#370, #371)

**Extraction note.** This directory is mission-specific and is meant to move
out of the core viewer into the ISS mission plugin. Until then it is kept
self-contained on purpose: it imports only public package APIs
(`@cosmolabe/core`, `@cosmolabe/three`, `three`), nothing from the viewer's own
`lib/`, and **no viewer code references it** (no loader, catalog schema or UI
change). To move it, copy this directory; nothing else needs to change.
`browser-check.mjs` shows how a host registers it (`renderer.use(plugin)`).

## What is here

| Path | Purpose |
| --- | --- |
| `joints.ts` | Joint names, model-local axis conventions, the Sun-tracking math (pure) |
| `rig.ts` | Finds and verifies the real glTF joint nodes; applies/restores angles |
| `plugin.ts` | Renderer plugin: Sun-tracking approximation, observed-source seam, info readout |
| `live/assembler.ts` | Coherent, timestamped, fresh sample assembly; counts rejections |
| `live/frames.ts` | LVLH, quaternion composition, the model-to-body axis rotation |
| `live/orbit.ts` | TLE parsing, validity window, CelesTrak fetch |
| `live/transport.ts` | Transport seam, replay transport, Lightstreamer adapter (client injected) |
| `live/channels.ts` | Observed ISS Live item mapping, timestamp parser, ready-made configs |
| `live/source.ts` | `MissionStateSource` + joint source + status |
| `__fixtures__/`, `live/__fixtures__/` | Node-tree extract of the real model; TLE; synthetic replay |
| `browser-check.mjs` | Real-browser check against the `iss` catalog |
| `live-smoke.mjs` | Optional real-provider smoke (network; not CI) |
| `extract-node-tree.mjs` | Regenerates the node-tree fixture from the real glb |

## #370: the model, as inspected (`ISS_stationary.glb`, NASA ISS 3D model)

Read from the glb's node tree, not assumed from names (`extract-node-tree.mjs`
regenerates the fixture; `real-model.test.ts` runs against the actual file when the LFS asset is present):

- Local axes: +Z forward (Harmony at +Z, Zvezda at -Z), +Y zenith (S0 truss up, Cupola down), +X port.
- `S4 Truss`, `P4 Truss`: outboard trusses with a baked **60 degree rest rotation about X**; they carry S5/S6 (P5/P6) and the arrays. Joint = rotation about X.
- `S4/S6/P4/P6 Truss_01/_02`: eight array wings. Geometry 12 m (X) x 1.3 m (Y) x 37 m (Z), pivot at the root of the Z axis. Joint = rotation about Z; the array normal is local +Y.
- `S1/P1 Truss_02` (radiators) are **not** driven: their long axis is Y, so the Z rotation used by the Takram example is not their joint.

The rig re-checks these at attach time (rest rotation axis, pivot/long axis, parent frame alignment) and disables only articulation with a one-line diagnostic if a model differs.

The approximation is a pure function of the current Sun direction in model axes: no smoothing, no history,
so seeks and reverse playback give identical poses. It is labelled **"Approximate Sun tracking (not recorded ISS array positions)"**.

The truss angle is an absolute rotation about X relative to the unrotated parent; whether the 60 degrees baked into the file corresponds to a particular SARJ telemetry value is **not known** (`offsetsRad` in `JointChannels` is where that goes once confirmed).

## #371: live channels, and what is and is not confirmed

Checked from a networked machine on 2026-11-09 (`probe` via Playwright + `lightstreamer-client-web`; `live-smoke.mjs` is the repeatable form).
The mapping lives in `live/channels.ts`.

| Item | Status |
| --- | --- |
| `https://push.lightstreamer.com`, adapter `ISSLIVE`, MERGE, fields `TimeStamp`/`Value`/`Status.Class` | **Observed working** from a normal browser (WS-STREAMING, CORS fine) |
| Attitude `USLAB000018..21` | **Observed.** Names from the community ISS-Mimic table: `USGNC_PS_Pointing_LVLH_Att_Quatrn_0..3`; `USLAB000017` reads "LVLH". `_0` ~ 1.0 so scalar-first. Reference = LVLH is therefore supported; **direction (A to B) is not stated and not confirmed** |
| SARJ `S0000004` (port) / `S0000003` (starboard); BGAs `S4000007/8`, `S6000008/7`, `P4000007/8`, `P6000008/7` | **Observed** delivering degrees (0-360, SARJ values mirrored: 69.06 / 290.98). IDs from ISS-Mimic, **not NASA definitions**. Which wing of a truss is the model's `_01` vs `_02`, the rotation sign per side and the zero offset are **not established** (`CANDIDATE_JOINT_ITEMS`), so joints are opt-in |
| `TimeStamp` | Fractional hours since 00:00 UTC 31 Dec of the previous year (1 Jan 00:00 = 24.0), per ISS-Mimic's freshness test. **Not confirmed against a ticking feed** (see below) |
| `Status.Class` | `24` on every observed item; ISS-Mimic treats 24 as good. Anything else is refused |
| CelesTrak GP TLE (NORAD 25544) | **Observed**: HTTP 200, `access-control-allow-origin: *`, parses and passes checksum. `live.celestrak.org` did not resolve |
| Provider usage conditions / rate | Not reviewed; the transport asks for the feed's own rate only |

**The feed was frozen when tested.** Every item carried an old stamp (about 05:04 UTC, nine or more hours before
the 14:0x UTC probes) and none updated in 60 s, though the connection was healthy (`TIME_000001` too). The adapter refused all of them as `stale` and reported
`unavailable`, which is the intended behaviour, but it means a pose from the real feed has **not** been seen end to end,
and the quaternion direction, the timestamp epoch (the calibrated clock string and the stamp disagree by a day, so the
convention above is a hypothesis) and the joint signs/offsets remain open.

To finish validation when the feed is ticking: run `live-smoke.mjs` (expects `LIVE`), compare `TimeStamp` with wall-clock UTC
to settle the epoch, compare the composed attitude and joint angles with an independent reference (the JSC ISS OEM
or imagery), and only then set `verification: 'verified'`.

### What is verified here (offline)

- Coherent assembly: partial frames, duplicates, out-of-order, stale and future values, reconnect snapshots (`assembler.test.ts`, `replay.test.ts`).
- LVLH and composition against hand-computed vector cases, direction/ordering handling (`frames.test.ts`). This checks the maths, not that the real feed uses this convention.
- Orbit: TLE checksum/NORAD/epoch parsing and a symmetric validity window (default 3 days); no extrapolation beyond it (`orbit.test.ts`).
- End to end through `MissionStateManager` with the SGP4 position at the *same* source epoch as the attitude (`source.test.ts`): live, stale, disconnected, unavailable; no value before the feed's own start (a historical clock reads `before-coverage`); removal stops the transport.
- Joints reach the rig only within seconds of the simulation time and while fresh and connected, otherwise the arrays sit at the authored pose and the readout says unavailable; the approximation never stands in (`plugin.test.ts`, `source.test.ts`).

### Wiring (host)

```ts
const feed = createLiveIssFeed({
  config: issLiveConfig(),                          // add { joints } only after validating CANDIDATE_JOINT_ITEMS
  transport: lightstreamerTransport(await import('lightstreamer-client-web'), issLiveTransportConfig()),
});
feed.setOrbit(await fetchCelestrakIss(fetch));
missionState.addSource(feed.source);               // catalog: trajectory/rotationModel { type: 'MissionState', source: 'ISS-LIVE' }
plugin.setJointSource('ISS', feed.jointSource);    // only for the body that should receive the feed
```

Only a catalog that names the `ISS-LIVE` source in a `MissionState` model receives the position/attitude. A scene
that does not is unaffected, and removing the source (catalog unload) stops the transport.

## Not done / open

- Real-feed validation against a *ticking* feed (above).
- A **Live ISS on/off** control and compact status in the viewer UI, and a live catalog that binds `ISS-LIVE` (kept out of the core viewer by design; belongs to the plugin).
- `ISS_MODEL_TO_BODY` (`live/frames.ts`) is the model-to-body rotation implied by the inspected axes
  (quaternion `[0.5, -0.5, 0.5, -0.5]`). The public `iss` catalog's `meshRotation [0,1,0,0]` is a different, visual-only offset;
  a live-attitude catalog must use the derived one. Not confirmed against a known real attitude sample.
- Takram's formulas were used as the idea only; the derivation is in `joints.ts`.
