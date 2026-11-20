// Host-supplied observations (a mission simulation's survey images): given
// footprints, one per exposure, with the region they were asked to cover.
// They must be read-only scene content draped on the terrain that is drawn —
// not lifted 0.2 % of the radius (≈3.5 km on the Moon) off a reference
// ellipsoid — pickable one exposure at a time, and precise at metre scale.
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { observationFromCosmographia, type Observation } from '@cosmolabe/core';
import { ObservationsVisualizer } from '../plugins/ObservationsVisualizer.js';
import type { RendererContext } from '../plugins/RendererContext.js';

const R = 1737.4;
/** Terrain 1.2 km below the reference sphere, as at MoonFall's crater floor. */
const FLOOR_KM = R - 1.2;

/** A footprint ~200 m across centred at (lon, lat), near the south pole. */
function square(lon: number, lat: number, halfKm = 0.1): [number, number][] {
  const dLat = (halfKm / R) * (180 / Math.PI);
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  return [[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat]];
}

function observation(): Observation {
  return observationFromCosmographia('Survey', 'Moon', {
    instrument: 'Polaris-A Survey Camera',
    observer: 'Polaris-A',
    provenance: { id: 'plandev:plan/99/simulation_dataset/7/span/3', kind: 'observation', classification: 'planned' },
    groups: [
      { startTime: 1000, endTime: 1000 },
      { startTime: 1002, endTime: 1002 },
    ],
    coverage: { kind: 'footprint', polygonLonLat: [square(-40, -89.70), square(-40, -89.69)] },
    requestedRegion: { name: 'West rim', label: 'West rim · Survey target', polygonLonLat: square(-70, -89.68, 0.4) },
    fillInObservations: false,
    footprintColor: [0.2, 0.9, 1],
  }, (v) => Number(v));
}

/** A stand-in BodyMesh with cube terrain: radial rays meet a sphere of radius FLOOR_KM. */
function terrain(resident = true) {
  let revision = 1;
  return {
    position: new THREE.Vector3(),
    terrainRaySurface: { bodyId: 'Moon' },
    get terrainRevision() { return revision; },
    bump() { revision++; },
    rays: 0,
    detail: 'sufficient' as 'sufficient' | 'coarse',
    intersectTerrainRay(ray: { origin: { xKm: number; yKm: number; zKm: number }; direction: readonly number[] }) {
      this.rays++;
      if (!resident) return { kind: 'unavailable', reason: 'not-resident' };
      const o = [ray.origin.xKm, ray.origin.yKm, ray.origin.zKm];
      const n = Math.hypot(...o);
      return { kind: 'hit', detail: this.detail, position: { xKm: (o[0] / n) * FLOOR_KM, yKm: (o[1] / n) * FLOOR_KM, zKm: (o[2] / n) * FLOOR_KM } };
    },
  };
}

/** Update until the per-build ray budget has placed every vertex (later builds are throttled in wall time). */
function settle(vis: ObservationsVisualizer, obj: THREE.Object3D, ctx: RendererContext, builds = 40) {
  let t = performance.now();
  const now = vi.spyOn(performance, 'now').mockImplementation(() => t);
  for (let i = 0; i < builds; i++) { vis.updateObservation(obj, 0, ctx); t += 1_000; }
  now.mockRestore();
}

function scene(mesh: ReturnType<typeof terrain>) {
  const ctx = {
    universe: { getBody: () => ({ radii: [R, R, R] }), bodyToWorldQuat: () => [1, 0, 0, 0], spiceInstance: undefined },
    scaleFactor: 1,
    getBodyMesh: () => mesh,
  } as unknown as RendererContext;
  const vis = new ObservationsVisualizer();
  const obj = vis.createVisualForObservation(observation(), ctx, 'Survey', { always: true });
  settle(vis, obj, ctx); // before any exposure: drawn anyway (`always`)
  const [fill, outline, , , regionOutline, regionFill, highlight] = obj.children as THREE.Mesh[];
  return { vis, obj, ctx, fill: fill!, outline: outline!, regionOutline: regionOutline!, regionFill: regionFill!, highlight: highlight! };
}

/** Absolute body-fixed radii of a mesh's vertices (stored relative to the mesh's own position). */
function radii(m: THREE.Object3D & { geometry?: THREE.BufferGeometry }) {
  const pos = m.geometry!.getAttribute('position');
  const out: number[] = [];
  for (let i = 0; i < pos.count; i++) out.push(Math.hypot(pos.getX(i) + m.position.x, pos.getY(i) + m.position.y, pos.getZ(i) + m.position.z));
  return out;
}

