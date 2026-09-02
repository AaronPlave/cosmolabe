// The API-surface snapshot demanded by the stability policy (schema v0,
// additive only until the packages restructure; the @bessel/compute
// mechanism, extended to this publishing package at the Session 9 pre-merge
// gate). The mirrors below are the committed snapshot of the public message
// shapes: the Exact assertions fail `pnpm typecheck` if any exported shape
// drifts in either direction, the keyof pins fail it if an options member
// is renamed or removed, and the runtime test fails if the export list
// changes. Additive evolution updates this snapshot in the same commit,
// deliberately; anything else is a breaking change. Product-schema-typed
// surfaces (oemToProduct) are governed by ADR M-0004 and snapshot in
// @bessel/compute; this file pins the message formats.

import { describe, it, expect } from 'vitest';
import * as api from './index.ts';

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

type _OemProductOptionsKeys = Assert<
  Exact<keyof api.OemProductOptions, 'fileName' | 'kind' | 'toEt'>
>;
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
      'CdmError',
      'OemError',
      'csvMetaPreamble',
      'groundTrackToCzml',
      'intervalsToCsv',
      'intervalsToCzml',
      'oemToProduct',
      'parseAem',
      'parseCdm',
      'parseOem',
      'seriesToCsv',
      'tableToCsv',
      'writeAem',
      'writeOem',
    ]);
  });
});
