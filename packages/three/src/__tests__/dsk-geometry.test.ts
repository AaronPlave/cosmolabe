// The Dsk geometry path end to end, short of a GPU: a real DSK read by the
// frames adapter, built into a BufferGeometry, installed on a BodyMesh in
// place of the placeholder, and oriented by the body's rotation with no
// size or axis correction in between.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createHeritageSpice, type HeritageSpice } from '@cosmolabe/frames';
import { Body, FixedRotation, SpiceRotation, UniformRotation, type SpiceInstance } from '@cosmolabe/core';
import { BodyMesh } from '../BodyMesh.js';
import { dskShapeProviderOf, dskToBufferGeometry, gunzipIfNeeded, type DskShape } from '../DskShapeProvider.js';
import { AssetLoadTracker } from '../AssetLoadTracker.js';
import { UniverseRenderer } from '../UniverseRenderer.js';
import { LabelManager } from '../LabelManager.js';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../../kernels/fixtures/${name}`, import.meta.url))));

const fixedPoint = { stateAt: () => ({ position: [0, 0, 0], velocity: [0, 0, 0] }) } as never;

function serve(bytes: Uint8Array) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes as BodyInit)));
}

describe('dskToBufferGeometry', () => {
  it('keeps vertices in body-fixed km and plates as the index', () => {
    const shape: DskShape = {
      vertices: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      plates: [0, 1, 2, 0, 3, 1, 1, 3, 2, 2, 3, 0],
      centerId: 499,
      frame: 'IAU_MARS',
    };
    const g = dskToBufferGeometry(shape);
    expect(Array.from(g.getAttribute('position').array)).toEqual(shape.vertices);
    expect(Array.from(g.getIndex()!.array)).toEqual(shape.plates);
    // Not recentred: the origin is the body's centre of mass.
    expect(g.boundingBox!.min.toArray()).toEqual([0, 0, 0]);
    // The outward plate (0,1,2) has an outward-pointing (+,+,+) normal at vertex 0's plates' average.
    const n = new THREE.Vector3().fromBufferAttribute(g.getAttribute('normal') as THREE.BufferAttribute, 2);
    expect(n.z).toBeGreaterThan(0);
  });

  it('rejects a plate that points past the vertex list', () => {
    expect(() => dskToBufferGeometry({ vertices: [0, 0, 0], plates: [0, 0, 1], centerId: 0, frame: '' })).toThrow(/outside/);
  });
});

describe('gunzipIfNeeded', () => {
  it('passes raw bytes through and inflates gzip by magic number', async () => {
    const raw = fixture('dsk-two-segments.bds');
    expect(await gunzipIfNeeded(raw)).toBe(raw);
    const gz = new Uint8Array(
      await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(),
    );
    expect(Array.from(await gunzipIfNeeded(gz))).toEqual(Array.from(raw));
  });
});

describe('BodyMesh.loadDsk', () => {
  let spice: HeritageSpice;

  beforeAll(async () => {
    spice = await createHeritageSpice();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('narrows the frames adapter to the DSK capability', () => {
    expect(dskShapeProviderOf(spice)).toBe(spice);
    expect(dskShapeProviderOf({})).toBeNull();
    expect(dskShapeProviderOf(undefined)).toBeNull();
  });

  it('replaces the placeholder with the shape at true size, ignoring size and meshRotation', async () => {
    serve(fixture('mu69_lopoly.bds'));
    const body = new Body({
      name: 'Arrokoth',
      naifId: 2486958,
      trajectory: fixedPoint,
      rotation: new FixedRotation([1, 0, 0, 0], 'ECLIPJ2000'),
      geometryType: 'Dsk',
      // Neither applies to an authoritative body-fixed shape.
      geometryData: { type: 'Dsk', source: 'models/mu69_lopoly.bds', size: 1000, meshRotation: [0, 1, 0, 0] },
    });
    const bm = new BodyMesh(body);
    const assets = new AssetLoadTracker();
    bm.assets = assets;
    await bm.loadDsk('https://example.test/models/mu69_lopoly.bds', 1e-3, spice, 'models/mu69_lopoly.bds');

    expect(bm.hasModel).toBe(true);
    expect(bm.mesh.visible).toBe(false);
    // Arrokoth is ~36 km end to end: the measured radius is half the bbox's longest side.
    expect(bm.displayRadius).toBeGreaterThan(15);
    expect(bm.displayRadius).toBeLessThan(20);
    expect(bm.modelContainer!.scale.x).toBeCloseTo(1e-3, 12);
    expect(bm.meshRotationQ.equals(new THREE.Quaternion())).toBe(true);

    const summary = await assets.settle();
    expect(summary.failed).toBe(0);
    expect(summary.loaded).toBe(1);
  });

  it('turns the shape with the body: a body-fixed vertex lands where the rotation puts it', async () => {
    serve(fixture('dsk-two-segments.bds'));
    // A 90° turn about +Z as the source→body rotation; the mesh is drawn with
    // its conjugate (body→world), so that is what a vertex must follow.
    const h = Math.SQRT1_2;
    const body = new Body({
      name: 'Shape',
      trajectory: fixedPoint,
      rotation: new FixedRotation([h, 0, 0, h], 'ECLIPJ2000'),
      geometryType: 'Dsk',
      geometryData: { type: 'Dsk', source: 'shape.bds' },
    });
    const bm = new BodyMesh(body);
    await bm.loadDsk('https://example.test/shape.bds', 1, spice, 'shape.bds');
    bm.updatePosition([0, 0, 0], 0, 1);
    bm.updateMatrixWorld(true);

    const mesh = bm.modelContainer!.children[0] as THREE.Mesh;
    // Vertex 0 is the tetrahedron's (1, 0, 0), body-fixed.
    const v = new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position') as THREE.BufferAttribute, 0);
    expect(v.toArray()).toEqual([1, 0, 0]);
    v.applyMatrix4(mesh.matrixWorld);
    const expected = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion(0, 0, h, h).invert());
    expect(v.distanceTo(expected)).toBeLessThan(1e-6);
  });

  it('shares body depth and picks real plates, leaving the empty gap between segments unpickable', async () => {
    serve(fixture('dsk-two-segments.bds'));
    const bm = new BodyMesh(new Body({ name: 'Shape', trajectory: fixedPoint,
      rotation: new FixedRotation([1, 0, 0, 0], 'ECLIPJ2000'), geometryType: 'Dsk' }));
    await bm.loadDsk('shape.bds', 1, spice, 'shape.bds');
    bm.updatePosition([0, 0, 0], 0, 1);
    bm.updateMatrixWorld(true);
    const mesh = bm.getDskMeshes()[0];
    expect(mesh.layers.isEnabled(0)).toBe(true);
    expect(mesh.layers.isEnabled(1)).toBe(false);
    expect(bm.modelContainer!.layers.isEnabled(1)).toBe(false);
    const shader = { vertexShader: '#include <logdepthbuf_vertex>', fragmentShader: '#include <logdepthbuf_fragment>', uniforms: {} };
    (mesh.material as THREE.Material).onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('#include <logdepthbuf_vertex>');
    expect(shader.fragmentShader).toContain('#include <logdepthbuf_fragment>');

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    const renderer = Object.assign(Object.create(UniverseRenderer.prototype), {
      camera, bodyMeshes: new Map([['Shape', bm]]), _dblClickRaycaster: new THREE.Raycaster(),
    }) as { _discoverBodyMesh(x: number, y: number): string | null };
    const aim = (x: number) => {
      camera.position.set(x, 0.2, 3); camera.lookAt(x, 0.2, 0); camera.updateMatrixWorld(true);
    };
    aim(0.2);
    expect(renderer._discoverBodyMesh(0, 0)).toBe('Shape');
    aim(5); // inside the merged bounding box/sphere, outside both actual shapes
    expect(renderer._discoverBodyMesh(0, 0)).toBeNull();
    aim(0.2); bm.visible = false;
    expect(renderer._discoverBodyMesh(0, 0)).toBeNull();
  });

  it('uses DSK triangles for label occlusion and returns probe coordinates in native body-fixed axes', async () => {
    serve(fixture('dsk-two-segments.bds'));
    const h = Math.SQRT1_2;
    const bm = new BodyMesh(new Body({ name: 'Shape', trajectory: fixedPoint,
      rotation: new FixedRotation([h, 0, 0, h], 'ECLIPJ2000'), geometryType: 'Dsk' }));
    await bm.loadDsk('shape.bds', 0.001, spice, 'shape.bds');
    bm.updatePosition([20, 30, 40], 0, 0.001);
    const q = bm.bodyToWorldQuaternion(new THREE.Quaternion());
    const world = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyQuaternion(q).multiplyScalar(0.001).add(bm.position);
    const origin = world(0.2, 0.2, 3);
    expect(bm.dskOccludes(origin, world(0.2, 0.2, 1))).toBe(false); // foreground
    expect(bm.dskOccludes(origin, world(0.2, 0.2, -1))).toBe(true);
    expect(bm.dskOccludes(world(5, 0.2, 3), world(5, 0.2, -1))).toBe(false);
    const labels = new LabelManager({} as HTMLElement);
    for (const [point, opacity] of [[world(0.2, 0.2, 1), 1], [world(0.2, 0.2, -1), 0]] as const) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial());
      labels.applyOcclusionFade(sprite, point, origin.distanceTo(point), [bm], origin);
      expect(sprite.material.opacity).toBe(opacity);
    }
    const camera = new THREE.PerspectiveCamera(45, 1, 1e-6, 100);
    camera.position.copy(origin); camera.lookAt(world(0.2, 0.2, 0)); camera.updateMatrixWorld(true);
    const renderer = Object.assign(Object.create(UniverseRenderer.prototype), {
      camera, scaleFactor: 0.001, bodyMeshes: new Map([['Shape', bm]]),
      _surfaceRaycaster: new THREE.Raycaster(), _surfaceTileRaycaster: new THREE.Raycaster(),
      renderer: { domElement: { clientHeight: 900 } },
    }) as UniverseRenderer;
    const picked = renderer.pickSurface(0, 0);
    expect(picked?.point.source).toBe('dsk');
    expect(picked?.altKm).toBeNull();
    expect(picked?.point.hit).toEqual({ heightKm: null, datum: null });
    expect(picked?.point.altitude).toEqual({ km: null, datum: null, from: 'unavailable' });
    expect(picked?.point.latitudeKind).toBe('planetocentric');
    expect(picked?.cameraDistanceKm).toBeGreaterThan(0);
    expect(picked?.point.surfaceNormal).toBeDefined();
    expect(picked?.bodyFixedHitKm[0]).toBeCloseTo(0.2, 6);
    expect(picked?.bodyFixedHitKm[1]).toBeCloseTo(0.2, 6);
    expect(picked?.bodyFixedHitKm[2]).toBeCloseTo(0.6, 6);
  });

  it('re-anchors a DSK pick and normal on its exact plate after rotation and translation without radial refinement', async () => {
    serve(fixture('dsk-two-segments.bds'));
    const bm = new BodyMesh(new Body({ name: 'Shape', trajectory: fixedPoint,
      rotation: new UniformRotation(1000, 0, 0.3, 0.6, 0.5, 'ECLIPJ2000'), geometryType: 'Dsk' }));
    await bm.loadDsk('shape.bds', 0.001, spice, 'shape.bds');
    bm.updatePosition([20, 30, 40], 0, 0.001);
    bm.updateWorldMatrix(true, true);
    const mesh = bm.getDskMeshes()[0];
    const camera = new THREE.PerspectiveCamera(45, 1, 1e-6, 100);
    camera.position.copy(mesh.localToWorld(new THREE.Vector3(0.2, 0.2, 3)));
    camera.lookAt(mesh.localToWorld(new THREE.Vector3(0.2, 0.2, 0.6)));
    camera.updateMatrixWorld(true);
    const renderer = Object.assign(Object.create(UniverseRenderer.prototype), {
      camera, scaleFactor: 0.001, bodyMeshes: new Map([['Shape', bm]]),
      _surfaceRaycaster: new THREE.Raycaster(), _surfaceTileRaycaster: new THREE.Raycaster(),
      renderer: { domElement: { clientHeight: 900 } },
    }) as UniverseRenderer;
    const point = renderer.pickSurface(0, 0)!.point;
    const internals = renderer as unknown as {
      surfacePointWorld(p: typeof point): { world: THREE.Vector3; normal: THREE.Vector3 };
      _refinePin(): void;
    };
    const native = new THREE.Vector3(...point.bodyFixedPositionKm);
    const initialHit = mesh.localToWorld(new THREE.Vector3(0.2, 0.2, 0.6));
    expect(internals.surfacePointWorld(point).world.distanceTo(initialHit)).toBeLessThan(1e-12);
    const pin = { pinned: point, setPin: vi.fn() };
    const cast = vi.fn();
    Object.assign(renderer, { _probe: pin, _castSurfaces: cast });
    for (const et of [0, 250]) {
      bm.updatePosition([20 + et / 50, 30 + et / 25, 40 - et / 20], et, 0.001);
      bm.updateWorldMatrix(true, true);
      const expected = mesh.localToWorld(native.clone());
      const normal = new THREE.Vector3(1, 1, 1).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld));
      const anchor = internals.surfacePointWorld(point);
      expect(anchor.world.distanceTo(expected)).toBeLessThan(1e-12);
      expect(anchor.normal.distanceTo(normal)).toBeLessThan(1e-10);
      internals._refinePin();
      expect(pin.pinned).toBe(point);
    }
    expect(cast).not.toHaveBeenCalled();
    expect(pin.setPin).not.toHaveBeenCalled();
    expect(internals.surfacePointWorld(point).world.distanceTo(initialHit)).toBeGreaterThan(0.01);
  });

  it('accelerates only DSK meshes while preserving exact intersections, plate indices and disposal', async () => {
    serve(fixture('dsk-two-segments.bds'));
    const bm = new BodyMesh(new Body({ name: 'Shape', trajectory: fixedPoint, geometryType: 'Dsk' }));
    await bm.loadDsk('shape.bds', 1, spice, 'shape.bds');
    bm.updatePosition([0, 0, 0], 0, 1);
    bm.updateWorldMatrix(true, true);
    const mesh = bm.getDskMeshes()[0];
    expect(mesh.geometry.boundsTree).toBeDefined();
    expect(mesh.raycast).not.toBe(THREE.Mesh.prototype.raycast);
    const index = Array.from(mesh.geometry.index!.array);
    const caster = new THREE.Raycaster();
    caster.firstHitOnly = true;
    const accelerated = mesh.raycast;
    for (let x = -1; x < 14; x += 0.17) {
      caster.set(new THREE.Vector3(x, 3, 0.2), new THREE.Vector3(0, -1, 0));
      const fast = caster.intersectObject(mesh, false)[0];
      mesh.raycast = THREE.Mesh.prototype.raycast;
      const native = caster.intersectObject(mesh, false)[0];
      mesh.raycast = accelerated;
      expect(fast?.distance).toEqual(native?.distance);
      expect(fast?.faceIndex).toEqual(native?.faceIndex);
      expect(fast?.face?.normal.toArray()).toEqual(native?.face?.normal.toArray());
    }
    expect(Array.from(mesh.geometry.index!.array)).toEqual(index);
    bm.dispose();
    expect(mesh.geometry.boundsTree).toBeUndefined();
  });

  it.each([
    { naifId: 401, frame: 'IAU_MARS', message: /describes NAIF body 499/ },
    { naifId: 499, frame: 'IAU_PHOBOS', message: /is in frame IAU_MARS/ },
  ])('fails incompatible coordinates ($naifId, $frame)', async ({ naifId, frame, message }) => {
    serve(fixture('dsk-two-segments.bds'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stub = { pxform: () => [1, 0, 0, 0, 1, 0, 0, 0, 1] } as unknown as SpiceInstance;
    const body = new Body({ name: 'Mismatch', naifId, trajectory: fixedPoint,
      rotation: new SpiceRotation(stub, frame, 'J2000'), geometryType: 'Dsk' });
    const bm = new BodyMesh(body);
    const assets = new AssetLoadTracker();
    bm.assets = assets;
    await bm.loadDsk('https://example.test/shape.bds', 1, spice, 'shape.bds');
    expect(bm.hasModel).toBe(false);
    const summary = await assets.settle();
    expect(summary.failed).toBe(1);
    expect(String(summary.failures[0]?.reason)).toMatch(message);
  });

  it('fails the asset, and keeps the placeholder, when the file is not a DSK', async () => {
    serve(new TextEncoder().encode('not a DSK'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = new Body({ name: 'Nope', trajectory: fixedPoint, geometryType: 'Dsk', geometryData: { type: 'Dsk', source: 'x.bds' } });
    const bm = new BodyMesh(body);
    const assets = new AssetLoadTracker();
    bm.assets = assets;
    await bm.loadDsk('https://example.test/x.bds', 1, spice, 'x.bds');
    expect(bm.hasModel).toBe(false);
    expect(bm.mesh.visible).toBe(true);
    const summary = await assets.settle();
    expect(summary.failed).toBe(1);
    expect(summary.failures[0]?.role).toBe("model:dsk");
  });
});

describe('BodyMesh.loadTimeSwitched', () => {
  let spice: HeritageSpice;
  beforeAll(async () => {
    spice = await createHeritageSpice();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('draws only the entry whose window holds the current time', async () => {
    const files: Record<string, Uint8Array> = {
      'https://example.test/with-lander.bds': fixture('dsk-two-segments.bds'),
      'https://example.test/bare.bds': fixture('mu69_lopoly.bds'),
    };
    vi.stubGlobal('fetch', vi.fn(async (u: string) => new Response(files[u] as BodyInit)));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = new Body({
      name: 'Orbiter',
      trajectory: fixedPoint,
      rotation: new FixedRotation([1, 0, 0, 0], 'ECLIPJ2000'),
      geometryType: 'TimeSwitched',
      geometryData: { type: 'TimeSwitched' },
    });
    const bm = new BodyMesh(body);
    const assets = new AssetLoadTracker();
    bm.assets = assets;
    await bm.loadTimeSwitched(
      [
        { startEt: -Infinity, endEt: 100, geometry: { type: 'Dsk', source: 'with-lander.bds' } },
        { startEt: 100, endEt: Infinity, geometry: { type: 'Dsk', source: 'bare.bds' } },
      ],
      1,
      spice,
      (p) => `https://example.test/${p}`,
    );
    expect(bm.hasModel).toBe(true);
    const [first, second] = bm.modelContainer!.children;
    bm.updatePosition([0, 0, 0], 50, 1);
    expect([first!.visible, second!.visible]).toEqual([true, false]);
    // End exclusive, start inclusive: the switch happens exactly at 100.
    bm.updatePosition([0, 0, 0], 100, 1);
    expect([first!.visible, second!.visible]).toEqual([false, true]);
    // Sized by the union of the entries: Arrokoth (~18 km radius) dominates.
    expect(bm.displayRadius).toBeGreaterThan(15);
    const summary = await assets.settle();
    expect(summary.loaded).toBe(2);
  });

  it('keeps the entries that load when one fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) =>
      u.endsWith('ok.bds') ? new Response(fixture('dsk-two-segments.bds') as BodyInit) : new Response('nope', { status: 404 })));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = new Body({ name: 'Craft', trajectory: fixedPoint, geometryType: 'TimeSwitched', geometryData: { type: 'TimeSwitched' } });
    const bm = new BodyMesh(body);
    const assets = new AssetLoadTracker();
    bm.assets = assets;
    await bm.loadTimeSwitched(
      [
        { startEt: 0, endEt: 10, geometry: { type: 'Dsk', source: 'ok.bds' } },
        { startEt: 10, endEt: 20, geometry: { type: 'Dsk', source: 'missing.bds' } },
      ],
      1,
      spice,
      (p) => `https://example.test/${p}`,
    );
    expect(bm.modelContainer!.children).toHaveLength(1);
    const summary = await assets.settle();
    expect(summary.loaded).toBe(1);
    expect(summary.failed).toBe(1);
  });
});

describe('the DSK centre check', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requires the actual structure origin instead of equating it with spacecraft CoM', () => {
    const make = (naifId: number) => new BodyMesh(new Body({
      name: 'Rosetta', naifId, trajectory: fixedPoint,
      rotation: new FixedRotation([1, 0, 0, 0], 'ECLIPJ2000'), geometryType: 'Dsk',
    })) as unknown as { checkDskFrame(n: string, c: number, f: string): void };
    expect(() => make(-226).checkDskFrame('bus.bds', -226000, '')).toThrow(/use the DSK origin/);
    expect(() => make(-226000).checkDskFrame('bus.bds', -226000, '')).not.toThrow();
  });
});
