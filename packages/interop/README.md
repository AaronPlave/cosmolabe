# @cosmolabe/interop

Standard-format ingest and export for analysis products: CCSDS message parsing
and writing (OEM, CDM, AEM) plus CSV and CZML serialization. Pure and headless
string transforms with no rendering or SPICE dependency. Part of the core layer.
Harvested from bessel; see the repository NOTICE.

Not included: CCSDS **OMM** parsing. Upstream it lives in bessel's propagator
package, next to the TLE ingest it feeds, and that package was not harvested —
this tree's TLE path is satellite.js inside `@cosmolabe/core`. Adding OMM here
would be the natural home for it if a need appears.

## Public API

OEM (CCSDS Orbit Ephemeris Message, KVN):

- `parseOem(text): Oem`, `writeOem(oem): string` (round-trips version, metadata, states)
- `OemError`, types `Oem`, `OemMetadata`, `OemState`

CDM (CCSDS Conjunction Data Message, KVN):

- `parseCdm(text): Cdm` extracts TCA, miss distance (m), relative speed (m/s),
  and the two object designators; the inputs a Pc screen needs
- `CdmError`, types `Cdm`, `CdmObject`

AEM (CCSDS Attitude Ephemeris Message, KVN):

- `parseAem(text): Aem` reads the metadata and quaternion attitude records,
  normalizing each quaternion to scalar-first `[w, x, y, z]` (the QUATERNION
  attitude type; closes the MONTE attitude-interchange seam, ADR-0012)
- `writeAem(aem): string` serializes a quaternion attitude history back to KVN,
  scalar-first (`QUATERNION_TYPE = FIRST`), so `parseAem(writeAem(aem))` round-trips
  the metadata and quaternions. This is the portable attitude read/write path used in
  place of native CK-binary IO (deferred until the `ck*` CSPICE-WASM exports land);
  pair it with `@cosmolabe/frames`' `orientation(body, frame, epochs)` for a
  pxform-style body-orientation query (upstream this pointed at bessel's
  attitude package, which was not harvested).
- `AemError`, types `Aem`, `AemMetadata`, `AemRecord`

CSV export (RFC 4180, with formula-injection neutralization):

- `seriesToCsv(et, columns, names, opts?)` for a column time series
- `intervalsToCsv(intervals, opts?)` for access/eclipse windows (adds duration_s)
- types `SeriesCsvOptions`, `IntervalsCsvOptions`

CZML export (Cesium/CZML 1.0):

- `intervalsToCzml(name, intervals)` emits an availability document
- `groundTrackToCzml(name, samples)` emits a time-tagged cartographicDegrees path
- types `IsoInterval`, `GroundSample`

```ts
import { parseOem, writeOem, parseCdm, seriesToCsv } from '@cosmolabe/interop';

const oem = parseOem(text);          // OemError on a malformed message
const back = writeOem(oem);          // round-trippable KVN
const csv = seriesToCsv(et, [alt], ['altitude_km']);
```

## Dependency rule

Depends on: nothing at runtime. Pure string and array transforms — no SPICE, no
renderer; epoch-to-ET conversion is the caller's concern. `@cosmolabe/frames` and
`cspice-wasm` are devDependencies only, used by the CCSDS round-trip suite to
generate real engine states to push through the writers and read back.

Upstream also exported `oemToProduct`, which turned a parsed OEM into an
`AnalysisProduct`. That adapter is not harvested: it types against the compute
plane's product schema, which is deferred. In this tree, ingest lands as core's
`OEMTrajectory` — a catalog points at an OEM and gets a renderable trajectory.

## Tests

Tests live in `packages/interop/src/*.test.ts` (oem, oem-write, aem, aem-write, cdm,
csv, czml). `aem-write.test.ts` round-trips a constructed attitude profile through
`parseAem`/`writeAem`, recovering the scalar-first quaternions within tolerance.
The real-data fixture `oem-fixture.test.ts` parses and round-trips the canonical
CCSDS 502.0-B OEM example (Mars Global Surveyor) from
`packages/interop/test-fixtures/mgs.oem`, asserting metadata and state vectors
against the published message values.

## Algorithm and references

- OEM, CDM, and AEM follow the CCSDS Key-Value Notation (KVN) message grammars;
  see REFERENCES.md: CCSDS 502.0-B (Orbit Data Messages) for OEM, CCSDS 508.0-B
  (Conjunction Data Message) for CDM, CCSDS 504.0-B (Attitude Data Messages) for AEM.
- CZML output targets the Cesium interchange schema (CZML 1.0); see REFERENCES.md.
- CSV follows RFC 4180 quoting.

## Status / limitations

OEM parsing reads the metadata block and position/velocity state lines, ignoring
acceleration columns and COMMENT lines; CDM parsing extracts the relative-state
summary and designators rather than the full covariance. CZML export covers
availability windows and ground-track paths only.
