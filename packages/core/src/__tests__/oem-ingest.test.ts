/**
 * CCSDS OEM ingest, end to end: a real file becomes a renderable trajectory.
 *
 * The fixture is the CCSDS standard's own Mars Global Surveyor example
 * (ORIGINATOR = NASA/JPL, REF_FRAME = EME2000, TIME_SYSTEM = UTC), which is
 * worth more than a synthetic one — it exercises the awkward parts a
 * hand-written fixture would smooth over: a fractional-second epoch, an
 * equatorial reference frame that does *not* match the catalog default, and a
 * declared interpolation degree we do not implement.
 *
 * What this pins, in order of how much it would hurt to get wrong:
 *   1. epoch conversion goes through SPICE, so leap seconds are real;
 *   2. the file's REF_FRAME is the frame of record, and a catalog frame that
 *      contradicts it is reported, not silently used;
 *   3. an unconvertible time system is refused rather than guessed at;
 *   4. the tabulated states survive the trip into the interpolator.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHeritageSpice, type HeritageSpice } from '@cosmolabe/frames';
import { parseOem } from '@cosmolabe/interop';
import {
  oemToStateRecords,
  oemEpochToEt,
  oemRefFrameToInertial,
  oemFrameName,
  checkOemFrame,
} from '../trajectories/OemAdapter.js';
import { Universe } from '../Universe.js';
import { OBLIQUITY_J2000_RAD } from '../constants.js';
import { InterpolatedStatesTrajectory } from '../trajectories/InterpolatedStates.js';
import { CatalogLoader } from '../catalog/CatalogLoader.js';
import type { CatalogJson } from '../catalog/CatalogLoader.js';

const OEM_TEXT = readFileSync(
  fileURLToPath(new URL('../../../interop/test-fixtures/mgs.oem', import.meta.url)),
  'utf8',
);
const LSK = fileURLToPath(
  new URL('../../../spice/test-kernels/naif0012.tls', import.meta.url),
);

/** The fixture's three tabulated states, transcribed from the file. */
const EXPECTED = [
  { epoch: '1996-12-18T12:00:00.331', p: [2789.6, -280.0, -1746.8], v: [4.73, -2.5, -1.04] },
  { epoch: '1996-12-18T12:01:00.331', p: [2783.4, -308.1, -1877.1], v: [5.19, -2.42, -2.0] },
  { epoch: '1996-12-18T12:02:00.331', p: [2776.0, -336.9, -2008.7], v: [5.64, -2.34, -1.95] },
];

