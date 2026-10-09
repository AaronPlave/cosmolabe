/**
 * The observation model (issue #28, Phase 2): one type for a Cosmographia
 * observation, a sensor `active` window and an archived product, and the
 * sensor footprint computed from IK + CK through CSPICE.
 *
 * The footprint tier runs on the real thing: every Cassini ISS frame of SOI
 * (2004 DOY 183–185) in the Phase-1 archive fixture, with the committed CK, IK
 * and reconstructed SPK. Ground truth for illumination is the archive's centre
 * phase angle — not the same point as the boresight intercept, but provably
 * within the target's angular radius of it (see the Titan test), which is a
 * bound with teeth: a radians/degrees slip, a swapped angle, or the wrong body
 * all land far outside it.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Spice } from '@cosmolabe/spice';
import type { ArchiveObservation } from '@cosmolabe/interop';
import { furnishKernels } from './_harness/kernels.js';
import {
  observationFromCosmographia,
  observationFromSensorActive,
  observationToCosmographia,
  observationSampleTimes,
  groupSampling,
  MAX_GROUP_SAMPLES,
  observationActiveAt,
  ObservationError,
} from '../observations/Observation.js';
import {
  computeFootprint,
  footprintGeometryProviderOf,
  fovBoundaryRays,
  lonLatToBodyFixed,
  bodyFixedToLonLat,
  type FootprintGeometryProvider,
} from '../observations/computeFootprint.js';
import { archiveToObservation, archiveTimeToEt, campaignSpans } from '../observations/ArchiveAdapter.js';
import { resolveSurfaceMethod } from '../observations/computeFootprint.js';
import { createSpiceEngine } from 'cspice-wasm';
import { arrokothDskScene, CAMERA, ARROKOTH } from './_harness/arrokoth-dsk.js';
import type { Vec3 } from '../spice-injection.js';

const parseNumber = (v: string | number) => (typeof v === 'number' ? v : Number(v));

describe('Cosmographia observations', () => {
  const geometry = {
    type: 'Observations',
    sensor: 'ISS NAC',
    groups: [
      { startTime: 100, endTime: 200, obsRate: 10 },
      { startTime: 300, endTime: 400, obsRate: 0 },
    ],
    footprintColor: [1, 0.5, 0],
    footprintOpacity: 0.4,
    showResWithColor: false,
    sideDivisions: 12,
    alongTrackDivisions: 50,
    shadowVolumeScaleFactor: 1.75,
    fillInObservations: true,
  };

  it('keeps every Cosmographia field under its own name, and round-trips', () => {
    const obs = observationFromCosmographia('Rings', 'Saturn', geometry, parseNumber);
    expect(obs).toMatchObject({
      name: 'Rings',
      target: 'Saturn',
      sensor: 'ISS NAC',
      coverage: { kind: 'sensor', sensor: 'ISS NAC' },
      groups: [
        { startEt: 100, endEt: 200, obsRate: 10 },
        { startEt: 300, endEt: 400, obsRate: 0 },
      ],
      footprintColor: [1, 0.5, 0],
      fillInObservations: true,
      shadowVolumeScaleFactor: 1.75,
    });
    expect(observationToCosmographia(obs, String)).toEqual({
      ...geometry,
      groups: geometry.groups.map((g) => ({ startTime: String(g.startTime), endTime: String(g.endTime), obsRate: g.obsRate })),
    });
  });

  it('defaults obsRate to a continuous swath', () => {
    const obs = observationFromCosmographia('x', 'Saturn', { sensor: 'S', groups: [{ startTime: 0, endTime: 1 }] }, parseNumber);
    expect(obs.groups[0]!.obsRate).toBe(0);
  });

  it('fails with located errors', () => {
    const bad = (g: Record<string, unknown>) => () => observationFromCosmographia('Obs', 'Saturn', g, parseNumber);
    expect(bad({ groups: [] })).toThrow(/observation "Obs": `sensor`/);
    expect(bad({ sensor: 'S', groups: [] })).toThrow(/non-empty array/);
    expect(bad({ sensor: 'S', groups: [{ startTime: 5, endTime: 1 }] })).toThrow(/groups\[0\] ends before it starts/);
    expect(bad({ sensor: 'S', groups: [{ startTime: 1, endTime: 2, obsRate: -1 }] })).toThrow(/groups\[0\]\.obsRate/);
    expect(bad({ sensor: 'S', groups: [{ startTime: 'never', endTime: 2 }] })).toThrow(/groups\[0\]\.startTime "never"/);
    expect(bad({ sensor: 'S', groups: [{ startTime: 1, endTime: 2 }], fillInObservations: 'yes' })).toThrow(/fillInObservations/);
    expect(() => observationFromCosmographia('Obs', '', geometry, parseNumber)).toThrow(/`center`/);
  });

  it('takes a given footprint through the same item (cosmolabe extension)', () => {
    const ring = [[10, -88], [11, -88], [11, -89]];
    const obs = observationFromCosmographia(
      'M1', 'Moon',
      { coverage: { kind: 'footprint', polygonLonLat: [ring] }, groups: [{ startTime: 1, endTime: 2 }], campaign: '61234' },
      parseNumber,
    );
    expect(obs.coverage).toEqual({ kind: 'footprint', polygonLonLat: [ring] });
    expect(obs.sensor).toBeUndefined();
    expect(obs.campaign).toBe('61234');
    expect(() => observationFromCosmographia('M1', 'Moon', { coverage: { kind: 'footprint', polygonLonLat: [[[1, 2]]] }, groups: [{ startTime: 1, endTime: 2 }] }, parseNumber))
      .toThrow(/polygonLonLat/);
  });

  it('refuses to write a given footprint as Cosmographia rather than drop it', () => {
    const obs = { name: 'p', target: 'Moon', groups: [], coverage: { kind: 'footprint', polygonLonLat: [] } } as const;
    expect(() => observationToCosmographia(obs, String)).toThrow(ObservationError);
  });
});

describe('sensor `active` windows', () => {
  it('become a continuous-swath observation on the sensor target', () => {
    const obs = observationFromSensorActive('Cam', { target: 'Mars', active: [{ start: 10, end: 20 }] }, parseNumber);
    expect(obs).toMatchObject({ target: 'Mars', coverage: { kind: 'sensor', sensor: 'Cam' }, groups: [{ startEt: 10, endEt: 20, obsRate: 0 }] });
    expect(observationActiveAt(obs!, 15)).toBe(true);
    expect(observationActiveAt(obs!, 25)).toBe(false);
  });

  it('are absent without windows and refused without a target', () => {
    expect(observationFromSensorActive('Cam', { target: 'Mars' }, parseNumber)).toBeUndefined();
    expect(() => observationFromSensorActive('Cam', { active: [{ start: 1, end: 2 }] }, parseNumber)).toThrow(/need a `target`/);
  });
});

describe('group sampling', () => {
  it('obsRate > 0 gives discrete footprints every obsRate seconds, and the end', () => {
    expect(observationSampleTimes({ startEt: 0, endEt: 25, obsRate: 10 })).toEqual([0, 10, 20, 25]);
    expect(observationSampleTimes({ startEt: 0, endEt: 20, obsRate: 10 })).toEqual([0, 10, 20]);
  });

  it('obsRate 0 gives a continuous swath of alongTrackDivisions steps', () => {
    expect(observationSampleTimes({ startEt: 0, endEt: 100, obsRate: 0 }, 4)).toEqual([0, 25, 50, 75, 100]);
  });

  it('reached() counts only the samples the clock has passed', () => {
    const s = groupSampling({ startEt: 0, endEt: 25, obsRate: 10 });
    expect([-1, 0, 9.9, 10, 22, 25, 99].map((t) => s.reached(t))).toEqual([0, 1, 1, 2, 3, 4, 4]);
    const w = groupSampling({ startEt: 0, endEt: 100, obsRate: 0 }, 4);
    expect([-1, 0, 60, 100].map((t) => w.reached(t))).toEqual([0, 1, 3, 5]);
  });

  it('a zero-length window is one instant', () => {
    expect(observationSampleTimes({ startEt: 7, endEt: 7, obsRate: 0 })).toEqual([7]);
  });

  it('stress: a year at obsRate 1 is O(1), thinned to MAX_GROUP_SAMPLES rather than allocated', () => {
    const year = 365.25 * 86400;
    const t0 = performance.now();
    const s = groupSampling({ startEt: 0, endEt: year, obsRate: 1 });
    expect(s.count).toBe(MAX_GROUP_SAMPLES);
    expect(s.thinned).toBe(true);
    expect(s.at(0)).toBe(0);
    expect(s.at(s.count - 1)).toBe(year);
    expect(s.reached(year / 2)).toBeCloseTo(MAX_GROUP_SAMPLES / 2, -1);
    for (let i = 0; i < 1000; i++) s.reached(Math.random() * year);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('rejects non-finite and pathological windows, rates and division counts', () => {
    expect(() => groupSampling({ startEt: 0, endEt: Infinity, obsRate: 1 })).toThrow(ObservationError);
    expect(() => groupSampling({ startEt: 0, endEt: 1, obsRate: NaN })).toThrow(ObservationError);
    const bad = (g: Record<string, unknown>) => () =>
      observationFromCosmographia('Obs', 'Saturn', { sensor: 'S', groups: [{ startTime: 0, endTime: 1 }], ...g }, parseNumber);
    expect(() => observationFromCosmographia('Obs', 'Saturn', { sensor: 'S', groups: [{ startTime: 0, endTime: 1, obsRate: Infinity }] }, parseNumber))
      .toThrow(/obsRate/);
    expect(bad({ alongTrackDivisions: 1e9 })).toThrow(/alongTrackDivisions must be a whole number/);
    expect(bad({ sideDivisions: 2.5 })).toThrow(/sideDivisions/);
    expect(bad({ sideDivisions: NaN })).toThrow(/sideDivisions must be a finite number/);
  });
});

describe('fovBoundaryRays', () => {
  it('walks a rectangle edge by edge, every ray on the pyramid', () => {
    const fov = {
      shape: 'RECTANGLE' as const,
      frame: 'F',
      boresight: [0, 0, 1] as Vec3,
      bounds: [[1, 1, 10], [-1, 1, 10], [-1, -1, 10], [1, -1, 10]] as Vec3[],
    };
    const rays = fovBoundaryRays(fov, 2);
    expect(rays).toHaveLength(8);
    // Corners and edge midpoints, on the z = 1 plane.
    expect(rays[0]).toEqual([0.1, 0.1, 1]);
    expect(rays[1]).toEqual([0, 0.1, 1]);
    for (const r of rays) expect(Math.max(Math.abs(r[0]), Math.abs(r[1]))).toBeCloseTo(0.1, 12);
  });

  it('goes around a circle at the IK half-angle', () => {
    const half = (0.5 * Math.PI) / 180;
    const fov = { shape: 'CIRCLE' as const, frame: 'F', boresight: [0, 0, 1] as Vec3, bounds: [[Math.sin(half), 0, Math.cos(half)]] as Vec3[] };
    const rays = fovBoundaryRays(fov, 3);
    expect(rays).toHaveLength(12);
    for (const r of rays) expect(Math.atan2(Math.hypot(r[0], r[1]), r[2])).toBeCloseTo(half, 12);
  });
});

describe('lon/lat ↔ body-fixed', () => {
  it('round-trips planetocentric coordinates on an oblate ellipsoid', () => {
    const radii: Vec3 = [60268, 60268, 54364];
    const p = lonLatToBodyFixed(-45, 30, radii);
    expect((p[0] / radii[0]) ** 2 + (p[1] / radii[1]) ** 2 + (p[2] / radii[2]) ** 2).toBeCloseTo(1, 12);
    const [lon, lat] = bodyFixedToLonLat(p);
    expect(lon).toBeCloseTo(-45, 10);
    expect(lat).toBeCloseTo(30, 10);
  });
});

// ── archive ingest ──────────────────────────────────────────────────────────

describe('archive ingest', () => {
  let spice: Spice;
  beforeAll(async () => {
    spice = await Spice.init();
    await furnishKernels(spice, ['naif0012.tls']);
  });

  const opusRow: ArchiveObservation = {
    archive: 'OPUS',
    id: 'co-iss-n1467344155',
    startTime: '2004-07-01T03:11:39.791',
    stopTime: '2004-07-01T03:11:40.791',
    timeSystem: 'UTC',
    target: 'Saturn',
    instrument: 'Cassini ISS',
    campaign: 'ISS_000RI_SOISPTURN183_SP',
    disk: { subObsLatDeg: 13.139, subObsLonDeg: 51.862, distanceKm: 90825.679 },
  };

  it('converts UTC through str2et — leap seconds, not a J2000 subtraction', () => {
    const et = archiveTimeToEt('2004-07-01T03:11:39.791', 'UTC', (s) => spice.str2et(s));
    // ΔT = 32 leap seconds + 32.184 s on 2004-07-01.
    expect(et - spice.str2et('2004-07-01 03:11:39.791 TDB')).toBeCloseTo(64.184, 2);
  });

  it('refuses a time system it cannot convert exactly', () => {
    expect(() => archiveTimeToEt('2004-07-01T00:00:00', 'SCLK', (s) => spice.str2et(s))).toThrow(/refusing rather than guessing/);
    expect(() => archiveToObservation({ ...opusRow, timeSystem: 'GPS' }, (s) => spice.str2et(s)))
      .toThrow(/OPUS co-iss-n1467344155: startTime/);
  });

  it('maps disk geometry, the exposure window and the opaque campaign', () => {
    const obs = archiveToObservation(opusRow, (s) => spice.str2et(s));
    expect(obs.coverage).toEqual({ kind: 'disk', subObsLatLon: [13.139, 51.862], distanceKm: 90825.679 });
    expect(obs.groups[0]!.endEt - obs.groups[0]!.startEt).toBeCloseTo(1, 6);
    expect(obs).toMatchObject({ name: 'co-iss-n1467344155', target: 'Saturn', campaign: 'ISS_000RI_SOISPTURN183_SP', archive: 'OPUS' });
  });

  it('prefers a given footprint, keeping its holes rather than filling them', () => {
    const outer = [[10, -80], [20, -80], [20, -90], [10, -80]] as const;
    const hole = [[14, -84], [16, -84], [16, -86], [14, -84]] as const;
    const obs = archiveToObservation(
      { archive: 'ODE', id: 'M1', startTime: '2025-01-15T10:00:00', timeSystem: 'UTC', target: 'MOON', footprint: [[outer, hole], [outer]], disk: opusRow.disk },
      (s) => spice.str2et(s),
    );
    expect(obs.coverage).toEqual({ kind: 'footprint', polygonLonLat: [outer, outer], holesLonLat: [[hole], []] });
    const plain = archiveToObservation(
      { archive: 'ODE', id: 'M2', startTime: '2025-01-15T10:00:00', timeSystem: 'UTC', target: 'MOON', footprint: [[outer]] },
      (s) => spice.str2et(s),
    );
    expect(plain.coverage).toEqual({ kind: 'footprint', polygonLonLat: [outer] });
  });

  it('warns loudly on a target mismatch and keeps the archive target', () => {
    const warn = vi.fn();
    const obs = archiveToObservation(opusRow, (s) => spice.str2et(s), { target: 'Titan', warn });
    expect(obs.target).toBe('Saturn');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/target is Saturn, but it was asked for on Titan/));
  });

  it('falls back to a named sensor, and refuses when there is no coverage at all', () => {
    const { disk: _d, ...bare } = opusRow;
    expect(archiveToObservation(bare, (s) => spice.str2et(s), { sensor: 'ISS NAC' }).coverage).toEqual({ kind: 'sensor', sensor: 'ISS NAC' });
    expect(() => archiveToObservation(bare, (s) => spice.str2et(s))).toThrow(/no footprint or disk geometry/);
  });

  it('groups by the campaign key without decoding it, degrading to one span each', () => {
    const at = (id: string, t: number, campaign?: string) => ({
      name: id, target: 'Saturn', coverage: { kind: 'sensor', sensor: 'S' } as const,
      groups: [{ startEt: t, endEt: t + 1, obsRate: 0 }], ...(campaign ? { campaign } : {}),
    });
    const spans = campaignSpans([at('a', 10, 'B'), at('b', 0, 'A'), at('c', 20, 'B'), at('d', 5)]);
    expect(spans.map((s) => [s.campaign, s.startEt, s.endEt, s.observations.length])).toEqual([
      ['A', 0, 1, 1],
      ['d', 5, 6, 1],
      ['B', 10, 21, 2],
    ]);
  });
});

// ── footprints on real Cassini pointing ─────────────────────────────────────

interface ArchiveRow {
  opusId: string;
  target: string;
  utcMid: string;
  instrument: 'ISSNA' | 'ISSWA';
  distanceKm: number;
  phaseDeg: number;
}
const ROWS = (
  JSON.parse(readFileSync(join(__dirname, '__fixtures__/pds-geometry-soi.json'), 'utf8')) as { rows: ArchiveRow[] }
).rows;
const INSTRUMENT_ID = { ISSNA: -82360, ISSWA: -82361 } as const;

describe('computeFootprint (Cassini ISS, SOI, IK + CK)', () => {
  let spice: Spice;
  let provider: FootprintGeometryProvider;

  beforeAll(async () => {
    spice = await Spice.init();
    await furnishKernels(spice, [
      'naif0012.tls',
      'pck00010.tpc',
      'cassini/040909R_SCPSE_04183_04185_subset.bsp',
      'cassini/cas_v43.tf',
      'cassini/cas00172.tsc',
      'cassini/cas_iss_v10.ti',
      'cassini/04183_04185ra.bc',
    ]);
    provider = footprintGeometryProviderOf(spice)!;
  });

  const footprint = (row: ArchiveRow, abcorr: 'LT+S' | 'NONE' = 'LT+S', sideDivisions = 4) =>
    computeFootprint(provider, {
      instrumentId: INSTRUMENT_ID[row.instrument],
      target: row.target,
      observer: 'CASSINI',
      fixref: `IAU_${row.target}`,
      et: spice.str2et(row.utcMid),
      abcorr,
      sideDivisions,
    });

  it('the reference engine satisfies the provider contract', () => {
    expect(provider).not.toBeNull();
    expect(footprintGeometryProviderOf({ getfov() {} })).toBeNull();
  });

  it('every intercept lies on the target ellipsoid, inside the camera field of view', () => {
    let checked = 0;
    for (const row of ROWS.filter((r) => r.target === 'TITAN')) {
      const f = footprint(row);
      if (!f.boresight) continue;
      const radii = spice.bodvrd(row.target, 'RADII') as Vec3;
      for (const p of [f.boresight, ...f.boundary]) {
        if (!p) continue;
        const s = (p[0] / radii[0]) ** 2 + (p[1] / radii[1]) ** 2 + (p[2] / radii[2]) ** 2;
        expect(s).toBeCloseTo(1, 9);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('boresight phase agrees with the archive centre phase within Titan’s angular radius', () => {
    // At a surface point P the observer direction differs from the centre's
    // by at most asin(r / range), and the Sun's by r / 1.4e9 km, so
    // |phase(P) − phase(centre)| ≤ asin(r / range). Plus 0.005° for the
    // archive's 3-decimal values and the Phase-1 residual (0.004°).
    const r = 2575;
    let hits = 0;
    let worstMargin = Infinity;
    for (const row of ROWS.filter((x) => x.target === 'TITAN')) {
      const f = footprint(row);
      if (!f.illumination) continue;
      hits++;
      const bound = (Math.asin(r / row.distanceKm) * 180) / Math.PI + 0.005;
      const d = Math.abs(f.illumination.phaseDeg - row.phaseDeg);
      expect(d, `${row.opusId}: |Δphase| ${d.toFixed(4)}° > ${bound.toFixed(4)}°`).toBeLessThanOrEqual(bound);
      worstMargin = Math.min(worstMargin, bound - d);
      expect(f.illumination.incidenceDeg).toBeGreaterThanOrEqual(0);
      expect(f.illumination.emissionDeg).toBeLessThanOrEqual(90);
    }
    // The bound applies to every Titan frame whose boresight is on Titan.
    expect(hits).toBeGreaterThan(100);
    expect(worstMargin).toBeGreaterThan(0);
  });

  it('mutation guard: the bound discriminates — incidence or emission in place of phase fails it', () => {
    const r = 2575;
    let rows = 0;
    let caughtIncidence = 0;
    let caughtEmission = 0;
    for (const row of ROWS.filter((x) => x.target === 'TITAN')) {
      const f = footprint(row);
      if (!f.illumination) continue;
      rows++;
      const bound = (Math.asin(r / row.distanceKm) * 180) / Math.PI + 0.005;
      if (Math.abs(f.illumination.incidenceDeg - row.phaseDeg) > bound) caughtIncidence++;
      if (Math.abs(f.illumination.emissionDeg - row.phaseDeg) > bound) caughtEmission++;
    }
    expect(caughtIncidence / rows).toBeGreaterThan(0.9);
    expect(caughtEmission / rows).toBeGreaterThan(0.9);
  });

  it('honours abcorr: dropping LT+S moves the boresight intercept measurably', () => {
    const row = ROWS.find((x) => x.target === 'TITAN' && footprint(x).boresight)!;
    const a = footprint(row, 'LT+S').boresight!;
    const b = footprint(row, 'NONE').boresight!;
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeGreaterThan(1); // km
  });

  it('a ray past the limb is a gap, not a fabricated point', () => {
    // The SOI ring scan points the NAC at the rings: Saturn is in the archive
    // row (centre geometry) but not under the boresight.
    const row = ROWS.find((x) => x.opusId === 'co-iss-n1467344155' && x.target === 'SATURN')!;
    const f = footprint(row);
    expect(f.boresight).toBeNull();
    expect(f.illumination).toBeUndefined();
    expect(f.complete).toBe(false);
  });
});

describe('the Cassini demo catalog (apps/viewer/test-catalogs/cassini-observations.json)', () => {
  it('every item is a plain Cosmographia observation the generic model reads, in 22 campaigns', async () => {
    const spice = await Spice.init();
    await furnishKernels(spice, ['naif0012.tls']);
    const catalog = JSON.parse(
      readFileSync(join(__dirname, '../../../../apps/viewer/test-catalogs/cassini-observations.json'), 'utf8'),
    ) as { require: string[]; items: { class: string; name: string; center: string; geometry: Record<string, unknown> }[] };
    expect(catalog.require).toEqual(['cassini-soi.json']);
    const parse = (v: string | number) => spice.str2et(String(v));
    const observations = catalog.items.map((it) => {
      expect(it.class).toBe('observation');
      // Cosmographia's own form: a sensor, not the cosmolabe `coverage` extension.
      expect(it.geometry.coverage).toBeUndefined();
      return observationFromCosmographia(it.name, it.center, it.geometry, parse);
    });
    expect(observations.reduce((n, o) => n + o.groups.length, 0)).toBe(514);
    expect(campaignSpans(observations)).toHaveLength(22);
  });
});

describe('resolveSurfaceMethod', () => {
  it('observation, then target declaration, then a DSK-named shape, then the ellipsoid', () => {
    expect(resolveSurfaceMethod({ surfaceMethod: 'DSK/UNPRIORITIZED' }, undefined)).toBe('DSK/UNPRIORITIZED');
    expect(resolveSurfaceMethod({}, { surfaceMethod: 'DSK/UNPRIORITIZED' })).toBe('DSK/UNPRIORITIZED');
    expect(resolveSurfaceMethod({}, { type: 'Mesh', dsk: 'shape.bds' })).toBe('DSK/UNPRIORITIZED');
    expect(resolveSurfaceMethod({}, { type: 'Mesh', source: 'models/67P.BDS' })).toBe('DSK/UNPRIORITIZED');
    expect(resolveSurfaceMethod({}, { type: 'Globe', radius: 2575 })).toBe('ELLIPSOID');
    expect(resolveSurfaceMethod({}, undefined)).toBe('ELLIPSOID');
  });
});

// ── an irregular DSK surface ────────────────────────────────────────────────

describe('computeFootprint on a DSK (Arrokoth low-poly shape, runtime engine)', () => {
  type V = [number, number, number];
  let provider: FootprintGeometryProvider;
  let et: number;
  let verts: Float64Array | number[];
  let plates: Int32Array | number[];

  beforeAll(async () => {
    const scene = await arrokothDskScene();
    provider = footprintGeometryProviderOf(scene.spice)!;
    et = scene.et;
    const engine = await createSpiceEngine();
    const shape = await engine.readDsk(
      'mu69_lopoly.bds',
      new Uint8Array(readFileSync(join(__dirname, '../../../../kernels/fixtures/mu69_lopoly.bds'))),
    );
    verts = shape.vertices;
    plates = shape.plates;
  });

  const footprint = (method: string) =>
    computeFootprint(provider, {
      instrumentId: CAMERA,
      target: String(ARROKOTH),
      observer: 'DSK_TEST_CRAFT',
      fixref: 'MU69_FIXED',
      et,
      abcorr: 'NONE',
      sideDivisions: 3,
      method,
    });

  /** Nearest hit of a ray on the plate model, by Möller–Trumbore over every
   *  plate: an intersection computed without SPICE. */
  function rayMesh(origin: V, dir: V): V | null {
    let best = Infinity;
    const v = (k: number): V => [verts[3 * k]!, verts[3 * k + 1]!, verts[3 * k + 2]!];
    for (let p = 0; p < plates.length; p += 3) {
      const a = v(plates[p]!), b = v(plates[p + 1]!), c = v(plates[p + 2]!);
      const e1: V = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2: V = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const h: V = [dir[1] * e2[2] - dir[2] * e2[1], dir[2] * e2[0] - dir[0] * e2[2], dir[0] * e2[1] - dir[1] * e2[0]];
      const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
      if (Math.abs(det) < 1e-12) continue;
      const s: V = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
      const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det;
      if (u < 0 || u > 1) continue;
      const q: V = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
      const w = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) / det;
      if (w < 0 || u + w > 1) continue;
      const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
      if (t > 0 && t < best) best = t;
    }
    return best === Infinity ? null : [origin[0] + best * dir[0], origin[1] + best * dir[1], origin[2] + best * dir[2]];
  }

  it('every intercept is where the ray meets the DSK plates, computed independently', () => {
    const f = footprint(resolveSurfaceMethod({}, { type: 'Mesh', dsk: 'mu69_lopoly.bds' }));
    expect(f.complete).toBe(true);
    const fov = provider.getfov(CAMERA);
    const rays = [...fovBoundaryRays(fov, 3), fov.boresight];
    const points = [...f.boundary, f.boresight];
    const camera: V = [0, 0, -100]; // the scene's camera, in the (identity) body frame
    for (let i = 0; i < rays.length; i++) {
      const ours = points[i]!;
      const truth = rayMesh(camera, rays[i]! as V)!;
      expect(truth).not.toBeNull();
      expect(Math.hypot(ours[0] - truth[0], ours[1] - truth[1], ours[2] - truth[2])).toBeLessThan(1e-6);
    }
    expect(f.illumination!.phaseDeg).toBeCloseTo(45, 4); // Sun at 45° from the camera, by construction
  });

  it('mutation guard: the ellipsoid method lands somewhere else on this body', () => {
    const dsk = footprint('DSK/UNPRIORITIZED').boresight!;
    const ell = footprint('ELLIPSOID').boresight!;
    expect(Math.hypot(dsk[0] - ell[0], dsk[1] - ell[1], dsk[2] - ell[2])).toBeGreaterThan(1); // km
  });
});
