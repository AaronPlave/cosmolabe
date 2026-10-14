import { describe, expect, it } from 'vitest';
import { CubeGridSurface, CubeSphereGridSource, cubeTileMesh, type CubeGridManifest } from '../surface/CubeSphereGrids.js';
import type { CubeFace } from '../surface/CubeSphere.js';
import { cameraPositionFromSurfacePick } from '../surface/SurfaceConsumers.js';
import { requestSurfaceIntersection } from '../surface/PhysicalSurface.js';

const R = 1737.4;
const faces: CubeFace[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const W = 5;

/** A REPLACE-complete product: six roots, nz refined to level 1, nz/1/1/1 (the south pole) to level 2. */
function manifest(): CubeGridManifest {
  const tiles: CubeGridManifest['tiles'] = faces.map(f => [f, 0, 0, 0, 0.001]);
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) tiles.push(['nz', 1, x, y, 0.0005]);
  for (const [x, y] of [[2, 2], [3, 2], [2, 3], [3, 3]]) tiles.push(['nz', 2, x, y, 0.0002]);
  return {
    format: 'cosmolabe-cube-height-grid-1',
    datum: { referenceShape: { kind: 'sphere', radiusKm: R }, verticalDatum: 'reference-sphere', heightConvention: 'radial' },
    source: { id: 'cube-fixture', kind: 'height-grid', version: 'fixture-v1' },
    grid: { width: W, height: W, uri: 'heights/{face}/{level}/{x}/{y}.f32' },
    maxLevel: 2,
    tiles,
  };
}

/** Constant height per level, in metres: level 0 → 100 m, 1 → 200 m, 2 → 300 m. */
function fixtureSource(options = {}) {
  const fetched: string[] = [];
  const source = new CubeSphereGridSource(manifest(), async (uri) => {
    fetched.push(uri);
    const level = Number(uri.split('/')[2]);
    return new Float32Array(W * W).fill(100 * (level + 1)).buffer;
  }, { residentLevel: 0, ...options });
  return { source, fetched };
}

describe('cube-sphere CPU grid source', () => {
  it('reports unloaded coverage until resident grids arrive, then falls back to the coarse parent', async () => {
    const { source, fetched } = fixtureSource();
    expect(source.coverage(-90, 0)).toMatchObject({ state: 'unloaded', availableLevel: 2, residentLevel: null });
    expect(source.sampler.sample(-90, 0)).toBeNull();
    await source.ready;
    expect(fetched).toHaveLength(6);
    expect(source.coverage(-90, 0)).toMatchObject({ state: 'parent-fallback', availableLevel: 2, residentLevel: 0 });
    expect(source.sampler.sample(-90, 0)).toMatchObject({ tileId: 'nz/0/0/0', elevationKm: expect.closeTo(0.1, 6), uncertaintyKm: 0.001 });
    // Points the product never refines are already at their finest level.
    expect(source.coverage(0, 0)).toMatchObject({ state: 'finest', availableLevel: 0 });
  });

  it('loads the tile chain a query asks for, independently of any renderer', async () => {
    const { source, fetched } = fixtureSource();
    await source.ready;
    // sample() answers from what is resident now and requests the finest tile.
    expect(source.sample(-90, 0)?.tileId).toBe('nz/0/0/0');
    await source.request(-90, 0);
    expect(fetched.slice(6).sort()).toEqual(['heights/nz/1/1/1.f32', 'heights/nz/2/2/2.f32']);
    expect(source.coverage(-90, 0)).toMatchObject({ state: 'finest', residentLevel: 2, residentTileId: 'nz/2/2/2' });
    expect(source.sample(-90, 123)).toMatchObject({ tileId: 'nz/2/2/2', elevationKm: expect.closeTo(0.3, 6), source: { version: 'fixture-v1' } });
    // The pole is one point whatever its longitude, so no further requests.
    await source.request(-90, -180);
    expect(fetched).toHaveLength(8);
    expect(source.stats).toMatchObject({ residentTiles: 6, detailTiles: 2, requests: 8, failed: 0, inFlight: 0 });
  });

  it('evicts detail least-recently-requested first but never the coarse fallback', async () => {
    const { source } = fixtureSource({ maxDetailTiles: 1 });
    await source.ready;
    await source.request(-90, 0);
    expect(source.stats.detailTiles).toBe(1);
    expect(source.coverage(-90, 0).state).toBe('finest');
    for (const face of faces) expect(source.sampler.getTile({ face, level: 0, x: 0, y: 0 })).toBeDefined();
    await source.request(-60, 45); // nz/1/0/1, evicting the pole chain
    expect(source.sampler.getTile({ face: 'nz', level: 2, x: 2, y: 2 })).toBeUndefined();
    expect(source.coverage(-90, 0)).toMatchObject({ state: 'parent-fallback', residentLevel: 0 });
  });

  it('records failed grids and does not report them as resident', async () => {
    const source = new CubeSphereGridSource(manifest(), async (uri) => {
      if (uri.includes('/2/')) throw new Error('offline');
      return new Float32Array(W * W).buffer;
    }, { residentLevel: 0 });
    await source.ready;
    await source.request(-90, 0);
    expect(source.stats.failed).toBe(1);
    expect(source.coverage(-90, 0)).toMatchObject({ state: 'parent-fallback', residentLevel: 1 });
  });

  it('rejects malformed grids and unsupported datums', async () => {
    const bad = new CubeSphereGridSource(manifest(), async () => new ArrayBuffer(12), { residentLevel: 0 });
    await expect(bad.ready).rejects.toThrow(/resident levels failed/);
    const triaxial = { ...manifest(), datum: { referenceShape: { kind: 'ellipsoid' as const, radiiKm: [3, 2, 1] as const }, verticalDatum: 'ellipsoid' as const, heightConvention: 'geodetic-normal' as const } };
    expect(() => new CubeSphereGridSource(triaxial, async () => new ArrayBuffer(0))).toThrow(/Unsupported cube-sphere datum/);
  });
});

