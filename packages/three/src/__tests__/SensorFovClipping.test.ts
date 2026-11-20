import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import type { BodyMesh } from '../BodyMesh.js';
import { SensorFovClipping } from '../SensorFovClipping.js';
import { TerrainSampler, geodeticToBodyFixed, type TerrainDatum } from '../TerrainSampler.js';
import { geographicTileBounds } from '../TerrainValidation.js';
import { decodeQuantizedMesh, toTerrainMeshTile } from '../internal/quantized-mesh.js';
import { fovBaseParams, fovBoundaryDirection, type Vec3 } from '../surface/FovClipper.js';

const radii: [number, number, number] = [3396.19, 3396.19, 3376.2];
const datum: TerrainDatum = { referenceShape: { kind: 'ellipsoid', radiiKm: radii }, verticalDatum: 'ellipsoid', heightConvention: 'geodetic-normal' };

/** The slice of BodyMesh the clipping owner reads: no WebGL needed. */
function fakeMars(sampler: TerrainSampler | null, visible = true): BodyMesh {
  return {
    body: { name: 'Mars', geometryType: 'Globe', radii },
    visible,
    terrainSampler: sampler,
    bodyToWorldQuaternion: (q: THREE.Quaternion) => q.identity(),
  } as unknown as BodyMesh;
}

function scene() {
  const sampler = new TerrainSampler(datum, { id: 'marshub', kind: 'quantized-mesh' }, 8);
  const bytes = readFileSync(new URL('./fixtures/marshub-14-23432-9870.terrain', import.meta.url));
  const tile = toTerrainMeshTile(decodeQuantizedMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    { id: '14/23432/9870', ...geographicTileBounds({ z: 14, x: 23432, y: 9870 }) });
  sampler.addTile(tile);
  const lat = (tile.southDeg + tile.northDeg) / 2, lon = (tile.westDeg + tile.eastDeg) / 2;
  const above = geodeticToBodyFixed({ latDeg: lat, lonDeg: lon, heightKm: 100 }, datum);
  const below = geodeticToBodyFixed({ latDeg: lat, lonDeg: lon, heightKm: -10 }, datum);
  const origin: Vec3 = [above.xKm, above.yKm, above.zKm];
  const z = [below.xKm - above.xKm, below.yKm - above.yKm, below.zKm - above.zKm];
  const zl = Math.hypot(...z);
  const Z: Vec3 = [z[0] / zl, z[1] / zl, z[2] / zl];
  const xl = Math.hypot(Z[1], Z[0]);
  const X: Vec3 = [-Z[1] / xl, Z[0] / xl, 0];
  const Y: Vec3 = [Z[1] * X[2] - Z[2] * X[1], Z[2] * X[0] - Z[0] * X[2], Z[0] * X[1] - Z[1] * X[0]];
  const shape = { kind: 'elliptical' as const, tanHalfH: Math.tan(0.05 * Math.PI / 180), tanHalfV: Math.tan(0.05 * Math.PI / 180) };
  const directionAt = (t: number): Vec3 => {
    const d = fovBoundaryDirection(shape, t);
    return [X[0] * d[0] + Y[0] * d[1] + Z[0] * d[2], X[1] * d[0] + Y[1] * d[1] + Z[1] * d[2], X[2] * d[0] + Y[2] * d[1] + Z[2] * d[2]];
  };
  return { sampler, origin, directionAt, base: fovBaseParams(shape, 32) };
}
const atCenter = () => [0, 0, 0] as [number, number, number];

