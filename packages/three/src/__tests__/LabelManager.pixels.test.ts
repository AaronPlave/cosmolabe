import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { LabelManager } from '../LabelManager.js';
import type { BodyMesh } from '../BodyMesh.js';

// Issue #350: body labels must be drawn texel-for-pixel on the device-pixel
// grid. A 4x-oversampled texture drawn at DPR 1 (or a 1:1 texture at a
// fractional pixel offset) samples differently at every sub-pixel position,
// which reads as a label that flips between sharp and blurry.

const rasterFonts: number[] = [];

function stubCanvas(): void {
  rasterFonts.length = 0;
  vi.stubGlobal('document', {
    createElement: () => {
      const canvas = { width: 300, height: 150, getContext: () => ctx };
      const ctx = {
        font: '',
        textBaseline: '',
        shadowColor: '',
        shadowBlur: 0,
        fillStyle: '',
        measureText(text: string) {
          const px = parseFloat(this.font);
          rasterFonts.push(px);
          return { width: text.length * px * 0.6 };
        },
        fillText() {},
      };
      return canvas;
    },
  });
}

function stubDpr(dpr: number): void {
  vi.stubGlobal('window', { devicePixelRatio: dpr });
}

function fakeBody(name: string, position: THREE.Vector3, parent: THREE.Object3D): BodyMesh {
  return {
    body: { name, classification: 'spacecraft', geometryType: 'Point', labelColor: undefined, geometryData: undefined },
    position,
    parent,
    present: true,
    displayRadius: 1,
    scaleFactor: 1e-6,
    dskOccludes: () => null,
  } as unknown as BodyMesh;
}

function makeCamera(cssW: number, cssH: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, cssW / cssH, 0.001, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

/** The sprite quad's device-pixel box, computed exactly as the GPU does. */
function deviceQuad(sprite: THREE.Sprite, camera: THREE.Camera, w: number, h: number) {
  const p = sprite.getWorldPosition(new THREE.Vector3()).project(camera);
  const P = camera.projectionMatrix.elements;
  const width = (sprite.scale.x * P[0] * w) / 2;
  const height = (sprite.scale.y * P[5] * h) / 2;
  const ax = (p.x * 0.5 + 0.5) * w;
  const ay = (-p.y * 0.5 + 0.5) * h;
  return { left: ax - sprite.center.x * width, top: ay - (1 - sprite.center.y) * height, width, height };
}

afterEach(() => vi.unstubAllGlobals());

describe('LabelManager device-pixel rendering (#350)', () => {
  for (const dpr of [1, 1.25, 2]) {
    it(`draws the label texture 1:1 on the device-pixel grid at DPR ${dpr}`, () => {
      stubCanvas();
      stubDpr(dpr);
      const cssW = 801, cssH = 457;
      const device = { width: Math.floor(cssW * dpr), height: Math.floor(cssH * dpr), pixelRatio: dpr };
      const camera = makeCamera(cssW, cssH);
      const scene = new THREE.Scene();
      const labels = new LabelManager({} as HTMLElement);
      // Positions chosen to land on assorted sub-pixel phases.
      const bodies = [
        fakeBody('Ingenuity', new THREE.Vector3(0.0123, -0.0377, 0), scene),
        fakeBody('Perseverance', new THREE.Vector3(-1.234567, 0.987654, -0.5), scene),
        fakeBody('MRO', new THREE.Vector3(2.71828, -1.41421, 1.1), scene),
      ];
      for (const bm of bodies) labels.addLabel(bm);
      labels.update(bodies, camera, { width: cssW, height: cssH }, device);
      scene.updateMatrixWorld(true);

      for (const sprite of labels.getSprites()) {
        const img = sprite.material.map!.image as { width: number; height: number };
        const quad = deviceQuad(sprite, camera, device.width, device.height);
        // One texel per device pixel …
        expect(quad.width).toBeCloseTo(img.width, 6);
        expect(quad.height).toBeCloseTo(img.height, 6);
        // … with texel edges on device-pixel edges.
        expect(Math.abs(quad.left - Math.round(quad.left))).toBeLessThan(1e-3);
        expect(Math.abs(quad.top - Math.round(quad.top))).toBeLessThan(1e-3);
      }
      // Rasterized at the on-screen device size: 12 CSS px × DPR.
      expect(new Set(rasterFonts)).toEqual(new Set([12 * dpr]));
    });
  }

  it('re-rasterizes for a new DPR while keeping the CSS-pixel layout box fixed', () => {
    stubCanvas();
    stubDpr(1);
    const cssW = 800, cssH = 600;
    const camera = makeCamera(cssW, cssH);
    const scene = new THREE.Scene();
    const labels = new LabelManager({} as HTMLElement);
    const bm = fakeBody('Ingenuity', new THREE.Vector3(0.3, 0.2, 0), scene);
    labels.addLabel(bm);

    const frame = (dpr: number) => {
      labels.update([bm], camera, { width: cssW, height: cssH }, { width: cssW * dpr, height: cssH * dpr, pixelRatio: dpr });
      scene.updateMatrixWorld(true);
      const sprite = labels.getSprites()[0];
      const img = sprite.material.map!.image as { width: number; height: number };
      const rect = labels.getScreenRects()[0];
      return { img: { width: img.width, height: img.height }, rect: { w: rect.x1 - rect.x0, h: rect.y1 - rect.y0 }, quad: deviceQuad(sprite, camera, cssW * dpr, cssH * dpr) };
    };

    const one = frame(1);
    const before = labels.getSprites()[0].material.map;
    const two = frame(2);
    // New texture at twice the resolution, the old one replaced.
    expect(labels.getSprites()[0].material.map).not.toBe(before);
    expect(rasterFonts.at(-1)).toBe(24);
    expect(two.img.height).toBeGreaterThan(one.img.height * 1.8);
    // Same apparent (CSS-pixel) size, and still texel-for-pixel.
    expect(two.rect.h).toBeCloseTo(one.rect.h, 0);
    expect(two.rect.w).toBeCloseTo(one.rect.w, 0);
    expect(two.quad.height).toBeCloseTo(two.img.height, 6);
    // And back again (external ↔ built-in display).
    const back = frame(1);
    expect(back.img).toEqual(one.img);
    expect(back.quad.height).toBeCloseTo(one.img.height, 6);
  });

  it('keeps texel alignment while the body moves by sub-pixel steps', () => {
    stubCanvas();
    stubDpr(1);
    const cssW = 640, cssH = 480;
    const camera = makeCamera(cssW, cssH);
    const scene = new THREE.Scene();
    const labels = new LabelManager({} as HTMLElement);
    const bm = fakeBody('Ingenuity', new THREE.Vector3(0, 0, 0), scene);
    labels.addLabel(bm);
    const sprite = labels.getSprites()[0];
    let previousLeft: number | undefined;
    for (let i = 0; i < 20; i++) {
      bm.position.set(i * 0.00377, i * -0.00213, 0);
      labels.update([bm], camera, { width: cssW, height: cssH }, { width: cssW, height: cssH, pixelRatio: 1 });
      scene.updateMatrixWorld(true);
      const quad = deviceQuad(sprite, camera, cssW, cssH);
      expect(Math.abs(quad.left - Math.round(quad.left))).toBeLessThan(1e-3);
      expect(Math.abs(quad.top - Math.round(quad.top))).toBeLessThan(1e-3);
      // Snapping moves a label by at most half a pixel, so it still follows its body.
      if (previousLeft !== undefined) expect(quad.left - previousLeft).toBeGreaterThan(-1e-6);
      previousLeft = quad.left;
    }
  });
});
