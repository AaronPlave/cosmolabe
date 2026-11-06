import * as THREE from 'three';
import type { BodyMesh } from './BodyMesh.js';

/**
 * Screen-space *position* glyphs for entities whose real shape is unresolved
 * (#337).
 *
 * A glyph says where an object is, never how big it is: it is an unlit sprite
 * at the body's actual scene position with a constant pixel size, so the apparent
 * size can't leak into measurements, picking geometry, camera distance, shadows
 * or occultations. It is the only thing drawn at that anchor for a spacecraft
 * far away, replacing a lit placeholder sphere that vanishes on the night side
 * of a planet.
 *
 * The glyph hands off to the real model/globe continuously: its weight is a
 * smoothstep of the object's projected on-screen extent, overlapping the model's
 * own fade-in so there is no point where neither is drawn.
 */

/** Projected radius (CSS px) up to which the glyph is fully drawn. */
export const GLYPH_FULL_PX = 4;
/** Projected radius (CSS px) from which the glyph is gone: the body is resolved. */
export const GLYPH_GONE_PX = 12;
/**
 * Natural bodies (planets, moons, asteroids, comets) are drawn at their real
 * angular size and never get a filled point: a fixed-size white dot on a planet
 * would read as a physical object. Only a selected/tracked one gets a hollow
 * ring (an annotation, with its pinned label), and only while its real disk is
 * too small to mark the position by itself.
 */
export const NATURAL_RING_FULL_PX = 1;
export const NATURAL_RING_GONE_PX = 2;

/** Solid dot diameter, CSS px. */
const DOT_DIAMETER_PX = 3;
/** Open ring (selected) outer diameter, CSS px, and its stroke. */
const RING_DIAMETER_PX = 11;
const RING_STROKE_PX = 1.25;
/** Tracked ring: slightly larger and heavier than selected. */
const TRACKED_RING_DIAMETER_PX = 13;
const TRACKED_RING_STROKE_PX = 1.75;
/** Dark halo around every stroke so the glyph reads on bright and dark backgrounds. */
const HALO_PX = 1;
const HALO_ALPHA = 0.7;
const REST_OPACITY = 0.85;
const HOVER_SCALE = 1.25;
/** Per-frame easing of the LOD / terrain-occlusion factors, and the frames a terrain verdict must persist. */
const VIS_RATE = 0.2;
const TERRAIN_RATE = 0.3;
const TERRAIN_DEBOUNCE_FRAMES = 2;
/** Below this opacity a sprite is imperceptible and is not drawn at all. */
const MIN_DRAW_OPACITY = 0.02;

function ease(value: number, target: number, rate: number): number {
  const next = value + (target - value) * rate;
  return Math.abs(target - next) < 0.01 ? target : next;
}

export type GlyphRing = 'none' | 'selected' | 'tracked';
type GlyphKind = 'dot' | 'selected' | 'tracked';

function bandWeight(extentPx: number, full: number, gone: number): number {
  if (!(extentPx > full)) return 1;
  if (extentPx >= gone) return 0;
  const t = (extentPx - full) / (gone - full);
  return 1 - t * t * (3 - 2 * t);
}

/**
 * 1 while an artificial body (spacecraft, lander, surface asset) is unresolved,
 * easing to 0 as its projected extent grows and its model takes over.
 */
export function glyphWeight(extentPx: number): number {
  return bandWeight(extentPx, GLYPH_FULL_PX, GLYPH_GONE_PX);
}

/**
 * Weight of the selected/tracked ring. For a natural body it leaves as soon as
 * its real disk is perceptible; for an artificial one it follows the glyph.
 */
export function ringWeight(extentPx: number, natural = false): number {
  return natural ? bandWeight(extentPx, NATURAL_RING_FULL_PX, NATURAL_RING_GONE_PX) : glyphWeight(extentPx);
}

/**
 * Natural bodies are drawn at real scale and explained by their label; artificial
 * ones (spacecraft, landers, surface infrastructure) are the entities whose
 * position needs a locator when their model is not resolvable. Unclassified
 * bodies are natural only when they are globes.
 */
