// The Dsk geometry path end to end, short of a GPU: a real DSK read by the
// frames adapter, built into a BufferGeometry, installed on a BodyMesh in
// place of the placeholder, and oriented by the body's rotation with no
// size or axis correction in between.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createHeritageSpice, type HeritageSpice } from '@cosmolabe/frames';
import { Body, FixedRotation, SpiceRotation, type SpiceInstance } from '@cosmolabe/core';
import { BodyMesh } from '../BodyMesh.js';
import { dskShapeProviderOf, dskToBufferGeometry, gunzipIfNeeded, type DskShape } from '../DskShapeProvider.js';
import { AssetLoadTracker } from '../AssetLoadTracker.js';

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

  it('warns when the DSK\'s own centre or frame disagrees with the body', async () => {
    serve(fixture('dsk-two-segments.bds'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stub = { pxform: () => [1, 0, 0, 0, 1, 0, 0, 0, 1] } as unknown as SpiceInstance;
    const body = new Body({
      name: 'Phobos',
      naifId: 401,
      trajectory: fixedPoint,
      rotation: new SpiceRotation(stub, 'IAU_PHOBOS', 'J2000'),
      geometryType: 'Dsk',
      geometryData: { type: 'Dsk', source: 'shape.bds' },
    });
    const bm = new BodyMesh(body);
    await bm.loadDsk('https://example.test/shape.bds', 1, spice, 'shape.bds');
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /describes NAIF body 499/.test(m))).toBe(true);
    expect(messages.some((m) => /is in frame IAU_MARS, but Phobos rotates into IAU_PHOBOS/.test(m))).toBe(true);
    // Reported, not refused: the shape still draws.
    expect(bm.hasModel).toBe(true);
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

  it('accepts a spacecraft DSK written about its structure frame (NAIF ID × 1000), flags anything else', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bm = new BodyMesh(new Body({
      name: 'Rosetta', naifId: -226, trajectory: fixedPoint, rotation: new FixedRotation([1, 0, 0, 0], 'ECLIPJ2000'),
      geometryType: 'Dsk', geometryData: { type: 'Dsk', source: 'bus.bds' },
    }));
    const check = (centre: number) =>
      (bm as unknown as { checkDskFrame(n: string, c: number, f: string): void }).checkDskFrame('bus.bds', centre, '');
    check(-226);
    check(-226000); // ROS_SPACECRAFT: the same body
    expect(warn).not.toHaveBeenCalled();
    check(-226800); // Philae is not Rosetta
    expect(warn.mock.calls.some((c) => /describes NAIF body -226800/.test(String(c[0])))).toBe(true);
  });
});
