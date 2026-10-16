import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Body, FixedPointTrajectory } from '@cosmolabe/core';
import { BodyMesh } from '../BodyMesh.js';
import { RingMesh } from '../RingMesh.js';

// A complete 4x4 DXT1 DDS with independently identifiable 4x4, 2x2, 1x1 levels.
function dds(levels: number): ArrayBuffer {
  const buffer = new ArrayBuffer(128 + levels * 8);
  const header = new Int32Array(buffer, 0, 32);
  header[0] = 0x20534444;
  header[1] = 124;
  header[2] = 0x21007;
  header[3] = header[4] = 4;
  header[7] = levels;
  header[19] = 32;
  header[20] = 4;
  header[21] = 0x31545844;
  header[27] = 0x401008;
  for (let i = 0; i < levels; i++) new Uint8Array(buffer, 128 + i * 8, 8).fill(i + 1);
  return buffer;
}

afterEach(() => vi.unstubAllGlobals());

describe('DDS minification', () => {
  it.each([1, 3])('retains all %i supplied globe mip levels', async levels => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(dds(levels))));
    const body = new BodyMesh(new Body({ name: 'Moon', geometryType: 'Globe',
      radii: [1, 1, 1], trajectory: new FixedPointTrajectory([0, 0, 0]) }));
    try {
      await body.loadGlobeTextures('moon.dds');
      const map = (body.mesh.material as THREE.MeshStandardMaterial).map!;
      expect(map.mipmaps.map(m => [m.width, m.height])).toEqual(
        levels === 3 ? [[4, 4], [2, 2], [1, 1]] : [[4, 4]]);
      expect(map.minFilter).toBe(levels === 1 ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter);
      expect((map.mipmaps.at(-1)! as THREE.CompressedTextureMipmap).data[0]).toBe(levels);
    } finally { body.dispose(); }
  });

  it('retains the ring mip chain', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(dds(3))));
    const ring = new RingMesh(1, 2);
    try {
      await ring.loadTexture('rings.dds');
      const map = (ring.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material.map!;
      expect(map.mipmaps).toHaveLength(3);
      expect(map.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    } finally { ring.dispose(); }
  });

  it('generates mipmaps on the final stitched DDS map', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(dds(3))));
    const body = new BodyMesh(new Body({ name: 'Moon', geometryType: 'Globe',
      radii: [1, 1, 1], trajectory: new FixedPointTrajectory([0, 0, 0]) }));
    const previous = new THREE.WebGLRenderTarget(1, 1);
    let output: THREE.WebGLRenderTarget | undefined;
    const renderer = {
      getRenderTarget: () => previous,
      setRenderTarget: vi.fn((target: THREE.WebGLRenderTarget) => {
        if (target !== previous) output = target;
      }),
      clear: vi.fn(),
      render: vi.fn(() => {
        // These flags must already be set when Three renders the stitch pass.
        expect(output!.texture.generateMipmaps).toBe(true);
        expect(output!.texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
      }),
    };
    try {
      await body.loadTiledBaseMap(['left.dds', 'right.dds'], renderer as unknown as THREE.WebGLRenderer);
      const map = (body.mesh.material as THREE.MeshStandardMaterial).map!;
      expect(renderer.render).toHaveBeenCalledOnce();
      expect(map).toBe(output!.texture);
      expect(output!.width).toBe(8);
      expect(output!.height).toBe(4);
      expect(map.generateMipmaps).toBe(true);
      expect(map.minFilter).toBe(THREE.LinearMipmapLinearFilter);
      expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(previous);
    } finally { body.dispose(); output?.dispose(); previous.dispose(); }
  });
});
