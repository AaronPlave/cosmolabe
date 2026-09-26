/**
 * Body-fixed orientation of solar-system bodies (#118).
 *
 * A planet or moon's rendered globe must sit in the same body-fixed frame the
 * SPICE-backed analysis uses (sub-points, footprints, event finders), so the
 * checks here compare against CSPICE's own IAU_<BODY> frames rather than
 * against a hand-tuned snapshot:
 *
 *   - `Builtin` rotations with a PCK loaded ARE the SPICE frame: the body→world
 *     orientation the renderer composes equals pxform(IAU_<BODY>, ECLIPJ2000).
 *   - The SPICE-free analytical fallback puts the pole and prime meridian where
 *     the PCK does (this is what catches a pole-convention mistake, e.g. an
 *     axial tilt w.r.t. the orbit fed in as an inclination from the J2000
 *     equator — the Europa Clipper Jupiter bug, ~25° off).
 *   - With SPICE present but no orientation data, `Builtin` falls back to the
 *     analytical model instead of producing a rotation that throws per frame.
 *   - Every hand-authored `Uniform` rotation left in the bundled catalogs for a
 *     body the PCK knows still agrees with the PCK pole.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Spice } from '@cosmolabe/spice';
import type { RotationMatrix, SpiceInstance, Vec3 } from '../spice-injection.js';
import { furnishKernels } from './_harness/kernels.js';
import { CatalogLoader, type CatalogItem, type CatalogJson } from '../catalog/CatalogLoader.js';
import { SpiceRotation } from '../rotations/SpiceRotation.js';
import { UniformRotation } from '../rotations/UniformRotation.js';
import type { RotationModel } from '../rotations/RotationModel.js';
import { composeBodyToWorldQuat, rotateVecByQuat } from '../kinematics.js';
import { quatToMat3, mat3Transpose, mat3Vec } from '../frames/mat3.js';
import { DEFAULT_FRAMES } from '../frames/FrameRegistry.js';
import { etFromCalendarString } from '../time.js';

const DEG = 180 / Math.PI;

/** Bodies with an IAU orientation model in pck00010.tpc. */
const PCK_BODIES = [
  'Sun', 'Mercury', 'Venus', 'Earth', 'Moon', 'Mars', 'Phobos', 'Deimos',
  'Jupiter', 'Io', 'Europa', 'Ganymede', 'Callisto',
  'Saturn', 'Mimas', 'Enceladus', 'Tethys', 'Dione', 'Rhea', 'Titan', 'Iapetus', 'Phoebe',
  'Uranus', 'Neptune', 'Pluto',
];

/** Bodies with an entry in the loader's analytical IAU table. */
const ANALYTICAL_BODIES = [
  'Sun', 'Mercury', 'Venus', 'Earth', 'Moon', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto',
];

function angleDeg(a: Vec3, b: Vec3): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const na = Math.hypot(...a), nb = Math.hypot(...b);
  return Math.acos(Math.max(-1, Math.min(1, dot / (na * nb)))) * DEG;
}

/** Body-fixed axis `v` expressed in J2000, from a rotation model. */
function axisInJ2000(rot: RotationModel, v: Vec3, et: number): Vec3 {
  const inSource = mat3Vec(mat3Transpose(quatToMat3(rot.rotationAt(et))), v);
  const toJ2000 = DEFAULT_FRAMES.rotation(rot.sourceFrame, 'J2000', et)!;
  return mat3Vec(toJ2000, inSource);
}

function loadRotation(loader: CatalogLoader, item: Partial<CatalogItem>): RotationModel | undefined {
  const json: CatalogJson = {
    items: [{ name: 'X', trajectory: { type: 'FixedPoint', position: [0, 0, 0] }, ...item } as CatalogItem],
  };
  return loader.load(json).bodies[0].rotation;
}

