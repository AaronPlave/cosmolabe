// The API-surface snapshot demanded by the stability policy: schema v0,
// additive only. The mirrors below are the committed snapshot of the public
// message shapes. The Exact assertions fail the build if any exported shape
// drifts in either direction, the keyof pins fail it if an options member is
// renamed or removed, and the runtime test fails if the export list changes.
// Additive evolution updates this snapshot in the same commit, deliberately;
// anything else is a breaking change.
//
// The Exact/keyof assertions only bite where a typechecker runs. That step now
// exists — `npm run typecheck:tests` (tsconfig.test.json) — so these hold for
// real. They did not before, and the first run found a pin referencing
// `OemProductOptions`, a type that left with `oem-product.ts` during the
// harvest: the assertion had quietly evaluated to `false` and nothing read it.

import { describe, it, expect } from 'vitest';
import * as api from './index.js';

type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Assert<T extends true> = T;

// ── message-shape snapshot (full mirrors, self-contained primitives) ─────────

interface SnapOemMetadata {
  readonly objectName?: string;
  readonly objectId?: string;
  readonly centerName?: string;
  readonly refFrame?: string;
  readonly timeSystem?: string;
  readonly startTime?: string;
  readonly stopTime?: string;
}
interface SnapOemState {
  readonly epoch: string;
  readonly position: readonly [number, number, number];
  readonly velocity: readonly [number, number, number];
}
interface SnapOem {
  readonly version: string;
  readonly originator?: string;
  readonly creationDate?: string;
  readonly metadata: SnapOemMetadata;
  readonly states: readonly SnapOemState[];
}
interface SnapAemMetadata {
  readonly objectName?: string;
  readonly objectId?: string;
  readonly centerName?: string;
  readonly refFrameA?: string;
  readonly refFrameB?: string;
  readonly attitudeDir?: string;
  readonly timeSystem?: string;
  readonly startTime?: string;
  readonly stopTime?: string;
  readonly attitudeType?: string;
  readonly quaternionType?: string;
}
interface SnapAemRecord {
  readonly epoch: string;
  readonly quaternion: readonly [number, number, number, number];
}
interface SnapAem {
  readonly version: string;
  readonly metadata: SnapAemMetadata;
  readonly records: readonly SnapAemRecord[];
}
interface SnapCdmObject {
  readonly designator?: string;
  readonly name?: string;
}
interface SnapCdm {
  readonly tca: string;
  readonly missDistanceM: number;
  readonly relativeSpeedMS?: number;
  readonly object1: SnapCdmObject;
  readonly object2: SnapCdmObject;
}
interface SnapIsoInterval {
  readonly start: string;
  readonly stop: string;
}
interface SnapGroundSample {
  readonly epoch: string;
  readonly lonDeg: number;
  readonly latDeg: number;
  readonly heightM?: number;
}
interface SnapCsvMeta {
  readonly mission?: string;
  readonly epoch?: string;
  readonly timeSystem?: 'UTC' | 'TDB' | 'TAI';
  readonly span?: string;
  readonly step?: string;
  readonly target?: string;
  readonly secondary?: string;
  readonly frame?: string;
}

type SnapLonLat = readonly [number, number];
type SnapWktPolygon = readonly (readonly SnapLonLat[])[];
interface SnapArchiveDiskGeometry {
  readonly subObsLatDeg: number;
  readonly subObsLonDeg: number;
  readonly distanceKm: number;
  readonly boresightRaDecDeg?: readonly [number, number];
}
interface SnapArchiveIllumination {
  readonly phaseDeg?: number;
  readonly incidenceDeg?: number;
  readonly emissionDeg?: number;
}
interface SnapArchiveObservation {
  readonly archive: string;
  readonly id: string;
  readonly instrument?: string;
  readonly target?: string;
  readonly startTime: string;
  readonly stopTime?: string;
  readonly timeSystem: string;
  readonly campaign?: string;
  readonly footprint?: readonly SnapWktPolygon[];
  readonly disk?: SnapArchiveDiskGeometry;
  readonly illumination?: SnapArchiveIllumination;
  readonly resolutionKm?: number;
}

