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
| `live/source.ts` | `MissionStateSource` + joint source + status |
| `__fixtures__/`, `live/__fixtures__/` | Node-tree extract of the real model; TLE; synthetic replay |
| `browser-check.mjs` | Real-browser check against the `iss` catalog |
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

Network access to `push.lightstreamer.com` and `live.celestrak.org` was **not available** where this was written,
so **no real telemetry has been observed**. Everything about the real feed below is therefore unconfirmed:

| Item | Status |
| --- | --- |
| Server `https://push.lightstreamer.com`, adapter set `ISSLIVE`, MERGE mode, fields `Value`/`TimeStamp` | From the earlier prototype (`apps/cesium-viewer/src/iss-live.ts`); **unconfirmed** |
| Attitude items `USLAB000018..21` as q0..q3 | From the prototype; **unconfirmed**, including component order |
| Quaternion frame (LVLH vs J2000), direction (A to B), sign convention | **Unconfirmed.** Stated explicitly in `LiveIssConfig.attitude`, with `verification: 'unverified'` echoed in status/provenance |
| `TimeStamp` format and epoch | **Unconfirmed.** `parseSourceTime` is a required argument with no default |
| SARJ alpha and the eight BGA beta item IDs, units, sign, zero offset | **Unknown. No IDs are shipped.** Joints stay `unavailable` until a host supplies a validated `JointChannels` |
| Provider usage conditions and update rate | Not reviewed |

To validate (needs a normal browser): subscribe to the candidate items; confirm names/values against NASA's field
definitions; check `TimeStamp` against wall-clock UTC; check the attitude against an independent reference
(for example the JSC ISS OEM/attitude products) for several instants; only then set `verification: 'verified'`.

### What is verified here (offline)

- Coherent assembly: partial frames, duplicates, out-of-order, stale and future values, reconnect snapshots (`assembler.test.ts`, `replay.test.ts`).
- LVLH and composition against hand-computed vector cases, direction/ordering handling (`frames.test.ts`). This checks the maths, not that the real feed uses this convention.
- Orbit: TLE checksum/NORAD/epoch parsing and a symmetric validity window (default 3 days); no extrapolation beyond it (`orbit.test.ts`).
- End to end through `MissionStateManager` with the SGP4 position at the *same* source epoch as the attitude (`source.test.ts`): live, stale, disconnected, unavailable; no value before the feed's own start (a historical clock reads `before-coverage`); removal stops the transport.
- Joints reach the rig only within seconds of the simulation time and while fresh and connected, otherwise the arrays sit at the authored pose and the readout says unavailable; the approximation never stands in (`plugin.test.ts`, `source.test.ts`).

### Wiring (host)

```ts
const feed = createLiveIssFeed({ config, transport: lightstreamerTransport(await import('lightstreamer-client-web'), lsConfig) });
feed.setOrbit(await fetchCelestrakIss(fetch));
missionState.addSource(feed.source);               // catalog: trajectory/rotationModel { type: 'MissionState', source: 'ISS-LIVE' }
plugin.setJointSource('ISS', feed.jointSource);    // only for the body that should receive the feed
```

Only a catalog that names the `ISS-LIVE` source in a `MissionState` model receives the position/attitude. A scene
that does not is unaffected, and removing the source (catalog unload) stops the transport.

## Not done / open

- Real-feed validation (above) and the optional real-provider smoke test.
- A **Live ISS on/off** control and compact status in the viewer UI, and a live catalog that binds `ISS-LIVE` (kept out of the core viewer by design; belongs to the plugin).
- `ISS_MODEL_TO_BODY` (`live/frames.ts`) is the model-to-body rotation implied by the inspected axes
  (quaternion `[0.5, -0.5, 0.5, -0.5]`). The public `iss` catalog's `meshRotation [0,1,0,0]` is a different, visual-only offset;
  a live-attitude catalog must use the derived one. Not confirmed against a known real attitude sample.
- Takram's formulas were used as the idea only; the derivation is in `joints.ts`.