describe('SPICE-backed body-fixed orientation', () => {
  let spice: SpiceInstance;
  const epochs = [
    0,
    etFromCalendarString('2004-07-01T00:00:00Z'),
    etFromCalendarString('2031-03-06T12:00:00Z'), // Europa Clipper science phase
  ];

  beforeAll(async () => {
    spice = await Spice.init();
    await furnishKernels(spice, ['naif0012.tls', 'pck00010.tpc']);
  });

  for (const trajectoryFrame of ['J2000', 'ECLIPJ2000'] as const) {
    it(`Builtin rotation equals pxform(IAU_<BODY>) through the render composition (trajectoryFrame ${trajectoryFrame})`, () => {
      const loader = new CatalogLoader(spice);
      for (const name of PCK_BODIES) {
        const rot = loadRotation(loader, { name, trajectoryFrame, rotationModel: { type: 'Builtin' } });
        expect(rot, name).toBeInstanceOf(SpiceRotation);
        const iau = `IAU_${name.toUpperCase()}`;
        for (const et of epochs) {
          // What BodyMesh applies to the globe: body-fixed → EclipticJ2000.
          const q = composeBodyToWorldQuat(rot!.rotationAt(et), rot!.sourceFrame, 'EclipticJ2000', et);
          const truth: RotationMatrix = spice.pxform(iau, 'ECLIPJ2000', et);
          for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[]) {
            const rendered = rotateVecByQuat(axis, q);
            const expected = mat3Vec(truth, axis);
            // 1e-6 rad ≈ 0.2″ — quaternion round-trip noise only.
            expect(angleDeg(rendered, expected) / DEG, `${name} axis ${axis} @ ${et}`).toBeLessThan(1e-6);
          }
        }
      }
    });
  }

  it('Spice rotation defaults to IAU_<BODY>', () => {
    const loader = new CatalogLoader(spice);
    const rot = loadRotation(loader, { name: 'Jupiter', trajectoryFrame: 'J2000', rotationModel: { type: 'Spice' } });
    const m = spice.pxform('J2000', 'IAU_JUPITER', epochs[2]);
    const q = quatToMat3(rot!.rotationAt(epochs[2]));
    for (let i = 0; i < 9; i++) expect(q[i]).toBeCloseTo(m[i], 9);
  });

  it('default body-fixed frame names normalise like the frame registry (multi-word, hyphens, padding)', () => {
    // Record the frame each rotation asks SPICE for; answer with identity.
    const asked: string[] = [];
    const recorder = {
      furnish: async () => {},
      str2et: () => 0,
      bodn2c: () => null,
      pxform: (_from: string, to: string) => { asked.push(to); return [1, 0, 0, 0, 1, 0, 0, 0, 1]; },
    } as unknown as SpiceInstance;
    const loader = new CatalogLoader(recorder);
    for (const type of ['Spice', 'Builtin']) {
      for (const [name, frame] of [['Ingenuity Heli', 'IAU_INGENUITY_HELI'], [' Comet-Wild 2 ', 'IAU_COMET_WILD_2']]) {
        asked.length = 0;
        const rot = loadRotation(loader, { name, trajectoryFrame: 'J2000', rotationModel: { type } });
        expect(rot, `${type} ${name}`).toBeInstanceOf(SpiceRotation);
        rot!.rotationAt(0);
        expect(asked.at(-1), `${type} ${name}`).toBe(frame);
      }
    }
    // An explicit Builtin frame name is normalised the same way.
    asked.length = 0;
    loadRotation(loader, { name: 'Moon', rotationModel: { type: 'Builtin', name: 'IAU Moon' } })!.rotationAt(0);
    expect(asked.at(-1)).toBe('IAU_MOON');
  });

  it('analytical IAU fallback puts pole and prime meridian where the PCK does', () => {
    const loader = new CatalogLoader();
    for (const name of ANALYTICAL_BODIES) {
      const rot = loadRotation(loader, { name, rotationModel: { type: 'Builtin' } });
      expect(rot, name).toBeInstanceOf(UniformRotation);
      const iauToJ2000 = spice.pxform(`IAU_${name.toUpperCase()}`, 'J2000', 0);
      const pole = angleDeg(axisInJ2000(rot!, [0, 0, 1], 0), mat3Vec(iauToJ2000, [0, 0, 1]));
      const meridian = angleDeg(axisInJ2000(rot!, [1, 0, 0], 0), mat3Vec(iauToJ2000, [1, 0, 0]));
      // The table is the constant-rate baseline. The PCK adds periodic terms
      // it omits: ~0.7° for Neptune, ~1.6° of physical libration for the Moon.
      const tol = name === 'Moon' ? 2 : 1;
      expect(pole, `${name} pole`).toBeLessThan(tol);
      expect(meridian, `${name} prime meridian`).toBeLessThan(tol);
    }
  });

  it('Europa Clipper Jupiter sits in the Galilean system, not tilted ~25° off it', () => {
    const catalog = JSON.parse(readFileSync(join(__dirname, '../../../../apps/viewer/test-catalogs/europa-clipper.json'), 'utf8')) as CatalogJson;
    const loader = new CatalogLoader(spice);
    const flatten = (items: CatalogItem[]): CatalogItem[] => items.flatMap((i) => [i, ...flatten(i.items ?? [])]);
    const byName = new Map(flatten(catalog.items ?? []).map((i) => [i.name, i]));
    const et = epochs[2];
    const jupiterPole = mat3Vec(spice.pxform('IAU_JUPITER', 'J2000', et), [0, 0, 1]);
    for (const name of ['Jupiter', 'Io', 'Europa', 'Ganymede', 'Callisto']) {
      const item = byName.get(name)!;
      const rot = loadRotation(loader, { name, trajectoryFrame: item.trajectoryFrame, rotationModel: item.rotationModel });
      const pole = axisInJ2000(rot!, [0, 0, 1], et);
      // The Galilean moons orbit within ~0.5° of Jupiter's equator and are
      // tidally locked, so their spin poles all lie within ~1° of Jupiter's.
      expect(angleDeg(pole, jupiterPole), name).toBeLessThan(1);
    }
  });
});

