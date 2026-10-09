import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TerrainSampler, geodeticToBodyFixed, type TerrainDatum } from '../TerrainSampler.js';
import { geographicTileBounds } from '../TerrainValidation.js';
import { decodeQuantizedMesh, toTerrainMeshTile } from '../internal/quantized-mesh.js';
import { CpuMeshSurface } from '../surface/CpuMeshSurface.js';
import {
  clipFovPerimeter, fovBaseParams, fovBoundaryDirection, rectangularFov, resolveFovRay,
  type FovBoundaryShape, type FovPerimeterSample, type FovSurfaceCandidate, type Vec3,
} from '../surface/FovClipper.js';
import { ReferenceEllipsoidSurface } from '../surface/ReferenceEllipsoidSurface.js';
import { ResidentTerrainSurface } from '../surface/ResidentTerrainSurface.js';
import { concaveSurface } from './fixtures/concaveSurface.js';

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const options = { maxMeshErrorKm: 0.001 };

function sphere(id: string, centerKm: Vec3, radiusKm: number): FovSurfaceCandidate {
  const reference = new ReferenceEllipsoidSurface(id, `${id}_FIXED`, [radiusKm, radiusKm, radiusKm]);
  return { id, centerKm, bodyToWorld: IDENTITY, boundingRadiusKm: radiusKm, surfaces: [reference] };
}

