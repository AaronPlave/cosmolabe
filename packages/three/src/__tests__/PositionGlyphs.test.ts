import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  GLYPH_FULL_PX, GLYPH_GONE_PX, PositionGlyphs, glyphWeight, rasterizeGlyph, wantsGlyph,
} from '../PositionGlyphs.js';
import type { BodyMesh } from '../BodyMesh.js';

// #337: unresolved entities get a screen-space *position* glyph that hands off
// continuously to the real model/globe.

const CSS = { width: 800, height: 600 };
const device = (pixelRatio = 1) => ({ width: CSS.width * pixelRatio, height: CSS.height * pixelRatio, pixelRatio });

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, CSS.width / CSS.height, 1e-6, 1e9);
  cam.position.set(0, 0, 100);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

function fakeBody(name: string, position: THREE.Vector3, o: Partial<{
  classification: string; geometryType: string; displayRadius: number; visible: boolean;
}> = {}): BodyMesh {
  return {
    body: { name, classification: o.classification ?? 'spacecraft', geometryType: o.geometryType ?? 'Mesh' },
    position,
    visible: o.visible ?? true,
    displayRadius: o.displayRadius ?? 1e-6,
    scaleFactor: 1,
    sunVisual: null,
    modelLocalBox: null,
    modelContainer: null,
  } as unknown as BodyMesh;
}

function ctx(over: Partial<Parameters<PositionGlyphs['update']>[2]> = {}): Parameters<PositionGlyphs['update']>[2] {
  return {
    viewport: CSS, device: device(),
    isEligible: (bm) => wantsGlyph(bm, false),
    isPinned: () => false, trackedName: null, hoveredName: null,
    ...over,
  };
}

/** Projected radius in px of a radius-r body at distance d for the test camera. */
const pxFor = (r: number, d: number) => r / (2 * Math.tan((50 * Math.PI / 180) / 2) * d) * CSS.height;

describe('glyphWeight', () => {
  it('is full while unresolved, gone once resolved, monotonic between', () => {
    expect(glyphWeight(0)).toBe(1);
    expect(glyphWeight(GLYPH_FULL_PX)).toBe(1);
    expect(glyphWeight(GLYPH_GONE_PX)).toBe(0);
    expect(glyphWeight(1000)).toBe(0);
    let prev = 1;
    for (let px = GLYPH_FULL_PX; px <= GLYPH_GONE_PX; px += 0.25) {
      const w = glyphWeight(px);
      expect(w).toBeLessThanOrEqual(prev + 1e-12);
      prev = w;
    }
  });

  it('never leaves a dead zone against the renderer model fade (2px → 5px)', () => {
    // Model opacity ramps 0 at 2px to 1 at 5px; the placeholder sphere is gone from 2px.
    for (let px = 0; px <= 12; px += 0.05) {
      const model = px < 2 ? 0 : Math.min(1, (px - 2) / 3);
      const visibility = 1 - (1 - glyphWeight(px)) * (1 - model);
      expect(visibility).toBeGreaterThanOrEqual(0.5);
    }
  });
});

describe('wantsGlyph', () => {
  it('skips the Sun/stars, barycenters, instruments, sensors and custom visuals', () => {
    const p = new THREE.Vector3();
    expect(wantsGlyph(fakeBody('Clipper', p), false)).toBe(true);
    expect(wantsGlyph(fakeBody('Phobos', p, { classification: 'moon', geometryType: 'Globe' }), false)).toBe(true);
    expect(wantsGlyph(fakeBody('Sol', p, { classification: 'star' }), false)).toBe(false);
    expect(wantsGlyph({ ...fakeBody('Sun', p), sunVisual: {} } as unknown as BodyMesh, false)).toBe(false);
    expect(wantsGlyph(fakeBody('EMB', p, { classification: 'barycenter' }), false)).toBe(false);
    expect(wantsGlyph(fakeBody('NAC', p, { classification: 'instrument' }), false)).toBe(false);
    expect(wantsGlyph(fakeBody('Cam', p, { geometryType: 'Sensor' }), false)).toBe(false);
    expect(wantsGlyph(fakeBody('Dot', p), true)).toBe(false);
  });
});