describe('cube grid CPU triangles and ray queries', () => {
  it('reconstructs shared face-edge and corner vertices identically on every face', () => {
    const tile = (face: CubeFace) => ({ face, level: 0, x: 0, y: 0, width: W, height: W, elevationsKm: new Float32Array(W * W).fill(0.25) });
    const vertices = new Map<string, number[][]>();
    for (const face of faces) {
      const { positionsKm } = cubeTileMesh(tile(face), R);
      for (let i = 0; i < W * W; i++) {
        const p = Array.from(positionsKm.subarray(i * 3, i * 3 + 3));
        expect(Math.hypot(...p)).toBeCloseTo(R + 0.25, 9);
        const key = p.map(v => v.toFixed(6)).join(',');
        vertices.set(key, [...(vertices.get(key) ?? []), p]);
      }
    }
    const shared = [...vertices.values()].filter(v => v.length > 1);
    // 12 edges × 3 interior edge vertices shared by 2 faces, 8 corners shared by 3.
    expect(shared.filter(v => v.length === 2)).toHaveLength(36);
    expect(shared.filter(v => v.length === 3)).toHaveLength(8);
  });

  it('intersects the finest resident triangles, keeps provenance, and places a clearance camera', async () => {
    const { source } = fixtureSource();
    const surface = new CubeGridSurface(source, '301', 'IAU_MOON');
    const down = { origin: { xKm: 0, yKm: 0, zKm: -(R + 50) }, direction: [0, 0, 1] as const, nearKm: 0, farKm: 100 };
    expect(surface.intersectRay(down, { maxMeshErrorKm: 0.01 })).toMatchObject({ kind: 'unavailable', reason: 'not-resident' });
    await source.ready;
    const coarse = surface.intersectRay(down, { maxMeshErrorKm: 0.01 });
    expect(coarse).toMatchObject({ kind: 'hit', tileId: 'nz/0/0/0', detail: 'coarse', accuracy: { meshDeviationBoundKm: null } });
    if (coarse.kind !== 'hit') throw new Error('expected a hit');
    expect(coarse.position.zKm).toBeCloseTo(-(R + 0.1), 5);
    await source.request(-90, 0);
    surface.invalidate('nz/0/0/0');
    const fine = surface.intersectRay(down, { maxMeshErrorKm: 0.01 });
    expect(fine).toMatchObject({ kind: 'hit', tileId: expect.stringMatching(/^nz\/2\//) });
    if (fine.kind !== 'hit') throw new Error('expected a hit');
    expect(fine.position.zKm).toBeCloseTo(-(R + 0.3), 5);
    expect(fine.normal[2]).toBeLessThan(-0.99); // outward at the south pole
    // Coarse/provisional hits need explicit opt-in for camera placement.
    expect(cameraPositionFromSurfacePick(fine, 0.05)).toBeNull();
    // Clearance follows the facet's winding normal, which tilts slightly on this coarse fixture.
    expect(cameraPositionFromSurfacePick(fine, 0.05, true)?.zKm).toBeCloseTo(-(R + 0.35), 3);
    // A ray that never reaches loaded heights is unavailable, not a miss.
    const away = { ...down, direction: [0, 0, -1] as const };
    expect(surface.intersectRay(away, { maxMeshErrorKm: 0.01 })).toMatchObject({ kind: 'unavailable', reason: 'partial-coverage' });
  });

  it('is its own #148 loader: one ensure-coverage pass along the ray, then a finer requery', async () => {
    const { source, fetched } = fixtureSource();
    const surface = new CubeGridSurface(source, '301', 'IAU_MOON');
    await source.ready;
    // Oblique across the pole: nothing finer than the roots is resident yet.
    const ray = { origin: { xKm: 3, yKm: 0, zKm: -(R + 2) }, direction: [-3, 0.5, 2] as const, nearKm: 0, farKm: 10 };
    expect(surface.intersectRay(ray, { maxMeshErrorKm: 0.001 })).toMatchObject({ kind: 'hit', tileId: 'nz/0/0/0' });
    const result = await requestSurfaceIntersection(surface, ray, { maxMeshErrorKm: 0.001 }, new AbortController().signal, surface);
    expect(result).toMatchObject({ kind: 'hit', detail: 'coarse' });
    if (result.kind !== 'hit') throw new Error('expected a hit');
    const p = result.position, r = Math.hypot(p.xKm, p.yKm, p.zKm);
    // The requery answers from the deepest tile the product has at the hit.
    const coverage = source.coverage(Math.asin(p.zKm / r) * 180 / Math.PI, Math.atan2(p.yKm, p.xKm) * 180 / Math.PI);
    expect(coverage).toMatchObject({ state: 'finest', residentTileId: result.tileId });
    expect(result.tileId).not.toBe('nz/0/0/0');
    expect(fetched.length).toBeGreaterThan(6);
    const aborted = new AbortController(); aborted.abort();
    await expect(requestSurfaceIntersection(surface, ray, { maxMeshErrorKm: 0.001 }, aborted.signal, surface)).rejects.toThrow();
  });
});