/** Instrument frame (+Z boresight) rotated onto an arbitrary world boresight. */
function pointing(boresight: Vec3): (d: Vec3) => Vec3 {
  const z = normalize(boresight);
  const ref: Vec3 = Math.abs(z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const x = normalize(cross(ref, z)), y = cross(z, x);
  return d => [x[0] * d[0] + y[0] * d[1] + z[0] * d[2], x[1] * d[0] + y[1] * d[1] + z[1] * d[2], x[2] * d[0] + y[2] * d[1] + z[2] * d[2]];
}
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (v: Vec3): Vec3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
const endpoint = (origin: Vec3, s: FovPerimeterSample): Vec3 => [origin[0] + s.direction[0] * s.distanceKm, origin[1] + s.direction[1] * s.distanceKm, origin[2] + s.direction[2] * s.distanceKm];
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function clip(origin: Vec3, boresight: Vec3, shape: FovBoundaryShape, candidates: FovSurfaceCandidate[], maxRangeKm: number, segments = 32) {
  const toWorld = pointing(boresight);
  return clipFovPerimeter(origin, t => toWorld(fovBoundaryDirection(shape, t)), fovBaseParams(shape, segments), candidates, { maxRangeKm });
}
const circular = (fullDeg: number): FovBoundaryShape => {
  const t = Math.tan((fullDeg * Math.PI) / 360);
  return { kind: 'elliptical', tanHalfH: t, tanHalfV: t };
};

describe('ReferenceEllipsoidSurface', () => {
  const s = new ReferenceEllipsoidSurface('mars', 'IAU_MARS', [3396.19, 3396.19, 3376.2]);
  it('returns the nearest analytic hit with an outward normal and reference provenance', () => {
    const hit = s.intersectRay({ origin: { xKm: 0, yKm: 0, zKm: 5000 }, direction: [0, 0, -1], nearKm: 0, farKm: 1e4 }, options);
    if (hit.kind !== 'hit') throw new Error('expected hit');
    expect(hit.distanceKm).toBeCloseTo(5000 - 3376.2, 9);
    expect(hit.normal[2]).toBeCloseTo(1, 12);
    expect(hit.detail).toBe('sufficient');
    expect(hit.metadata.source.kind).toBe('reference-shape');
    expect(s.intersectRay({ origin: { xKm: 0, yKm: 0, zKm: 5000 }, direction: [0, 0, -1], nearKm: 0, farKm: 1000 }, options).kind).toBe('miss');
    expect(s.intersectRay({ origin: { xKm: 4000, yKm: 0, zKm: 5000 }, direction: [0, 0, -1], nearKm: 0, farKm: 1e4 }, options).kind).toBe('miss');
  });
  it('reports the exit point from inside and detects containment', () => {
    expect(s.contains({ xKm: 0, yKm: 0, zKm: 0 })).toBe(true);
    const exit = s.intersectRay({ origin: { xKm: 0, yKm: 0, zKm: 0 }, direction: [1, 0, 0], nearKm: 0, farKm: 1e4 }, options);
    expect(exit).toMatchObject({ kind: 'hit' });
    if (exit.kind === 'hit') expect(exit.distanceKm).toBeCloseTo(3396.19, 9);
  });
});

describe('FOV clipping against physical surfaces', () => {
  const R = 1000;
  const body = sphere('target', [0, 0, 0], R);
  const origin: Vec3 = [0, 0, 10000];

  it('terminates a nadir FOV at the surface, not the target center or far range', () => {
    const samples = clip(origin, [0, 0, -1], circular(5), [body], 50000);
    expect(samples.every(s => s.hit?.candidateId === 'target' && s.hit.source === 'reference')).toBe(true);
    for (const s of samples) {
      expect(dist(endpoint(origin, s), [0, 0, 0])).toBeCloseTo(R, 2); // within the 1 m standoff
      expect(s.distanceKm).toBeLessThan(10000 - R / 2);
    }
  });

  it('renders a sensor that intersects nothing to its maximum range', () => {
    const samples = clip(origin, [0, 0, 1], circular(5), [body], 1234);
    expect(samples).toHaveLength(32);
    expect(samples.every(s => s.hit === null && s.distanceKm === 1234)).toBe(true);
  });

  it('produces a refined, stable partial clip for a grazing FOV', () => {
    const limb = Math.asin(R / 10000); // angular radius of the body
    const boresightAt = (offset: number): Vec3 => [Math.sin(limb + offset), 0, -Math.cos(limb + offset)];
    const a = clip(origin, boresightAt(0), circular(4), [body], 20000);
    const hits = a.filter(s => s.hit).length;
    expect(hits).toBeGreaterThan(0);
    expect(hits).toBeLessThan(a.length);
    // Every hit/miss transition is bisected to a tight interval rather than one coarse segment.
    const transitions = a.map((s, i) => [s, a[(i + 1) % a.length]] as const).filter(([p, q]) => !!p.hit !== !!q.hit);
    expect(transitions.length).toBe(2);
    for (const [p, q] of transitions) expect(Math.acos(Math.min(1, p.direction[0] * q.direction[0] + p.direction[1] * q.direction[1] + p.direction[2] * q.direction[2]))).toBeLessThan(1e-4);
    // A tiny pointing change (ordinary CK motion) moves the limb crossing only slightly.
    const b = clip(origin, boresightAt(1e-6), circular(4), [body], 20000);
    const crossing = (s: FovPerimeterSample[]) => s.filter((x, i) => x.hit && !s[(i + 1) % s.length].hit).map(x => endpoint(origin, x))[0];
    expect(dist(crossing(a), crossing(b))).toBeLessThan(5);
    // Hit endpoints never lie past the surface along their rays.
    for (const s of a.filter(x => x.hit)) expect(dist(endpoint(origin, s), [0, 0, 0])).toBeGreaterThanOrEqual(R - 1e-6);
  });

  it('finds a grazing body whose limb crosses only between two missing base samples (review #174)', () => {
    // 10° circular FOV, 32 base samples. A sphere 10,000 km away with a 3°
    // angular radius, centred 7.98° off boresight at azimuth 5.625° — halfway
    // between the first two samples. Both neighbours are ~3.04° from its centre
    // (miss) while the midpoint is ~2.98° (hit), on an interval far shorter
    // than the body's angular radius.
    const toWorld = pointing([0, 0, -1]);
    const at = (offDeg: number, azDeg: number): Vec3 => {
      const off = offDeg * Math.PI / 180, az = azDeg * Math.PI / 180;
      return toWorld([Math.sin(off) * Math.cos(az), Math.sin(off) * Math.sin(az), Math.cos(off)]);
    };
    const place = (offDeg: number): FovSurfaceCandidate => {
      const d = at(offDeg, 5.625);
      return sphere('grazer', [d[0] * 10000, d[1] * 10000, d[2] * 10000], 10000 * Math.sin(3 * Math.PI / 180));
    };
    const grazer = place(7.98);
    const samples = clip([0, 0, 0], [0, 0, -1], circular(10), [grazer], 20000);
    expect(samples.filter(s => s.base).every(s => s.hit === null)).toBe(true);
    const hits = samples.filter(s => s.hit?.candidateId === 'grazer');
    expect(hits.length).toBeGreaterThan(0);
    for (const s of hits) expect(dist(endpoint([0, 0, 0], s), grazer.centerKm)).toBeCloseTo(grazer.boundingRadiusKm, 2);
    // Just out of reach (closest perimeter approach ~3.2°): one probe ray per
    // overlapping interval at most, no runaway subdivision, no false hit.
    const near = clip([0, 0, 0], [0, 0, -1], circular(10), [place(8.2)], 20000);
    expect(near.every(s => s.hit === null)).toBe(true);
    expect(near.length).toBeLessThanOrEqual(34);
  });

  it('probes exactly against a rotated reference ellipsoid, not its bounding sphere', () => {
    // A flattened body whose bounding cone (3.44°) overlaps the 5° perimeter
    // (closest approach 3.4°) while its short axis, aimed back at the
    // boresight, keeps the real surface ~0.57° from the centre: nothing to hit,
    // and nothing to subdivide.
    const toWorld = pointing([0, 0, -1]);
    const off = 8.4 * Math.PI / 180, az = 5.625 * Math.PI / 180;
    const d = toWorld([Math.sin(off) * Math.cos(az), Math.sin(off) * Math.sin(az), Math.cos(off)]);
    const bore: Vec3 = [0, 0, -1];
    const k = bore[0] * d[0] + bore[1] * d[1] + bore[2] * d[2];
    const u = normalize([bore[0] - k * d[0], bore[1] - k * d[1], bore[2] - k * d[2]]);
    const y = cross(u, d);
    // Columns are body X (line of sight), Y, Z (short axis, toward boresight) in world.
    const bodyToWorld = [d[0], y[0], u[0], d[1], y[1], u[1], d[2], y[2], u[2]];
    const flat = new ReferenceEllipsoidSurface('flat', 'F', [600, 600, 100]);
    const candidate: FovSurfaceCandidate = { id: 'flat', centerKm: [d[0] * 10000, d[1] * 10000, d[2] * 10000], bodyToWorld, boundingRadiusKm: 600, surfaces: [flat] };
    const samples = clip([0, 0, 0], [0, 0, -1], circular(10), [candidate], 20000);
    expect(samples.every(s => s.hit === null)).toBe(true);
    expect(samples).toHaveLength(32);
    // Rotate the long axis toward the boresight instead and the probe finds it.
    const longToward = [u[0], y[0], d[0], u[1], y[1], d[1], u[2], y[2], d[2]];
    const hit = clip([0, 0, 0], [0, 0, -1], circular(10), [{ ...candidate, bodyToWorld: longToward }], 20000);
    expect(hit.some(s => s.hit?.candidateId === 'flat')).toBe(true);
  });

  it('detects a body crossing the middle of a rectangle edge while both corners miss', () => {
    // 20°×20° rectangle; a small body centred on the bottom edge's midpoint.
    const shape = rectangularFov(Math.tan(10 * Math.PI / 180), Math.tan(10 * Math.PI / 180));
    const toWorld = pointing([0, 0, -1]);
    const edgeMid = toWorld(normalize([0, -Math.tan(10 * Math.PI / 180), 1]));
    const small = sphere('moonlet', [origin[0] + edgeMid[0] * 5000, origin[1] + edgeMid[1] * 5000, origin[2] + edgeMid[2] * 5000], 50);
    const cornersOnly = clipFovPerimeter(origin, t => toWorld(fovBoundaryDirection(shape, t)), fovBaseParams(shape, 4), [small], { maxRangeKm: 20000 });
    expect(cornersOnly.filter(s => s.base).every(s => s.hit === null)).toBe(true);
    const hits = cornersOnly.filter(s => s.hit?.candidateId === 'moonlet');
    expect(hits.length).toBeGreaterThan(0);
    for (const s of hits) expect(dist(endpoint(origin, s), small.centerKm)).toBeCloseTo(50, 2);
    // Without a possible occluder, missing corner pairs are not subdivided.
    const empty = clipFovPerimeter(origin, t => toWorld(fovBoundaryDirection(shape, t)), fovBaseParams(shape, 4), [], { maxRangeKm: 20000 });
    expect(empty).toHaveLength(4);
  });

  it('is smooth across the limb of a circular FOV without low-segment faceting', () => {
    const limb = Math.asin(R / 10000);
    const samples = clip(origin, [Math.sin(limb), 0, -Math.cos(limb)], circular(6), [body], 20000, 16);
    // Consecutive hit endpoints on the body stay close to the surface between them.
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i], q = samples[(i + 1) % samples.length];
      if (!p.hit || !q.hit) continue;
      const a = endpoint(origin, p), b = endpoint(origin, q);
      const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      expect(R - dist(mid, [0, 0, 0])).toBeLessThan(0.01 * R);
    }
  });

  it('chooses the nearest eligible surface among several candidate bodies', () => {
    const near = sphere('near', [0, 0, 5000], 200);
    const far = sphere('far', [0, 0, 0], R);
    const direct = resolveFovRay(origin, [0, 0, -1], [far, near], 20000);
    expect(direct).toMatchObject({ candidateId: 'near' });
    expect(direct!.surfaceDistanceKm).toBeCloseTo(4800, 9);
    // A second small body straddling the FOV edge, in front of the large one.
    const edge = sphere('edge', [5000 * Math.tan(2.5 * Math.PI / 180), 0, 5000], 100);
    const samples = clip(origin, [0, 0, -1], circular(5), [far, edge], 20000);
    const ids = new Set(samples.map(s => s.hit?.candidateId));
    expect(ids).toEqual(new Set(['edge', 'far']));
    for (const s of samples.filter(x => x.hit?.candidateId === 'edge')) expect(dist(endpoint(origin, s), edge.centerKm)).toBeCloseTo(100, 2);
    // Body-to-body transitions are refined like hit/miss transitions.
    expect(samples.length).toBeGreaterThan(32);
  });

  it('skips a reference shape that contains the sensor (no fake exit-point clipping)', () => {
    expect(resolveFovRay([0, 0, 500], [1, 0, 0], [body], 20000)).toBeNull();
  });

  it('uses nearest-hit semantics on the concave #148 mesh, never a radial assumption', () => {
    const torus = new CpuMeshSurface(
      { bodyId: 'torus', frame: 'FIXTURE_FIXED', source: { id: 'torus', kind: 'triangle-mesh', version: 'fixture-mesh-v1' }, shape: { kind: 'mesh' }, coverage: 'complete-product' },
      concaveSurface(), { meshDeviationBoundKm: 0 },
    );
    // An explicit reference shape behind the mesh must not "fill" the hole: a complete mesh miss is authoritative.
    const reference = new ReferenceEllipsoidSurface('torus', 'FIXTURE_FIXED', [3, 3, 1]);
    const candidate: FovSurfaceCandidate = { id: 'torus', centerKm: [0, 0, 0], bodyToWorld: IDENTITY, boundingRadiusKm: 3.01, surfaces: [torus, reference] };
    expect(resolveFovRay([0, 0, 4], [0, 0, -1], [candidate], 20)).toBeNull();
    // From inside the hole looking out: the inner face at x=1, not the outer x=3 at the same lat/lon.
    const inner = resolveFovRay([0, 0, 0], [1, 0, 0], [candidate], 20);
    expect(inner).toMatchObject({ candidateId: 'torus', source: 'mesh', detail: 'sufficient', fallback: false });
    expect(inner!.surfaceDistanceKm).toBeCloseTo(1, 9);
    expect(resolveFovRay([4, 0, 0], [-1, 0, 0], [candidate], 20)!.surfaceDistanceKm).toBeCloseTo(1, 9);
    // A narrow FOV straddling the hole: the boresight passes through, the edges hit the tube.
    const samples = clip([0, 0, 4], [0, 0, -1], circular(2 * Math.atan(1.5 / 4) * 180 / Math.PI), [candidate], 20);
    expect(samples.every(s => s.hit?.source === 'mesh')).toBe(true);
    expect(clip([0, 0, 4], [0, 0, -1], circular(5), [candidate], 20).every(s => s.hit === null)).toBe(true);
  });

  it('resolves rays in the body-fixed frame through bodyToWorld', () => {
    // Prolate body, long axis on body X; rotated 90° about Z so body X → world Y.
    const reference = new ReferenceEllipsoidSurface('prolate', 'P', [3000, 1000, 1000]);
    const rotated: FovSurfaceCandidate = { id: 'prolate', centerKm: [0, 0, 0], bodyToWorld: [0, -1, 0, 1, 0, 0, 0, 0, 1], boundingRadiusKm: 3000, surfaces: [reference] };
    expect(resolveFovRay([0, 10000, 0], [0, -1, 0], [rotated], 20000)!.surfaceDistanceKm).toBeCloseTo(7000, 9);
    expect(resolveFovRay([10000, 0, 0], [-1, 0, 0], [rotated], 20000)!.surfaceDistanceKm).toBeCloseTo(9000, 9);
  });
});