export function isNaturalBody(bm: Pick<BodyMesh, 'body'>): boolean {
  switch (bm.body.classification) {
    case 'planet': case 'moon': case 'asteroid': case 'comet': case 'dwarf-planet': case 'dwarf_planet':
      return true;
    case 'spacecraft': case 'other': case 'instrument':
      return false;
    default:
      return bm.body.geometryType === 'Globe';
  }
}

/**
 * Whether a body is ever represented by a glyph. Physical optics (the Sun and
 * other stars), barycenters, instrument sensors and bodies drawn by a custom
 * visualizer own their own appearance and are left alone.
 */
export function wantsGlyph(bm: Pick<BodyMesh, 'body' | 'sunVisual'>, hasCustomVisual: boolean): boolean {
  if (hasCustomVisual || bm.sunVisual) return false;
  const body = bm.body;
  if (body.geometryType === 'Sensor' || body.geometryType === 'Rings') return false;
  switch (body.classification) {
    case 'star':
    case 'barycenter':
    case 'instrument':
      return false;
    default:
      return true;
  }
}

/**
 * Whether the entity gets the unlit point marker (dot, plus ring when
 * selected/tracked): eligible and artificial. Natural bodies never do.
 */
export function wantsPointMarker(bm: Pick<BodyMesh, 'body' | 'sunVisual'>, hasCustomVisual: boolean): boolean {
  return wantsGlyph(bm, hasCustomVisual) && !isNaturalBody(bm);
}

/**
 * Whether the glyph stands in for the legacy lit minimum-size placeholder
 * sphere this frame. Only while glyphs are on, the body is eligible and its
 * projected radius is still unresolved; otherwise the old behaviour stands.
 */
export function glyphReplacesPlaceholder(glyphsEnabled: boolean, eligible: boolean, radiusPx: number): boolean {
  return glyphsEnabled && eligible && radiusPx < GLYPH_GONE_PX;
}

/** Anti-aliased coverage of a signed distance in device pixels. */
function coverage(distance: number): number {
  return Math.min(1, Math.max(0, 0.5 - distance));
}

/**
 * Rasterize a glyph analytically into straight-alpha RGBA. Deterministic and
 * canvas-free, so it works in workers, tests and any host. `boxCssPx` is the
 * square the glyph occupies; the texture is `ceil(boxCssPx * dpr)` device px,
 * drawn texel-for-pixel.
 */
export function rasterizeGlyph(kind: GlyphKind, pixelRatio: number): { data: Uint8Array; size: number } {
  const dpr = Math.max(1, pixelRatio);
  const outer = kind === 'dot' ? DOT_DIAMETER_PX
    : kind === 'selected' ? RING_DIAMETER_PX : TRACKED_RING_DIAMETER_PX;
  const size = Math.ceil((outer + 2 * HALO_PX + 1) * dpr);
  const data = new Uint8Array(size * size * 4);
  const c = size / 2;
  const radius = (outer / 2) * dpr;
  const stroke = (kind === 'tracked' ? TRACKED_RING_STROKE_PX : RING_STROKE_PX) * dpr;
  const halo = HALO_PX * dpr;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      // Signed distance to the white stroke/fill and to its halo-grown outline.
      const sd = kind === 'dot' ? d - radius : Math.abs(d - (radius - stroke / 2)) - stroke / 2;
      const fill = coverage(sd);
      const grown = coverage(sd - halo) * HALO_ALPHA;
      const alpha = Math.max(fill, grown);
      if (alpha <= 0) continue;
      // Straight alpha: white where the fill dominates, black in the halo.
      const white = alpha > 0 ? Math.round(255 * (fill / alpha)) : 0;
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.max(0, Math.min(255, white));
      data[i + 3] = Math.round(255 * alpha);
    }
  }
  return { data, size };
}

