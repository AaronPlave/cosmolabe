// @bessel/interop: standard-format ingest/export (CCSDS, etc.). TLE lives in
// @bessel/propagator; this package adds the message formats. (STK_PARITY_SPEC §4.11.)
//
// Stability policy (the @bessel/compute discipline, extended here because
// interop is on the publish list): the public surface is schema v0,
// additive only until the packages restructure. Surfaces typed against the
// product schema (oemToProduct) are governed by ADR M-0004; the message
// shapes and format functions (OEM, AEM, CDM, CSV, CZML) are governed by
// this package policy, and a breaking change to either requires the
// api-surface snapshot (api-surface.test.ts) to move in the same
// deliberate commit; the snapshot fails pnpm verify loudly on any drift.

export {
  parseOem,
  OemError,
  type Oem,
  type OemMetadata,
  type OemState,
} from './oem.ts';
export { writeOem } from './oem-write.ts';
export { oemToProduct, type OemProductOptions } from './oem-product.ts';
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
} from './csv.ts';
export {
  intervalsToCzml,
  groundTrackToCzml,
  type IsoInterval,
  type GroundSample,
} from './czml.ts';
export { parseCdm, CdmError, type Cdm, type CdmObject } from './cdm.ts';
export { parseAem, AemError, type Aem, type AemMetadata, type AemRecord } from './aem.ts';
export { writeAem } from './aem-write.ts';