describe('FOV clipping against resident terrain', () => {
  function marsTerrain() {
    const datum: TerrainDatum = { referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] }, verticalDatum: 'ellipsoid', heightConvention: 'geodetic-normal' };
    const sampler = new TerrainSampler(datum, { id: 'marshub', kind: 'quantized-mesh', version: 'repo-fixture', uncertaintyKm: 0.1 }, 4);
    const bytes = readFileSync(new URL('./fixtures/marshub-14-23432-9870.terrain', import.meta.url));
    const decoded = decodeQuantizedMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const tile = toTerrainMeshTile(decoded, { id: '14/23432/9870', ...geographicTileBounds({ z: 14, x: 23432, y: 9870 }) });
    sampler.addTile(tile);
    const latDeg = (tile.southDeg + tile.northDeg) / 2, lonDeg = (tile.westDeg + tile.eastDeg) / 2;
    const ground = sampler.sample(latDeg, lonDeg)!;
    const groundPos = geodeticToBodyFixed({ latDeg, lonDeg, heightKm: ground.elevationKm }, datum);
    const above = geodeticToBodyFixed({ latDeg, lonDeg, heightKm: ground.elevationKm + 100 }, datum);
    const terrain = new ResidentTerrainSurface(sampler, '499', 'IAU_MARS');
    const reference = new ReferenceEllipsoidSurface('499', 'IAU_MARS', [3396.19, 3396.19, 3376.2]);
    const candidate: FovSurfaceCandidate = { id: 'Mars', centerKm: [0, 0, 0], bodyToWorld: IDENTITY, boundingRadiusKm: 3396.19 * 1.01, surfaces: [terrain, reference] };
    const origin: Vec3 = [above.xKm, above.yKm, above.zKm];
    const nadir: Vec3 = [groundPos.xKm - above.xKm, groundPos.yKm - above.yKm, groundPos.zKm - above.zKm];
    return { sampler, candidate, origin, nadir, ground };
  }

  it('clips at terrain through the shared physical-surface path and keeps it coarse', () => {
    const { candidate, origin, nadir } = marsTerrain();
    const samples = clip(origin, nadir, circular(0.1), [candidate], 1000);
    expect(samples.every(s => s.hit?.source === 'terrain' && s.hit.detail === 'coarse' && !s.hit.fallback)).toBe(true);
    // Terrain at Jezero is below the datum, so the terrain answer differs from the reference shape.
    const terrainHit = resolveFovRay(origin, nadir, [candidate], 1000)!;
    const referenceOnly = resolveFovRay(origin, nadir, [{ ...candidate, surfaces: [candidate.surfaces[1]] }], 1000)!;
    expect(terrainHit.surfaceDistanceKm).toBeCloseTo(100, 1);
    expect(Math.abs(terrainHit.surfaceDistanceKm - referenceOnly.surfaceDistanceKm)).toBeGreaterThan(0.5);
  });

  it('falls back to the explicit reference shape outside resident terrain, marked as such', () => {
    const { candidate, origin, nadir, sampler } = marsTerrain();
    const wide = clip(origin, nadir, circular(10), [candidate], 1000);
    expect(wide.every(s => s.hit)).toBe(true);
    expect(wide.some(s => s.hit!.source === 'reference' && s.hit!.fallback && s.hit!.detail === 'sufficient')).toBe(true);
    sampler.clear();
    const unloaded = clip(origin, nadir, circular(0.1), [candidate], 1000);
    expect(unloaded.every(s => s.hit?.source === 'reference' && s.hit.fallback)).toBe(true);
  });
});
