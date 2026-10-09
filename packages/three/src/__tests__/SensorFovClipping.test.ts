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
    const sources: string[][] = [];
    for (let i = 0; i < 40; i++) {
      const samples = clipping.clipperFor(`Cam${i}`, 'target')(origin, directionAt, base, 1000);
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
    for (let i = 0; i < firstDeferred; i++) clipping.clipperFor(`Cam${i}`, 'target')(origin, directionAt, base, 1000);
    expect(clipping.terrainTrianglesThisFrame()).toBe(0);
    const retried = clipping.clipperFor(`Cam${firstDeferred}`, 'target')(origin, directionAt, base, 1000);
    expect(retried.every(s => s.hit?.source === 'terrain')).toBe(true);
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
