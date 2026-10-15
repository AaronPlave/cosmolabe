import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, DoubleSide, Raycaster, Vector3 } from 'three';
import { Ellipsoid } from '3d-tiles-renderer/three';
import { TerrainSampler, bodyFixedToGeodetic, type TerrainDatum, type BodyFixedCartesian } from '../TerrainSampler.js';
import { geographicTileBounds } from '../TerrainValidation.js';
import { decodeQuantizedMesh, toTerrainMeshTile } from '../internal/quantized-mesh.js';
import { CpuMeshSurface } from '../surface/CpuMeshSurface.js';
import { GlobeTileSurface } from '../surface/GlobeTileSurface.js';
import { requestSurfaceIntersection, type PhysicalSurfaceMetadata, type SurfaceRay } from '../surface/PhysicalSurface.js';
import { pickPhysicalSurface, cameraPositionFromSurfacePick, surfaceRayBetween } from '../surface/SurfaceConsumers.js';
import { concaveSurface } from './fixtures/concaveSurface.js';

const metadata: PhysicalSurfaceMetadata = {
  bodyId: 'fixture', frame: 'FIXTURE_FIXED', source: { id: 'torus', kind: 'triangle-mesh', version: 'fixture-mesh-v1', uncertaintyKm: 0 },
  shape: { kind: 'mesh' }, coverage: 'complete-product',
};
const options = { maxMeshErrorKm: 0.001 };
const ray = (x = 4, direction = -1): SurfaceRay => ({ origin: { xKm: x, yKm: 0, zKm: 0 }, direction: [direction, 0, 0], nearKm: 0, farKm: 8 });
const distance = (a: BodyFixedCartesian, b: BodyFixedCartesian) => Math.hypot(a.xKm - b.xKm, a.yKm - b.yKm, a.zKm - b.zKm);
const meshSurface = () => new CpuMeshSurface(metadata, concaveSurface(), { meshDeviationBoundKm: 0, sourceUncertaintyKm: 0 });

function marsTile() {
  const datum: TerrainDatum = { referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] }, verticalDatum: 'ellipsoid', heightConvention: 'geodetic-normal' };
  const sampler = new TerrainSampler(datum, { id: 'marshub', kind: 'quantized-mesh', version: 'repo-fixture', uncertaintyKm: 0.1 }, 1);
  const bytes = readFileSync(new URL('./fixtures/marshub-14-23432-9870.terrain', import.meta.url));
  const decoded = decodeQuantizedMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const tile = toTerrainMeshTile(decoded, { id: '14/23432/9870', ...geographicTileBounds({ z: 14, x: 23432, y: 9870 }) });
  sampler.addTile(tile);
  // Independently reconstruct the renderer's cartographic vertices through upstream Ellipsoid,
  // in tile-centered float32 coordinates like QuantizedMeshLoader. No scene used by the query.
  const ellipsoid = new Ellipsoid(3396190, 3396190, 3376200);
  const points = Array.from(tile.u, (u, i) => ellipsoid.getCartographicToPosition(
    (tile.southDeg + tile.v[i] * (tile.northDeg - tile.southDeg)) * Math.PI / 180,
    (tile.westDeg + u * (tile.eastDeg - tile.westDeg)) * Math.PI / 180,
    decoded.heightMeters[i], new Vector3(),
  ).multiplyScalar(0.001));
  const center = points[0].clone();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(points.flatMap(p => p.clone().sub(center).toArray()), 3));
  geometry.setIndex(Array.from(tile.indices));
  const rendered = new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide }));
  rendered.position.copy(center); rendered.updateMatrixWorld(true);
  const a = points[tile.indices[0]], b = points[tile.indices[1]], c = points[tile.indices[2]];
  const centroid = a.clone().add(b).add(c).multiplyScalar(1 / 3);
  const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
  const start = centroid.clone().addScaledVector(normal, 0.01), end = centroid.clone().addScaledVector(normal, -0.01);
  const queryRay = surfaceRayBetween({ xKm: start.x, yKm: start.y, zKm: start.z }, { xKm: end.x, yKm: end.y, zKm: end.z });
  return { sampler, tile, datum, queryRay, rendered };
}