describe('SensorFovClipping (renderer-side owner)', () => {
  it('clips against resident terrain, then defers whole sensors to the reference shape once the frame budget is spent', () => {
    const { sampler, origin, directionAt, base } = scene();
    const clipping = new SensorFovClipping();
    clipping.begin(0, [0, 0, 0], [fakeMars(sampler)], atCenter);
    const directionFor = (i: number) => (t: number) => directionAt(t + i / (base.length * 200));
    const sources: string[][] = [];
    for (let i = 0; i < 200; i++) {
      const samples = clipping.clipperFor(`Cam${i}`, 'target')(origin, directionFor(i), base, 1000);
      expect(samples.every(s => s.hit?.candidateId === 'Mars')).toBe(true);
      // A sensor is terrain-clipped entirely or not at all: no seam mid-perimeter.
      sources.push([...new Set(samples.map(s => `${s.hit!.source}${s.hit!.fallback ? '+fallback' : ''}`))]);
    }
    expect(sources[0]).toEqual(['terrain']);
    expect(sources.at(-1)).toEqual(['reference+fallback']);
    const firstDeferred = sources.findIndex(s => s[0] !== 'terrain');
    expect(firstDeferred).toBeGreaterThan(0);
    expect(sources.slice(firstDeferred).every(s => s.length === 1 && s[0] === 'reference+fallback')).toBe(true);
    expect(clipping.terrainTrianglesThisFrame()).toBeLessThan(200_000);

    // Next frame at the same epoch (paused): terrain results are reused at no
    // cost, so the budget now reaches sensors that were deferred last frame.
    clipping.begin(0, [0, 0, 0], [fakeMars(sampler)], atCenter);
    for (let i = 0; i < firstDeferred; i++) clipping.clipperFor(`Cam${i}`, 'target')(origin, directionFor(i), base, 1000);
    expect(clipping.terrainTrianglesThisFrame()).toBe(0);
    const retried = clipping.clipperFor(`Cam${firstDeferred}`, 'target')(origin, directionFor(firstDeferred), base, 1000);
    expect(retried.every(s => s.hit?.source === 'terrain')).toBe(true);
  });

  it('shares terrain rays across overlapping instruments without spending the frame budget repeatedly', () => {
    const { sampler, origin, directionAt, base } = scene();
    const clipping = new SensorFovClipping();
    clipping.begin(0, [0, 0, 0], [fakeMars(sampler)], atCenter);
    const first = clipping.clipperFor('Cam0', 'target')(origin, directionAt, base, 1000);
    const triangles = clipping.terrainTrianglesThisFrame();
    expect(triangles).toBeGreaterThan(0);
    for (let i = 1; i < 40; i++) {
      const samples = clipping.clipperFor(`Cam${i}`, 'target')(origin, directionAt, base, 1000);
      expect(samples).toEqual(first);
      expect(clipping.terrainTrianglesThisFrame()).toBe(triangles);
    }
    // A new epoch must query the surface again, even with the same test rays.
    clipping.begin(1, [0, 0, 0], [fakeMars(sampler)], atCenter);
    clipping.clipperFor('Cam0', 'target')(origin, directionAt, base, 1000);
    expect(clipping.terrainTrianglesThisFrame()).toBe(triangles);
  });

  it('ignores hidden bodies and the sensor\'s own body', () => {
    const { origin, directionAt, base } = scene();
    const clipping = new SensorFovClipping();
    clipping.begin(0, [0, 0, 0], [fakeMars(null, false)], atCenter);
    expect(clipping.clipperFor('Cam', 'target')(origin, directionAt, base, 1000).every(s => s.hit === null)).toBe(true);
    clipping.begin(1, [0, 0, 0], [fakeMars(null)], atCenter);
    expect(clipping.clipperFor('Mars', 'target')(origin, directionAt, base, 1000).every(s => s.hit === null)).toBe(true);
    expect(clipping.clipperFor('Cam', 'target')(origin, directionAt, base, 1000).every(s => s.hit?.source === 'reference')).toBe(true);
  });
});

describe('SensorFovClipping on cube-sphere terrain', () => {
  // Cube-sphere terrain has no tile sampler, only Cartesian ray queries. A
  // lunar crater floor 1 km below the reference sphere, a drone 1.8 km above
  // it: the frustum must end on the floor, not 1 km up on the sphere.
  const R = 1737.4, FLOOR = R - 1;
  const meta = { bodyId: 'Moon', frame: 'MOON_ME', source: { id: 'cube', kind: 'height-grid' }, shape: { kind: 'globe', datum: { referenceShape: { kind: 'sphere', radiusKm: R }, verticalDatum: 'reference-sphere', heightConvention: 'radial' } }, coverage: 'partial-product' };
  function fakeMoon(resident: boolean): BodyMesh {
    return {
      body: { name: 'Moon', geometryType: 'Globe', radii: [R, R, R] },
      visible: true,
      terrainSampler: null,
      terrainRevision: 1,
      terrainRaySurface: meta,
      intersectTerrainRay: (ray: { origin: { xKm: number; yKm: number; zKm: number }; direction: Vec3; farKm: number }) => {
        if (!resident) return { kind: 'unavailable', reason: 'not-resident', metadata: meta };
        const o = [ray.origin.xKm, ray.origin.yKm, ray.origin.zKm], d = ray.direction;
        const b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2], c = o[0] ** 2 + o[1] ** 2 + o[2] ** 2 - FLOOR ** 2;
        const t = -b - Math.sqrt(b * b - c);
        const p = o.map((v, i) => v + t * d[i]);
        return { kind: 'hit', distanceKm: t, position: { xKm: p[0], yKm: p[1], zKm: p[2] }, metadata: meta };
      },
      bodyToWorldQuaternion: (q: THREE.Quaternion) => q.identity(),
    } as unknown as BodyMesh;
  }
  const origin: Vec3 = [0, 0, -(FLOOR + 1.8)];
  const h = Math.tan(20 * Math.PI / 180), v = Math.tan(15 * Math.PI / 180);
  const rect = { kind: 'polygon' as const, vertices: [[-h, -v, 1], [h, -v, 1], [h, v, 1], [-h, v, 1]] as Vec3[] };
  // Boresight straight down: +Z, toward the Moon's centre from below the south pole.
  const directionAt = (t: number): Vec3 => fovBoundaryDirection(rect, t);

  it('ends the frustum on the terrain, and falls back to the reference shape (flagged) where it is not resident', () => {
    const clipping = new SensorFovClipping();
    clipping.begin(0, [0, 0, 0], [fakeMoon(true)], atCenter);
    const base = fovBaseParams(rect, 8);
    const hits = clipping.clipperFor('Cam', 'attitude')(origin, directionAt, base, 5);
    expect(hits.every(s => s.hit?.source === 'terrain' && !s.hit.fallback)).toBe(true);
    for (const s of hits) {
      const p = origin.map((v, i) => v + s.direction[i] * s.distanceKm);
      expect(Math.abs(Math.hypot(...p) - FLOOR)).toBeLessThan(0.01);
    }
    clipping.begin(1, [0, 0, 0], [fakeMoon(false)], atCenter);
    const ref = clipping.clipperFor('Cam', 'attitude')(origin, directionAt, base, 5);
    expect(ref.every(s => s.hit?.source === 'reference' && s.hit.fallback)).toBe(true);
  });
});
