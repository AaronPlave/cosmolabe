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

export type GlyphRing = 'none' | 'selected' | 'tracked';
type GlyphKind = 'dot' | 'selected' | 'tracked';

/** 1 while the body is unresolved, easing to 0 as its projected extent grows. */
export function glyphWeight(extentPx: number): number {
  if (!(extentPx > GLYPH_FULL_PX)) return 1;
  if (extentPx >= GLYPH_GONE_PX) return 0;
  const t = (extentPx - GLYPH_FULL_PX) / (GLYPH_GONE_PX - GLYPH_FULL_PX);
  return 1 - t * t * (3 - 2 * t);
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
  /** Whether the anchor lies inside the canvas. Depth occlusion is applied on the GPU and is not reported. */
  onScreen: boolean;
}

export interface PositionGlyphContext {
  /** CSS-pixel canvas size. */
  viewport: { width: number; height: number };
  /** Device-pixel backing store, for texel-exact sizing. */
  device: { width: number; height: number; pixelRatio: number };
  isEligible: (bm: BodyMesh) => boolean;
  isPinned: (name: string) => boolean;
  trackedName: string | null;
  hoveredName: string | null;
}

interface GlyphEntry {
  dot: THREE.Sprite;
  ring: THREE.Sprite;
  readout: PositionGlyphReadout;
}

const _proj = new THREE.Vector3();
const _corner = new THREE.Vector3();
const _toCam = new THREE.Vector3();

export class PositionGlyphs {
  /** Add to the scene; sprites live on the overlay layer and depth-test against bodies. */
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
      // Depth-tested against the scene so a nearer body or terrain hides the
      // glyph; depth writes off so it never occludes anything itself.
      depthTest: true,
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
        dot: this.makeSprite(textures.dot, 998),
        ring: this.makeSprite(textures.selected, 998),
        readout: {
          name, anchor: null, extentPx: Infinity, glyphWeight: 0,
          ring: 'none', hovered: false, footprintPx: 0, onScreen: false,
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

      const extent = PositionGlyphs.extentPx(bm, camera, ctx.viewport);
      const weight = glyphWeight(extent);
      if (weight <= 0) {
        if (existing) this.hide(existing);
        continue;
      }

      const entry = existing ?? this.entryFor(name, textures);
      const ring: GlyphRing = ctx.trackedName === name ? 'tracked' : ctx.isPinned(name) ? 'selected' : 'none';
      const hovered = ctx.hoveredName === name;

      // Anchor: the body's true scene position, nudged a few pixels toward the
      // camera so terrain/model depth at the anchor itself (surface-locked
      // assets sit exactly on the terrain) can't z-fight the sprite away. This
      // moves only the sprite; the body, its trajectory and every query keep
      // their exact positions.
      _toCam.copy(camera.position).sub(bm.position);
      const dist = _toCam.length();
      const worldPerPx = (2 * dist * halfFovTan) / Math.max(1, ctx.viewport.height);
      const nudge = dist > 0 ? Math.min(3 * worldPerPx, dist * 0.5) / dist : 0;
      entry.dot.position.copy(bm.position).addScaledVector(_toCam, nudge);
      entry.ring.position.copy(entry.dot.position);

      const dotMat = entry.dot.material as THREE.SpriteMaterial;
      dotMat.opacity = (hovered ? 1 : REST_OPACITY) * weight;
      const dotScale = hovered ? HOVER_SCALE : 1;
      entry.dot.scale.set(
        (this.texSize.dot / pxPerScaleX) * dotScale,
        (this.texSize.dot / pxPerScaleY) * dotScale, 1);
      entry.dot.visible = true;

      if (ring === 'none') {
        entry.ring.visible = false;
      } else {
        this.setRingTexture(entry, ring);
        const ringMat = entry.ring.material as THREE.SpriteMaterial;
        ringMat.opacity = (ring === 'tracked' ? 1 : 0.92) * weight;
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
      r.footprintPx = (ring === 'none' ? DOT_DIAMETER_PX * dotScale
        : ring === 'tracked' ? TRACKED_RING_DIAMETER_PX : RING_DIAMETER_PX);
      r.onScreen = !behind && x >= 0 && y >= 0 && x <= ctx.viewport.width && y <= ctx.viewport.height;
    }
  }

  private hide(entry: GlyphEntry): void {
    entry.dot.visible = false;
    entry.ring.visible = false;
    const r = entry.readout;
    r.glyphWeight = 0;
    r.footprintPx = 0;
    r.anchor = null;
    r.onScreen = false;
    r.ring = 'none';
  }

  /**
   * Nearest drawn glyph within `slopPx` of a canvas position (CSS px), so a
   * click on the point itself selects the entity just like its label does.
   *
   * The GPU depth test hides a glyph behind a nearer globe or terrain, so the
   * pick must too: candidates are tried nearest first and any for which
   * `isOccluded(name)` is true is skipped.
   */
  pickNearest(screenX: number, screenY: number, slopPx: number, isOccluded?: (name: string) => boolean): string | null {
    const slopSq = slopPx * slopPx;
    const candidates: Array<{ name: string; d2: number }> = [];
    for (const [name, entry] of this.entries) {
      const r = entry.readout;
      if (!entry.dot.visible || !r.anchor || r.glyphWeight < 0.3) continue;
      const dx = r.anchor.x - screenX;
      const dy = r.anchor.y - screenY;
      const d2 = dx * dx + dy * dy;
      if (d2 <= slopSq) candidates.push({ name, d2 });
    }
    candidates.sort((a, b) => a.d2 - b.d2);
    for (const { name } of candidates) {
      if (!isOccluded?.(name)) return name;
    }
    return null;
  }

  /** Observable marker state for every entity currently drawn as a glyph (or fading out). */
  readout(): PositionGlyphReadout[] {
    const out: PositionGlyphReadout[] = [];
    for (const entry of this.entries.values()) {
      if (entry.dot.visible) out.push({ ...entry.readout, anchor: entry.readout.anchor && { ...entry.readout.anchor } });
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