describe('rasterizeGlyph (deterministic raster-contrast check)', () => {
  const at = (g: { data: Uint8Array; size: number }, x: number, y: number) => {
    const i = (y * g.size + x) * 4;
    return { r: g.data[i], a: g.data[i + 3] };
  };

  it('dot: opaque white core ringed by a darker halo, so it reads on bright and dark sky', () => {
    const g = rasterizeGlyph('dot', 1);
    const c = Math.floor(g.size / 2);
    expect(at(g, c, c)).toEqual({ r: 255, a: 255 });
    // Walk outward: a halo pixel is dark and translucent.
    let halo = false;
    for (let x = c; x < g.size; x++) {
      const px = at(g, x, c);
      if (px.a > 0 && px.r < 80) { halo = true; break; }
    }
    expect(halo).toBe(true);
    // The very corner is empty.
    expect(at(g, 0, 0).a).toBe(0);
  });

  it('ring: hollow centre (the dot shows through), solid stroke, heavier when tracked', () => {
    const sel = rasterizeGlyph('selected', 1);
    const trk = rasterizeGlyph('tracked', 1);
    expect(at(sel, Math.floor(sel.size / 2), Math.floor(sel.size / 2)).a).toBe(0);
    const opaque = (g: { data: Uint8Array }) => { let n = 0; for (let i = 3; i < g.data.length; i += 4) if (g.data[i] === 255) n++; return n; };
    expect(opaque(sel)).toBeGreaterThan(0);
    expect(opaque(trk)).toBeGreaterThan(opaque(sel));
  });

  it('is texel-exact at device pixel ratios', () => {
    expect(rasterizeGlyph('dot', 2).size).toBeGreaterThan(rasterizeGlyph('dot', 1).size);
  });
});