type _LonLatExact = Assert<Exact<api.LonLat, SnapLonLat>>;
type _WktPolygonExact = Assert<Exact<api.WktPolygon, SnapWktPolygon>>;
type _ArchiveObservationExact = Assert<Exact<api.ArchiveObservation, SnapArchiveObservation>>;
type _ArchiveDiskGeometryExact = Assert<Exact<api.ArchiveDiskGeometry, SnapArchiveDiskGeometry>>;
type _ArchiveIlluminationExact = Assert<Exact<api.ArchiveIllumination, SnapArchiveIllumination>>;
type _OpusQueryKeys = Assert<Exact<keyof api.OpusQuery, 'params' | 'campaignColumn' | 'disk' | 'limit' | 'startObs' | 'api'>>;
type _OpusDiskColumnsKeys = Assert<
  Exact<keyof api.OpusDiskColumns, 'subObsLat' | 'subObsLonWest' | 'centerDistance' | 'raMin' | 'raMax' | 'decMin' | 'decMax' | 'phase'>
>;
type _OdeQueryKeys = Assert<Exact<keyof api.OdeQuery, 'params' | 'limit' | 'offset' | 'api'>>;
type _ObservationArchiveKeys = Assert<Exact<keyof api.ObservationArchive<unknown>, 'name' | 'url' | 'parse' | 'search'>>;

type _OemExact = Assert<Exact<api.Oem, SnapOem>>;
type _OemMetadataExact = Assert<Exact<api.OemMetadata, SnapOemMetadata>>;
type _OemStateExact = Assert<Exact<api.OemState, SnapOemState>>;
type _AemExact = Assert<Exact<api.Aem, SnapAem>>;
type _AemMetadataExact = Assert<Exact<api.AemMetadata, SnapAemMetadata>>;
type _AemRecordExact = Assert<Exact<api.AemRecord, SnapAemRecord>>;
type _CdmExact = Assert<Exact<api.Cdm, SnapCdm>>;
type _CdmObjectExact = Assert<Exact<api.CdmObject, SnapCdmObject>>;
type _IsoIntervalExact = Assert<Exact<api.IsoInterval, SnapIsoInterval>>;
type _GroundSampleExact = Assert<Exact<api.GroundSample, SnapGroundSample>>;
type _CsvMetaExact = Assert<Exact<api.CsvMeta, SnapCsvMeta>>;
type _CsvTimeSystemExact = Assert<Exact<api.CsvTimeSystem, 'UTC' | 'TDB' | 'TAI'>>;

// ── options member pins (rename or removal fails typecheck) ──────────────────

// `OemProductOptions` is intentionally absent: `oem-product.ts` typed against
// the deferred compute product schema and was dropped when this package was
// harvested, so there is no pin for it to hold.
type _SeriesCsvOptionsKeys = Assert<
  Exact<keyof api.SeriesCsvOptions, 'epochHeader' | 'epochLabels' | 'digits' | 'meta'>
>;
type _IntervalsCsvOptionsKeys = Assert<
  Exact<keyof api.IntervalsCsvOptions, 'startHeader' | 'stopHeader' | 'format' | 'meta'>
>;
type _TableCsvOptionsKeys = Assert<Exact<keyof api.TableCsvOptions, 'meta' | 'digits'>>;

describe('interop API surface (stability policy)', () => {
  it('exports exactly the committed runtime surface', () => {
    expect(Object.keys(api).sort()).toEqual([
      'AemError',
      'ArchiveError',
      'CdmError',
      'ODE_API',
      'OPUS_API',
      'OemError',
      'WktError',
      'csvMetaPreamble',
      'groundTrackToCzml',
      'intervalsToCsv',
      'intervalsToCzml',
      'ode',
      'opus',
      'opusColumns',
      'parseAem',
      'parseCdm',
      'parseOem',
      'parseWktPolygons',
      'seriesToCsv',
      'tableToCsv',
      'writeAem',
      'writeOem',
    ]);
  });
});
