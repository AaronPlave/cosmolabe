/**
 * Surface navigation's terrain anchor (#190) on cube-sphere terrain: a
 * coordinate target placed while the cube grids are cold moves onto the
 * coarse resident grid, then onto the finer grid that replaces it, each time
 * by the difference in elevation, and the camera's orbit pivot with it.
 *
 * Driven against a real `TerrainManager` with cube grids, whose samples come
 * from `CubeSphereGridSource` rather than the tile sampler — the revision the
 * anchor watches has to be the one those grids move.
 */
import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { navigationReference, resolveGeographicTarget, surfaceViewPlacement, withoutTerrainCoverage } from '@cosmolabe/core';
import { TerrainManager } from '../TerrainManager.js';
import { CameraController } from '../controls/CameraController.js';
import { SurfaceTerrainAnchor, bodyFixedToMeshLocal, surfacePoseFromBodyFixed, type AnchorTerrain } from '../SurfaceNavigation.js';
import type { CubeGridManifest } from '../surface/CubeSphereGrids.js';
import type { BodyMesh } from '../BodyMesh.js';

const NO_RENDERER = undefined as unknown as THREE.WebGLRenderer;
const R = 1737.4, W = 5;
const BASE = 'https://example.invalid/cube/';
/** Level 0 grids are 100 m above the sphere, level 1 (the south pole face) 200 m. */
const HEIGHT_M = (level: number) => 100 * (level + 1);

function manifest(): CubeGridManifest {
  const tiles: CubeGridManifest['tiles'] = (['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const).map(f => [f, 0, 0, 0, 0.001]);
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) tiles.push(['nz', 1, x, y, 0.0005]);
  return {
    format: 'cosmolabe-cube-height-grid-1',
    datum: { referenceShape: { kind: 'sphere', radiusKm: R }, verticalDatum: 'reference-sphere', heightConvention: 'radial' },
    source: { id: 'cube-fixture', kind: 'height-grid', version: 'fixture-v1' },
    grid: { width: W, height: W, uri: 'heights/{face}/{level}/{x}/{y}.f32' },
    heightRangeKm: [0.1, 0.2],
    maxLevel: 1,
    tiles,
  };
}

/** Serve the manifest at once, and hold each level's grids until `release` lets that level through. */
function serve() {
  const released = new Set<number>();
  const waiting = new Map<number, (() => void)[]>();
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = String(input);
    if (url.endsWith('cpu-grids.json')) return new Response(JSON.stringify(manifest()));
    const level = Number(url.split('/heights/')[1].split('/')[1]);
    if (!released.has(level)) await new Promise<void>((resolve) => waiting.set(level, [...(waiting.get(level) ?? []), resolve]));
    return new Response(new Float32Array(W * W).fill(HEIGHT_M(level)).buffer);
  }));
  return {
    release: (level: number) => {
      released.add(level);
      for (const resolve of waiting.get(level) ?? []) resolve();
      waiting.delete(level);
    },
  };
}

function fakeElement() {
  const noop = { addEventListener() {}, removeEventListener() {} };
  return {
    addEventListener() {}, removeEventListener() {}, style: {},
    ownerDocument: { ...noop, defaultView: noop, documentElement: { clientLeft: 0, clientTop: 0 } },
    clientWidth: 800, clientHeight: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 }),
    setPointerCapture() {}, releasePointerCapture() {},
  } as unknown as HTMLElement;
}

beforeAll(() => vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} }));
afterEach(() => { vi.unstubAllGlobals(); vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} }); vi.restoreAllMocks(); });