describe('PositionGlyphs.update', () => {
  it('draws a glyph for a spacecraft too small to see, anchored on its true position', () => {
    const g = new PositionGlyphs(2);
    const cam = camera();
    const sc = fakeBody('Clipper', new THREE.Vector3(5, 3, 0));
    g.update([sc], cam, ctx());
    const [r] = g.readout();
    expect(r.name).toBe('Clipper');
    expect(r.glyphWeight).toBe(1);
    expect(r.ring).toBe('none');
    expect(r.footprintPx).toBeGreaterThanOrEqual(3);
    expect(r.footprintPx).toBeLessThanOrEqual(6);
    // Same projection as the label anchor: body.position through the camera.
    const ndc = sc.position.clone().project(cam);
    expect(r.anchor!.x).toBeCloseTo((ndc.x * 0.5 + 0.5) * CSS.width, 6);
    expect(r.anchor!.y).toBeCloseTo((-ndc.y * 0.5 + 0.5) * CSS.height, 6);
    // Render-only nudge: the body itself never moves.
    expect(sc.position.toArray()).toEqual([5, 3, 0]);
  });

  it('does not let the glyph size feed back into position or geometry', () => {
    const g = new PositionGlyphs(2);
    const cam = camera();
    const sc = fakeBody('Clipper', new THREE.Vector3(0, 0, 0));
    g.update([sc], cam, ctx());
    const sprite = g.group.children[0] as THREE.Sprite;
    expect(sprite.raycast(new THREE.Raycaster(), [])).toBeUndefined();
    expect(sprite.layers.test(Object.assign(new THREE.Layers(), { mask: 1 << 2 }))).toBe(true);
    // Constant pixel size: nearer or farther gives the same footprint.
    const before = g.readout()[0].footprintPx;
    cam.position.set(0, 0, 5000); cam.updateMatrixWorld(true);
    g.update([sc], cam, ctx());
    expect(g.readout()[0].footprintPx).toBe(before);
  });

  it('selected shows a ring, tracked a stronger one, hover grows the dot; unselected has none', () => {
    const g = new PositionGlyphs(2);
    const cam = camera();
    const sc = fakeBody('Clipper', new THREE.Vector3());
    const sprites = () => g.group.children as THREE.Sprite[];
    g.update([sc], cam, ctx());
    expect(sprites()[1].visible).toBe(false);

    g.update([sc], cam, ctx({ isPinned: (n) => n === 'Clipper' }));
    expect(g.readout()[0].ring).toBe('selected');
    expect(sprites()[1].visible).toBe(true);
    const selectedScale = sprites()[1].scale.x;

    g.update([sc], cam, ctx({ isPinned: () => true, trackedName: 'Clipper' }));
    expect(g.readout()[0].ring).toBe('tracked');
    expect(sprites()[1].scale.x).toBeGreaterThan(selectedScale);

    const dotScale = sprites()[0].scale.x;
    g.update([sc], cam, ctx({ hoveredName: 'Clipper' }));
    expect(sprites()[0].scale.x).toBeGreaterThan(dotScale);
  });

  it('hands off: no glyph once the body is clearly resolved, no ring left behind', () => {
    const g = new PositionGlyphs(2);
    const cam = camera();
    const pinned = ctx({ isPinned: () => true });
    // A body whose projected radius sweeps from 1px to 40px.
    let last = 1;
    for (const px of [1, 3, 4, 5, 6, 7, 8, 12, 40]) {
      const radius = px / pxFor(1, 100);
      const sc = fakeBody('Moon', new THREE.Vector3(), { displayRadius: radius, classification: 'moon', geometryType: 'Globe' });
      g.update([sc], cam, pinned);
      const r = g.readout();
      const w = r[0]?.glyphWeight ?? 0;
      expect(w).toBeLessThanOrEqual(last + 1e-9);
      last = w;
      if (px >= GLYPH_GONE_PX) {
        expect(r).toHaveLength(0);
        expect((g.group.children as THREE.Sprite[]).every((s) => !s.visible)).toBe(true);
      }
    }
  });

  it('counts a wide model silhouette, not just the bounding-sphere radius', () => {
    const g = new PositionGlyphs(2);
    const cam = camera();
    const sc = fakeBody('Clipper', new THREE.Vector3(), { displayRadius: 1e-6 });
    // Solar-array wingspan: ±20 world units wide projects to ~±... px; resolved.
    const container = new THREE.Object3D();
    container.updateMatrixWorld(true);
    (sc as unknown as { modelContainer: THREE.Object3D }).modelContainer = container;
    (sc as unknown as { modelLocalBox: THREE.Box3 }).modelLocalBox =
      new THREE.Box3(new THREE.Vector3(-20, -0.01, -0.01), new THREE.Vector3(20, 0.01, 0.01));
    g.update([sc], cam, ctx());
    expect(g.readout()).toHaveLength(0);
  });

  it('draws nothing for hidden, absent or ineligible bodies (no ghost points)', () => {
    const g = new PositionGlyphs(2);
    const cam = camera();
    const sc = fakeBody('Clipper', new THREE.Vector3());
    g.update([sc], cam, ctx());
    expect(g.readout()).toHaveLength(1);
    sc.visible = false; // outside existence window / ephemeris gap / catalog-hidden
    g.update([sc], cam, ctx());
    expect(g.readout()).toHaveLength(0);
    sc.visible = true;
    g.update([sc], cam, ctx({ isEligible: () => false }));
    expect(g.readout()).toHaveLength(0);
  });

  it('reports anchors behind the camera and off-screen honestly', () => {
    const g = new PositionGlyphs(2);
    const cam = camera();
    g.update([
      fakeBody('Behind', new THREE.Vector3(0, 0, 500)),
      fakeBody('Off', new THREE.Vector3(500, 0, 0)),
      fakeBody('In', new THREE.Vector3(0, 0, 0)),
    ], cam, ctx());
    const byName = Object.fromEntries(g.readout().map((r) => [r.name, r]));
    expect(byName.Behind.anchor).toBeNull();
    expect(byName.Behind.onScreen).toBe(false);
    expect(byName.Off.onScreen).toBe(false);
    expect(byName.In.onScreen).toBe(true);
  });

  it('picks the nearest drawn glyph within slop', () => {
    const g = new PositionGlyphs(2);
    const cam = camera();
    g.update([fakeBody('Clipper', new THREE.Vector3())], cam, ctx());
    const { anchor } = g.readout()[0];
    expect(g.pickNearest(anchor!.x + 4, anchor!.y, 6)).toBe('Clipper');
    expect(g.pickNearest(anchor!.x + 40, anchor!.y, 6)).toBeNull();
  });

  it('keeps allocation and sprite count bounded with many unresolved entities', () => {
    const g = new PositionGlyphs(2);
    const cam = camera();
    const bodies = Array.from({ length: 2000 }, (_, i) =>
      fakeBody(`b${i}`, new THREE.Vector3((i % 50) - 25, Math.floor(i / 50) - 20, 0)));
    g.update(bodies, cam, ctx());
    const sprites = g.group.children.length;
    expect(sprites).toBe(4000);
    const textures = new Set(g.group.children.map((s) => (s as THREE.Sprite).material.map));
    expect(textures.size).toBeLessThanOrEqual(3); // shared, never per-frame/per-body
    for (let i = 0; i < 5; i++) g.update(bodies, cam, ctx());
    expect(g.group.children.length).toBe(sprites);
    g.dispose();
    expect(g.group.children.length).toBe(0);
  });
});
