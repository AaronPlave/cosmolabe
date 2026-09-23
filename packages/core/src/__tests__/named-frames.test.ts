/**
 * Named frames (#101): the frame registry and the transforms `Universe` builds
 * on it, on both the SPICE and SPICE-free paths.
 *
 * The matrix at the heart of this file runs every pair of built-in frames
 * through two registries — one with no SPICE, one backed by a real CSPICE
 * instance — and checks, pair by pair:
 *   - the rotation is proper and orthonormal, and inverts its reverse;
 *   - it composes through any third frame;
 *   - the two paths agree;
 *   - where SPICE defines both frames, both paths equal `pxform`.
 *
 * Independent references, so this is not only self-consistency:
 *   - SPICE's built-in inertial frames (J2000, ECLIPJ2000, B1950, FK4,
 *     ECLIPB1950, GALACTIC);
 *   - SPICE's own IAU-1976 / IAU-1980 parameterized dynamic frames, defined
 *     in a frame kernel below, for MOD and TOD;
 *   - Vallado et al. (AIAA 2006-6753), the published TEME → J2000 and PEF
 *     example, for TEME and the Earth-fixed path.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Spice } from '@cosmolabe/spice';
import type { RotationMatrix, SpiceInstance, Vec3 } from '../spice-injection.js';
import { kernelArrayBuffer } from './_harness/kernels.js';
import {
  BODY_FIXED,
  FrameRegistry,
  DEFAULT_FRAMES,
  WORLD_FRAME,
  bodyFixedFrameName,
  isStateDependentFrameName,
} from '../frames/FrameRegistry.js';
import { mat3Mul, mat3Transpose, mat3Vec, quatToMat3 } from '../frames/mat3.js';
import { j2000ToTeme, j2000ToEarthFixed, j2000ToTod } from '../frames/earthOrientation.js';
import { alignPositionToFrame, composeBodyToWorldQuat, frameAlignmentQuat, rotateVecByQuat } from '../kinematics.js';
import { Universe } from '../Universe.js';
import { Body } from '../Body.js';
import { CatalogLoader, type CatalogJson } from '../catalog/CatalogLoader.js';
import { FixedPointTrajectory } from '../trajectories/FixedPoint.js';
import { CompositeTrajectory } from '../trajectories/CompositeTrajectory.js';
import { TLETrajectory } from '../trajectories/TLETrajectory.js';
import { SpiceTrajectory } from '../trajectories/SpiceTrajectory.js';
import { UniformRotation } from '../rotations/UniformRotation.js';
import { FixedRotation } from '../rotations/FixedRotation.js';
import { OBLIQUITY_J2000_RAD } from '../constants.js';
import { etFromCalendarString } from '../time.js';

const KERNELS = join(__dirname, '../../../spice/test-kernels');
const ARCSEC = Math.PI / (180 * 3600);

/** SPICE's own IAU-1976 precession and IAU-1980 nutation, as parameterized
 *  dynamic frames. CSPICE implements the full 106-term nutation series, so
 *  this is an independent check on the analytical path, not a restatement. */
const EARTH_OF_DATE_FK = `KPL/FK
\\begindata
FRAME_EARTH_MOD_TEST        = 1599001
FRAME_1599001_NAME          = 'EARTH_MOD_TEST'
FRAME_1599001_CLASS         = 5
FRAME_1599001_CLASS_ID      = 1599001
FRAME_1599001_CENTER        = 399
FRAME_1599001_RELATIVE      = 'J2000'
FRAME_1599001_DEF_STYLE     = 'PARAMETERIZED'
FRAME_1599001_FAMILY        = 'MEAN_EQUATOR_AND_EQUINOX_OF_DATE'
FRAME_1599001_PREC_MODEL    = 'EARTH_IAU_1976'
FRAME_1599001_ROTATION_STATE = 'ROTATING'

FRAME_EARTH_TOD_TEST        = 1599002
FRAME_1599002_NAME          = 'EARTH_TOD_TEST'
FRAME_1599002_CLASS         = 5
FRAME_1599002_CLASS_ID      = 1599002
FRAME_1599002_CENTER        = 399
FRAME_1599002_RELATIVE      = 'J2000'
FRAME_1599002_DEF_STYLE     = 'PARAMETERIZED'
FRAME_1599002_FAMILY        = 'TRUE_EQUATOR_AND_EQUINOX_OF_DATE'
FRAME_1599002_PREC_MODEL    = 'EARTH_IAU_1976'
FRAME_1599002_NUT_MODEL     = 'EARTH_IAU_1980'
FRAME_1599002_ROTATION_STATE = 'ROTATING'
\\begintext
`;

/** The built-in frames the matrix runs over. */
const FRAMES = [
  'ICRF', 'EME2000', 'EME2000_IERS', 'ECLIPJ2000', 'B1950', 'FK4', 'ECLIPB1950', 'GALACTIC',
  'MOD', 'TOD', 'TEME', 'ITRF',
] as const;

/** The ones SPICE defines itself (no kernel needed). */
const SPICE_BUILTIN = new Set(['ICRF', 'EME2000', 'ECLIPJ2000', 'B1950', 'FK4', 'ECLIPB1950', 'GALACTIC']);

/** Epochs spread over the range a mission catalog uses. */
const EPOCHS = [
  -15 * 365.25 * 86400, // 1985
  0, // J2000
  134509952.5716639, // Vallado's TEME example, 2004-04-06 07:51:28.386 UTC
  26.5 * 365.25 * 86400, // mid-2026
];