describe('Builtin rotation with SPICE but no orientation data', () => {
  it('falls back to the analytical model instead of a rotation that throws', () => {
    const noPck = {
      furnish: async () => {},
      pxform: () => { throw new Error('SPICE(FRAMEDATANOTFOUND): insufficient orientation data'); },
      str2et: () => 0,
      bodn2c: () => null,
    } as unknown as SpiceInstance;
    const loader = new CatalogLoader(noPck);
    const rot = loadRotation(loader, { name: 'Jupiter', trajectoryFrame: 'J2000', rotationModel: { type: 'Builtin' } });
    expect(rot).toBeInstanceOf(UniformRotation);
    expect(() => rot!.rotationAt(0)).not.toThrow();
  });
});

describe('bundled catalogs: remaining Uniform rotations agree with the IAU pole', () => {
  let spice: SpiceInstance;
  beforeAll(async () => {
    spice = await Spice.init();
    await furnishKernels(spice, ['naif0012.tls', 'pck00010.tpc']);
  });

  const dirs = [
    join(__dirname, '../../../../apps/viewer/test-catalogs'),
    join(__dirname, '../../../../apps/viewer/test-catalogs/base'),
    join(__dirname, '../builtin-catalogs'),
  ];

  it('every hand-authored Uniform pole for a PCK body is within 2° of the PCK pole', () => {
    const loader = new CatalogLoader();
    const checked: string[] = [];
    const walk = (file: string, items: CatalogItem[]) => {
      for (const item of items) {
        const spec = item.rotationModel;
        const pckName = PCK_BODIES.find((b) => b.toUpperCase() === item.name.toUpperCase());
        if (spec?.type === 'Uniform' && pckName) {
          const rot = loadRotation(loader, { name: item.name, rotationModel: spec })!;
          const truth = mat3Vec(spice.pxform(`IAU_${pckName.toUpperCase()}`, 'J2000', 0), [0, 0, 1]);
          expect(angleDeg(axisInJ2000(rot, [0, 0, 1], 0), truth), `${file}: ${item.name}`).toBeLessThan(2);
          checked.push(`${file}:${item.name}`);
        }
        walk(file, item.items ?? []);
      }
    };
    for (const dir of dirs) {
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
        const json = JSON.parse(readFileSync(join(dir, f), 'utf8')) as CatalogJson;
        walk(f, json.items ?? []);
      }
    }
    // Guard against the walk silently finding nothing (e.g. a moved directory).
    expect(checked.length).toBeGreaterThan(0);
  });
});
