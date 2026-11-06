import { describe, expect, it } from 'vitest';
import { CubeGridSurface, CubeSphereGridSource, cubeTileMesh, type CubeGridManifest } from '../surface/CubeSphereGrids.js';
import { cubeFaceToDirection, type CubeFace } from '../surface/CubeSphere.js';
import { bodyFixedToGeodetic } from '../TerrainSampler.js';

const faces: CubeFace[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

/** Independent analytic zero-height oblate ellipsoid, encoded as radial offsets.
 * A very flat body makes normal-vs-radial mistakes large, including below zero. */
function fixture(a = 100, c = 50, level = 2) {
  const w = 33;
  const manifest: CubeGridManifest = {
    format: 'cosmolabe-cube-height-grid-1',
    datum: { referenceShape: { kind: 'ellipsoid', radiiKm: [a, a, c] }, verticalDatum: 'ellipsoid', heightConvention: 'geodetic-normal' },
    geometry: { kind: 'radial-lattice', referenceRadiusKm: a },
    source: { id: 'analytic-oblate', kind: 'height-grid', version: 'one-build' },
    grid: { width: w, height: w, uri: '{face}/{level}/{x}/{y}' },
    heightRangeKm: [c - a - 0.001, 0.001], maxLevel: level,
    tiles: faces.flatMap(f => Array.from({ length: level + 1 }, (_, l) =>
      Array.from({ length: 4 ** l }, (_, k) => [f, l, k % 2 ** l, Math.floor(k / 2 ** l), 0.01] as CubeGridManifest['tiles'][number])).flat()),
  };
  const source = new CubeSphereGridSource(manifest, async uri => {
    const [face, ls, xs, ys] = uri.split('/');
    const l = Number(ls), x = Number(xs), y = Number(ys);
    const offsets = new Float32Array(w * w);
    for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) {
      const d = cubeFaceToDirection(face as CubeFace, -1 + 2 * (x + i / (w - 1)) / 2 ** l, -1 + 2 * (y + j / (w - 1)) / 2 ** l);
      offsets[j * w + i] = (1 / Math.sqrt((d[0] ** 2 + d[1] ** 2) / a ** 2 + d[2] ** 2 / c ** 2) - a) * 1000;
    }
    return offsets.buffer;
  }, { residentLevel: 0, maxDetailTiles: 2000 });
  return { source, manifest };
}

describe('ellipsoidal cube physical surface', () => {
  it('requires an explicit storage contract and bounds the radial lattice for horizon occlusion', async () => {
    const { source, manifest } = fixture();
    await source.ready;
    const surface = new CubeGridSurface(source, '499', 'IAU_MARS');
    expect(surface.renderedInnerRadiusKm).toBe(0); // terrain draw policy stays unchanged
    const inner = surface.radialRenderedInnerRadiusKm;
    expect(inner).toBeGreaterThan(49);
    expect(inner).toBeLessThan(50);
    // Sample the Cartesian triangles, including their interiors, on all faces.
    // The bound comes from radial offsets; it never treats them as datum heights.
    for (const face of faces) {
      const tile = source.sampler.getTile({ face, level: 0, x: 0, y: 0 })!;
      const { positionsKm: p, indices } = cubeTileMesh(tile, 100);
      for (let t = 0; t < indices.length; t += 3) for (const weights of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [.5, .5, 0], [.25, .25, .5]]) {
        const position = [0, 1, 2].map(axis => weights.reduce((sum, w, k) => sum + w * p[3 * indices[t + k] + axis], 0));
        expect(Math.hypot(...position)).toBeGreaterThan(inner);
      }
    }
    manifest.renderedLatticeRoundingBoundKm = .001;
    expect(new CubeGridSurface(source, '499', 'IAU_MARS').radialRenderedInnerRadiusKm).toBeCloseTo(inner - .001, 10);
    expect(source.sampler.sample(30, 0)).toBeNull(); // raw offsets cannot masquerade as datum heights
    delete manifest.geometry;
    expect(() => new CubeSphereGridSource(manifest, async () => new ArrayBuffer(0))).toThrow(/explicit radial-lattice/);
  });

  it.each([[100, 50], [3396.19, 3376.2]])('matches independent ellipsoid normals and Cartesian intersections (%s, %s)', async (a, c) => {
    const { source } = fixture(a, c);
    const surface = new CubeGridSurface(source, '499', 'IAU_MARS');
    const phi = 37 * Math.PI / 180, lam = 77 * Math.PI / 180;
    const e2 = 1 - c * c / (a * a), n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    const p = [n * Math.cos(phi) * Math.cos(lam), n * Math.cos(phi) * Math.sin(lam), n * (1 - e2) * Math.sin(phi)];
    const normal = [Math.cos(phi) * Math.cos(lam), Math.cos(phi) * Math.sin(lam), Math.sin(phi)] as const;
    const converted = bodyFixedToGeodetic({ xKm: p[0] - normal[0], yKm: p[1] - normal[1], zKm: p[2] - normal[2] }, source.manifest.datum);
    expect(converted.latDeg).toBeCloseTo(37, 10);
    expect(converted.heightKm).toBeCloseTo(-1, 10);
    expect(Math.acos(p.reduce((sum, v, i) => sum + v * normal[i], 0) / Math.hypot(...p))).toBeGreaterThan(a === 100 ? 0.3 : 0.005);
    await source.ready;
    const ray = { origin: { xKm: p[0] + 2 * normal[0], yKm: p[1] + 2 * normal[1], zKm: p[2] + 2 * normal[2] }, direction: normal.map(v => -v) as [number, number, number], nearKm: 0, farKm: 5 };
    const coarse = surface.intersectRay(ray, { maxMeshErrorKm: 0.0001 });
    await surface.ensureRayCoverage(ray, { maxMeshErrorKm: 0 }, new AbortController().signal);
    const hit = surface.intersectRay(ray, { maxMeshErrorKm: 0.0001 });
    expect(coarse.kind).toBe('hit');
    expect(hit.kind).toBe('hit');
    if (hit.kind !== 'hit') throw new Error('expected lattice intersection');
    const sagLimit = a === 100 ? 0.02 : 0.3;
    expect(hit.distanceKm).toBeGreaterThanOrEqual(2 - 1e-5);
    expect(hit.distanceKm - 2).toBeLessThan(sagLimit);
    expect(hit).toMatchObject({ detail: 'coarse', accuracy: { meshDeviationBoundKm: null }, metadata: { source: { version: 'one-build' } } });
    const sample = source.sample(37, 77)!;
    expect(sample.elevationKm).toBeCloseTo(2 - hit.distanceKm, 7);
    expect(sample.elevationKm).toBeLessThan(0); // actual chord sag, not an interpolated zero
    expect(sample.uncertaintyKm).toBeUndefined(); // sampled representation error is not a validated bound
    expect(sample.tileId).toBe(hit.tileId);
  });

  it('preserves equivalent pole and antimeridian coordinates with CPU-only fallback', async () => {
    const { source } = fixture();
    expect(source.sample(90, 0)).toBeNull();
    await source.ready;
    for (const lat of [-90, 90]) {
      const samples = [0, 90, -180, 137, 360].map(lon => source.sample(lat, lon)!);
      expect(new Set(samples.map(s => s.tileId)).size).toBe(1);
      expect(samples.every(s => Math.abs(s.elevationKm) < 1e-8)).toBe(true);
    }
    expect(source.sample(0, 180)).toEqual(source.sample(0, -180));
    expect(source.coverage(37, 77).state).toBe('parent-fallback');
    await source.request(37, 77);
    expect(source.coverage(37, 77).state).toBe('finest');
  });
});