describe('SurfaceTerrainAnchor on cube-sphere terrain', () => {
  it('follows cold → coarse → fine cube grids, moving the target and pivot by each change', async () => {
    const { release } = serve();
    const tm = new TerrainManager(
      { type: '3dtiles', url: `${BASE}tileset.json`, datum: { verticalDatum: 'reference-sphere', heightConvention: 'radial' },
        cubeSphere: { cpuGrids: `${BASE}cpu-grids.json`, residentLevel: 0 } },
      R, NO_RENDERER,
    );
    // The body as surface navigation sees it: BodyMesh's revision and sample are TerrainManager's.
    const terrain: AnchorTerrain = {
      get terrainRevision() { return tm.cpuRevision; },
      sampleTerrain: (lat, lon) => tm.sample(lat, lon),
    };

    // Cold: nothing decoded, so the target goes on the datum, awaiting terrain.
    const reference = navigationReference({ name: 'Moon', radii: [R, R, R], geometryType: 'Globe', terrainDatum: tm.sampler.datum });
    if (!reference.ok) throw new Error(reference.reason);
    expect(reference.reference.datum.origin).toBe('terrain');
    expect(tm.sample(-89.9, 0)).toBeNull();
    const target = withoutTerrainCoverage(resolveGeographicTarget(
      { bodyName: 'Moon', latDeg: -89.9, lonDeg: 0, latitude: 'planetocentric', longitudeDirection: 'east' }, reference.reference));
    const anchor = new SurfaceTerrainAnchor(target, terrain);

    // The camera, overhead and pivoting on that datum point.
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const cc = new CameraController(new THREE.PerspectiveCamera(60, 4 / 3, 1e-6, 1e12), fakeElement());
    const moon = {
      position: new THREE.Vector3(), displayRadius: R, scaleFactor: 1, hasTerrain: true,
      mesh: { quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) },
      body: { name: 'Moon', rotation: undefined, rotationAt: () => undefined },
    } as unknown as BodyMesh;
    cc.setModeContext(null, 0, 1, new Map([['Moon', moon]]));
    cc.jumpToSurface(moon, surfacePoseFromBodyFixed(surfaceViewPlacement(target, 'overhead'), 1));
    const frame = () => { now += 16; cc.applyPendingOriginSwitch(); cc.update(); };
    frame();
    const apply = (shift: readonly [number, number, number]) => cc.retargetSurface(moon, bodyFixedToMeshLocal(shift, 1));
    const pivotHeightKm = () => cc.controls.target.length() - R;
    const eyeAbovePivotKm = () => cc.camera.position.distanceTo(cc.controls.target);
    const eyeRange = eyeAbovePivotKm();
    expect(pivotHeightKm()).toBeCloseTo(0, 9);
    expect(anchor.update(terrain, apply)).toBeNull(); // nothing new decoded yet

    // The resident coarse grids arrive: the target and pivot rise 100 m.
    release(0);
    await vi.waitFor(() => expect(tm.cubeStats?.residentTiles).toBe(6));
    const coarse = anchor.update(terrain, apply);
    expect(coarse).not.toBeNull();
    expect(coarse !== 'released' && coarse?.height).toMatchObject({ from: 'terrain-sample', km: expect.closeTo(0.1, 6), tileId: 'nz/0/0/0' });
    frame();
    expect(pivotHeightKm()).toBeCloseTo(0.1, 6);
    expect(eyeAbovePivotKm()).toBeCloseTo(eyeRange, 6); // the framing is kept

    // The sample asked for the finer grid; it replaces the coarse parent: up another 100 m, not 200.
    release(1);
    await vi.waitFor(() => expect(tm.cubeCoverage(-89.9, 0)?.state).toBe('finest'));
    const fine = anchor.update(terrain, apply);
    expect(fine !== 'released' && fine?.height).toMatchObject({ km: expect.closeTo(0.2, 6), tileId: expect.stringMatching(/^nz\/1\//) });
    frame();
    expect(pivotHeightKm()).toBeCloseTo(0.2, 6);
    expect(eyeAbovePivotKm()).toBeCloseTo(eyeRange, 6);

    // Settled: no new revision, nothing moves.
    expect(anchor.update(terrain, apply)).toBeNull();
    // Other navigation ends it: the shift has nowhere to go.
    cc.frame(moon);
    (anchor as unknown as { revision: number }).revision = -1;
    (anchor.target as { height: { km: number } }).height.km = 0;
    expect(anchor.update(terrain, apply)).toBe('released');
    tm.dispose();
  });

  it('counts cube grid arrivals in the CPU revision, which the tile sampler never sees', async () => {
    const { release } = serve();
    const tm = new TerrainManager(
      { type: '3dtiles', url: `${BASE}tileset.json`, datum: { verticalDatum: 'reference-sphere', heightConvention: 'radial' },
        cubeSphere: { cpuGrids: `${BASE}cpu-grids.json`, residentLevel: 0 } },
      R, NO_RENDERER,
    );
    const start = tm.cpuRevision;
    const samplerStart = tm.sampler.revision;
    release(0);
    await vi.waitFor(() => expect(tm.cubeStats?.residentTiles).toBe(6));
    expect(tm.cpuRevision).toBeGreaterThan(start);
    expect(tm.sampler.revision).toBe(samplerStart);
    tm.dispose();
  });
});