describe('shared physical surface proof', () => {
  it('picks and places a camera on a concave mesh without a globe capability', () => {
    const surface = meshSurface();
    expect(surface).not.toHaveProperty('sampleElevation');
    const hit = pickPhysicalSurface(surface, ray(), options);
    expect(hit.kind).toBe('hit');
    if (hit.kind !== 'hit') throw new Error('Expected torus intersection');
    expect(hit.position.xKm).toBeCloseTo(3, 10);
    expect(hit.distanceKm).toBeCloseTo(1, 10);
    expect(hit.detail).toBe('sufficient');
    expect(hit.metadata.source.version).toBe('fixture-mesh-v1');
    const camera = cameraPositionFromSurfacePick(hit, 0.01)!;
    expect(distance(camera, hit.position)).toBeCloseTo(0.01, 10);
    expect(camera.xKm).toBeGreaterThan(hit.position.xKm);
    // Crossing the hole has no surface hit: an ellipsoid fallback would incorrectly block it.
    expect(surface.intersectRay({ origin: { xKm: 0, yKm: 0, zKm: 4 }, direction: [0, 0, -1], nearKm: 0, farKm: 8 }, options).kind).toBe('miss');
  });

  it('retains two intersections at the same lat/lon, including the concave inside face', () => {
    const surface = meshSurface();
    const first = surface.intersectRay(ray(0, 1), options);
    const second = surface.intersectRay({ ...ray(0, 1), nearKm: 1.01 }, options);
    if (first.kind !== 'hit' || second.kind !== 'hit') throw new Error('Expected both torus surfaces');
    expect(first.position.xKm).toBeCloseTo(1, 10);
    expect(second.position.xKm).toBeCloseTo(3, 10);
    expect(first.normal[0]).toBeLessThan(0); // outward into the concavity, never universally radial
    const sphere: TerrainDatum = { referenceShape: { kind: 'sphere', radiusKm: 1 }, verticalDatum: 'reference-sphere', heightConvention: 'radial' };
    expect(bodyFixedToGeodetic(first.position, sphere).latDeg).toBeCloseTo(bodyFixedToGeodetic(second.position, sphere).latDeg);
    expect(bodyFixedToGeodetic(first.position, sphere).lonDeg).toBeCloseTo(bodyFixedToGeodetic(second.position, sphere).lonDeg);
  });

  it('uses an existing decoded Mars tile for the same picking and camera consumer', () => {
    const { sampler, tile, datum, queryRay, rendered } = marsTile();
    try {
      const surface = new GlobeTileSurface(sampler, tile.id, '499', 'IAU_MARS');
      const hit = pickPhysicalSurface(surface, queryRay, options);
      if (hit.kind !== 'hit') throw new Error('Expected Mars tile intersection');
      expect(hit.tileId).toBe(tile.id);
      expect(hit.detail).toBe('coarse'); // no claimed source-error bound or whole ray coverage
      expect(hit.accuracy.meshDeviationBoundKm).toBeNull();
      expect(hit.accuracy.sourceUncertaintyKm).toBe(0.1);
      expect(cameraPositionFromSurfacePick(hit, 0.001)).toBeNull();
      expect(distance(cameraPositionFromSurfacePick(hit, 0.001, true)!, hit.position)).toBeCloseTo(0.001, 9);
      const g = bodyFixedToGeodetic(hit.position, datum);
      const sample = surface.sampleElevation(g.latDeg, g.lonDeg)!;
      // Scientific angular interpolation and Cartesian chord intersection differ by curvature.
      // This fixture gate is 1 metre; it is not a universal error bound for all source tiles.
      expect(Math.abs(sample.elevationKm - g.heightKm!)).toBeLessThan(0.001);
      const rc = new Raycaster(new Vector3(queryRay.origin.xKm, queryRay.origin.yKm, queryRay.origin.zKm), new Vector3(...queryRay.direction).normalize(), queryRay.nearKm, queryRay.farKm);
      const visualHit = rc.intersectObject(rendered)[0];
      expect(visualHit).toBeDefined();
      expect(distance(hit.position, { xKm: visualHit.point.x, yKm: visualHit.point.y, zKm: visualHit.point.z })).toBeLessThan(0.000001); // 1 mm
      sampler.clear();
      expect(surface.intersectRay(queryRay, options)).toMatchObject({ kind: 'unavailable', reason: 'not-resident' });
    } finally { rendered.geometry.dispose(); rendered.material.dispose(); }
  });

  it('reports partial misses, unknown/coarse approximation and budget failures explicitly', () => {
    const mesh = concaveSurface();
    const partial = new CpuMeshSurface({ ...metadata, coverage: 'partial-product' }, mesh, { meshDeviationBoundKm: 0 });
    expect(partial.intersectRay(ray(), options)).toMatchObject({ kind: 'hit', detail: 'coarse' });
    expect(partial.intersectRay({ ...ray(), origin: { xKm: 4, yKm: 4, zKm: 4 } }, options)).toMatchObject({ kind: 'unavailable', reason: 'partial-coverage' });
    const coarse = new CpuMeshSurface(metadata, mesh, { meshDeviationBoundKm: 0.01, sourceUncertaintyKm: 0.5 });
    expect(coarse.intersectRay(ray(), options)).toMatchObject({ detail: 'coarse', accuracy: { meshDeviationBoundKm: 0.01, sourceUncertaintyKm: 0.5 } });
    expect(coarse.intersectRay(ray(), { maxMeshErrorKm: 0.02 })).toMatchObject({ detail: 'sufficient' });
    const budget = new CpuMeshSurface(metadata, mesh, { meshDeviationBoundKm: 0 }, 1);
    expect(budget.retainedBytes).toBe(0);
    expect(budget.intersectRay(ray(), options)).toMatchObject({ kind: 'unavailable', reason: 'budget' });
  });

  it('invalidates globe snapshots on tile replacement and rejects unsupported datum conversions', () => {
    const { sampler, tile, queryRay, rendered } = marsTile();
    rendered.geometry.dispose(); rendered.material.dispose();
    const surface = new GlobeTileSurface(sampler, tile.id, '499', 'IAU_MARS');
    const first = surface.intersectRay(queryRay, options);
    expect(first.kind).toBe('hit');
    sampler.addTile({ ...tile, elevationsKm: Float32Array.from(tile.elevationsKm, h => h + 1) });
    expect(surface.intersectRay(queryRay, options).kind).toBe('unavailable');
    expect(new GlobeTileSurface(sampler, tile.id, '499', 'IAU_MARS', 1).intersectRay(queryRay, options)).toMatchObject({ reason: 'budget' });
    for (const datum of [
      { ...sampler.datum, heightConvention: 'radial' as const },
      { ...sampler.datum, verticalDatum: 'areoid' as const },
      { ...sampler.datum, referenceShape: { kind: 'ellipsoid' as const, radiiKm: [3, 2, 1] as const } },
    ]) {
      const unsupported = new TerrainSampler(datum, sampler.source); unsupported.addTile(tile);
      expect(new GlobeTileSurface(unsupported, tile.id, '499', 'IAU_MARS').intersectRay(queryRay, options)).toMatchObject({ reason: 'unsupported-datum' });
    }
  });

  it('normalizes directions, enforces distance bounds and validates inputs', () => {
    const surface = meshSurface();
    expect(surface.intersectRay({ ...ray(), direction: [-20, 0, 0] }, options)).toMatchObject({ distanceKm: 1 });
    expect(surface.intersectRay({ ...ray(), farKm: 0.5 }, options).kind).toBe('miss');
    for (const invalid of [{ ...ray(), direction: [0, 0, 0] as const }, { ...ray(), farKm: Infinity }, { ...ray(), nearKm: -1 }]) {
      expect(() => surface.intersectRay(invalid, options)).toThrow();
    }
    expect(() => surface.intersectRay(ray(), { maxMeshErrorKm: NaN })).toThrow();
    expect(() => new CpuMeshSurface(metadata, { positionsKm: new Float64Array(9), indices: new Uint32Array([0, 1, 3]) }, { meshDeviationBoundKm: 0 })).toThrow();
    const original = concaveSurface(), copied = new CpuMeshSurface(metadata, original, { meshDeviationBoundKm: 0 });
    original.positionsKm.fill(0);
    expect(copied.intersectRay(ray(), options)).toMatchObject({ distanceKm: 1 });
  });

  it('reuses sphere grids across the antimeridian without changing scientific sampling', () => {
    const datum: TerrainDatum = { referenceShape: { kind: 'sphere', radiusKm: 1 }, verticalDatum: 'reference-sphere', heightConvention: 'radial' };
    const sampler = new TerrainSampler(datum, { id: 'grid', kind: 'height-grid' });
    sampler.addTile({ id: 'wrap', westDeg: 170, eastDeg: -170, southDeg: -1, northDeg: 1, width: 3, height: 3, elevationsKm: new Float32Array(9) });
    const surface = new GlobeTileSurface(sampler, 'wrap', 'sphere', 'SPHERE_FIXED');
    const hit = surface.intersectRay({ origin: { xKm: -2, yKm: 0, zKm: 0 }, direction: [1, 0, 0], nearKm: 0, farKm: 2 }, options);
    expect(hit).toMatchObject({ kind: 'hit', tileId: 'wrap' });
    if (hit.kind !== 'hit') throw new Error('Expected antimeridian intersection');
    expect(hit.distanceKm).toBeCloseTo(1, 12);
    expect(surface.sampleElevation(0, 180)?.elevationKm).toBe(0);
  });

  it('loads once, preserves unresolved availability, and discards cancelled results', async () => {
    const surface = meshSurface(), controller = new AbortController();
    let loads = 0;
    expect((await requestSurfaceIntersection(surface, ray(), options, controller.signal, { async ensureRayCoverage() { loads++; } })).kind).toBe('hit');
    expect(loads).toBe(0);
    const partial = new CpuMeshSurface({ ...metadata, coverage: 'partial-product' }, concaveSurface(), { meshDeviationBoundKm: null });
    expect((await requestSurfaceIntersection(partial, ray(), options, controller.signal, { async ensureRayCoverage() { loads++; } })).kind).toBe('hit');
    expect(loads).toBe(1);
    const coarse = new CpuMeshSurface(metadata, concaveSurface(), { meshDeviationBoundKm: null });
    const missedRay = { ...ray(), origin: { xKm: 4, yKm: 4, zKm: 4 } };
    expect(await requestSurfaceIntersection(coarse, missedRay, options, controller.signal, { async ensureRayCoverage() { loads++; } })).toMatchObject({ kind: 'miss', detail: 'coarse' });
    expect(loads).toBe(2);
    await expect(requestSurfaceIntersection(partial, ray(), options, controller.signal, {
      async ensureRayCoverage(_ray, _options, signal) { expect(signal).toBe(controller.signal); controller.abort(); },
    })).rejects.toThrow();
    await expect(requestSurfaceIntersection(surface, ray(), options, controller.signal)).rejects.toThrow();
  });
});
