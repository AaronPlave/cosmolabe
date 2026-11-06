import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  GLYPH_FULL_PX, GLYPH_GONE_PX, NATURAL_RING_GONE_PX, PositionGlyphs,
  glyphReplacesPlaceholder, glyphWeight, isNaturalBody, ringWeight, rasterizeGlyph, wantsGlyph, wantsPointMarker,
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
    // Default: a labelled entity whose label is shown and not occluded.
    labelState: () => ({ legible: true, occlusion: 1 }),
    ...over,
  };
}

type Ctx = Parameters<PositionGlyphs['update']>[2];

/** Run enough frames for the eased visibility factors to settle. */
function settle(g: PositionGlyphs, bodies: BodyMesh[], cam: THREE.PerspectiveCamera, c: Ctx, frames = 60): void {
  for (let i = 0; i < frames; i++) g.update(bodies, cam, c);
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

describe('glyphReplacesPlaceholder', () => {
  it('replaces the legacy placeholder only for eligible, unresolved bodies while enabled', () => {
    expect(glyphReplacesPlaceholder(true, true, 0.5)).toBe(true);
    expect(glyphReplacesPlaceholder(true, true, GLYPH_GONE_PX - 0.01)).toBe(true);
    expect(glyphReplacesPlaceholder(true, true, GLYPH_GONE_PX)).toBe(false); // resolved: normal rendering
    expect(glyphReplacesPlaceholder(false, true, 0.5)).toBe(false); // glyphs off: legacy behaviour
    expect(glyphReplacesPlaceholder(true, false, 0.5)).toBe(false); // ineligible (Sun, custom visual…)
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
    settle(g, [fakeBody('Clipper', new THREE.Vector3())], cam, ctx());
    const { anchor } = g.readout()[0];
    expect(g.pickNearest(anchor!.x + 4, anchor!.y, 6)).toBe('Clipper');
    expect(g.pickNearest(anchor!.x + 40, anchor!.y, 6)).toBeNull();
  });

  it('does not pick a glyph whose anchor is occluded (and does not draw it)', () => {
    const g = new PositionGlyphs(2);
    const cam = camera();
    const hidden = fakeBody('Hidden', new THREE.Vector3(0, 0, -50)); // behind a foreground globe
    const visible = fakeBody('Visible', new THREE.Vector3(0.0001, 0, 0)); // a few px away, in front
    const c = ctx({ labelState: (n) => ({ legible: true, occlusion: n === 'Hidden' ? 0 : 1 }) });
    settle(g, [hidden, visible], cam, c);
    const hiddenGlyph = g.readout().find((r) => r.name === 'Hidden');
    expect(hiddenGlyph?.occluded ?? true).toBe(true);
    expect(g.group.children.filter((o) => o.visible)).toHaveLength(1); // only Visible's dot is drawn
    const a = g.readout().find((r) => r.name === 'Visible')!.anchor!;
    expect(g.pickNearest(a.x, a.y, 6)).toBe('Visible');
  });

  it('keeps a surface-locked asset anchored on its surface point, nudged only toward the camera', () => {
    const g = new PositionGlyphs(2);
    const cam = camera();
    const rover = fakeBody('Rover', new THREE.Vector3(3, 2, 0));
    (rover.body as unknown as { geometryData: unknown }).geometryData = { surfaceLock: true };
    g.update([rover], cam, ctx());
    const dot = g.group.children[0] as THREE.Sprite;
    const toCam = cam.position.clone().sub(rover.position);
    const offset = dot.position.clone().sub(rover.position);
    // Same screen anchor as the body; offset is purely along the line of sight, a few px worth.
    expect(offset.clone().normalize().dot(toCam.clone().normalize())).toBeCloseTo(1, 6);
    const worldPerPx = (2 * toCam.length() * Math.tan((50 * Math.PI / 180) / 2)) / CSS.height;
    expect(offset.length()).toBeGreaterThan(0);
    expect(offset.length()).toBeLessThanOrEqual(3.0001 * worldPerPx);
    const a = dot.position.clone().project(cam);
    const b = rover.position.clone().project(cam);
    expect(a.x).toBeCloseTo(b.x, 9); expect(a.y).toBeCloseTo(b.y, 9);
    expect(rover.position.toArray()).toEqual([3, 2, 0]);
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

describe('label-coordinated LOD (#337 live-testing feedback)', () => {
  const sprites = (g: PositionGlyphs) => g.group.children as THREE.Sprite[];
  const drawn = (g: PositionGlyphs) => sprites(g).filter((o) => o.visible).length;

  it('an ordinary entity whose label is culled gets no glyph — no unexplained dots', () => {
    const g = new PositionGlyphs(2);
    const cam = camera();
    const sc = fakeBody('Far', new THREE.Vector3());
    settle(g, [sc], cam, ctx({ labelState: () => ({ legible: false, occlusion: 1 }) }));
    expect(g.readout()).toHaveLength(0);
    expect(g.group.children).toHaveLength(0); // never even allocated
    // Entities with no label at all are not marked either.
    settle(g, [sc], cam, ctx({ labelState: () => null }));
    expect(g.readout()).toHaveLength(0);
  });

  it('shows the glyph when the label is legible, and fades it with the label — no pop either way', () => {
    const g = new PositionGlyphs(2);
    const cam = camera();
    const sc = fakeBody('Clipper', new THREE.Vector3());
    const alphas: number[] = [];
    const op = () => (sprites(g)[0].material as THREE.SpriteMaterial).opacity;
    const on = ctx({ labelState: () => ({ legible: true, occlusion: 1 }) });
    const off = ctx({ labelState: () => ({ legible: false, occlusion: 1 }) });
    for (let i = 0; i < 40; i++) { g.update([sc], cam, on); alphas.push(op()); }
    const peak = alphas.at(-1)!;
    expect(peak).toBeGreaterThan(0.8);
    // Gradual rise: no frame-to-frame jump larger than a fraction of the range.
    for (let i = 1; i < alphas.length; i++) expect(alphas[i] - alphas[i - 1]).toBeLessThan(peak * 0.3);
    alphas.length = 0;
    for (let i = 0; i < 60; i++) { g.update([sc], cam, off); alphas.push(op()); }
    for (let i = 1; i < alphas.length; i++) {
      expect(alphas[i]).toBeLessThanOrEqual(alphas[i - 1] + 1e-9); // monotone fade-out
      expect(alphas[i - 1] - alphas[i]).toBeLessThan(peak * 0.3);
    }
    expect(g.readout()).toHaveLength(0); // gone, not lingering
  });

  it('a selected or tracked entity keeps its locator even when its label is culled or the entity is far', () => {
    const g = new PositionGlyphs(2);
    const cam = camera();
    const sc = fakeBody('Clipper', new THREE.Vector3());
    const culled = { labelState: () => ({ legible: false, occlusion: 1 }) };
    settle(g, [sc], cam, ctx({ ...culled, isPinned: () => true }));
    expect(g.readout()[0].ring).toBe('selected');
    expect(g.readout()[0].visibility).toBeGreaterThan(0.95);
    settle(g, [sc], cam, ctx({ ...culled, isPinned: () => true, trackedName: 'Clipper' }));
    expect(g.readout()[0].ring).toBe('tracked');
    expect(g.readout()[0].visibility).toBeGreaterThan(0.95);
    // Hover alone is not focus: with the label culled it earns nothing.
    const g2 = new PositionGlyphs(2);
    settle(g2, [sc], cam, ctx({ ...culled, hoveredName: 'Clipper' }));
    expect(g2.readout()).toHaveLength(0);
  });

  it('draws the whole glyph or none: dot and ring share one visibility, and occlusion removes both', () => {
    const g = new PositionGlyphs(2);
    const cam = camera();
    const sc = fakeBody('Clipper', new THREE.Vector3());
    const pinned = { isPinned: () => true, trackedName: 'Clipper' as string | null };
    const op = (i: number) => (sprites(g)[i].material as THREE.SpriteMaterial).opacity;
    for (const occlusion of [1, 0.7, 0.4, 0.1]) {
      settle(g, [sc], cam, ctx({ ...pinned, labelState: () => ({ legible: true, occlusion }) }), 3);
      if (sprites(g)[1].visible && sprites(g)[0].visible) {
        // Same multiplier on both parts (ring base 1 for tracked, dot base 0.85).
        expect(op(1) / 1).toBeCloseTo(op(0) / 0.85, 6);
      }
    }
    settle(g, [sc], cam, ctx({ ...pinned, labelState: () => ({ legible: true, occlusion: 0 }) }));
    expect(drawn(g)).toBe(0); // nothing left of either part
    expect(g.readout().every((r) => r.occluded)).toBe(true);
    const anchor = g.readout()[0]?.anchor ?? { x: 400, y: 300 };
    expect(g.pickNearest(anchor.x, anchor.y, 20)).toBeNull();
  });

  it('terrain occlusion of the anchor is debounced and hides dot and ring together', () => {
    const g = new PositionGlyphs(2);
    const cam = camera();
    const rover = fakeBody('Rover', new THREE.Vector3());
    const base = { isPinned: () => true };
    let hidden = false;
    const c = ctx({ ...base, terrainOccluded: () => hidden });
    settle(g, [rover], cam, c);
    expect(drawn(g)).toBe(2);
    // A single frame of rim contact does not toggle the glyph.
    hidden = true; g.update([rover], cam, c); hidden = false;
    for (let i = 0; i < 10; i++) g.update([rover], cam, c);
    expect(drawn(g)).toBe(2);
    expect(g.readout()[0].occluded).toBe(false);
    // A persistent occlusion hides both parts and makes the glyph unpickable.
    hidden = true;
    settle(g, [rover], cam, c);
    expect(drawn(g)).toBe(0);
    hidden = false;
    settle(g, [rover], cam, c);
    expect(drawn(g)).toBe(2);
  });

  it('natural bodies never get a filled point; only selected/tracked ones get a hollow ring', () => {
    const cam = camera();
    const px = (r: number, d: number) => r / (2 * Math.tan((50 * Math.PI / 180) / 2) * d) * CSS.height;
    const tiny = 0.4 / px(1, 100); // sub-pixel disk: the case that used to get a white dot
    const planet = fakeBody('Jupiter', new THREE.Vector3(), { displayRadius: tiny, classification: 'planet', geometryType: 'Globe' });
    const moon = fakeBody('Moon', new THREE.Vector3(2, 0, 0), { displayRadius: tiny, classification: 'moon', geometryType: 'Globe' });
    const rock = fakeBody('Ceres', new THREE.Vector3(-2, 0, 0), { displayRadius: tiny, classification: 'asteroid', geometryType: 'Globe' });
    // Ordinary view, even with a legible label: nothing at all (the label explains the position).
    const g = new PositionGlyphs(2);
    settle(g, [planet, moon, rock], cam, ctx());
    expect(g.readout()).toHaveLength(0);
    expect(g.group.children.filter((o) => o.visible)).toHaveLength(0);
    // Selected: a hollow ring, never a dot. Tracked: the heavier ring, still no dot.
    settle(g, [planet], cam, ctx({ isPinned: () => true }));
    const sel = g.group.children as THREE.Sprite[];
    expect(g.readout().map((r) => [r.name, r.ring])).toEqual([['Jupiter', 'selected']]);
    expect(sel[0].visible).toBe(false); // dot sprite
    expect(sel[1].visible).toBe(true);  // ring sprite
    expect(g.readout()[0].footprintPx).toBeGreaterThan(8);
    settle(g, [planet], cam, ctx({ isPinned: () => true, trackedName: 'Jupiter' }));
    expect(g.readout()[0].ring).toBe('tracked');
    expect(sel[0].visible).toBe(false);
    // Its label need not be legible for the locator (focus), and hover alone adds nothing.
    const g2 = new PositionGlyphs(2);
    settle(g2, [planet], cam, ctx({ hoveredName: 'Jupiter' }));
    expect(g2.readout()).toHaveLength(0);
  });

  it('the ring leaves a natural body as soon as its real disk is perceptible; an artificial one keeps the dot', () => {
    expect(ringWeight(0.5, true)).toBe(1);
    expect(ringWeight(NATURAL_RING_GONE_PX, true)).toBe(0);
    expect(ringWeight(NATURAL_RING_GONE_PX, false)).toBeGreaterThan(0.9); // a model that small still needs its locator
    const cam = camera();
    const px = (r: number, d: number) => r / (2 * Math.tan((50 * Math.PI / 180) / 2) * d) * CSS.height;
    const radius = 5 / px(1, 100);
    const moon = fakeBody('Moon', new THREE.Vector3(), { displayRadius: radius, classification: 'moon', geometryType: 'Globe' });
    const g = new PositionGlyphs(2);
    settle(g, [moon], cam, ctx({ isPinned: () => true, trackedName: 'Moon' }));
    expect(g.readout()).toHaveLength(0); // a 5px disk is its own marker, even when tracked
    const sat = fakeBody('Sat', new THREE.Vector3(), { displayRadius: radius });
    settle(g, [sat], cam, ctx({}));
    expect(g.readout().map((r) => r.name)).toEqual(['Sat']);
    expect((g.group.children[0] as THREE.Sprite).visible).toBe(true); // the artificial asset's dot
  });

  it('classifies natural vs artificial bodies and who replaces the legacy placeholder', () => {
    const p = new THREE.Vector3();
    const cls = (classification: string | undefined, geometryType = 'Mesh') =>
      ({ ...fakeBody('X', p, { classification: classification as string, geometryType }), body: { name: 'X', classification, geometryType } }) as unknown as BodyMesh;
    for (const c of ['planet', 'moon', 'asteroid', 'comet']) expect(isNaturalBody(cls(c, 'Globe'))).toBe(true);
    for (const c of ['spacecraft', 'other']) expect(isNaturalBody(cls(c, 'Globe'))).toBe(false); // a spacecraft drawn as a globe is still artificial
    expect(isNaturalBody(cls(undefined, 'Globe'))).toBe(true);
    expect(isNaturalBody(cls(undefined, 'Mesh'))).toBe(false);
    // Natural bodies stay eligible for the focus ring but never for the point marker / placeholder replacement.
    expect(wantsGlyph(cls('planet', 'Globe'), false)).toBe(true);
    expect(wantsPointMarker(cls('planet', 'Globe'), false)).toBe(false);
    expect(wantsPointMarker(cls('moon', 'Globe'), false)).toBe(false);
    expect(wantsPointMarker(cls('spacecraft'), false)).toBe(true);
    expect(wantsPointMarker(cls('other'), false)).toBe(true);
    expect(wantsPointMarker(cls('spacecraft'), true)).toBe(false);
  });

  it('is stable under a slow zoom: no flicker, and the glyph never reappears after resolving', () => {
    const g = new PositionGlyphs(2);
    const cam = camera();
    const px = (r: number, d: number) => r / (2 * Math.tan((50 * Math.PI / 180) / 2) * d) * CSS.height;
    const radius = 1 / px(1, 100);
    let state: 'shown' | 'gone' = 'shown';
    let prev = -1;
    for (let extentPx = 0.5; extentPx <= 16; extentPx += 0.05) {
      const sc = fakeBody('Sat', new THREE.Vector3(), { displayRadius: radius * extentPx });
      for (let k = 0; k < 3; k++) g.update([sc], cam, ctx({}));
      const r = g.readout()[0];
      const a = r ? r.visibility * r.glyphWeight : 0;
      if (a === 0 && state === 'shown' && extentPx > GLYPH_GONE_PX) state = 'gone';
      if (state === 'gone') expect(a).toBe(0);
      if (prev >= 0 && extentPx > GLYPH_FULL_PX + 0.5) expect(a).toBeLessThanOrEqual(prev + 1e-6); // non-increasing once resolving
      prev = a;
    }
    expect(state).toBe('gone');
  });
});
