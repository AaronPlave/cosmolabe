import { beforeAll, describe, expect, it } from 'vitest';
import { createHeritageSpice } from '@cosmolabe/frames';
import { Universe } from '../Universe.js';
import { FrameRegistry } from '../frames/FrameRegistry.js';
import { LUNAR_SURFACE_FRAME, lunarProductFrame } from '../geographic/lunar-frame.js';
import { surfaceTrajectoryAvailability, type SurfaceTrajectoryProvenance } from '../geometry/surface-trajectory.js';
import { composeBodyToWorldQuat, rotateVecByQuat, subPointOf, bodyFixedVelocityMagnitudeOf } from '../kinematics.js';
import { mat3Vec } from '../frames/mat3.js';
import { furnishKernels, VIEWER_KERNELS } from './_harness/kernels.js';
import type { SpiceInstance, Vec3 } from '../spice-injection.js';
import type { CatalogJson } from '../catalog/CatalogLoader.js';

const datum = { referenceShape: { kind: 'sphere' as const, radiusKm: 1737.4 }, verticalDatum: 'reference-sphere' as const, heightConvention: 'radial' as const };
const provenance: SurfaceTrajectoryProvenance = { frame: LUNAR_SURFACE_FRAME, datum, positionUnits: 'km', purpose: 'supplied', terrainRevision: 'planned-v1' };
const catalog: CatalogJson = { items: [{ name: 'Moon', trajectory: { type: 'FixedPoint', position: [0, 0, 0] }, rotationModel: { type: 'Spice', bodyFrame: LUNAR_SURFACE_FRAME }, items: [
  { name: 'Surface', surfaceTrajectory: provenance, trajectory: { type: 'Waypoints', referenceRadius: 1737.4, waypoints: [
    { t: 0, lat: -89.67, lon: 129.78, alt: '-1km' }, { t: 1e9, lat: -89.67, lon: 129.78, alt: '-1km' },
  ] } },
  { name: 'LRO', trajectory: { type: 'Spice', target: 'LRO', center: 'MOON' }, trajectoryFrame: LUNAR_SURFACE_FRAME },
] }] };
const delta = (a: Vec3, b: Vec3) => Math.hypot(...a.map((x, i) => x - b[i]));