/** What the renderer reports for one entity: the observable state of its marker. */
export interface PositionGlyphReadout {
  name: string;
  /** Marker anchor in CSS px from the canvas's top-left; null when behind the camera. */
  anchor: { x: number; y: number } | null;
  /** Projected radius of the entity's actual representation, CSS px (silhouette when a model is loaded). */
  extentPx: number;
  /** 0..1: how much of the glyph is drawn (`1` unresolved, `0` fully resolved). */
  glyphWeight: number;
  ring: GlyphRing;
  hovered: boolean;
  /** Glyph's approximate pixel footprint (diameter, CSS px) — 0 when not drawn. */
  footprintPx: number;
  /** Whether the anchor lies inside the canvas. */
  onScreen: boolean;
  /**
   * Whole-glyph visibility, 0..1: the label-coordinated LOD decision, anchor
   * occlusion by bodies and terrain, all eased. Dot and ring share it, so a
   * glyph is drawn whole or not at all.
   */
  visibility: number;
  /** The anchor is hidden behind a nearer body or terrain (glyph is not pickable). */
  occluded: boolean;
  /** The entity's label is deliberately shown (stable); focus entities show a glyph regardless. */
  labelLegible: boolean;
}

export interface PositionGlyphContext {
  /** CSS-pixel canvas size. */
  viewport: { width: number; height: number };
  /** Device-pixel backing store, for texel-exact sizing. */
  device: { width: number; height: number; pixelRatio: number };
  isEligible: (bm: BodyMesh) => boolean;
  /** Host-pinned (selected / highlighted); a transient hover pin must not count. */
  isPinned: (name: string) => boolean;
  trackedName: string | null;
  hoveredName: string | null;
  /**
   * The stable label decision for a body (null if it has no label). Ordinary
   * entities get a glyph only while their label is legible, so a marker never
   * outlives the label that explains it; selected/tracked entities do not need one.
   */
  labelState: (name: string) => { legible: boolean; occlusion: number } | null;
  /**
   * Whether terrain or reconstructed plates hide the entity's anchor. Asked
   * only for glyphs that would otherwise draw. Spheres are covered by the
   * label occlusion fade.
   */
  terrainOccluded?: (bm: BodyMesh) => boolean;
}

interface GlyphEntry {
  /** In the LOD set this frame (drawn, or hidden only by anchor occlusion). */
  active: boolean;
  /** Eased 0..1 LOD visibility (label coordination / focus). */
  vis: number;
  /** Eased 0..1 terrain-occlusion factor and its debounce. */
  terrainVis: number;
  terrainTarget: number;
  terrainPending: number;
  dot: THREE.Sprite;
  ring: THREE.Sprite;
  readout: PositionGlyphReadout;
}

const _proj = new THREE.Vector3();
const _corner = new THREE.Vector3();
const _toCam = new THREE.Vector3();

export class PositionGlyphs {
  /** Add to the scene; sprites live on the overlay layer and are never depth-tested (see makeSprite). */
  readonly group = new THREE.Group();
  private readonly entries = new Map<string, GlyphEntry>();
  private textures: Record<GlyphKind, THREE.DataTexture> | null = null;
  private texturePixelRatio = 0;
  private texSize: Record<GlyphKind, number> = { dot: 0, selected: 0, tracked: 0 };

  constructor(private readonly layer: number) {
    this.group.name = 'position-glyphs';
  }

  private ensureTextures(pixelRatio: number): Record<GlyphKind, THREE.DataTexture> {
    const ratio = Math.max(1, pixelRatio);
    if (this.textures && this.texturePixelRatio === ratio) return this.textures;
    const next = {} as Record<GlyphKind, THREE.DataTexture>;
    for (const kind of ['dot', 'selected', 'tracked'] as const) {
      const { data, size } = rasterizeGlyph(kind, ratio);
      const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      next[kind] = tex;
      this.texSize[kind] = size;
    }
    const previous = this.textures;
    this.textures = next;
    this.texturePixelRatio = ratio;
    for (const entry of this.entries.values()) {
      (entry.dot.material as THREE.SpriteMaterial).map = next.dot;
      this.setRingTexture(entry, entry.readout.ring);
    }
    if (previous) for (const tex of Object.values(previous)) tex.dispose();
    return next;
  }