describe('host observations (given footprints on streamed terrain)', () => {
  it('drapes footprints and the requested region on the terrain, a couple of metres above it', () => {
    const s = scene(terrain());
    expect(s.obj.visible).toBe(true);
    for (const m of [s.outline, s.fill, s.regionOutline, s.regionFill]) {
      const r = radii(m);
      expect(r.length).toBeGreaterThan(0);
      for (const x of r) expect(Math.abs(x - (FLOOR_KM + 0.002))).toBeLessThan(1e-6);
    }
    expect(s.vis.placementOf(s.obj)).toBe('terrain');
  });

  it('stores vertices relative to the footprints, not the Moon’s centre (metre precision in Float32)', () => {
    const s = scene(terrain());
    expect(s.outline.position.length()).toBeGreaterThan(R - 2);
    const pos = s.outline.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) expect(Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i))).toBeLessThan(5);
  });

  it('subdivides edges along the terrain rather than spanning them with chords', () => {
    const s = scene(terrain());
    // Each ~200 m edge in ≤25 m steps: at least 8 segments per edge, 4 edges, 2 footprints.
    expect(s.outline.geometry.getAttribute('position').count / 2).toBeGreaterThanOrEqual(2 * 4 * 8);
  });

  it('picks one exposure (with its epoch) or the region, and highlights it', () => {
    const s = scene(terrain());
    const ray = (lon: number, lat: number) => {
      const lo = (lon * Math.PI) / 180, la = (lat * Math.PI) / 180;
      const d = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
      s.obj.updateMatrixWorld(true);
      return new THREE.Raycaster(d.clone().multiplyScalar(R + 5), d.clone().negate());
    };
    expect(s.vis.pickGiven(s.obj, ray(-40, -89.69))).toMatchObject({ footprint: 1, region: false, et: 1002 });
    expect(s.vis.pickGiven(s.obj, ray(-40, -89.70))).toMatchObject({ footprint: 0, region: false, et: 1000 });
    expect(s.vis.pickGiven(s.obj, ray(-70, -89.68))).toMatchObject({ footprint: null, region: true });
    expect(s.vis.pickGiven(s.obj, ray(120, -89.5))).toBeNull();
    s.vis.setSelected(s.obj, 1);
    expect(s.highlight.geometry.getAttribute('position').count).toBeGreaterThan(0);
    s.vis.setSelected(s.obj, null);
    expect(s.highlight.geometry.getAttribute('position').count).toBe(0);
  });

  it('tells overlapping footprints apart: the one centred nearest the pointer wins', () => {
    const ctx = {
      universe: { getBody: () => ({ radii: [R, R, R] }), bodyToWorldQuat: () => [1, 0, 0, 0], spiceInstance: undefined },
      scaleFactor: 1, getBodyMesh: () => terrain(),
    } as unknown as RendererContext;
    // Consecutive survey images overlap by most of their length.
    const obs = observationFromCosmographia('Overlap', 'Moon', {
      groups: [0, 2, 4].map((t) => ({ startTime: t, endTime: t })),
      coverage: { kind: 'footprint', polygonLonLat: [-40.0, -39.6, -39.2].map((lon) => square(lon, -89.7)) },
    }, (v) => Number(v));
    const vis = new ObservationsVisualizer();
    const obj = vis.createVisualForObservation(obs, ctx, 'Overlap', { always: true });
    settle(vis, obj, ctx);
    obj.updateMatrixWorld(true);
    for (const [lon, want] of [[-40.0, 0], [-39.6, 1], [-39.2, 2]] as const) {
      const lo = (lon * Math.PI) / 180, la = (-89.7 * Math.PI) / 180;
      const d = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
      expect(vis.pickGiven(obj, new THREE.Raycaster(d.clone().multiplyScalar(R + 5), d.clone().negate()))?.footprint).toBe(want);
    }
  });

  it('falls back to the reference shape where terrain is not resident, says so, and re-drapes as it arrives', () => {
    const mesh = terrain(false);
    const s = scene(mesh);
    expect(s.vis.placementOf(s.obj)).toBe('partial-terrain');
    for (const x of radii(s.outline)) expect(Math.abs(x - (R + 0.002))).toBeLessThan(1e-6);
    // Nothing new to try at the same terrain revision: no rebuild, no rays.
    const rays = mesh.rays;
    s.vis.updateObservation(s.obj, 0, s.ctx);
    expect(mesh.rays).toBe(rays);
  });

  it('spreads a large drape over several builds within the per-build ray budget', () => {
    const mesh = terrain();
    const ctx = { universe: { getBody: () => ({ radii: [R, R, R] }), bodyToWorldQuat: () => [1, 0, 0, 0] }, scaleFactor: 1, getBodyMesh: () => mesh } as unknown as RendererContext;
    const vis = new ObservationsVisualizer();
    const obj = vis.createVisualForObservation(observation(), ctx, 'Survey', { always: true });
    vis.updateObservation(obj, 0, ctx);
    expect(mesh.rays).toBeLessThanOrEqual(200);
    expect(vis.placementOf(obj)).toBe('partial-terrain');
    settle(vis, obj, ctx);
    expect(vis.placementOf(obj)).toBe('terrain');
  });

  it('casts each vertex once when terrain is detailed, and re-casts only pending vertices as terrain refines', () => {
    const mesh = terrain();
    const s = scene(mesh);
    const first = mesh.rays;
    expect(first).toBeGreaterThan(0);
    mesh.bump();
    const t = performance.now();
    // Settled: a new terrain revision does not re-drape.
    vi.spyOn(performance, 'now').mockReturnValue(t + 10_000);
    s.vis.updateObservation(s.obj, 0, s.ctx);
    expect(mesh.rays).toBe(first);
    vi.restoreAllMocks();
    // Coarse hits stay pending and are cast again on the next build.
    const coarse = terrain();
    coarse.detail = 'coarse';
    const c = scene(coarse);
    const n = coarse.rays;
    coarse.bump(); // finer terrain arrived
    vi.spyOn(performance, 'now').mockReturnValue(t + 10_000);
    c.vis.updateObservation(c.obj, 0, c.ctx);
    expect(coarse.rays).toBeGreaterThan(n);
    vi.restoreAllMocks();
  });

  it('is never drawn as editable geography: no handles, only line and mesh content', () => {
    const s = scene(terrain());
    expect(s.obj.children.every((c) => c instanceof THREE.Mesh || c instanceof THREE.LineSegments)).toBe(true);
  });
});
