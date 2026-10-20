import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Body } from '@cosmolabe/core';
import { SensorFrustum, type SensorFovClipper } from '../SensorFrustum.js';
import { clipFovPerimeter, type FovSurfaceCandidate, type Vec3 } from '../surface/FovClipper.js';
import { ReferenceEllipsoidSurface } from '../surface/ReferenceEllipsoidSurface.js';

// SensorFrustum draws its label into a canvas; Node has no DOM, so stub the 2D context.
const g = globalThis as { document?: unknown };
let hadDocument = false;
beforeAll(() => {
  hadDocument = 'document' in g;
  if (!hadDocument) {
    g.document = {
      createElement: () => ({
        width: 0, height: 0,
        getContext: () => ({ measureText: () => ({ width: 40 }), fillText() {}, font: '', textBaseline: '', shadowColor: '', shadowBlur: 0, fillStyle: '' }),
      }),
    };
  }
});
afterAll(() => { if (!hadDocument) delete g.document; });

const R = 1000;
const target = { name: 'Target', stateAt: () => ({ position: [0, 0, 0] }) } as unknown as Body;

function sensor(geometryData: Record<string, unknown>): SensorFrustum {
  const body = { name: 'Cam', geometryData, stateAt: () => ({ position: [0, 0, 10000] }) } as unknown as Body;
  return new SensorFrustum(body);
}

function clipper(candidates: FovSurfaceCandidate[]): SensorFovClipper {
  return (originKm, directionAt, baseParams, maxRangeKm) => clipFovPerimeter(originKm, directionAt, baseParams, candidates, { maxRangeKm });
}

const ball: FovSurfaceCandidate = {
  id: 'Target', centerKm: [0, 0, 0], bodyToWorld: [1, 0, 0, 0, 1, 0, 0, 0, 1], boundingRadiusKm: R,
  surfaces: [new ReferenceEllipsoidSurface('Target', 'TARGET_FIXED', [R, R, R])],
};

/** World-space triangles of the filled frustum (scale factor 1 → km). */
function triangles(sf: SensorFrustum): Vec3[][] {
  const mesh = (sf as unknown as { frustumMesh: { geometry: { getAttribute(n: string): { array: Float32Array } } } }).frustumMesh;
  const a = mesh.geometry.getAttribute('position').array;
  const out: Vec3[][] = [];
  for (let i = 0; i < a.length; i += 9) {
    out.push([0, 3, 6].map(k => [a[i + k] + sf.position.x, a[i + k + 1] + sf.position.y, a[i + k + 2] + sf.position.z] as Vec3));
  }
  return out;
}

describe('SensorFrustum physical clipping (reference scene)', () => {
  it('draws to the target-center distance when no clipper is supplied', () => {
    const sf = sensor({ horizontalFov: 4, verticalFov: 4 });
    sf.update(0, 1, target);
    expect(sf.clipSummary).toMatchObject({ clipped: false, hitSamples: 0, maxRangeKm: 10000 });
    expect(sf.perimeter.every(s => s.distanceKm === 10000)).toBe(true);
    sf.dispose();
  });

  it('terminates a target-pointed FOV at the surface with no geometry through the body', () => {
    const sf = sensor({ horizontalFov: 8, verticalFov: 6, shape: 'rectangular', range: 30000 });
    sf.update(0, 1, target, undefined, undefined, clipper([ball]));
    expect(sf.clipSummary).toMatchObject({ clipped: true, bodies: ['Target'], sources: ['reference'], coarse: false, fallback: false, maxRangeKm: 30000 });
    expect(sf.clipSummary!.hitSamples).toBe(sf.clipSummary!.samples);
    // Any viewpoint sees only what exists: probe every face densely; nothing
    // may sit deeper inside the body than the bounded chord sag.
    let deepest = 0;
    for (const [o, p, q] of triangles(sf)) {
      for (let u = 0; u <= 1; u += 0.125) for (let v = 0; u + v <= 1; v += 0.125) {
        const x: Vec3 = [o[0] + u * (p[0] - o[0]) + v * (q[0] - o[0]), o[1] + u * (p[1] - o[1]) + v * (q[1] - o[1]), o[2] + u * (p[2] - o[2]) + v * (q[2] - o[2])];
        deepest = Math.max(deepest, R - Math.hypot(...x));
      }
    }
    expect(deepest).toBeLessThan(0.005 * R);
    // The label rides the clipped far boundary, not the old target-center plane.
    expect(Math.hypot(sf.labelSprite.position.x, sf.labelSprite.position.y, sf.labelSprite.position.z + 10000)).toBeCloseTo(R, 0);
    sf.dispose();
  });

  it('keeps a grazing FOV partially clipped and the rest at max range', () => {
    // Boresight from the catalog orientation is applied after target pointing;
    // tilt by the limb angle about the mesh horizontal axis.
    const limb = Math.asin(R / 10000);
    const sf = sensor({ horizontalFov: 6, verticalFov: 6, range: 15000, orientation: [Math.sin(limb / 2), 0, 0, Math.cos(limb / 2)] });
    sf.update(0, 1, target, undefined, undefined, clipper([ball]));
    const summary = sf.clipSummary!;
    expect(summary.hitSamples).toBeGreaterThan(0);
    expect(summary.hitSamples).toBeLessThan(summary.samples);
    expect(summary.samples).toBeGreaterThan(32); // limb refined
    expect(sf.perimeter.filter(s => !s.hit).every(s => s.distanceKm === 15000)).toBe(true);
    sf.dispose();
  });

  it('follows SPICE polygon bounds when pointing comes from SPICE', () => {
    const sf = sensor({ horizontalFov: 10, verticalFov: 10, range: 20000 });
    sf.spiceFovBoundary = { kind: 'polygon', vertices: [[-0.05, -0.02, 1], [0.05, -0.02, 1], [0, 0.06, 1]] };
    // Instrument +Z → world -Z (pointing at the target), rows of instrument→world.
    sf.update(0, 1, target, undefined, [1, 0, 0, 0, -1, 0, 0, 0, -1], clipper([ball]));
    expect(sf.perimeter.filter(s => s.base)).toHaveLength(3 * 11); // round(32 / 3) per edge
    expect(sf.clipSummary!.hitSamples).toBe(sf.clipSummary!.samples);
    sf.dispose();
  });
});
