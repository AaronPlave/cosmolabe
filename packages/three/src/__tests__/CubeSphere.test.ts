import { describe, expect, it } from 'vitest';
import { CubeSphereSampler, cubeFaceToDirection, cubeTileAt, directionToCubeFace, type CubeFace, type CubeHeightTile } from '../surface/CubeSphere.js';
import type { TerrainDatum } from '../TerrainSampler.js';

const faces: CubeFace[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const sphere: TerrainDatum = { referenceShape: { kind: 'sphere', radiusKm: 1737.4 }, verticalDatum: 'reference-sphere', heightConvention: 'radial' };

describe('experimental cube-sphere addressing', () => {
  it('round trips every face, including points close to edges and corners', () => {
    for (const face of faces) for (const u of [-1, -0.999, 0, 0.999, 1]) for (const v of [-1, -0.25, 0.75, 1]) {
      const direction = cubeFaceToDirection(face, u, v);
      const inverse = directionToCubeFace(direction);
      // Exact edges can be owned by an adjacent higher-priority face. Direction,
      // rather than the non-unique face label, is the round-trip invariant.
      const rebuilt = cubeFaceToDirection(inverse.face, inverse.u, inverse.v);
      expect(Math.hypot(...rebuilt.map((value, i) => value - direction[i]))).toBeLessThan(1e-14);
    }
  });

  it('assigns exact edges and the eight corners deterministically', () => {
    expect(directionToCubeFace([1, 1, 0])).toMatchObject({ face: 'px', u: 0, v: 1 });
    expect(directionToCubeFace([1, 1, 1]).face).toBe('px');
    expect(directionToCubeFace([-1, -1, -1]).face).toBe('nx');
    expect(cubeTileAt([0, 0, 1], 2)).toMatchObject({ face: 'pz', x: 2, y: 2 });
    expect(cubeTileAt([1, 1, 0], 2)).toMatchObject({ face: 'px', x: 2, y: 3 });
  });

  it('samples a continuous analytic field on every face with explicit provenance', () => {
    const sampler = new CubeSphereSampler(sphere, { id: 'fused-lunar-fixture', kind: 'height-grid', version: 'synthetic-v1', uncertaintyKm: 0.001 });
    for (const face of faces) sampler.addTile(makeTile(face, 0, 0, 0, 9));
    for (const [lat, lon] of [[90, 0], [-90, 137], [0, 180], [0, -180], [35.26438968, 45], [0, 45]]) {
      const sample = sampler.sample(lat, lon)!;
      expect(sample).not.toBeNull();
      expect(sample.elevationKm).toBeCloseTo(field(lat, lon), 3);
      expect(sample.source.version).toBe('synthetic-v1');
      expect(sample.tileId).toMatch(/^(px|nx|py|ny|pz|nz)\/0\/0\/0$/);
    }
  });

  it('uses the ellipsoid geocentric ray rather than confusing it with its geodetic normal', () => {
    const ellipsoid: TerrainDatum = { referenceShape: { kind: 'ellipsoid', radiiKm: [2, 2, 1] }, verticalDatum: 'ellipsoid', heightConvention: 'geodetic-normal' };
    const sampler = new CubeSphereSampler(ellipsoid, { id: 'ellipsoid-fixture', kind: 'height-grid' });
    for (const face of faces) sampler.addTile({ face, level: 0, x: 0, y: 0, width: 2, height: 2, elevationsKm: new Float64Array(4).fill(faces.indexOf(face)) });
    // A 60 degree geodetic normal points into +Z ownership, but on this
    // flattened ellipsoid the surface point's geocentric latitude is only
    // atan(tan(60)/4) ~ 23.4 degrees, which +X owns.
    const result = sampler.sample(60, 0)!;
    expect(result.tileId).toBe('px/0/0/0');
    expect(result.elevationKm).toBe(0);
    expect(sampler.sample(80, 0)!.tileId).toBe('pz/0/0/0');
  });

  it('rejects datums the geodetic converters do not implement instead of addressing a substitute', () => {
    const source = { id: 'fixture', kind: 'height-grid' } as const;
    for (const datum of [
      { referenceShape: { kind: 'ellipsoid', radiiKm: [2, 1, 1] }, verticalDatum: 'ellipsoid', heightConvention: 'geodetic-normal' },
      { referenceShape: { kind: 'ellipsoid', radiiKm: [2, 2, 1] }, verticalDatum: 'ellipsoid', heightConvention: 'radial' },
      { referenceShape: { kind: 'sphere', radiusKm: 3396 }, verticalDatum: 'areoid', heightConvention: 'radial' },
      { referenceShape: { kind: 'sphere', radiusKm: 0 }, verticalDatum: 'reference-sphere', heightConvention: 'radial' },
    ] satisfies TerrainDatum[]) expect(() => new CubeSphereSampler(datum, source)).toThrow(/Unsupported cube-sphere datum/);
  });

  it('prefers the finest resident geometry tile and reports unloaded coverage', () => {
    const sampler = new CubeSphereSampler(sphere, { id: 'fixture', kind: 'height-grid' });
    expect(sampler.sample(0, 0)).toBeNull();
    sampler.addTile({ face: 'px', level: 0, x: 0, y: 0, width: 2, height: 2, elevationsKm: new Float64Array(4).fill(1) });
    sampler.addTile({ face: 'px', level: 1, x: 1, y: 1, width: 2, height: 2, elevationsKm: new Float64Array(4).fill(2) });
    expect(sampler.sample(0, 0)?.elevationKm).toBe(2);
    // Points outside the resident child fall back to the parent.
    expect(sampler.sample(10, 0)).toMatchObject({ tileId: 'px/0/0/0', elevationKm: 1 });
    expect(sampler.sample(0, -10)).toMatchObject({ tileId: 'px/0/0/0', elevationKm: 1 });
    sampler.removeTile({ face: 'px', level: 1, x: 1, y: 1 });
    expect(sampler.sample(0, 0)?.tileId).toBe('px/0/0/0');
  });

  it('addresses equivalent geographic coordinates identically below the root level', () => {
    const resident = (face: CubeFace, x: number, y: number) => {
      const sampler = new CubeSphereSampler(sphere, { id: 'fixture', kind: 'height-grid' });
      sampler.addTile({ face, level: 1, x, y, width: 2, height: 2, elevationsKm: new Float64Array(4).fill(5) });
      return sampler;
    };
    const cases: [CubeFace, [number, number][]][] = [
      ['nx', [[0, 180], [0, -180], [0, 540], [0, -540]]],
      ['px', [[0, 0], [0, 360], [0, -360], [0, 720]]],
      ['pz', [[90, 0], [90, 90], [90, 180], [90, 270], [90, -45], [90, 137]]],
      ['nz', [[-90, 0], [-90, 90], [-90, 180], [-90, -90], [-90, 33]]],
    ];
    for (const [face, points] of cases) {
      const sampler = resident(face, 1, 1);
      for (const [lat, lon] of points) {
        const sample = sampler.sample(lat, lon);
        expect(sample?.tileId, `${face} at ${lat},${lon}`).toBe(`${face}/1/1/1`);
        // Samples keep the existing wrapped-longitude convention.
        expect(sample!.position.lonDeg).toBeGreaterThanOrEqual(-180);
        expect(sample!.position.lonDeg).toBeLessThan(180);
      }
    }
    expect(resident('nx', 1, 1).sample(0, 180)!.position.lonDeg).toBe(-180);
    // Only exact quadrant angles are canonical; real nearby points keep their side.
    expect(resident('px', 1, 1).sample(0, -1e-9)).toBeNull();
    expect(resident('pz', 1, 1).sample(90 - 1e-9, 180)).toBeNull();
  });
});

function field(latDeg: number, lonDeg: number): number {
  const lat = latDeg * Math.PI / 180, lon = lonDeg * Math.PI / 180;
  return 0.01 * Math.cos(lat) * Math.cos(lon) + 0.02 * Math.sin(lat);
}

function makeTile(face: CubeFace, level: number, x: number, y: number, size: number): CubeHeightTile {
  const count = 2 ** level, values = new Float64Array(size * size);
  for (let row = 0; row < size; row++) for (let column = 0; column < size; column++) {
    const u = -1 + 2 * (x + column / (size - 1)) / count;
    const v = -1 + 2 * (y + row / (size - 1)) / count;
    const [dx, dy, dz] = cubeFaceToDirection(face, u, v);
    values[row * size + column] = field(Math.atan2(dz, Math.hypot(dx, dy)) * 180 / Math.PI, Math.atan2(dy, dx) * 180 / Math.PI);
  }
  return { face, level, x, y, width: size, height: size, elevationsKm: values };
}
