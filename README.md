# @bessel/interop

Standard-format ingest and export for analysis products: CCSDS message parsing
and writing (OEM, CDM, AEM) plus CSV and CZML serialization. Pure and headless
string transforms with no rendering or SPICE dependency. Part of the core layer.
(CCSDS OMM parsing lives in `@bessel/propagator`, next to the TLE ingest it feeds.)

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
  pair it with the `@bessel/attitude` `attitudeHistory` sampler for a pxform-style
  body-orientation query.
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
import { parseOem, writeOem, parseCdm, seriesToCsv } from '@bessel/interop';

const oem = parseOem(text);          // OemError on a malformed message
const back = writeOem(oem);          // round-trippable KVN
const csv = seriesToCsv(et, [alt], ['altitude_km']);
```

## Dependency rule

Depends on: nothing (pure). The package has no `@bessel` dependencies and pulls
in no SPICE or timeline package; epoch-to-ET conversion is the caller's concern.
Part of the core layer; lower layers never import higher ones, and the core never
imports a concrete PAL implementation.

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
