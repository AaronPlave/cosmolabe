import { describe, expect, it } from 'vitest';
import { CubeGridSurface, CubeSphereGridSource, cubeTileMesh, type CubeGridManifest } from '../surface/CubeSphereGrids.js';
import { CubeSphereSampler, cubeFaceToDirection, type CubeFace } from '../surface/CubeSphere.js';
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
    heightRangeKm: [0.1, 0.3],
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
    expect(() => new CubeSphereGridSource({ ...manifest(), heightRangeKm: [1, 0] }, async () => new ArrayBuffer(0))).toThrow(/height range/);
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

  it('samples the lattice triangles the .glb draws and rays hit, not a bilinear patch over them', () => {
    // One twisted 2.7 km cell (level 10): h(0,0) = h(1,1) = 0, h(1,0) = h(0,1) = 1 km.
    const tile = { face: 'pz' as const, level: 10, x: 0, y: 0, width: 2, height: 2, elevationsKm: new Float64Array([0, 1, 1, 0]) };
    const sampler = new CubeSphereSampler(manifest().datum, manifest().source);
    sampler.addTile(tile);
    const { positionsKm, indices } = cubeTileMesh(tile, R);
    const P = (i: number) => [0, 1, 2].map(c => positionsKm[3 * i + c]);
    for (const [tx, ty] of [[0.5, 0.5], [0.75, 0.25], [0.2, 0.7], [0.9, 0.1]]) {
      const n = 2 ** tile.level, d = cubeFaceToDirection('pz', -1 + 2 * tx / n, -1 + 2 * ty / n);
      const sample = sampler.sample(Math.asin(d[2]) * 180 / Math.PI, Math.atan2(d[1], d[0]) * 180 / Math.PI)!;
      // The emitted triangle along the same radial ray (the diagonal splits the cell at tx = ty).
      const [a, b, c] = Array.from(tx >= ty ? indices.slice(0, 3) : indices.slice(3, 6), P);
      const e1 = b.map((v, k) => v - a[k]), e2 = c.map((v, k) => v - a[k]);
      const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const radius = (nrm[0] * a[0] + nrm[1] * a[1] + nrm[2] * a[2]) / (nrm[0] * d[0] + nrm[1] * d[1] + nrm[2] * d[2]);
      expect(Math.abs(sample.elevationKm - (radius - R))).toBeLessThan(0.001); // chord sag only (≈ 0.5 m here)
    }
    // Where bilinear would say 0.5 km, the cell's diagonal is at 0.
    const d = cubeFaceToDirection('pz', -1 + 1 / 1024, -1 + 1 / 1024);
    expect(sampler.sample(Math.asin(d[2]) * 180 / Math.PI, Math.atan2(d[1], d[0]) * 180 / Math.PI)!.elevationKm).toBeCloseTo(0, 9);
  });

  it('bounds every rendered triangle from below with renderedInnerRadiusKm (the draw cull\'s horizon occluder)', () => {
    const { source } = fixtureSource();
    const surface = new CubeGridSurface(source, '301', 'IAU_MOON');
    const inner = surface.renderedInnerRadiusKm;
    expect(inner).toBeGreaterThan(R * 0.9);
    // Level-0 lattices at the product's lowest height: no point of any triangle dips inside.
    let lowest = Infinity;
    for (const face of faces) {
      const { positionsKm, indices } = cubeTileMesh({ face, level: 0, x: 0, y: 0, width: W, height: W, elevationsKm: new Float32Array(W * W).fill(0.1) } as never, R);
      const p = (i: number) => [0, 1, 2].map(c => positionsKm[3 * i + c]);
      for (let t = 0; t < indices.length; t += 3) {
        const [a, b, c] = [p(indices[t]), p(indices[t + 1]), p(indices[t + 2])];
        for (let i = 0; i <= 8; i++) for (let j = 0; i + j <= 8; j++) {
          const k = 8 - i - j;
          lowest = Math.min(lowest, Math.hypot(...[0, 1, 2].map(n => (i * a[n] + j * b[n] + k * c[n]) / 8)));
        }
      }
    }
    expect(lowest).toBeGreaterThanOrEqual(inner);
    expect(lowest - inner).toBeLessThan(0.01 * R); // and not uselessly loose, even on these 22° cells
    // A simplified product's rendered triangles sit up to their deviation lower; a tile without one gives no bound.
    const simplified = (deviations: (number | undefined)[]) => {
      const m = manifest();
      m.renderedMesh = { simplification: 'rtin', cpuSurface: 'lattice', deviation: 'sampled' };
      m.tiles = m.tiles.map((t, i) => [t[0], t[1], t[2], t[3], t[4], deviations[i % deviations.length]]);
      const source = new CubeSphereGridSource(m, async () => new ArrayBuffer(0));
      source.ready.catch(() => {}); // no grids served: only the manifest matters here
      return new CubeGridSurface(source, '301', 'IAU_MOON').renderedInnerRadiusKm;
    };
    expect(simplified([0.5, 2])).toBeCloseTo(inner - 2, 9);
    expect(simplified([0.5, undefined])).toBe(0);
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

  it('never lets a parent hit inside resident child coverage win (oblique ray, higher parent)', async () => {
    // Full lunar-sized lattice so chord sag stays small. The nz parent sits 2 km above a resident
    // child at 0 m; px stands 5 km high, so the search shell starts well above the parent.
    const G = 65;
    const base = manifest();
    const product: CubeGridManifest = { ...base, grid: { ...base.grid, width: G, height: G }, heightRangeKm: [0, 5], maxLevel: 1,
      tiles: base.tiles.filter(t => t[1] <= 1) };
    const heightM = (uri: string) => uri.includes('/px/') ? 5000 : uri.split('/')[2] === '0' ? 2000 : 0;
    const source = new CubeSphereGridSource(product, async (uri) => new Float32Array(G * G).fill(heightM(uri)).buffer, { residentLevel: 0 });
    await source.ready;
    // Only nz/1/1/1 (u, v ≥ 0) is resident below the roots; u < 0 still answers from the parent.
    const at = (u: number, v: number, hKm: number) => cubeFaceToDirection('nz', u, v).map(c => c * (R + hKm));
    const childPoint = at(0.001, 0.5, 0);
    await source.requestCoordinate({ face: 'nz', u: 0.001, v: 0.5 });
    expect(source.sampler.getTile({ face: 'nz', level: 1, x: 1, y: 1 })).toBeDefined();
    expect(source.sampler.getTile({ face: 'nz', level: 1, x: 0, y: 1 })).toBeUndefined();
    // Starts over the parent at 2.5 km and reaches the parent's 2 km surface only inside the child's region.
    const origin = at(-0.0002, 0.5, 2.5);
    const ray = { origin: { xKm: origin[0], yKm: origin[1], zKm: origin[2] },
      direction: [childPoint[0] - origin[0], childPoint[1] - origin[1], childPoint[2] - origin[2]] as const, nearKm: 0, farKm: 10 };
    const hit = new CubeGridSurface(source, '301', 'IAU_MOON').intersectRay(ray, { maxMeshErrorKm: 0.001 });
    expect(hit).toMatchObject({ kind: 'hit', tileId: 'nz/1/1/1' });
    if (hit.kind !== 'hit') throw new Error('expected a hit');
    expect(Math.hypot(hit.position.xKm, hit.position.yKm, hit.position.zKm) - R).toBeLessThan(0.05);
  });

  it('ends an exhausted bounded ray after rejecting a superseded ancestor hit', async () => {
    const source = new CubeSphereGridSource(manifest(), async uri => {
      const level = Number(uri.split('/')[2]);
      return new Float32Array(W * W).fill(level === 0 ? 300 : 100).buffer;
    }, { residentLevel: 2 });
    await source.ready;
    const surface = new CubeGridSurface(source, 'Moon', 'MOON_ME_DE421');
    // The coarse 300 m surface lies at the inclusive end of the ray, but the
    // finest 100 m surface owning this point is beyond it. Advancing past the
    // rejected coarse hit must end the query, never reverse its interval.
    expect(surface.intersectRay({ origin: { xKm: 0, yKm: 0, zKm: -(R + 1) }, direction: [0, 0, 1],
      nearKm: 0, farKm: 0.7000000005 }, { maxMeshErrorKm: 0.001 }).kind).toBe('unavailable');
    source.dispose();
  });

  it('keeps closed mixed-level edges queryable without reviving superseded interiors', async () => {
    const m = manifest();
    const source = new CubeSphereGridSource(m, async uri => {
      const level = Number(uri.split('/')[2]);
      return new Float32Array(W * W).fill(300 - 100 * level).buffer;
    }, { residentLevel: 2 });
    await source.ready;
    const surface = new CubeGridSurface(source, '301', 'IAU_MOON');
    // A parent edge below which fine detail owns only one incident side. Both
    // source LOD heights are real; canonical half-open ownership cannot erase
    // the coarse triangle's closed edge when the fine lattice has no hit.
    for (const [u, v] of [[0, 0.5], [0.5, 0], [0, 0]]) {
      const d = cubeFaceToDirection('nz', u, v);
      const target = d.map(c => c * (R + 0.2));
      const origin = target.map((c, i) => c + 2 * d[i] + [0.7, -0.4, 0][i]);
      const ray = { origin: { xKm: origin[0], yKm: origin[1], zKm: origin[2] },
        direction: target.map((c, i) => c - origin[i]) as [number, number, number], nearKm: 0, farKm: 10 };
      const hit = surface.intersectRay(ray, { maxMeshErrorKm: 0.001 });
      expect(hit.kind).toBe('hit');
      if (hit.kind !== 'hit') throw new Error('closed edge must retain physical support');
      expect(hit).toMatchObject({ detail: 'coarse', accuracy: { meshDeviationBoundKm: null } });
    }
    // If fine triangles do intersect, nearer superseded ancestor edges must
    // not replace them merely because that ancestor has a closed footprint.
    const d = cubeFaceToDirection('nz', 0.5, 0);
    const fine = surface.intersectRay({ origin: { xKm: d[0] * (R + 2), yKm: 0, zKm: d[2] * (R + 2) },
      direction: [-d[0], 0, -d[2]], nearKm: 0, farKm: 10 }, { maxMeshErrorKm: 0.001 });
    expect(fine).toMatchObject({ kind: 'hit', tileId: expect.stringMatching(/^nz\/2\//), distanceKm: expect.closeTo(1.9, 6) });
  });

  it('hands a rejected fine-owner query back to real closed ancestor edges', async () => {
    const m = manifest();
    m.grid = { ...m.grid, width: 65, height: 65 };
    m.heightRangeKm = [-4.002, -3.999];
    m.maxLevel = 11;
    m.tiles = faces.map(face => [face, 0, 0, 0, 0]);
    const u = 0.22308349609375, v = -0.34375;
    for (let level = 1; level <= 11; level++) {
      const count = 2 ** (level - 1);
      const x = Math.floor((u + 1) * count / 2), y = Math.floor((v + 1) * count / 2);
      for (const dx of [0, 1]) for (const dy of [0, 1]) m.tiles.push(['py', level, 2 * x + dx, 2 * y + dy, 0]);
    }
    const source = new CubeSphereGridSource(m, async uri => {
      const level = Number(uri.split('/')[2]);
      return new Float32Array(65 * 65).fill(level === 11 ? -3999 : level === 10 ? -4000 : -4002).buffer;
    }, { residentLevel: 11 });
    await source.ready;
    const surface = new CubeGridSurface(source, 'fixture', 'fixture');
    const d = cubeFaceToDirection('py', u, v), target = d.map(c => c * (R - 4));
    for (let az = 0; az < 16; az++) {
      const origin = target.map((c, i) => c + 2 * d[i] + [Math.cos(az), 0, Math.sin(az)][i]);
      const ray = { origin: { xKm: origin[0], yKm: origin[1], zKm: origin[2] }, direction: target.map((c, i) => c - origin[i]) as [number, number, number], nearKm: 0, farKm: 10 };
      expect(surface.intersectRay(ray, { maxMeshErrorKm: 0.001 })).toMatchObject({ kind: 'hit', detail: 'coarse' });
    }
  });

  it('loads incident face/corner tiles and preserves missing coverage at poles and the antimeridian', async () => {
    const { source } = fixtureSource();
    await source.ready;
    const surface = new CubeGridSurface(source, '301', 'IAU_MOON');
    for (const d of [[1, 0, -1], [-1, 0, -1], [1, 1, -1], [-1, -1, -1], [0, 0, -1], [0, 0, 1], [-1, 0, 0]]) {
      const length = Math.hypot(...d), n = d.map(c => c / length);
      const ray = { origin: { xKm: n[0] * (R + 2), yKm: n[1] * (R + 2), zKm: n[2] * (R + 2) },
        direction: n.map(c => -c) as [number, number, number], nearKm: 0, farKm: 100 };
      const hit = await requestSurfaceIntersection(surface, ray, { maxMeshErrorKm: 0.001 }, new AbortController().signal, surface);
      expect(hit).toMatchObject({ kind: 'hit', detail: 'coarse' });
    }
    expect(source.sampler.getTile({ face: 'nz', level: 1, x: 0, y: 0 })).toBeDefined();
    expect(source.sampler.getTile({ face: 'nz', level: 1, x: 1, y: 1 })).toBeDefined();
    // A real absent face still cannot be answered from an unrelated face edge.
    source.sampler.removeTile({ face: 'px', level: 0, x: 0, y: 0 });
    expect(surface.intersectRay({ origin: { xKm: R + 2, yKm: 0, zKm: 0 }, direction: [-1, 0, 0], nearKm: 0, farKm: 10 }, { maxMeshErrorKm: 0.001 }))
      .toMatchObject({ kind: 'unavailable', reason: 'not-resident' });
  });

  it('discovers unloaded terrain above every resident grid when loading ray coverage', async () => {
    // 100 km sphere, flat roots at 0 m, an unloaded child 10 km up; a short inward ray at 110.05 km.
    const r = 100;
    const base = manifest();
    const product: CubeGridManifest = { ...base, datum: { ...base.datum, referenceShape: { kind: 'sphere', radiusKm: r } }, heightRangeKm: [0, 10],
      maxLevel: 1, tiles: base.tiles.filter(t => t[1] <= 1) };
    const fetched: string[] = [];
    const source = new CubeSphereGridSource(product, async (uri) => {
      fetched.push(uri);
      return new Float32Array(W * W).fill(uri.split('/')[2] === '0' ? 0 : 10000).buffer;
    }, { residentLevel: 0 });
    const surface = new CubeGridSurface(source, 'fixture', 'fixture');
    await source.ready;
    // nz/1/1/1's centre is one of its lattice vertices, so the hit is exactly 50 m away.
    const d = cubeFaceToDirection('nz', 0.5, 0.5);
    const ray = { origin: { xKm: d[0] * (r + 10.05), yKm: d[1] * (r + 10.05), zKm: d[2] * (r + 10.05) },
      direction: [-d[0], -d[1], -d[2]] as const, nearKm: 0, farKm: 0.1 };
    expect(surface.intersectRay(ray, { maxMeshErrorKm: 0.001 }).kind).toBe('unavailable');
    const result = await requestSurfaceIntersection(surface, ray, { maxMeshErrorKm: 0.001 }, new AbortController().signal, surface);
    expect(fetched).toContain('heights/nz/1/1/1.f32');
    expect(result).toMatchObject({ kind: 'hit', tileId: 'nz/1/1/1', distanceKm: expect.closeTo(0.05, 6) });
  });
});
