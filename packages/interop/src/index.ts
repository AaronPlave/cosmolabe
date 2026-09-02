// @cosmolabe/interop: standard-format ingest/export (CCSDS, etc.). TLE lives in
// @cosmolabe/core (satellite.js); this package adds the message formats. (STK_PARITY_SPEC §4.11.)
//
// Stability policy: the public surface is schema v0, additive only. A
// breaking change to any message shape or format function (OEM, AEM, CDM,
// CSV, CZML) requires the api-surface snapshot (api-surface.test.ts) to move
// in the same deliberate commit, so drift fails the suite loudly rather than
// leaking out.
//
// Upstream also exported oemToProduct here, which turned a parsed OEM into an
// AnalysisProduct. That adapter is not harvested: it types against the compute
// plane's product schema, which is deferred. Ingest lands in this tree as
// core's OEMTrajectory instead, which is what a catalog actually needs.

export {
  parseOem,
  OemError,
  type Oem,
  type OemMetadata,
  type OemState,
} from './oem.js';
export { writeOem } from './oem-write.js';
export {
  seriesToCsv,
  intervalsToCsv,
  tableToCsv,
  csvMetaPreamble,
  type SeriesCsvOptions,
  type IntervalsCsvOptions,
  type TableCsvOptions,
  type CsvMeta,
  type CsvTimeSystem,
} from './csv.js';
export {
  intervalsToCzml,
  groundTrackToCzml,
  type IsoInterval,
  type GroundSample,
} from './czml.js';
export { parseCdm, CdmError, type Cdm, type CdmObject } from './cdm.js';
export { parseAem, AemError, type Aem, type AemMetadata, type AemRecord } from './aem.js';
export { writeAem } from './aem-write.js';
