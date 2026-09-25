// Legacy .3ds models (Cosmographia mission packages ship them): parsed with
// three's TDSLoader through the same install path as every other model, with
// material textures resolved relative to the model and counted as assets.

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Body } from '@cosmolabe/core';
import { BodyMesh } from '../BodyMesh.js';
import { AssetLoadTracker } from '../AssetLoadTracker.js';

const fixedPoint = { stateAt: () => ({ position: [0, 0, 0], velocity: [0, 0, 0] }) } as never;

/** A 3DS chunk: uint16 id, uint32 length (header included), then the body. */
function chunk(id: number, ...parts: Uint8Array[]): Uint8Array {
  const len = 6 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, id, true);
  dv.setUint32(2, len, true);
  let o = 6;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** One triangle, 2 × 1 × 0.5 model units, as the smallest file TDSLoader reads. */
function triangle3ds(): Uint8Array {
  const verts = [[0, 0, 0], [2, 0, 0], [0, 1, 0.5]];
  const points = new Uint8Array(2 + verts.length * 12);
  const pv = new DataView(points.buffer);
  pv.setUint16(0, verts.length, true);
  verts.flat().forEach((v, i) => pv.setFloat32(2 + i * 4, v, true));
  const faces = new Uint8Array(2 + 8);
  const fv = new DataView(faces.buffer);
  fv.setUint16(0, 1, true);
  [0, 1, 2, 0].forEach((v, i) => fv.setUint16(2 + i * 2, v, true));
  const name = new TextEncoder().encode('tri\0');
  return chunk(0x4d4d, chunk(0x3d3d, chunk(0x4000, name, chunk(0x4100, chunk(0x4110, points), chunk(0x4120, faces)))));
}

describe('.3ds models', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads through TDSLoader and is sized by the catalog like any model', async () => {
    const bytes = triangle3ds();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes as BodyInit)));
    const body = new Body({
      name: 'Philae',
      trajectory: fixedPoint,
      geometryType: 'Mesh',
      geometryData: { type: 'Mesh', source: 'models/philae.3ds', size: 0.004 },
    });
    const bm = new BodyMesh(body);
    const assets = new AssetLoadTracker();
    bm.assets = assets;
    // A blob URL has no extension: the format comes from the catalog path.
    await bm.loadModel('blob:https://example.test/1234', 1, 'models/philae.3ds');

    expect(bm.hasModel).toBe(true);
    const box = new THREE.Box3().setFromObject(bm.modelContainer!);
    // `size` is the diameter in km: the longest side (2 units) becomes 0.004.
    expect(box.max.x - box.min.x).toBeCloseTo(0.004, 9);
    expect(bm.displayRadius).toBeCloseTo(0.002, 9);
    const summary = await assets.settle();
    expect(summary.failed).toBe(0);
    expect(summary.loaded).toBe(1);
  });

  it('resolves material maps relative to the model and counts them as assets', async () => {
    const body = new Body({ name: 'Rosetta', trajectory: fixedPoint });
    const bm = new BodyMesh(body);
    const assets = new AssetLoadTracker();
    bm.assets = assets;
    const resolver = (p: string) => `https://cdn.test/${p}`;
    const manager = (bm as unknown as {
      textureManagerFor(s?: string, r?: (p: string) => string | undefined): THREE.LoadingManager;
    }).textureManagerFor('models/rosetta/rosetta.3ds', resolver);

    // Windows-style map paths are normalised and joined onto the model's directory.
    expect(manager.resolveURL('TEX\\FOIL.JPG')).toBe('https://cdn.test/models/rosetta/TEX/FOIL.JPG');

    manager.itemStart('https://cdn.test/models/rosetta/TEX/FOIL.JPG');
    manager.itemEnd('https://cdn.test/models/rosetta/TEX/FOIL.JPG');
    manager.itemStart('https://cdn.test/models/rosetta/TEX/GONE.JPG');
    manager.itemError('https://cdn.test/models/rosetta/TEX/GONE.JPG');
    manager.itemEnd('https://cdn.test/models/rosetta/TEX/GONE.JPG');
    const summary = await assets.settle();
    expect(summary.loaded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.failures[0]?.kind).toBe('texture');
  });
});