  private setRingTexture(entry: GlyphEntry, ring: GlyphRing): void {
    if (ring === 'none' || !this.textures) return;
    const mat = entry.ring.material as THREE.SpriteMaterial;
    const tex = this.textures[ring];
    if (mat.map !== tex) mat.map = tex;
  }

  private makeSprite(map: THREE.Texture, renderOrder: number): THREE.Sprite {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map,
      transparent: true,
      // Occlusion is decided once, for the anchor (label occlusion fade + terrain
      // test), and applied to the whole glyph as opacity. A per-fragment depth
      // test would let terrain slice an arbitrary crescent out of the symbol.
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: false,
      fog: false,
    }));
    sprite.layers.set(this.layer);
    sprite.renderOrder = renderOrder;
    // A position glyph is not a pick target of the 3D scene; screen-space
    // picking goes through pickNearest() so hit geometry never depends on it.
    sprite.raycast = () => {};
    sprite.visible = false;
    return sprite;
  }

  private entryFor(name: string, textures: Record<GlyphKind, THREE.DataTexture>): GlyphEntry {
    let entry = this.entries.get(name);
    if (!entry) {
      entry = {
        active: false, vis: 0, terrainVis: 1, terrainTarget: 1, terrainPending: 0,
        dot: this.makeSprite(textures.dot, 998),
        ring: this.makeSprite(textures.selected, 998),
        readout: {
          name, anchor: null, extentPx: Infinity, glyphWeight: 0,
          ring: 'none', hovered: false, footprintPx: 0, onScreen: false,
          visibility: 0, occluded: false, labelLegible: false,
        },
      };
      this.group.add(entry.dot, entry.ring);
      this.entries.set(name, entry);
    }
    return entry;
  }

  /** Projected radius of the body's actual representation in CSS px. */
  private static extentPx(bm: BodyMesh, camera: THREE.PerspectiveCamera, viewport: { width: number; height: number }): number {
    const halfFovTan = Math.tan((camera.fov * Math.PI / 180) / 2);
    const dist = bm.position.distanceTo(camera.position);
    if (!(dist > 0)) return Infinity;
    const pxPerWorld = viewport.height / (2 * halfFovTan * dist);
    let extent = bm.displayRadius * bm.scaleFactor * pxPerWorld;
    // A model's displayRadius is only its longest half-extent; wide arrays and
    // booms reach farther. Use the projected bounding box while it can matter.
    const box = bm.modelLocalBox;
    const container = bm.modelContainer;
    if (box && container && extent < GLYPH_GONE_PX * 4) {
      _proj.copy(bm.position).project(camera);
      const cx = (_proj.x * 0.5 + 0.5) * viewport.width;
      const cy = (-_proj.y * 0.5 + 0.5) * viewport.height;
      const m = container.matrixWorld;
      let maxSq = 0;
      for (let i = 0; i < 8; i++) {
        _corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)
          .applyMatrix4(m).project(camera);
        const dx = (_corner.x * 0.5 + 0.5) * viewport.width - cx;
        const dy = (-_corner.y * 0.5 + 0.5) * viewport.height - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > maxSq) maxSq = d2;
      }
      extent = Math.max(extent, Math.sqrt(maxSq));
    }
    return extent;
  }

  update(bodies: Iterable<BodyMesh>, camera: THREE.PerspectiveCamera, ctx: PositionGlyphContext): void {
    const textures = this.ensureTextures(ctx.device.pixelRatio);
    const proj = camera.projectionMatrix.elements;
    // On-screen size in device px of an unattenuated sprite is
    // scale * P[axis] * bufferSize / 2 (see LabelManager): invert it so each
    // glyph covers exactly its texture, texel for pixel.
    const pxPerScaleX = (Math.abs(proj[0]) * ctx.device.width) / 2;
    const pxPerScaleY = (Math.abs(proj[5]) * ctx.device.height) / 2;
    const halfFovTan = Math.tan((camera.fov * Math.PI / 180) / 2);

    for (const bm of bodies) {
      const name = bm.body.name;
      const existing = this.entries.get(name);
      // Not in the scene (user-hidden, outside its existence window, no
      // ephemeris at this time) or never glyph-worthy: draw nothing.
      if (!bm.visible || !ctx.isEligible(bm)) {
        if (existing) this.hide(existing);
        continue;
      }

      const ring: GlyphRing = ctx.trackedName === name ? 'tracked' : ctx.isPinned(name) ? 'selected' : 'none';
      const hovered = ctx.hoveredName === name;

      // Natural bodies are drawn at real scale and explained by their label: no
      // marker in ordinary view. Only a selected/tracked one gets a hollow ring
      // (an annotation, never a filled point), while its real disk is too small to
      // mark the position itself.
      const natural = isNaturalBody(bm);
      if (natural && ring === 'none') {
        if (existing) this.hide(existing);
        continue;
      }

      const extent = PositionGlyphs.extentPx(bm, camera, ctx.viewport);
      const weight = natural ? ringWeight(extent, true) : glyphWeight(extent);
      if (weight <= 0) {
        if (existing) this.hide(existing);
        continue;
      }

      // LOD policy. A glyph is a navigation symbol tied to its label: ordinary
      // entities show one only while their label is deliberately shown (a stable,
      // hysteretic decision made by the label manager), so no unexplained marker
      // is left behind at far zoom. Selected/tracked entities always keep their
      // locator (their label is pinned by the label manager).
      const label = ctx.labelState(name);
      const focus = ring !== 'none';
      const wantVis = focus || label?.legible ? 1 : 0;
      let entry = existing;
      if (!entry && wantVis === 0) continue;
      entry = entry ?? this.entryFor(name, textures);
      entry.vis = ease(entry.vis, wantVis, VIS_RATE);
      if (wantVis === 0 && entry.vis === 0) { this.hide(entry); continue; }

      // Anchor occlusion: the label's analytic body occlusion fade, plus terrain /
      // plate tests for the few glyphs that would draw. Decided for the anchor and
      // applied to the whole glyph; debounced so a rim grazing the anchor does not
      // toggle it frame to frame.
      let terrainWant = 1;
      if (ctx.terrainOccluded && entry.vis > 0.02) terrainWant = ctx.terrainOccluded(bm) ? 0 : 1;
      if (terrainWant !== entry.terrainTarget) {
        if (++entry.terrainPending >= TERRAIN_DEBOUNCE_FRAMES) { entry.terrainTarget = terrainWant; entry.terrainPending = 0; }
      } else entry.terrainPending = 0;
      entry.terrainVis = ease(entry.terrainVis, entry.terrainTarget, TERRAIN_RATE);
      const occlusion = label?.occlusion ?? 1;
      entry.active = true;
      const visibility = entry.vis * occlusion * entry.terrainVis;
      const occluded = occlusion * entry.terrainVis < 0.5;

      // Anchor: the body's true scene position, nudged a few pixels toward the
      // camera so a surface-locked asset sitting exactly on its parent's surface
      // is not clipped by it. This moves only the sprite; the body, its
      // trajectory and every query keep their exact positions.
      _toCam.copy(camera.position).sub(bm.position);
      const dist = _toCam.length();
      const worldPerPx = (2 * dist * halfFovTan) / Math.max(1, ctx.viewport.height);
      const nudge = dist > 0 ? Math.min(3 * worldPerPx, dist * 0.5) / dist : 0;
      entry.dot.position.copy(bm.position).addScaledVector(_toCam, nudge);
      entry.ring.position.copy(entry.dot.position);

      const dotMat = entry.dot.material as THREE.SpriteMaterial;
      dotMat.opacity = natural ? 0 : (hovered ? 1 : REST_OPACITY) * weight * visibility;
      const dotScale = hovered ? HOVER_SCALE : 1;
      entry.dot.scale.set(
        (this.texSize.dot / pxPerScaleX) * dotScale,
        (this.texSize.dot / pxPerScaleY) * dotScale, 1);
      entry.dot.visible = dotMat.opacity > MIN_DRAW_OPACITY;

      const ringAlpha = ring === 'none' ? 0 : (ring === 'tracked' ? 1 : 0.92) * ringWeight(extent, natural) * visibility;
      if (ring === 'none' || ringAlpha <= MIN_DRAW_OPACITY) {
        entry.ring.visible = false;
      } else {
        this.setRingTexture(entry, ring);
        const ringMat = entry.ring.material as THREE.SpriteMaterial;
        ringMat.opacity = ringAlpha;
        const size = this.texSize[ring];
        entry.ring.scale.set(size / pxPerScaleX, size / pxPerScaleY, 1);
        entry.ring.visible = true;
      }

      _proj.copy(bm.position).project(camera);
      const behind = _proj.z > 1;
      const x = (_proj.x * 0.5 + 0.5) * ctx.viewport.width;
      const y = (-_proj.y * 0.5 + 0.5) * ctx.viewport.height;
      const r = entry.readout;
      r.anchor = behind ? null : { x, y };
      r.extentPx = extent;
      r.glyphWeight = weight;
      r.ring = ring;
      r.hovered = hovered;
      r.footprintPx = entry.ring.visible ? (ring === 'tracked' ? TRACKED_RING_DIAMETER_PX : RING_DIAMETER_PX)
        : entry.dot.visible ? DOT_DIAMETER_PX * dotScale : 0;
      r.visibility = visibility;
      r.occluded = occluded;
      r.labelLegible = !!label?.legible;
      r.onScreen = !behind && x >= 0 && y >= 0 && x <= ctx.viewport.width && y <= ctx.viewport.height;
    }
  }

  private hide(entry: GlyphEntry): void {
    entry.dot.visible = false;
    entry.ring.visible = false;
    entry.active = false;
    entry.vis = 0; entry.terrainVis = 1; entry.terrainTarget = 1; entry.terrainPending = 0;
    const r = entry.readout;
    r.visibility = 0; r.occluded = false; r.labelLegible = false;
    r.glyphWeight = 0;
    r.footprintPx = 0;
    r.anchor = null;
    r.onScreen = false;
    r.ring = 'none';
  }

  /**
   * Nearest drawn glyph within `slopPx` of a canvas position (CSS px), so a
   * click on the point itself selects the entity just like its label does.
   * A glyph whose anchor is occluded (and so is not drawn) is never a hit.
   */
  pickNearest(screenX: number, screenY: number, slopPx: number): string | null {
    let best: string | null = null;
    let bestD = slopPx * slopPx;
    for (const [name, entry] of this.entries) {
      const r = entry.readout;
      if (!(entry.dot.visible || entry.ring.visible) || !r.anchor || r.occluded || r.glyphWeight * r.visibility < 0.3) continue;
      const dx = r.anchor.x - screenX;
      const dy = r.anchor.y - screenY;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD) { bestD = d2; best = name; }
    }
    return best;
  }

  /**
   * Observable marker state for every entity in the glyph set: drawn, fading
   * out, or hidden only because its anchor is occluded (`occluded: true`,
   * `visibility` near 0). Depth occlusion by anything the analytic label fade and
   * the terrain/plate test do not cover is not reported.
   */
  readout(): PositionGlyphReadout[] {
    const out: PositionGlyphReadout[] = [];
    for (const entry of this.entries.values()) {
      if (entry.active) out.push({ ...entry.readout, anchor: entry.readout.anchor && { ...entry.readout.anchor } });
    }
    return out;
  }

  remove(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    this.group.remove(entry.dot, entry.ring);
    (entry.dot.material as THREE.Material).dispose();
    (entry.ring.material as THREE.Material).dispose();
    this.entries.delete(name);
  }

  dispose(): void {
    for (const name of [...this.entries.keys()]) this.remove(name);
    if (this.textures) for (const tex of Object.values(this.textures)) tex.dispose();
    this.textures = null;
  }
}