describe('DE421 lunar surface placement', () => {
  let spice: SpiceInstance;
  beforeAll(async () => {
    spice = await createHeritageSpice();
    await furnishKernels(spice, ['naif0012.tls', 'pck00011.tpc', 'lro/moon_080317.tf', 'lro/moon_pa_de421_1900_2050.bpc', 'lro/lrorg_2024350_2025074_v01.bsp'], VIEWER_KERNELS);
  });

  it('keeps IAU_MOON distinct while body-fixed children and rendered axes use the declared ME realization', () => {
    const u = new Universe(spice); u.loadCatalog(catalog);
    expect(u.resolveFrame('BodyFixed', 'Moon')).toBe(LUNAR_SURFACE_FRAME);
    for (const utc of ['2000-01-01T12:00:00', '2010-06-01T00:00:00', '2025-01-15T00:03:00', '2028-12-15T10:04:00']) {
      const et = spice.str2et(utc), moon = u.getBody('Moon')!;
      const q = composeBodyToWorldQuat(moon.rotationAt(et)!, moon.rotation!.sourceFrame, undefined, et, u.frames);
      for (const v of [[1737.4, 0, 0], [0, 1737.4, 0], [0, 0, -1737.4], [1000, 1000, 1000]] as Vec3[]) {
        expect(delta(rotateVecByQuat(v, q), mat3Vec(spice.pxform(LUNAR_SURFACE_FRAME, 'ECLIPJ2000', et), v))).toBeLessThan(1e-9);
        expect(delta(u.frames.transformRequired(v, 'IAU_MOON', 'ECLIPJ2000', et), mat3Vec(spice.pxform('IAU_MOON', 'ECLIPJ2000', et), v))).toBeLessThan(1e-9);
      }
      const p = u.getBody('Surface')!.stateAt(et).position;
      expect(delta(u.absolutePositionOf('Surface', et), mat3Vec(spice.pxform(LUNAR_SURFACE_FRAME, 'ECLIPJ2000', et), p))).toBeLessThan(1e-9);
      // The mismatch is measurable, not an alias or quaternion roundoff.
      expect(delta(mat3Vec(spice.pxform(LUNAR_SURFACE_FRAME, 'IAU_MOON', et), [1737.4, 0, 0]), [1737.4, 0, 0])).toBeGreaterThan(0.001);
    }
  });

  it('classifies exact non-IAU lunar rotation targets as body-fixed without aliasing IAU_MOON', () => {
    const u = new Universe(spice);
    u.loadCatalog(catalog);
    const de421 = u.frames.get(LUNAR_SURFACE_FRAME)!;
    expect(de421.kind).toBe('body-fixed');
    expect(u.frames.get('IAU_MOON')!.kind).toBe('body-fixed');
    expect(u.frames.sameFrame('IAU_MOON', LUNAR_SURFACE_FRAME)).toBe(false);
    expect(u.frames.get('EME2000')!.kind).toBe('inertial');
    const et = spice.str2et('2028-12-15T10:04:00');
    expect(u.frames.transformRequired([1, 2, 3], LUNAR_SURFACE_FRAME, 'ECLIPJ2000', et))
      .toEqual(mat3Vec(spice.pxform(LUNAR_SURFACE_FRAME, 'ECLIPJ2000', et), [1, 2, 3]));
    // Removing the body must not leave a cached body-fixed classification.
    u.removeBody('Moon');
    expect(u.frames.get(LUNAR_SURFACE_FRAME)!.kind).toBe('inertial');
    u.loadCatalog(catalog);
    expect(u.frames.get(LUNAR_SURFACE_FRAME)!.kind).toBe('body-fixed');
  });

  it('classifies a declared non-IAU lunar SPICE frame as body-fixed, including after catalog changes', () => {
    const u = new Universe(spice);
    // An unknown SPICE name must not be classified from its spelling alone.
    expect(u.frames.get(LUNAR_SURFACE_FRAME)?.kind).toBe('inertial');
    u.loadCatalog(catalog);
    expect(u.frames.get(LUNAR_SURFACE_FRAME)?.kind).toBe('body-fixed');
    expect(u.frames.get('IAU_MOON')?.kind).toBe('body-fixed');
    expect(u.frames.get('ECLIPJ2000')?.kind).toBe('inertial');
    // Replacing the body's rotation target invalidates an earlier classification.
    u.loadCatalog({ items: [{ name: 'Moon', trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
      rotationModel: { type: 'Builtin', name: 'IAU_MOON' } }] });
    expect(u.frames.get(LUNAR_SURFACE_FRAME)?.kind).toBe('inertial');
  });

  it('reports surface coordinates and co-rotating speeds in the selected realization', () => {
    const u = new Universe(spice); u.loadCatalog(catalog);
    const at = (name: string) => u.getBody(name);
    const et = spice.str2et('2028-12-15T10:04:00');
    const point = subPointOf(at, 'Surface', et, u.frames)!;
    expect(point.lat).toBeCloseTo(-89.67, 8); expect(point.lon).toBeCloseTo(129.78, 8);
    expect(bodyFixedVelocityMagnitudeOf(at, 'Surface', et, 1, u.frames)).toBeLessThan(1e-9);
    u.loadCatalog({ items: [{ name: 'IAU input', center: 'Moon', trajectoryFrame: 'IAU_MOON', trajectory: { type: 'FixedPoint', position: [1737.4, 0, 0] } }] });
    const expected = mat3Vec(spice.pxform('IAU_MOON', LUNAR_SURFACE_FRAME, et), [1737.4, 0, 0]);
    const iau = subPointOf(at, 'IAU input', et, u.frames)!;
    expect(iau.lat).toBeCloseTo(Math.asin(expected[2]/1737.4)*180/Math.PI, 9);
    expect(iau.lon).toBeCloseTo(Math.atan2(expected[1],expected[0])*180/Math.PI, 9);
  });

  it('normalizes a structured body-fixed reference against a parent declared in the same catalog', () => {
    const u = new Universe(spice);
    u.loadCatalog({ items: [{ ...catalog.items![0], items: [{ name: 'Structured',
      trajectoryFrame: { type: 'BodyFixed', body: 'Moon' }, trajectory: { type: 'FixedPoint', position: [1737.4, 0, 0] } }] }] });
    expect(u.frameOf('Structured', 0)).toBe(LUNAR_SURFACE_FRAME);
    expect(delta(u.absolutePositionOf('Structured', 0), mat3Vec(spice.pxform(LUNAR_SURFACE_FRAME, 'ECLIPJ2000', 0), [1737.4, 0, 0]))).toBeLessThan(1e-9);
  });

  it('places a real LRO reconstruction through the same transform as the surface', () => {
    const u = new Universe(spice); u.loadCatalog(catalog);
    for (const utc of ['2025-01-15T00:03:00', '2025-01-16T12:00:00', '2025-02-01T00:00:00']) {
      const et = spice.str2et(utc);
      expect(delta(u.absolutePositionOf('LRO', et), spice.spkpos('LRO', et, 'ECLIPJ2000', 'NONE', 'MOON').position)).toBeLessThan(1e-9);
    }
  });

  it('reports datum and planning revision disagreements without changing absolute waypoint positions', () => {
    const u = new Universe(spice); u.loadCatalog(catalog);
    const body = u.getBody('Surface')!, before = body.stateAt(0);
    const result = u.surfaceTrajectoryStatus('Surface', 0, { frame: 'IAU_MOON', datum: { ...datum, verticalDatum: 'unknown' }, terrainRevision: 'current-v2' });
    expect(result?.kind).toBe('available');
    expect(result?.diagnostics.map(d => d.code)).toEqual(['frame-disagreement', 'datum-disagreement', 'terrain-revision-disagreement']);
    expect(body.stateAt(0)).toEqual(before);
    expect(Math.hypot(...before.position)).toBeCloseTo(1736.4, 10);
    expect(body.trajectory).toMatchObject({ useAbsoluteAlt: true, frame: LUNAR_SURFACE_FRAME });
  });

  it('withholds unavailable ME placement with no engine, no binary PCK or out of coverage', async () => {
    const missing = await createHeritageSpice();
    await furnishKernels(missing, ['naif0012.tls', 'pck00011.tpc', 'lro/moon_080317.tf'], VIEWER_KERNELS);
    for (const u of [new Universe(), new Universe(missing), new Universe(spice)]) {
      u.loadCatalog({ items: [{ ...catalog.items![0], items: [catalog.items![0].items![0]] }] });
      const et = u.spiceInstance === spice ? 1e11 : 0;
      expect(u.absolutePositionOf('Surface', et).every(Number.isNaN)).toBe(true);
      expect(u.surfaceTrajectoryStatus('Surface', et, { frame: LUNAR_SURFACE_FRAME, datum })?.kind).toBe('unavailable');
    }
  });

  it('withholds contradictory input frame declarations without changing supplied Cartesian states', () => {
    const u = new Universe(spice);
    const samples = [{ et: 0, position: [1736, 0, 0] as Vec3, velocity: [0, 0, 0] as Vec3 }, { et: 1e9, position: [1736, 0, 0] as Vec3, velocity: [0, 0, 0] as Vec3 }];
    u.loadCatalog({ items: [{ name: 'Absolute', trajectoryFrame: 'IAU_MOON', surfaceTrajectory: provenance,
      trajectory: { type: 'InterpolatedStates', samples } }] });
    expect(u.getBody('Absolute')!.stateAt(0).position).toEqual([1736, 0, 0]);
    expect(u.frames.isResolvable('IAU_MOON', 0)).toBe(true);
    expect(u.frames.isResolvable(LUNAR_SURFACE_FRAME, 0)).toBe(true);
    expect(u.absolutePositionOf('Absolute', 0).every(Number.isNaN)).toBe(true);
    expect(u.relativePositionInWorld('Absolute', 0).every(Number.isNaN)).toBe(true);
    expect(u.trajectoryPlacementAvailable('Absolute', 0)).toBe(false);
    expect(u.surfaceTrajectoryStatus('Absolute', 0, { frame: LUNAR_SURFACE_FRAME, datum })?.kind).toBe('unavailable');
  });

  it('limits metadata errata to audited immutable revisions', () => {
    expect(lunarProductFrame('IAU_MOON', 'cube-fused-79895697c6b6-g3-m12-b6747ec9d')).toBe(LUNAR_SURFACE_FRAME);
    expect(lunarProductFrame('IAU_MOON', 'unknown')).toBe('IAU_MOON');
    expect(lunarProductFrame('IAU_MARS', 'cube-fused-79895697c6b6-g3-m12-b6747ec9d')).toBe('IAU_MARS');
    expect(surfaceTrajectoryAvailability(provenance, { frame: LUNAR_SURFACE_FRAME, datum }, new FrameRegistry(), 0).kind).toBe('unavailable');
  });
});