function maxAbsDiff(a: readonly number[], b: readonly number[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

function det(m: RotationMatrix): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

const IDENTITY: RotationMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Angle of the rotation a ᵀb, radians: how far apart two frame rotations are. */
function angleBetween(a: RotationMatrix, b: RotationMatrix): number {
  const r = mat3Mul(mat3Transpose(a), b);
  const c = (r[0] + r[4] + r[8] - 1) / 2;
  return Math.acos(Math.min(1, Math.max(-1, c)));
}

describe('FrameRegistry: names', () => {
  it('canonicalizes aliases case-insensitively', () => {
    const r = new FrameRegistry();
    expect(r.canonicalName('J2000')).toBe('EME2000');
    expect(r.canonicalName('EquatorJ2000')).toBe('EME2000');
    expect(r.canonicalName('equatorial')).toBe('EME2000');
    expect(r.canonicalName('EclipticJ2000')).toBe('ECLIPJ2000');
    expect(r.canonicalName('ecliptic')).toBe('ECLIPJ2000');
    expect(r.canonicalName('gcrf')).toBe('ICRF');
    expect(r.canonicalName('ITRF93')).toBe('ITRF');
    expect(r.canonicalName('ITRF-93')).toBe('ITRF');
    expect(r.canonicalName('teme')).toBe('TEME');
    expect(r.canonicalName('BodyFixed')).toBe(BODY_FIXED);
    expect(r.canonicalName('body-fixed')).toBe(BODY_FIXED);
    expect(r.canonicalName('iau_mars')).toBe('IAU_MARS');
    expect(r.canonicalName('CASSINI_SC_COORD')).toBe('CASSINI_SC_COORD');
  });

  it('keeps TEME, EME2000 and ICRF apart', () => {
    const r = new FrameRegistry();
    expect(r.sameFrame('TEME', 'EME2000')).toBe(false);
    expect(r.sameFrame('EME2000', 'ICRF')).toBe(false);
    expect(r.sameFrame('J2000', 'EME2000')).toBe(true);
  });

  it('maps frames to the names SPICE knows them by', () => {
    const r = new FrameRegistry();
    expect(r.spiceName('EclipticJ2000')).toBe('ECLIPJ2000');
    expect(r.spiceName('EME2000')).toBe('J2000');
    expect(r.spiceName('ICRF')).toBe('J2000');
    expect(r.spiceName('ITRF')).toBe('ITRF93');
    expect(r.spiceName('IAU_Mars')).toBe('IAU_MARS');
    expect(r.spiceName('CASSINI_SC_COORD')).toBe('CASSINI_SC_COORD');
    // SPICE has no TEME, MOD or TOD.
    expect(r.spiceName('TEME')).toBeUndefined();
    expect(r.spiceName('MOD')).toBeUndefined();
    expect(r.spiceName(BODY_FIXED)).toBeUndefined();
  });

  it('names a body-fixed frame after its body', () => {
    expect(bodyFixedFrameName('Io')).toBe('IAU_IO');
    expect(bodyFixedFrameName('Ingenuity Heli')).toBe('IAU_INGENUITY_HELI');
  });

  it('recognizes state-dependent frames only to keep them out', () => {
    for (const f of ['LVLH', 'RIC', 'rtn', 'VNC']) {
      expect(isStateDependentFrameName(f), f).toBe(true);
      expect(new FrameRegistry().get(f), f).toBeUndefined();
    }
    expect(isStateDependentFrameName('TEME')).toBe(false);
  });

  it('passes a vector through unchanged when a frame cannot be resolved', () => {
    const r = new FrameRegistry();
    const v: Vec3 = [1, 2, 3];
    expect(r.transform(v, 'NOT_A_FRAME', 'ECLIPJ2000', 0)).toEqual(v);
    expect(r.transform(v, 'IAU_NOWHERE', 'ECLIPJ2000', 0)).toEqual(v);
    expect(r.isResolvable('NOT_A_FRAME', 0)).toBe(false);
    expect(r.isResolvable('TEME', 0)).toBe(true);
  });
});

describe('FrameRegistry: the frame-pair matrix', () => {
  let spice: SpiceInstance;
  let withSpice: FrameRegistry;
  const noSpice = new FrameRegistry();

  beforeAll(async () => {
    const s = await Spice.init();
    for (const f of ['naif0012.tls', 'pck00010.tpc']) {
      await s.furnish({ type: 'buffer', data: kernelArrayBuffer(readFileSync(join(KERNELS, f))), filename: f });
    }
    await s.furnish({
      type: 'buffer',
      data: kernelArrayBuffer(Buffer.from(EARTH_OF_DATE_FK)),
      filename: 'earth_of_date_test.tf',
    });
    spice = s;
    withSpice = new FrameRegistry({ spice });
  }, 30000);

  const paths = (): Array<[string, FrameRegistry]> => [
    ['SPICE-free', noSpice],
    ['SPICE', withSpice],
  ];

  it('every pair is a proper rotation that inverts its reverse, on both paths', () => {
    for (const [label, r] of paths()) {
      for (const et of EPOCHS) {
        for (const a of FRAMES) {
          for (const b of FRAMES) {
            const ab = r.rotation(a, b, et);
            const ba = r.rotation(b, a, et);
            expect(ab, `${label} ${a}->${b}`).toBeDefined();
            expect(Math.abs(det(ab!) - 1), `${label} det ${a}->${b}`).toBeLessThan(1e-12);
            expect(maxAbsDiff(mat3Mul(ab!, mat3Transpose(ab!)), IDENTITY), `${label} orthonormal ${a}->${b}`).toBeLessThan(1e-12);
            expect(maxAbsDiff(mat3Mul(ba!, ab!), IDENTITY), `${label} ${a}->${b}->${a}`).toBeLessThan(1e-12);
          }
        }
      }
    }
  });

  it('every pair composes through every third frame, on both paths', () => {
    const et = EPOCHS[2]!;
    for (const [label, r] of paths()) {
      for (const a of FRAMES) {
        for (const b of FRAMES) {
          for (const c of FRAMES) {
            const direct = r.rotation(a, c, et)!;
            const via = mat3Mul(r.rotation(b, c, et)!, r.rotation(a, b, et)!);
            expect(maxAbsDiff(direct, via), `${label} ${a}->${b}->${c}`).toBeLessThan(1e-12);
          }
        }
      }
    }
  });

  it('the SPICE and SPICE-free paths agree on every pair', () => {
    // No binary Earth PCK is furnished, so ITRF falls back to the analytical
    // path under SPICE too; every other frame here is analytical by design.
    for (const et of EPOCHS) {
      for (const a of FRAMES) {
        for (const b of FRAMES) {
          const d = maxAbsDiff(noSpice.rotation(a, b, et)!, withSpice.rotation(a, b, et)!);
          expect(d, `${a}->${b} at ${et}`).toBeLessThan(1e-15);
        }
      }
    }
  });

  it('equals SPICE pxform for every pair of SPICE-defined frames', () => {
    for (const et of EPOCHS) {
      for (const a of FRAMES) {
        for (const b of FRAMES) {
          if (!SPICE_BUILTIN.has(a) || !SPICE_BUILTIN.has(b)) continue;
          const truth = spice.pxform(noSpice.spiceName(a)!, noSpice.spiceName(b)!, et);
          expect(maxAbsDiff(noSpice.rotation(a, b, et)!, truth), `${a}->${b}`).toBeLessThan(1e-12);
        }
      }
    }
  });

  it('MOD matches SPICE’s IAU-1976 mean-of-date frame', () => {
    for (const et of EPOCHS) {
      const truth = spice.pxform('EARTH_MOD_TEST', 'J2000', et);
      const ours = noSpice.toICRF('MOD', et)!;
      // Same IAU-1976 polynomial; the two implementations agree to a few
      // milliarcseconds over four decades (~0.1 m at LEO radius).
      expect(angleBetween(ours, truth) / ARCSEC, `MOD at ${et}`).toBeLessThan(0.01);
    }
  });

  it('TOD matches SPICE’s full IAU-1980 true-of-date frame to the nutation truncation', () => {
    for (const et of EPOCHS) {
      const truth = spice.pxform('EARTH_TOD_TEST', 'J2000', et);
      const ours = noSpice.toICRF('TOD', et)!;
      // 20 of 106 nutation terms; the dropped tail is < 0.05″.
      expect(angleBetween(ours, truth) / ARCSEC, `TOD at ${et}`).toBeLessThan(0.05);
    }
  });

  it('resolves a frame only SPICE knows through pxform, and it agrees with the analytical one', () => {
    // EARTH_TOD_TEST is not a registry frame; the SPICE-backed registry
    // reaches it through pxform, the SPICE-free one cannot.
    const et = EPOCHS[3]!;
    expect(noSpice.isResolvable('EARTH_TOD_TEST', et)).toBe(false);
    const m = withSpice.rotation('EARTH_TOD_TEST', 'TOD', et)!;
    expect(angleBetween(m, IDENTITY) / ARCSEC).toBeLessThan(0.05);
  });

  it('resolves IAU_<body> frames through the PCK on the SPICE path', () => {
    const et = EPOCHS[2]!;
    const truth = spice.pxform('IAU_EARTH', 'ECLIPJ2000', et);
    expect(maxAbsDiff(withSpice.rotation('IAU_EARTH', 'ECLIPJ2000', et)!, truth)).toBeLessThan(1e-12);
    expect(noSpice.isResolvable('IAU_EARTH', et)).toBe(false);
  });

  it('resolves IAU_<body> through the body’s own rotation model on the SPICE-free path', () => {
    // The stock SPICE-free Earth: the analytical IAU pole and spin the loader
    // falls back to. It omits the IAU pole drift and uses a rounded sidereal
    // period, so it tracks pck00010 to a few hundredths of a degree in 2004.
    const u = new Universe();
    u.loadCatalog({
      name: 'earth',
      items: [{ name: 'Earth', trajectory: { type: 'FixedPoint', position: [0, 0, 0] }, rotationModel: { type: 'Builtin' } }],
    } as unknown as CatalogJson);
    const et = EPOCHS[2]!;
    const ours = u.frames.toICRF('IAU_EARTH', et)!;
    const truth = spice.pxform('IAU_EARTH', 'J2000', et);
    expect(angleBetween(ours, truth) * (180 / Math.PI)).toBeLessThan(0.1);
  });

  it('prefers the body’s rotation model to SPICE, so surface points sit on the drawn globe', () => {
    // A rotation model deliberately unlike IAU_EARTH.
    const u = new Universe(spice);
    u.addBody(new Body({
      name: 'Earth',
      trajectory: new FixedPointTrajectory([0, 0, 0]),
      rotation: new UniformRotation(3600, 0, 0, 0, Math.PI / 2, 'EME2000'),
    }));
    const et = 900; // a quarter turn
    const expected = mat3Transpose(quatToMat3(u.getBody('Earth')!.rotationAt(et)!));
    expect(maxAbsDiff(u.frames.toICRF('IAU_EARTH', et)!, expected)).toBeLessThan(1e-12);
    // …which is nowhere near SPICE's IAU_EARTH at the same epoch.
    expect(angleBetween(expected, spice.pxform('IAU_EARTH', 'J2000', et))).toBeGreaterThan(0.1);
  });
});

describe('EME2000_IERS: FK5 J2000 with the IERS frame bias', () => {
  it('matches SOFA’s ICRS → J2000 bias matrix (iauBp00 rb)', () => {
    // SOFA t_sofa_c.c, t_bp00: the frame-bias matrix rb.
    const rb: RotationMatrix = [
      0.9999999999999942, -7.078279744199195e-8, 8.056217146976134e-8,
      7.078279477857338e-8, 0.9999999999999969, 3.306041454222136e-8,
      -8.056217380986972e-8, -3.306040883980552e-8, 0.9999999999999962,
    ];
    const r = new FrameRegistry();
    expect(maxAbsDiff(r.rotation('ICRF', 'EME2000_IERS', 0)!, rb)).toBeLessThan(1e-14);
  });

  it('is ~23 mas from EME2000, which stays identity to ICRF as in SPICE', () => {
    const r = new FrameRegistry();
    const mas = angleBetween(r.toICRF('EME2000_IERS', 0)!, IDENTITY) / ARCSEC * 1000;
    expect(mas).toBeGreaterThan(23);
    expect(mas).toBeLessThan(23.3);
    expect(r.rotation('EME2000', 'ICRF', 0)).toEqual(IDENTITY);
    expect(r.spiceName('EME2000_IERS')).toBeUndefined();
  });
});

describe('TEME and Earth-fixed against Vallado’s published example', () => {
  // AIAA 2006-6753, "Revisiting Spacetrack Report #3", the TEME example:
  // 2004-04-06 07:51:28.386009 UTC, ΔUT1 = −0.4399619 s.
  const et = etFromCalendarString('2004-04-06T07:51:28.386009Z');
  const rTeme: Vec3 = [5094.1801621, 6127.6446595, 6380.3445327];
  const rJ2000: Vec3 = [5102.5089579, 6123.0114007, 6378.1369282];
  const rPef: Vec3 = [-1033.4750313, 7901.3055856, 6380.3445327];

  const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  it('rotates TEME into J2000 to within a few metres', () => {
    const r = new FrameRegistry();
    expect(dist(r.transform(rTeme, 'TEME', 'EME2000', et), rJ2000)).toBeLessThan(0.005);
  });

  it('rotates TEME into the Earth-fixed frame to within the UT1−UTC it neglects', () => {
    const r = new FrameRegistry();
    // UT1 ≈ UTC costs 0.44 s of Earth rotation here: ~0.26 km at this radius.
    expect(dist(r.transform(rTeme, 'TEME', 'ITRF', et), rPef)).toBeLessThan(0.3);
    // And the model itself is exact once UT1 is supplied.
    const withUt1 = mat3Mul(j2000ToEarthFixed(et - 0.4399619), mat3Transpose(j2000ToTeme(et)));
    expect(dist(mat3Vec(withUt1, rTeme), rPef)).toBeLessThan(0.005);
  });

  it('is what TLE trajectories are rotated from: ~20 arcminutes of precession by 2026', () => {
    // The size of what treating TEME as J2000 used to drop.
    const et2026 = EPOCHS[3]!;
    const angle = angleBetween(j2000ToTeme(et2026), IDENTITY) / ARCSEC / 60;
    expect(angle).toBeGreaterThan(15);
    expect(angle).toBeLessThan(25);
  });
});

describe('kinematics helpers read the registry', () => {
  const vectors: Vec3[] = [[1, 0, 0], [0, 185520, 0], [3, -4, 12]];

  it('agree on position and orientation for every static pair', () => {
    const statics = ['ICRF', 'EME2000', 'ECLIPJ2000', 'B1950', 'GALACTIC'];
    for (const a of statics) {
      for (const b of statics) {
        const q = frameAlignmentQuat(a, b);
        for (const v of vectors) {
          const p = alignPositionToFrame(v, a, b);
          const viaQ = rotateVecByQuat(v, q);
          expect(maxAbsDiff(p, viaQ), `${a}->${b}`).toBeLessThan(1e-9 * Math.max(1, Math.hypot(...v)));
        }
      }
    }
  });

  it('rotate time-dependent frames only when given an epoch', () => {
    const v: Vec3 = [7000, 0, 0];
    const et = EPOCHS[3]!;
    expect(alignPositionToFrame(v, 'TEME', 'EME2000')).toEqual(v);
    const rotated = alignPositionToFrame(v, 'TEME', 'EME2000', et);
    expect(rotated).not.toEqual(v);
    const expected = mat3Vec(mat3Transpose(j2000ToTeme(et)), v);
    expect(maxAbsDiff(rotated, expected)).toBeLessThan(1e-9);
  });
});

describe('Universe: frames across the parent chain', () => {
  const c = Math.cos(OBLIQUITY_J2000_RAD);
  const s = Math.sin(OBLIQUITY_J2000_RAD);
  const eqToEcl = (v: Vec3): Vec3 => [v[0], c * v[1] + s * v[2], -s * v[1] + c * v[2]];

  it('places a TLE body by rotating TEME, not by treating it as J2000', () => {
    const u = new Universe();
    u.addBody(new Body({ name: 'Earth', trajectory: new FixedPointTrajectory([0, 0, 0]) }));
    const tle = new TLETrajectory({
      line1: '1 25544U 98067A   26090.13309952  .00011434  00000+0  21777-3 0  9998',
      line2: '2 25544  51.6341 326.3497 0006202 253.7499 106.2807 15.48671303559657',
    });
    // The legacy 'equatorial' declaration is overridden by the trajectory's own frame.
    u.addBody(new Body({ name: 'ISS', parentName: 'Earth', trajectory: tle, trajectoryFrame: 'equatorial' }));
    expect(u.getBody('ISS')!.frame).toBe('TEME');
    const et = tle.epochEt + 600;
    const teme = tle.stateAt(et).position;
    const expected = eqToEcl(mat3Vec(mat3Transpose(j2000ToTeme(et)), teme));
    const got = u.absolutePositionOf('ISS', et);
    expect(maxAbsDiff(got, expected)).toBeLessThan(1e-6);
    // …and the precession it now applies is tens of km at LEO.
    const asJ2000 = eqToEcl(teme);
    expect(Math.hypot(got[0] - asJ2000[0], got[1] - asJ2000[1], got[2] - asJ2000[2])).toBeGreaterThan(20);
  });

  it('composes a mixed chain one leg at a time, ending in ECLIPJ2000', () => {
    const et = EPOCHS[3]!;
    const u = new Universe();
    u.addBody(new Body({ name: 'Sun', trajectory: new FixedPointTrajectory([0, 0, 0]) }));
    u.addBody(new Body({ name: 'Earth', parentName: 'Sun', trajectory: new FixedPointTrajectory([1.5e8, 0, 0]), trajectoryFrame: 'ECLIPJ2000' }));
    u.addBody(new Body({ name: 'Relay', parentName: 'Earth', trajectory: new FixedPointTrajectory([0, 40000, 0]), trajectoryFrame: 'EME2000' }));
    u.addBody(new Body({ name: 'Probe', parentName: 'Relay', trajectory: new FixedPointTrajectory([0, 0, 10]), trajectoryFrame: 'B1950' }));
    const r = u.frames;
    const probeInRelay = r.transform([0, 0, 10], 'B1950', 'EME2000', et);
    const inEarth = r.transform([probeInRelay[0], probeInRelay[1] + 40000, probeInRelay[2]], 'EME2000', 'ECLIPJ2000', et);
    const expected: Vec3 = [inEarth[0] + 1.5e8, inEarth[1], inEarth[2]];
    expect(maxAbsDiff(u.absolutePositionOf('Probe', et), expected)).toBeLessThan(1e-6);
  });

  it('turns a body-fixed child with its parent through IAU_<PARENT>', () => {
    const u = new Universe();
    const spin = new UniformRotation(86400, 0, 0, 0, Math.PI / 2, 'EME2000');
    u.addBody(new Body({ name: 'Earth', trajectory: new FixedPointTrajectory([0, 0, 0]), rotation: spin }));
    u.addBody(new Body({ name: 'Station', parentName: 'Earth', trajectory: new FixedPointTrajectory([6378, 0, 0], { frame: BODY_FIXED }) }));
    const et = 21600; // quarter day
    expect(u.frameOf('Station', et)).toBe('IAU_EARTH');
    const inertial = rotateVecByQuat([6378, 0, 0], [spin.rotationAt(et)[0], -spin.rotationAt(et)[1], -spin.rotationAt(et)[2], -spin.rotationAt(et)[3]]);
    expect(maxAbsDiff(u.absolutePositionOf('Station', et), eqToEcl(inertial))).toBeLessThan(1e-6);
  });

  it('carries a grandchild of a body-fixed parent around with the planet', () => {
    // A camera mast 2 m above a rover, stated in the rover's (Mars) body-fixed
    // frame via an explicit IAU_MARS. The rover's own body-fixed offset used to
    // be summed raw into the chain; now every leg is rotated.
    const u = new Universe();
    const spin = new UniformRotation(88642.66, 0, 0, 0, Math.PI / 2, 'EME2000');
    u.addBody(new Body({ name: 'Mars', trajectory: new FixedPointTrajectory([0, 0, 0]), rotation: spin }));
    u.addBody(new Body({ name: 'Rover', parentName: 'Mars', trajectory: new FixedPointTrajectory([3390, 0, 0]), trajectoryFrame: 'BodyFixed' }));
    u.addBody(new Body({ name: 'Mast', parentName: 'Rover', trajectory: new FixedPointTrajectory([0.002, 0, 0]), trajectoryFrame: 'IAU_MARS' }));
    for (const et of [0, 20000, 44321]) {
      const q = spin.rotationAt(et);
      const expected = eqToEcl(rotateVecByQuat([3390.002, 0, 0], [q[0], -q[1], -q[2], -q[3]]));
      expect(maxAbsDiff(u.absolutePositionOf('Mast', et), expected), `et ${et}`).toBeLessThan(1e-6);
    }
  });

  it('gives each arc of a composite trajectory its own frame', () => {
    const u = new Universe();
    const spin = new UniformRotation(86400, 0, 0, 0, Math.PI / 2, 'EME2000');
    u.addBody(new Body({ name: 'Moon', trajectory: new FixedPointTrajectory([0, 0, 0]), rotation: spin }));
    const composite = new CompositeTrajectory([
      { trajectory: new FixedPointTrajectory([2000, 0, 0]), startTime: 0, endTime: 100, centerName: 'Moon', frame: 'EME2000' },
      { trajectory: new FixedPointTrajectory([1737, 0, 0], { frame: BODY_FIXED }), startTime: 100, endTime: 1e6, centerName: 'Moon' },
    ]);
    u.addBody(new Body({ name: 'Lander', trajectory: composite }));
    expect(u.getBody('Lander')!.frameAt(50)).toBe('EME2000');
    expect(u.frameOf('Lander', 50)).toBe('EME2000');
    expect(u.frameOf('Lander', 500)).toBe('IAU_MOON');
    expect(maxAbsDiff(u.absolutePositionOf('Lander', 50), eqToEcl([2000, 0, 0]))).toBeLessThan(1e-9);
    const et = 21700;
    const q = spin.rotationAt(et);
    const landed = eqToEcl(rotateVecByQuat([1737, 0, 0], [q[0], -q[1], -q[2], -q[3]]));
    expect(maxAbsDiff(u.absolutePositionOf('Lander', et), landed)).toBeLessThan(1e-6);
  });

  it('relativePositionInWorld is absolutePositionOf with the parent left out', () => {
    const u = new Universe();
    u.addBody(new Body({ name: 'Saturn', trajectory: new FixedPointTrajectory([1e9, 2e8, 0]) }));
    u.addBody(new Body({ name: 'Titan', parentName: 'Saturn', trajectory: new FixedPointTrajectory([1.2e6, 3e5, 1e4]), trajectoryFrame: 'J2000' }));
    const rel = u.relativePositionInWorld('Titan', 0);
    const abs = u.absolutePositionOf('Titan', 0);
    expect(maxAbsDiff(rel, [abs[0] - 1e9, abs[1] - 2e8, abs[2]])).toBeLessThan(1e-6);
    expect(maxAbsDiff(u.toWorldFrame([1.2e6, 3e5, 1e4], 'J2000', 'Saturn', 0), rel)).toBeLessThan(1e-9);
  });
});

describe('Catalogs declare frames by name', () => {
  it('registers catalog frames and places bodies in them', () => {
    const half = Math.SQRT1_2;
    const u = new Universe();
    u.loadCatalog({
      name: 'declared',
      // 90° about +Z from EME2000: the declared frame's +X is EME2000's +Y.
      frames: [{ name: 'PAD_FRAME', base: 'EME2000', quaternion: [half, 0, 0, half] }],
      items: [
        { name: 'Earth', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
        { name: 'Beacon', center: 'Earth', trajectoryFrame: 'PAD_FRAME', trajectory: { type: 'FixedPoint', position: [100, 0, 0] } },
      ],
    } as unknown as CatalogJson);
    expect(u.getBody('Beacon')!.frame).toBe('PAD_FRAME');
    const c = Math.cos(OBLIQUITY_J2000_RAD);
    const s = Math.sin(OBLIQUITY_J2000_RAD);
    const expected: Vec3 = [0, c * 100, -s * 100]; // EME2000 +Y, into the ecliptic
    expect(maxAbsDiff(u.absolutePositionOf('Beacon', 0), expected)).toBeLessThan(1e-9);
  });

  it('matrix and quaternion declarations are the same frame', () => {
    const r = new FrameRegistry();
    const half = Math.SQRT1_2;
    r.defineFixedFrame({ name: 'Q', base: 'ECLIPJ2000', quaternion: [half, half, 0, 0] });
    r.defineFixedFrame({ name: 'M', base: 'ECLIPJ2000', matrix: [...quatToMat3([half, half, 0, 0])] });
    expect(maxAbsDiff(r.rotation('Q', 'M', 0)!, IDENTITY)).toBeLessThan(1e-15);
  });

  it('refuses a declared frame with no rotation, or defined against itself', () => {
    const r = new FrameRegistry();
    expect(() => r.defineFixedFrame({ name: 'X', base: 'ICRF' })).toThrow(/matrix|quaternion/);
    expect(() => r.defineFixedFrame({ name: 'X', base: 'x', matrix: [...IDENTITY] })).toThrow(/itself/);
  });

  it('declares intrinsic frames on trajectory types that know them', () => {
    const loader = new CatalogLoader();
    const { bodies } = loader.load({
      name: 'intrinsic',
      items: [
        { name: 'Earth', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
        {
          name: 'Sat', center: 'Earth', trajectoryFrame: 'J2000',
          trajectory: {
            type: 'TLE',
            line1: '1 25544U 98067A   26090.13309952  .00011434  00000+0  21777-3 0  9998',
            line2: '2 25544  51.6341 326.3497 0006202 253.7499 106.2807 15.48671303559657',
          },
        },
        { name: 'Pad', center: 'Earth', trajectory: { type: 'FixedSpherical', latitude: 28.5, longitude: -80.6, radius: 6378 } },
        { name: 'Beacon', center: 'Earth', trajectoryFrame: 'EME2000', trajectory: { type: 'FixedPoint', position: [1, 0, 0] } },
        { name: 'Moon', center: 'Earth', trajectory: { type: 'FixedPoint', position: [384400, 0, 0] } },
      ],
    } as unknown as CatalogJson);
    const frame = (n: string) => bodies.find((b) => b.name === n)!.frame;
    expect(frame('Sat')).toBe('TEME');
    expect(frame('Pad')).toBe(BODY_FIXED);
    expect(frame('Beacon')).toBe('EME2000');
    expect(frame('Moon')).toBe(WORLD_FRAME);
    // The legacy buckets are still derived for old consumers.
    const bucket = (n: string) => bodies.find((b) => b.name === n)!.trajectoryFrame;
    expect(bucket('Sat')).toBe('equatorial');
    expect(bucket('Pad')).toBe('body-fixed');
    expect(bucket('Moon')).toBe('ecliptic');
  });

  it('warns once at load about a state-dependent or unresolvable frame', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      new CatalogLoader().load({
        name: 'bad frames',
        items: [
          { name: 'A', trajectoryFrame: 'LVLH', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
          { name: 'B', trajectoryFrame: 'NOT_A_FRAME', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
        ],
      } as unknown as CatalogJson);
      const text = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(text).toMatch(/"A".*state-dependent/);
      expect(text).toMatch(/"B".*unknown frame "NOT_A_FRAME"/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('Catalog frame names reach SPICE in SPICE’s spelling', () => {
  let spice: SpiceInstance;

  beforeAll(async () => {
    const s = await Spice.init();
    for (const f of ['naif0012.tls', 'pck00010.tpc', 'de425s.bsp']) {
      await s.furnish({ type: 'buffer', data: kernelArrayBuffer(readFileSync(join(KERNELS, f))), filename: f });
    }
    spice = s;
  }, 30000);

  it('queries ECLIPJ2000 for a Cosmographia "EclipticJ2000" and J2000 for "EME2000"', () => {
    const loader = new CatalogLoader({ spice });
    const { bodies } = loader.load({
      name: 'spice names',
      items: [
        { name: 'Mars', center: 'Sun', trajectoryFrame: 'EclipticJ2000', trajectory: { type: 'Spice', target: 'MARS BARYCENTER', center: 'SUN' } },
        { name: 'Venus', center: 'Sun', trajectoryFrame: 'EME2000', trajectory: { type: 'Spice', target: 'VENUS BARYCENTER', center: 'SUN' } },
        { name: 'Moon', center: 'Earth', trajectoryFrame: 'TEME', trajectory: { type: 'Spice', target: 'MOON', center: 'EARTH' } },
      ],
    } as unknown as CatalogJson);
    const traj = (n: string) => bodies.find((b) => b.name === n)!.trajectory as SpiceTrajectory;
    expect(traj('Mars').spiceFrame).toBe('ECLIPJ2000');
    expect(traj('Venus').spiceFrame).toBe('J2000');
    // SPICE has no TEME: the states are fetched in J2000 and labelled so.
    expect(traj('Moon').spiceFrame).toBe('J2000');
    expect(bodies.find((b) => b.name === 'Moon')!.frame).toBe('EME2000');
    // And the query works — "EclipticJ2000" used to be handed to SPICE as-is.
    const et = spice.str2et('2020-01-01T00:00:00');
    expect(Number.isFinite(traj('Mars').stateAt(et).position[0])).toBe(true);
    expect(traj('Mars').failed).toBe(false);
  });

  it('places the same body identically whichever frame it is fetched in', () => {
    const et = spice.str2et('2020-01-01T00:00:00');
    const place = (frame: string) => {
      const u = new Universe(spice);
      u.loadCatalog({
        name: 'x',
        items: [
          { name: 'Sun', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
          { name: 'Mars', center: 'Sun', trajectoryFrame: frame, trajectory: { type: 'Spice', target: 'MARS BARYCENTER', center: 'SUN' } },
        ],
      } as unknown as CatalogJson);
      return u.absolutePositionOf('Mars', et);
    };
    const ecl = place('ECLIPJ2000');
    for (const f of ['J2000', 'EME2000', 'ICRF', 'B1950', 'GALACTIC']) {
      // 1e-6 relative at 1.5 AU is ~0.2 km of float round-off.
      expect(maxAbsDiff(place(f), ecl) / Math.hypot(...ecl), f).toBeLessThan(1e-9);
    }
  });

  it('agrees with SPICE on the TOD pole it would get from a full-series nutation', () => {
    // Guard on the analytical constants: the TOD Z axis stays within the
    // nutation truncation of SPICE's IAU_EARTH-independent J2000→TOD.
    const et = EPOCHS[3]!;
    const z = mat3Vec(mat3Transpose(j2000ToTod(et)), [0, 0, 1]);
    // Precession alone has moved the pole ~0.14° from J2000 by 2026.
    const tilt = Math.acos(z[2]) * (180 / Math.PI);
    expect(tilt).toBeGreaterThan(0.1);
    expect(tilt).toBeLessThan(0.2);
  });
});

describe('DEFAULT_FRAMES', () => {
  it('is a registry with the built-ins only', () => {
    expect(DEFAULT_FRAMES.isResolvable('TEME', 0)).toBe(true);
    expect(DEFAULT_FRAMES.isResolvable('IAU_EARTH', 0)).toBe(false);
  });
});

describe('Review fixes: structured frames, shared registry, composite ancestors, validation', () => {
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

  it('normalizes Cosmographia’s structured BodyFixed frames on items and arcs', () => {
    const warn = quiet();
    try {
      const { bodies } = new CatalogLoader().load({
        name: 'structured',
        items: [
          { name: 'Mars', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
          // dawn.json / msl.json form: the named body's frame, not the center's.
          { name: 'Cam', center: 'Mars', trajectoryFrame: { type: 'BodyFixed', body: 'Rover' }, trajectory: { type: 'FixedPoint', position: [1, 0, 0] } },
          {
            name: 'Lander', center: 'Mars',
            arcs: [
              { trajectoryFrame: { type: 'BodyFixed' }, trajectory: { type: 'FixedPoint', position: [3390, 0, 0] }, startTime: '2024-01-01T00:00:00Z', endTime: '2024-01-02T00:00:00Z' },
              { trajectoryFrame: { type: 'BodyFixed', body: 'Mars' }, trajectory: { type: 'FixedPoint', position: [3390, 0, 0] }, startTime: '2024-01-02T00:00:00Z', endTime: '2024-01-03T00:00:00Z' },
            ],
          },
          { name: 'Odd', center: 'Mars', trajectoryFrame: { type: 'TwoVector' }, trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
        ],
      } as unknown as CatalogJson);
      const body = (n: string) => bodies.find((b) => b.name === n)!;
      expect(body('Cam').frame).toBe('IAU_ROVER');
      expect(body('Lander').frameAt(etFromCalendarString('2024-01-01T12:00:00Z'))).toBe(BODY_FIXED);
      expect(body('Lander').frameAt(etFromCalendarString('2024-01-02T12:00:00Z'))).toBe('IAU_MARS');
      expect(body('Odd').frame).toBe(WORLD_FRAME);
      const text = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(text).toMatch(/"Odd".*not supported/);
      // IAU_ROVER has no body behind it in this catalog and no SPICE.
      expect(text).toMatch(/"Cam".*IAU_ROVER/);
    } finally {
      warn.mockRestore();
    }
  });

  it('orients through the same registry that positions: a declared frame reaches the orientation', () => {
    const half = Math.SQRT1_2;
    const u = new Universe();
    u.loadCatalog({
      name: 'tilted',
      // 90° about +X from the scene frame.
      frames: [{ name: 'TILT', base: 'ECLIPJ2000', quaternion: [half, half, 0, 0] }],
      items: [{ name: 'Probe', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } }],
    } as unknown as CatalogJson);
    const probe = u.getBody('Probe')!;
    probe.setRotation(new FixedRotation([1, 0, 0, 0], 'TILT'));

    const q = u.bodyToWorldQuat(probe, 0)!;
    const bodyAxis: Vec3 = [0, 1, 0];
    const qr = probe.rotationAt(0)!;
    const inSource = rotateVecByQuat(bodyAxis, [qr[0], -qr[1], -qr[2], -qr[3]]);
    const expected = u.toWorldFrame(inSource, 'TILT', undefined, 0);
    expect(maxAbsDiff(rotateVecByQuat(bodyAxis, q), expected)).toBeLessThan(1e-12);
    // The built-in registry alone cannot see TILT — the gap this closes.
    const viaDefault = rotateVecByQuat(bodyAxis, composeBodyToWorldQuat(qr, 'TILT', WORLD_FRAME, 0));
    expect(maxAbsDiff(viaDefault, expected)).toBeGreaterThan(0.5);
  });

  it('follows a composite ancestor’s active arc center, not its static parent', () => {
    const u = new Universe();
    u.addBody(new Body({ name: 'Earth', trajectory: new FixedPointTrajectory([1.5e8, 0, 0]) }));
    u.addBody(new Body({ name: 'Moon', parentName: 'Earth', trajectory: new FixedPointTrajectory([384400, 0, 0]) }));
    const phases = new CompositeTrajectory([
      { trajectory: new FixedPointTrajectory([7000, 0, 0]), startTime: 0, endTime: 100, centerName: 'Earth' },
      { trajectory: new FixedPointTrajectory([2000, 0, 0]), startTime: 100, endTime: 200, centerName: 'Moon' },
    ]);
    // Static parent is Earth; in the second phase the spacecraft orbits the Moon.
    u.addBody(new Body({ name: 'Craft', parentName: 'Earth', trajectory: phases }));
    u.addBody(new Body({ name: 'Instrument', parentName: 'Craft', trajectory: new FixedPointTrajectory([0.001, 0, 0]) }));
    expect(u.absolutePositionOf('Instrument', 50)[0]).toBeCloseTo(1.5e8 + 7000.001, 6);
    expect(u.absolutePositionOf('Instrument', 150)[0]).toBeCloseTo(1.5e8 + 384400 + 2000.001, 6);
  });
});

describe('Review fixes: SPICE-present validation', () => {
  let spice: SpiceInstance;
  beforeAll(async () => {
    const s = await Spice.init();
    for (const f of ['naif0012.tls', 'pck00010.tpc', 'de425s.bsp']) {
      await s.furnish({ type: 'buffer', data: kernelArrayBuffer(readFileSync(join(KERNELS, f))), filename: f });
    }
    spice = s;
  }, 30000);

  it('reports a frame SPICE does not recognize, on items and arcs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      new CatalogLoader({ spice }).load({
        name: 'typos',
        items: [
          { name: 'Mars', trajectoryFrame: 'IAU_MARS', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
          { name: 'A', trajectoryFrame: 'ECLIPJ200', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
          {
            name: 'B',
            arcs: [{ trajectoryFrame: 'LVLH', trajectory: { type: 'FixedPoint', position: [0, 0, 0] }, startTime: 0, endTime: 1 }],
          },
        ],
      } as unknown as CatalogJson);
      const text = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(text).toMatch(/"A".*ECLIPJ200.*SPICE does not recognize/);
      expect(text).toMatch(/"B \(arc 0\)".*state-dependent/);
      // IAU_MARS is in the PCK: no warning.
      expect(text).not.toMatch(/"Mars"/);
    } finally {
      warn.mockRestore();
    }
  });

  it('queries SPICE in J2000 for a body-fixed frame SPICE has no definition of', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { bodies } = new CatalogLoader({ spice }).load({
        name: 'bodyfixed spice',
        items: [
          { name: 'Probe', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
          {
            name: 'Mars', center: 'Sun', trajectoryFrame: { type: 'BodyFixed', body: 'Probe' },
            trajectory: { type: 'Spice', target: 'MARS BARYCENTER', center: 'SUN' },
          },
        ],
      } as unknown as CatalogJson);
      const mars = bodies.find((b) => b.name === 'Mars')!;
      expect((mars.trajectory as SpiceTrajectory).spiceFrame).toBe('J2000');
      expect(mars.frame).toBe('EME2000');
      expect(Number.isFinite(mars.stateAt(spice.str2et('2020-01-01')).position[0])).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