describe('CCSDS OEM ingest', () => {
  let spice: HeritageSpice;
  let str2et: (s: string) => number;

  beforeAll(async () => {
    spice = await createHeritageSpice();
    const bytes = readFileSync(LSK);
    await spice.furnish({
      type: 'buffer',
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      filename: 'naif0012.tls',
    });
    str2et = (s) => spice.str2et(s);
  }, 120_000);

  it('parses the fixture into the states the file tabulates', () => {
    const oem = parseOem(OEM_TEXT);
    expect(oem.version).toBe('2.0');
    expect(oem.originator).toBe('NASA/JPL');
    expect(oem.metadata.refFrame).toBe('EME2000');
    expect(oem.metadata.timeSystem).toBe('UTC');
    expect(oem.metadata.centerName).toBe('MARS BARYCENTER');
    expect(oem.states).toHaveLength(3);
  });

  describe('epoch conversion', () => {
    it('routes through SPICE, so leap seconds are actually applied', () => {
      const et = oemEpochToEt('1996-12-18T12:00:00.331', 'UTC', str2et);
      expect(et).toBe(str2et('1996-12-18 12:00:00.331 UTC'));

      // The point of using SPICE rather than date arithmetic. A naive
      // "milliseconds since the J2000 epoch" conversion misses TAI-UTC (30
      // leap seconds as of December 1996) plus the TT-TAI and TDB-TT terms,
      // which together land near 62 s. That is not a rounding difference: at
      // MGS's ~5 km/s it is over 300 km of along-track error, on a body whose
      // whole orbit radius here is ~3300 km.
      const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
      const naive = (Date.parse('1996-12-18T12:00:00.331Z') - J2000_MS) / 1000;
      const offset = et - naive;
      expect(offset).toBeGreaterThan(60);
      expect(offset).toBeLessThan(65);
    });

    it('accepts a trailing Z without letting it collide with the system token', () => {
      expect(oemEpochToEt('1996-12-18T12:00:00.331Z', 'UTC', str2et)).toBe(
        oemEpochToEt('1996-12-18T12:00:00.331', 'UTC', str2et),
      );
    });

    it('honours a declared TDB time system instead of assuming UTC', () => {
      const asUtc = oemEpochToEt('1996-12-18T12:00:00.331', 'UTC', str2et);
      const asTdb = oemEpochToEt('1996-12-18T12:00:00.331', 'TDB', str2et);
      // Reading a TDB file as UTC (or vice versa) is the ~62 s error above.
      expect(Math.abs(asTdb - asUtc)).toBeGreaterThan(60);
    });

    it('refuses a time system it cannot convert exactly', () => {
      expect(() => oemEpochToEt('1996-12-18T12:00:00.331', 'GPS', str2et)).toThrow(/TIME_SYSTEM/);
      // The message has to name what is supported, or the refusal is useless.
      expect(() => oemEpochToEt('1996-12-18T12:00:00.331', 'TAI', str2et)).toThrow(/UTC, TDB/);
    });
  });

  describe('reference frame', () => {
    it('maps the equatorial aliases onto one frame', () => {
      for (const f of ['EME2000', 'J2000', 'ICRF', 'GCRF', 'eme2000']) {
        expect(oemRefFrameToInertial(f), f).toBe('EquatorJ2000');
      }
      expect(oemRefFrameToInertial('ECLIPJ2000')).toBe('EclipticJ2000');
      expect(oemRefFrameToInertial('ITRF93')).toBeUndefined();
      expect(oemRefFrameToInertial(undefined)).toBeUndefined();
    });

    it('names every CCSDS frame the registry knows, keeping them apart', () => {
      expect(oemFrameName('EME2000')).toBe('EME2000');
      expect(oemFrameName('ICRF')).toBe('ICRF');
      expect(oemFrameName('GCRF')).toBe('ICRF');
      expect(oemFrameName('TEME')).toBe('TEME');
      expect(oemFrameName('TOD')).toBe('TOD');
      expect(oemFrameName('ITRF-93')).toBe('ITRF');
      expect(oemFrameName('ITRF2000')).toBe('ITRF');
      expect(oemFrameName('TDR')).toBe('ITRF');
      // Names the registry does not define are kept for the universe to resolve.
      expect(oemFrameName('MCI')).toBe('MCI');
      expect(oemFrameName('  MY_MISSION_FRAME ')).toBe('MY_MISSION_FRAME');
      expect(oemFrameName(undefined)).toBeUndefined();
    });

    it('reports a catalog frame that contradicts the file', () => {
      const oem = parseOem(OEM_TEXT); // EME2000, i.e. equatorial
      // Declaring nothing is fine now: the file's own frame is used.
      expect(checkOemFrame(oem, undefined).ok).toBe(true);

      const bad = checkOemFrame(oem, 'ecliptic');
      expect(bad.ok).toBe(false);
      expect(bad.message).toMatch(/EME2000/);
      expect(bad.message).toMatch(/file's frame is used/);
      expect(checkOemFrame(oem, 'J2000').ok).toBe(true);
      expect(checkOemFrame(oem, 'equatorial').ok).toBe(true);
      expect(checkOemFrame(oem, 'ICRF').ok).toBe(true);
      expect(checkOemFrame(oem, 'TEME').ok).toBe(false);
    });

    it('makes no claim when either side is unrecognized', () => {
      const oem = parseOem(OEM_TEXT.replace('REF_FRAME = EME2000', 'REF_FRAME = MCI'));
      expect(checkOemFrame(oem, 'ecliptic').ok).toBe(true);
    });
  });

  describe('state records', () => {
    it('carries every tabulated state through in ET order', () => {
      const records = oemToStateRecords(parseOem(OEM_TEXT), str2et);
      expect(records).toHaveLength(3);
      records.forEach((r, i) => {
        expect(r.et, `record ${i} et`).toBe(str2et(`${EXPECTED[i]!.epoch.replace('T', ' ')} UTC`));
        expect(Array.from(r.position), `record ${i} position`).toEqual(EXPECTED[i]!.p);
        expect(Array.from(r.velocity), `record ${i} velocity`).toEqual(EXPECTED[i]!.v);
      });
      // Sorted ascending, whatever order the file listed them in.
      expect(records[1]!.et).toBeGreaterThan(records[0]!.et);
      expect(records[2]!.et).toBeGreaterThan(records[1]!.et);
    });

    it('reproduces the source states exactly at the tabulated epochs', () => {
      // Hermite interpolation is exact at its nodes, so a sample taken at a
      // file epoch must return the file's own numbers. This is the assertion
      // that the ingest is lossless where it claims to be.
      const traj = new InterpolatedStatesTrajectory(
        oemToStateRecords(parseOem(OEM_TEXT), str2et),
      );
      for (const e of EXPECTED) {
        const s = traj.stateAt(str2et(`${e.epoch.replace('T', ' ')} UTC`));
        expect(Array.from(s.position), `${e.epoch} position`).toEqual(e.p);
        expect(Array.from(s.velocity), `${e.epoch} velocity`).toEqual(e.v);
      }
    });

    it('interpolates between nodes rather than stepping', () => {
      const traj = new InterpolatedStatesTrajectory(
        oemToStateRecords(parseOem(OEM_TEXT), str2et),
      );
      const t0 = str2et(`${EXPECTED[0]!.epoch.replace('T', ' ')} UTC`);
      const mid = traj.stateAt(t0 + 30).position;
      // Strictly between the bracketing samples on the component that moves
      // most (z drops ~130 km per minute here), and not equal to either.
      expect(mid[2]).toBeLessThan(EXPECTED[0]!.p[2]!);
      expect(mid[2]).toBeGreaterThan(EXPECTED[1]!.p[2]!);
    });
  });

  describe('through a catalog', () => {
    const catalogWith = (trajectoryFrame?: string): CatalogJson =>
      ({
        name: 'OEM ingest test',
        items: [
          {
            name: 'Mars',
            class: 'planet',
            trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
            geometry: { type: 'Globe', radius: 3396 },
          },
          {
            name: 'MGS',
            class: 'spacecraft',
            center: 'Mars',
            ...(trajectoryFrame ? { trajectoryFrame } : {}),
            trajectory: { type: 'OEM', source: 'mgs.oem' },
          },
        ],
      }) as unknown as CatalogJson;

    it('builds a trajectory a catalog can point at with a file reference', () => {
      const loader = new CatalogLoader({
        spice,
        resolveFile: (source) => (source === 'mgs.oem' ? OEM_TEXT : undefined),
      });
      const { bodies } = loader.load(catalogWith('J2000'));
      const mgs = bodies.find((b) => b.name === 'MGS');
      expect(mgs, 'MGS should be in the catalog').toBeDefined();

      // The whole point: the states in the file are the states in the scene.
      for (const e of EXPECTED) {
        const s = mgs!.trajectory.stateAt(str2et(`${e.epoch.replace('T', ' ')} UTC`));
        expect(Array.from(s.position), `${e.epoch} position`).toEqual(e.p);
        expect(Array.from(s.velocity), `${e.epoch} velocity`).toEqual(e.v);
      }
    });

    it('takes the frame from REF_FRAME, so the catalog need not declare one', () => {
      const loader = new CatalogLoader({ spice, resolveFile: () => OEM_TEXT });
      const { bodies } = loader.load(catalogWith());
      const mgs = bodies.find((b) => b.name === 'MGS')!;
      expect(mgs.frame).toBe('EME2000');
    });

    it('places the states by the file frame, with no app-side rotation', () => {
      // The acceptance case of #101: an EME2000 OEM loads as-is and lands where
      // the file says, i.e. rotated into the ecliptic scene frame by the J2000
      // obliquity, not drawn raw as if it were already ecliptic.
      const u = new Universe(spice, { resolveFile: () => OEM_TEXT });
      u.loadCatalog(catalogWith());
      const et = str2et(`${EXPECTED[0]!.epoch.replace('T', ' ')} UTC`);
      const [x, y, z] = EXPECTED[0]!.p as [number, number, number];
      const c = Math.cos(OBLIQUITY_J2000_RAD);
      const sn = Math.sin(OBLIQUITY_J2000_RAD);
      const expected = [x, c * y + sn * z, -sn * y + c * z];
      const got = u.absolutePositionOf('MGS', et);
      for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(expected[i]!, 9);
    });

    it('lets the catalog say which EME2000 a bias-aware producer meant', () => {
      const warn = console.warn;
      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
      let frame: string | undefined;
      try {
        const loader = new CatalogLoader({ spice, resolveFile: () => OEM_TEXT });
        frame = loader.load(catalogWith('EME2000_IERS')).bodies.find((b) => b.name === 'MGS')?.frame;
      } finally {
        console.warn = warn;
      }
      expect(frame).toBe('EME2000_IERS');
      expect(warnings.join('\n')).not.toMatch(/frame mismatch/i);
    });

    it('keeps a REF_FRAME only the universe can resolve, and places the states in it', () => {
      // A mission frame declared in the catalog, named only by the file.
      const half = Math.SQRT1_2;
      const text = OEM_TEXT.replace('REF_FRAME = EME2000', 'REF_FRAME = MISSION_FRAME');
      const u = new Universe(spice, { resolveFile: () => text });
      u.loadCatalog({
        ...catalogWith(),
        // 90° about +Z from EME2000.
        frames: [{ name: 'MISSION_FRAME', base: 'EME2000', quaternion: [half, 0, 0, half] }],
      } as unknown as CatalogJson);
      expect(u.getBody('MGS')!.frame).toBe('MISSION_FRAME');
      const et = str2et(`${EXPECTED[0]!.epoch.replace('T', ' ')} UTC`);
      const [x, y, z] = EXPECTED[0]!.p as [number, number, number];
      const eme: [number, number, number] = [-y, x, z]; // the frame's +X is EME2000 +Y
      const c = Math.cos(OBLIQUITY_J2000_RAD);
      const sn = Math.sin(OBLIQUITY_J2000_RAD);
      const expected = [eme[0], c * eme[1] + sn * eme[2], -sn * eme[1] + c * eme[2]];
      const got = u.absolutePositionOf('MGS', et);
      for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(expected[i]!, 6);
    });

    it('reports a REF_FRAME nothing can resolve instead of silently using the default', () => {
      const warnings: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
      let frame: string | undefined;
      try {
        const text = OEM_TEXT.replace('REF_FRAME = EME2000', 'REF_FRAME = MCI');
        const loader = new CatalogLoader({ spice, resolveFile: () => text });
        frame = loader.load(catalogWith()).bodies.find((b) => b.name === 'MGS')?.frame;
      } finally {
        console.warn = original;
      }
      expect(frame).toBe('MCI');
      expect(warnings.join('\n')).toMatch(/MGS \(OEM REF_FRAME\).*MCI/);
    });

    it('warns rather than throwing when the catalog frame contradicts the file', () => {
      const warnings: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
      let frame: string | undefined;
      try {
        const loader = new CatalogLoader({
          spice,
          resolveFile: () => OEM_TEXT,
        });
        // The catalog says ecliptic; the file says EME2000. The body loads in
        // the file's frame and the contradiction is reported.
        const { bodies } = loader.load(catalogWith('ecliptic'));
        frame = bodies.find((b) => b.name === 'MGS')?.frame;
      } finally {
        console.warn = original;
      }
      expect(frame).toBe('EME2000');
      expect(warnings.join('\n')).toMatch(/frame mismatch/i);
      expect(warnings.join('\n')).toMatch(/MGS/);
    });

    it('degrades to a fixed point, with a warning, when the file cannot be resolved', () => {
      const warnings: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
      try {
        const loader = new CatalogLoader({ spice, resolveFile: () => undefined });
        const { bodies } = loader.load(catalogWith('J2000'));
        const mgs = bodies.find((b) => b.name === 'MGS');
        expect(mgs).toBeDefined();
        expect(Array.from(mgs!.trajectory.stateAt(0).position)).toEqual([0, 0, 0]);
      } finally {
        console.warn = original;
      }
      expect(warnings.join('\n')).toMatch(/could not resolve/i);
    });
  });
});
