import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { Body, GeometryEvent } from '@cosmolabe/core';
import type { DrawnTrail, PositionResolver } from './TrajectoryLine.js';
import { EmphasisClock, stepEmphasis } from './emphasisFade.js';

/** Semantic glyph choice; temporality decides point versus span independently. */
export type EventGlyph = 'diamond';

export interface EventMarker {
  id: string;
  queryId: string;
  kind: GeometryEvent['kind'];
  label?: string;
  /** Event semantics are independent of instant/interval layout. */
  glyph?: EventGlyph;
  color?: THREE.ColorRepresentation;
  selected?: boolean;
  temporality: GeometryEvent['temporality'];
  startEt: number;
  endEt: number;
  /**
   * The part of an interval this trajectory line draws, when the interval
   * crosses arc boundaries and is split across lines. Caps appear only at the
   * event's true bounds and the midpoint glyph only on the piece containing
   * it; defaults to the whole interval.
   */
  pieceStartEt?: number;
  pieceEndEt?: number;
}

export interface EventMarkerHit {
  marker: EventMarker;
  et: number;
  distanceSq: number;
  renderOrder: number;
  boundary?: 'start' | 'end';
  worldPosition: THREE.Vector3;
  /** Hit the interval's trajectory span rather than one of its glyphs. */
  span?: boolean;
}

/**
 * Glyphs win over spans at any distance inside the pick radius: a span runs
 * through its own caps and midpoint glyph (and past other events' glyphs), so
 * nearest-wins let the line steal hovers aimed at a glyph. Within a feature
 * type, nearest wins; near-ties go to what renders on top.
 */
function preferHit(hit: EventMarkerHit, best: EventMarkerHit | null): boolean {
  if (!best) return true;
  if (!hit.span !== !best.span) return !hit.span;
  return hit.distanceSq < best.distanceSq - 1 ||
    (Math.abs(hit.distanceSq - best.distanceSq) <= 1 && hit.renderOrder > best.renderOrder);
}

/** @deprecated Event kinds are open strings; use `EventMarker['kind']`. */
export type EventMarkerType = EventMarker['kind'];

export interface EventMarkersOptions {
  markerSize?: number;
  intervalSamples?: number;
  color?: THREE.ColorRepresentation;
  selectedColor?: THREE.ColorRepresentation;
  /**
   * The owning TrajectoryLine's drawn polyline. When given, the selected-span
   * stroke retraces those exact vertices, so it bends with the trail and ends
   * at the trail's live head sample (the body's current position) instead of
   * at the last coarse interval sample.
   */
  trail?: () => DrawnTrail;
}

const SPAN_INITIAL_CAPACITY = 256;

/**
 * How an interval is drawn at its current projected length. Caps and the
 * midpoint glyph each need room; below that they collapse rather than pile up.
 */
export type IntervalLayout = 'full' | 'caps' | 'point';

interface MarkerVisual {
  marker: EventMarker;
  times: number[];
  framePositions: Array<[number, number, number]> | null;
  sprites: THREE.Sprite[];
  spriteSampleIndices: number[];
  spriteEpochs: number[];
  spriteBaseOpacity: number[];
  /** Visible envelope of each sprite's quad, in CSS pixels. */
  spriteSizePx: number[];
  points: THREE.Vector3[];
  visibleRange: readonly [number, number] | null;
  layout: IntervalLayout;
  /** Whether each sprite belongs to this piece (midpoint, start cap, end cap). */
  present: boolean[];
  /** Epochs this visual covers: the whole event, or its piece on this line. */
  pieceStart: number;
  pieceEnd: number;
}

/** A time-tagged polyline: the drawn trail, or an interval's own samples. */
interface Polyline {
  count: number;
  time(i: number): number;
  /** Writes vertex `i` into `out` (world space). */
  at(i: number, out: THREE.Vector3): THREE.Vector3;
}

const trailPolyline = (trail: DrawnTrail): Polyline => ({
  count: trail.count,
  time: (i) => trail.times[i],
  at: (i, out) => out.set(trail.positions[i * 3], trail.positions[i * 3 + 1], trail.positions[i * 3 + 2]),
});

/**
 * Visit `line` restricted to [start, end]: the vertices inside, plus points
 * interpolated at the bounds, in time order. Times must ascend.
 */
function traceRange(
  line: Polyline,
  start: number,
  end: number,
  emit: (point: THREE.Vector3, et: number) => void,
): void {
  const { count } = line;
  if (count < 2 || !(start <= end) || line.time(count - 1) < start || line.time(0) > end) return;
  const first = lowerBound(line, start); // first vertex with t >= start
  let last = lowerBound(line, end);
  while (last < count && line.time(last) <= end) last++;
  last--; // last vertex with t <= end
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const cut = (et: number, i: number) => {
    const t0 = line.time(i);
    const f = (et - t0) / (line.time(i + 1) - t0 || 1);
    emit(line.at(i, a).lerp(line.at(i + 1, b), f), et);
  };
  if (first > 0 && line.time(first) > start) cut(start, first - 1);
  for (let i = first; i <= last; i++) emit(line.at(i, a), line.time(i));
  if (last < count - 1 && line.time(last) < end) cut(end, last);
}

/** Position on `line` at `et` by linear interpolation, or null outside it. */
function polylineAt(line: Polyline, et: number, out: THREE.Vector3): THREE.Vector3 | null {
  const { count } = line;
  if (count < 1 || et < line.time(0) || et > line.time(count - 1)) return null;
  const i = Math.max(1, Math.min(count - 1, lowerBound(line, et)));
  if (count === 1) return line.at(0, out);
  const t0 = line.time(i - 1);
  const f = (et - t0) / (line.time(i) - t0 || 1);
  return line.at(i - 1, out).lerp(line.at(i, new THREE.Vector3()), f);
}

export interface EventMarkersViewport {
  width: number;
  height: number;
}

type GlyphShape = 'diamond' | 'cap';

function eventGlyphShape(glyph: EventGlyph): GlyphShape {
  switch (glyph) {
    case 'diamond': return 'diamond';
  }
}

interface GlyphUniforms {
  eventGlyphKind: { value: number };
  eventGlyphFill: { value: number };
  eventGlyphStrokeCssPx: { value: number };
  eventGlyphDpr: { value: number };
}

/** Sprite quad UV is the glyph's local screen-space frame, independent of camera zoom. */
const EVENT_GLYPH_FRAGMENT = /* glsl */`
  vec2 glyphP = (vEventUv - vec2(0.5)) * 2.0;
  float glyphCoverage;
  float glyphKnockoutAlpha = 0.0;
  if (eventGlyphKind < 0.5) {
    // Exact distance to the diamond edge segment, including its two tips.
    // The earlier L1-distance approximation had a derivative kink there,
    // which made stroke/AA width change as a tip crossed the pixel grid.
    vec2 glyphQ = abs(glyphP);
    const float glyphRadius = 0.78;
    float glyphT = clamp((glyphRadius - glyphQ.x + glyphQ.y) / (2.0 * glyphRadius), 0.0, 1.0);
    vec2 glyphNearest = glyphRadius * vec2(1.0 - glyphT, glyphT);
    float glyphDistance = length(glyphQ - glyphNearest) *
      (glyphQ.x + glyphQ.y <= glyphRadius ? -1.0 : 1.0);
    // Euclidean derivative length keeps a CSS-pixel stroke even on diagonals;
    // fwidth supplies the fragment footprint for antialiasing.
    float glyphPixel = max(length(vec2(dFdx(glyphDistance), dFdy(glyphDistance))), 0.00001);
    float glyphAa = 0.5 * max(fwidth(glyphDistance), glyphPixel);
    float glyphHalfStroke = 0.5 * eventGlyphStrokeCssPx * eventGlyphDpr * glyphPixel;
    float glyphOutline = 1.0 - smoothstep(glyphHalfStroke - glyphAa,
      glyphHalfStroke + glyphAa, abs(glyphDistance));
    float glyphInterior = 1.0 - smoothstep(-glyphAa, glyphAa, glyphDistance);
    glyphCoverage = max(glyphOutline, glyphInterior * eventGlyphFill);
    // A narrow dark keyline and quiet interior keep the owning trajectory
    // from visually extending a diamond tip as it passes underneath.
    float glyphKeylineWidth = 0.75 * eventGlyphDpr * glyphPixel;
    float glyphKeyline = 1.0 - smoothstep(glyphHalfStroke + glyphKeylineWidth - glyphAa,
      glyphHalfStroke + glyphKeylineWidth + glyphAa, abs(glyphDistance));
    glyphKnockoutAlpha = max(max(glyphKeyline - glyphCoverage, 0.0) * 0.7,
      glyphInterior * 0.55);
  } else {
    float glyphPixelX = max(fwidth(glyphP.x), 0.00001);
    float glyphPixelY = max(fwidth(glyphP.y), 0.00001);
    float glyphHalfWidth = 0.5 * eventGlyphStrokeCssPx * eventGlyphDpr * glyphPixelX;
    float glyphAcross = 1.0 - smoothstep(glyphHalfWidth - 0.5 * glyphPixelX,
      glyphHalfWidth + 0.5 * glyphPixelX, abs(glyphP.x));
    float glyphAlong = 1.0 - smoothstep(0.56 - 0.5 * glyphPixelY,
      0.56 + 0.5 * glyphPixelY, abs(glyphP.y));
    glyphCoverage = glyphAcross * glyphAlong;
  }
  float glyphAlpha = glyphCoverage + (1.0 - glyphCoverage) * glyphKnockoutAlpha;
  diffuseColor.rgb = mix(vec3(0.008, 0.012, 0.018), diffuseColor.rgb,
    glyphCoverage / max(glyphAlpha, 0.00001));
  diffuseColor.a *= glyphAlpha;
`;

const EVENT_GLYPH_DECLARATIONS = /* glsl */`
varying vec2 vEventUv;
uniform float eventGlyphKind;
uniform float eventGlyphFill;
uniform float eventGlyphStrokeCssPx;
uniform float eventGlyphDpr;
`;

function glyphUniforms(material: THREE.SpriteMaterial): GlyphUniforms {
  return material.userData.eventGlyphUniforms as GlyphUniforms;
}

const DEFAULT_COLOR = 0x70b7d7;
const SELECTED_COLOR = 0xffc857;

/**
 * Visible glyph envelopes in CSS pixels. The diamond spans 0.78 of its quad
 * (~12 px tip to tip); a cap's bar spans 1.12 of its quad (~12 px across the
 * path). Picking uses its own, larger radius, so these stay compact.
 */
const DIAMOND_QUAD_PX = 15;
const INTERVAL_DIAMOND_QUAD_PX = 14;
const CAP_QUAD_PX = 22;
/** Projected start→end separation below which the whole interval is one glyph. */
export const INTERVAL_POINT_PX = 16;
/** Below this, span + caps read on their own and a midpoint diamond would crowd them. */
export const INTERVAL_CAPS_ONLY_PX = 44;

/**
 * Interaction state is carried by fill and stroke, not size:
 * open (default) → softly filled (preview) → solid (selected).
 * Hover grows only ~3% and selection not at all: state reads as definiteness, not size.
 */
const GLYPH_STATE = {
  default: { fill: 0, diamondStroke: 1.35, capStroke: 1.5, scale: 1 },
  preview: { fill: 0.38, diamondStroke: 1.75, capStroke: 2, scale: 1.03 },
  selected: { fill: 1, diamondStroke: 1.5, capStroke: 2, scale: 1 },
} as const;

/**
 * Width of the selected interval's emphasis stroke, in CSS pixels. Trails are
 * 1 device pixel; this is just enough to make cap → span → cap traceable.
 */
const SELECTED_SPAN_WIDTH_PX = 1.6;
const SELECTED_SPAN_OPACITY = 0.92;
/** Hover strokes match the selected width; color and opacity tell them apart. */
const PREVIEW_SPAN_OPACITY = 0.8;

/** Choose the interval representation from its projected length in CSS pixels. */
export function intervalLayoutForPixels(lengthPx: number): IntervalLayout {
  if (!(lengthPx >= INTERVAL_POINT_PX)) return 'point';
  return lengthPx < INTERVAL_CAPS_ONLY_PX ? 'caps' : 'full';
}

export function eventMarkerColor(kind: string, state?: string): THREE.ColorRepresentation {
  if (state === 'partial') return 0xe0a84c;
  if (state === 'annular') return 0xd96f4c;
  if (kind === 'distance-range') return 0x71b896;
  if (kind === 'occultation') return 0x987fce;
  return DEFAULT_COLOR;
}

/** Whole-glyph visibility against one spherical body, softened across its screen-space limb. */
export function eventAnchorOpacityAtSphere(
  anchor: THREE.Vector3,
  cameraPosition: THREE.Vector3,
  center: THREE.Vector3,
  radius: number,
  focalLengthPx: number,
): number {
  if (!(radius > 0) || !(focalLengthPx > 0)) return 1;
  const ax = anchor.x - cameraPosition.x;
  const ay = anchor.y - cameraPosition.y;
  const az = anchor.z - cameraPosition.z;
  const anchorDistance = Math.hypot(ax, ay, az);
  const cx = center.x - cameraPosition.x;
  const cy = center.y - cameraPosition.y;
  const cz = center.z - cameraPosition.z;
  const centerDistanceSq = cx * cx + cy * cy + cz * cz;
  if (!(anchorDistance > 0) || centerDistanceSq <= radius * radius) return 1;
  const along = (cx * ax + cy * ay + cz * az) / anchorDistance;
  if (along <= 0) return 1;
  const miss = Math.sqrt(Math.max(0, centerDistanceSq - along * along));
  if (miss < radius) {
    const near = along - Math.sqrt(radius * radius - miss * miss);
    if (near >= anchorDistance - radius * 0.001) return 1;
  } else if (along >= anchorDistance) {
    return 1;
  }
  // A few CSS pixels on either side of the projected limb avoid an abrupt
  // all-or-nothing change as the camera moves. The opacity applies to the
  // sprite as a whole; its fragment shader never depth-tests against the body.
  const signedPixels = (miss - radius) * focalLengthPx / along;
  const t = Math.max(0, Math.min(1, (signedPixels + 4) / 8));
  return t * t * (3 - 2 * t);
}

const markerKey = (marker: EventMarker) => `${marker.queryId}\u0000${marker.id}`;

/**
 * One wide interval stroke (Line2) over a trajectory, written in place.
 *
 * three.js caches an instanced geometry's draw count on first render and
 * never raises it, so re-calling setPositions() with more points froze the
 * stroke at whatever was visible at first draw (and leaked a GPU buffer per
 * frame). Segments are written into a fixed buffer and limited with
 * `instanceCount`; growing swaps in a fresh geometry, which three.js has not
 * cached yet.
 */
class SpanStroke {
  readonly line: Line2;
  private readonly material: LineMaterial;
  private segments!: THREE.InstancedInterleavedBuffer;
  /** Event traced now; held while fading out after the target clears. */
  private key: string | null = null;
  private alpha = 0;

  constructor(name: string, color: THREE.ColorRepresentation, private readonly opacity: number, renderOrder: number) {
    this.material = new LineMaterial({
      color,
      linewidth: SELECTED_SPAN_WIDTH_PX,
      transparent: true,
      opacity,
      depthWrite: false,
      worldUnits: false,
    });
    this.line = new Line2(this.createGeometry(SPAN_INITIAL_CAPACITY), this.material);
    this.line.name = name;
    this.line.frustumCulled = false;
    this.line.visible = false;
    this.line.renderOrder = renderOrder; // above the trail (-1), below bodies' overlays
    const resolution = new THREE.Vector2();
    this.line.onBeforeRender = (renderer) => {
      renderer.getDrawingBufferSize(resolution);
      this.material.resolution.copy(resolution);
      this.material.linewidth = SELECTED_SPAN_WIDTH_PX * renderer.getPixelRatio();
    };
  }

  /**
   * Ease toward showing `target` (or nothing) and return the event to trace
   * this frame. A new event starts from transparent rather than inheriting
   * the previous one's opacity.
   */
  follow(target: string | null, dt: number): string | null {
    if (target !== null && target !== this.key) {
      this.key = target;
      this.alpha = 0;
    }
    this.alpha = stepEmphasis(this.alpha, target === null ? 0 : 1, dt);
    if (this.alpha === 0 && target === null) this.key = null;
    this.material.opacity = this.opacity * this.alpha;
    return this.key;
  }

  setColor(color: THREE.ColorRepresentation): void {
    this.material.color.set(color);
  }

  show(visible: boolean, segments: number): void {
    this.line.visible = visible;
    this.line.geometry.instanceCount = segments;
    if (segments > 0) this.segments.needsUpdate = true;
  }

  /**
   * Rewrite the stroke from `trace`, which emits the polyline's points in
   * order; `maxPoints` bounds how many it can emit.
   */
  write(maxPoints: number, trace: (emit: (point: THREE.Vector3) => void) => void): number {
    const array = this.reserve(Math.max(1, maxPoints - 1));
    let segments = 0;
    let px = NaN, py = NaN, pz = NaN;
    trace((point) => {
      if (!Number.isNaN(px)) {
        const o = segments++ * 6;
        array[o] = px; array[o + 1] = py; array[o + 2] = pz;
        array[o + 3] = point.x; array[o + 4] = point.y; array[o + 5] = point.z;
      }
      px = point.x; py = point.y; pz = point.z;
    });
    return segments;
  }

  dispose(): void {
    this.line.removeFromParent();
    this.line.geometry.dispose();
    this.material.dispose();
  }

  /** Segment buffer with room for `segments`, growing by doubling. */
  private reserve(segments: number): Float32Array {
    let capacity = this.segments.array.length / 6;
    if (segments > capacity) {
      while (capacity < segments) capacity *= 2;
      const previous = this.line.geometry;
      this.line.geometry = this.createGeometry(capacity);
      previous.dispose();
    }
    return this.segments.array as Float32Array;
  }

  private createGeometry(segments: number): LineGeometry {
    const geometry = new LineGeometry();
    geometry.setPositions(new Float32Array((segments + 1) * 3));
    this.segments = (geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute)
      .data as THREE.InstancedInterleavedBuffer;
    geometry.instanceCount = 0;
    return geometry;
  }
}

/** Draws event instants and intervals in one rendered trajectory line's frame. */
export class EventMarkers extends THREE.Object3D {
  readonly body: Body;
  /**
   * Interval emphasis strokes: gold for the selected span, the event's own
   * color for the hovered one. The owning TrajectoryLine still colors the
   * span; these depth-tested overlays only add width, so they belong in the
   * main (depth-tested) scene rather than this group's always-on-top pass.
   * The host adds both to that scene.
   */
  readonly spanEmphasis: Line2;
  readonly spanPreview: Line2;
  private visuals: MarkerVisual[] = [];
  private readonly options: EventMarkersOptions;
  private preview: { id: string; queryId: string } | null = null;
  private readonly selectedStroke: SpanStroke;
  private readonly previewStroke: SpanStroke;
  private readonly emphasisClock = new EmphasisClock();

  constructor(body: Body, options: EventMarkersOptions = {}) {
    super();
    this.body = body;
    this.name = `${body.name}_events`;
    this.options = options;
    this.selectedStroke = new SpanStroke(`${body.name}_selected_span`,
      options.selectedColor ?? SELECTED_COLOR, SELECTED_SPAN_OPACITY, -0.5);
    // The hovered span draws under a selected one where they overlap.
    this.previewStroke = new SpanStroke(`${body.name}_preview_span`,
      options.color ?? DEFAULT_COLOR, PREVIEW_SPAN_OPACITY, -0.6);
    this.spanEmphasis = this.selectedStroke.line;
    this.spanPreview = this.previewStroke.line;
  }

  setMarkers(markers: readonly EventMarker[]): void {
    this.rebuildVisuals(markers);
  }

  setPreview(preview: { id: string; queryId: string } | null): void {
    this.preview = preview;
    for (const visual of this.visuals) this.styleVisual(visual);
  }

  /**
   * Where a callout for this event attaches: the hovered cap, else the
   * representative point. A collapsed interval still anchors at its midpoint
   * sample even though only one glyph is drawn there.
   */
  anchorFor(id: string, queryId: string, boundary?: 'start' | 'end'): THREE.Vector3 | null {
    const visual = this.visuals.find((item) => item.marker.id === id && item.marker.queryId === queryId);
    if (!visual) return null;
    const index = boundary === 'start' ? 1 : boundary === 'end' ? 2 : 0;
    if (visual.marker.temporality === 'interval' && boundary && visual.layout !== 'point' &&
      visual.sprites[index]?.visible) {
      return visual.sprites[index].position.clone();
    }
    // Pieces of a split interval that do not own the midpoint leave the
    // anchor to the piece that does.
    if (!visual.present[0]) return null;
    if (visual.sprites[0]?.visible || visual.spriteBaseOpacity[0] > 0) return visual.sprites[0].position.clone();
    return visual.sprites.find((sprite) => sprite.visible)?.position.clone() ?? null;
  }

  /** An interval's trail-visible samples in world space (empty for instants). */
  visibleSpanPoints(id: string, queryId: string): THREE.Vector3[] {
    const visual = this.visuals.find((item) => item.marker.id === id && item.marker.queryId === queryId);
    if (!visual || visual.marker.temporality !== 'interval' || !visual.visibleRange) return [];
    const [start, end] = visual.visibleRange;
    return visual.points.filter((_, i) => visual.times[i] >= start && visual.times[i] <= end);
  }

  /** Current projected representation of an interval, for callout copy and tests. */
  layoutFor(id: string, queryId: string): IntervalLayout | null {
    return this.visuals.find((item) => item.marker.id === id && item.marker.queryId === queryId)?.layout ?? null;
  }

  private isPreview(marker: EventMarker): boolean {
    return this.preview?.id === marker.id && this.preview.queryId === marker.queryId;
  }

  /** Apply the same resolver and current vertex offset as the owning trajectory line. */
  update(
    scaleFactor: number,
    vertexOffset: readonly [number, number, number],
    resolvePosition: PositionResolver,
    visibleRange: readonly [number, number] | null = null,
    trailAlphaAt: (et: number) => number = () => 1,
    camera?: THREE.Camera,
    pixelRatio = 1,
    viewport?: EventMarkersViewport,
  ): void {
    // Glyphs are sized in CSS pixels, independent of window height and FOV.
    // Without a viewport (tests, offscreen callers) the options' markerSize applies.
    const perspective = camera as THREE.PerspectiveCamera | undefined;
    const scalePerPx = perspective?.isPerspectiveCamera && viewport && viewport.height > 0
      ? 2 * Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2) / (viewport.height * (perspective.zoom || 1))
      : null;
    const projected = new THREE.Vector3();
    for (const visual of this.visuals) {
      const { marker } = visual;
      visual.visibleRange = visibleRange;
      const inTrail = visibleRange !== null &&
        visual.pieceStart <= visibleRange[1] && visual.pieceEnd >= visibleRange[0];
      if (!inTrail) {
        for (let i = 0; i < visual.sprites.length; i++) {
          visual.spriteBaseOpacity[i] = 0;
          visual.sprites[i].visible = false;
        }
        continue;
      }
      if (!visual.framePositions) {
        const positions: Array<[number, number, number]> = [];
        try {
          for (const et of visual.times) {
            const position = resolvePosition(this.body.name, et);
            if (!position.every(Number.isFinite)) throw new Error('event position is outside trajectory coverage');
            positions.push(position);
          }
          visual.framePositions = positions;
        } catch {
          visual.visibleRange = null;
          for (let i = 0; i < visual.sprites.length; i++) {
            visual.spriteBaseOpacity[i] = 0;
            visual.sprites[i].visible = false;
          }
          continue;
        }
      }

      const positions = visual.framePositions;
      const clipStart = visibleRange![0];
      const clipEnd = visibleRange![1];
      if (visual.points.length !== positions.length) {
        visual.points = positions.map(() => new THREE.Vector3());
      }
      for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        visual.points[i].set(
          (pos[0] + vertexOffset[0]) * scaleFactor,
          (pos[1] + vertexOffset[1]) * scaleFactor,
          (pos[2] + vertexOffset[2]) * scaleFactor,
        );
      }
      visual.layout = marker.temporality === 'interval' && camera && viewport
        ? intervalLayoutForPixels(this.projectedVisibleLength(visual, camera, viewport, projected))
        : 'full';
      for (let i = 0; i < visual.sprites.length; i++) {
        const sampleIndex = visual.spriteSampleIndices[i];
        visual.spriteEpochs[i] = visual.times[sampleIndex];
        visual.sprites[i].position.copy(visual.points[sampleIndex]);
        if (scalePerPx !== null) {
          const scale = visual.spriteSizePx[i] * scalePerPx;
          visual.sprites[i].scale.set(scale, scale, 1);
        }
        glyphUniforms(visual.sprites[i].material as THREE.SpriteMaterial).eventGlyphDpr.value = pixelRatio;
        const alpha = marker.selected || this.isPreview(marker) ? 1 : trailAlphaAt(visual.times[sampleIndex]);
        const inRange = visual.times[sampleIndex] >= clipStart && visual.times[sampleIndex] <= clipEnd;
        visual.spriteBaseOpacity[i] = inRange && visual.present[i] ? alpha : 0;
        // A collapsed interval keeps the anchor opacity of its hidden glyphs
        // (callouts still attach there) but draws none of them.
        const drawn = marker.temporality !== 'interval' ||
          (i === 0 ? visual.layout !== 'caps' : visual.layout !== 'point');
        (visual.sprites[i].material as THREE.SpriteMaterial).opacity = visual.spriteBaseOpacity[i];
        visual.sprites[i].visible = drawn && visual.spriteBaseOpacity[i] > 0;
        if (camera && marker.temporality === 'interval' && i > 0) {
          const neighbor = i === 1 ? 1 : visual.points.length - 2;
          const a = visual.points[sampleIndex].clone().project(camera);
          const b = visual.points[neighbor].clone().project(camera);
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          if (dx * dx + dy * dy > 1e-12) {
            (visual.sprites[i].material as THREE.SpriteMaterial).rotation = Math.atan2(dy, dx);
          }
        }
      }
    }
    this.updateSpanEmphasis();
  }

  /**
   * Rewrite both interval strokes from the drawn trail. Each eases in when its
   * event changes and keeps tracing the old span while it eases out.
   */
  private updateSpanEmphasis(): void {
    const dt = this.emphasisClock.tick();
    const drawable = (visual: MarkerVisual) =>
      visual.marker.temporality === 'interval' && visual.visibleRange !== null && visual.layout !== 'point';
    const selected = this.visuals.find((visual) => visual.marker.selected && drawable(visual));
    const preview = this.visuals.find((visual) =>
      !visual.marker.selected && this.isPreview(visual.marker) && drawable(visual));
    this.drawStroke(this.selectedStroke, selected, dt);
    this.drawStroke(this.previewStroke, preview, dt);
  }

  private drawStroke(stroke: SpanStroke, target: MarkerVisual | undefined, dt: number): void {
    const key = stroke.follow(target ? markerKey(target.marker) : null, dt);
    const visual = key === null ? undefined : this.visuals.find((item) =>
      markerKey(item.marker) === key && item.visibleRange !== null && item.layout !== 'point');
    let segments = 0;
    if (visual) {
      if (stroke === this.previewStroke) stroke.setColor(visual.marker.color ?? this.options.color ?? DEFAULT_COLOR);
      const { line, start, end } = this.drawnSpan(visual);
      segments = stroke.write(line.count + 2, (emit) => traceRange(line, start, end, emit));
    }
    stroke.show(this.visible && segments > 0, segments);
  }

  /**
   * The polyline an interval is drawn along and the epochs of it this visual
   * covers. With a trail that is the trail's own vertices (cut at the piece
   * bounds, reaching the live head sample), so the stroke, picking, and hit
   * anchoring all agree with what is on screen; otherwise the interval's
   * samples, cut at the trail's visible range.
   */
  private drawnSpan(visual: MarkerVisual): { line: Polyline; start: number; end: number } {
    const trail = this.options.trail?.();
    if (trail) return { line: trailPolyline(trail), start: visual.pieceStart, end: visual.pieceEnd };
    const range = visual.visibleRange ?? [Infinity, -Infinity];
    return {
      line: { count: visual.points.length, time: (i) => visual.times[i], at: (i, out) => out.copy(visual.points[i]) },
      start: Math.max(visual.pieceStart, range[0]),
      end: Math.min(visual.pieceEnd, range[1]),
    };
  }

  /**
   * Where the drawn span of an interval is at `et` (e.g. where the pointer
   * hit it), or null if this line does not draw that epoch right now.
   */
  anchorAt(id: string, queryId: string, et: number): THREE.Vector3 | null {
    for (const visual of this.visuals) {
      if (visual.marker.id !== id || visual.marker.queryId !== queryId || !visual.visibleRange) continue;
      const { line, start, end } = this.drawnSpan(visual);
      if (et < start || et > end) continue;
      const point = polylineAt(line, et, new THREE.Vector3());
      if (point) return point;
    }
    return null;
  }

  /** Called after camera movement, immediately before the final marker pass. */
  applyAnchorOpacity(opacityAt: (anchor: THREE.Vector3) => number): void {
    for (const visual of this.visuals) {
      for (let i = 0; i < visual.sprites.length; i++) {
        const sprite = visual.sprites[i];
        const baseOpacity = visual.spriteBaseOpacity[i];
        const drawn = visual.marker.temporality !== 'interval' ||
          (i === 0 ? visual.layout !== 'caps' : visual.layout !== 'point');
        if (!(baseOpacity > 0) || !drawn) {
          sprite.visible = false;
          continue;
        }
        const opacity = baseOpacity * opacityAt(sprite.position);
        (sprite.material as THREE.SpriteMaterial).opacity = opacity;
        sprite.visible = opacity > 0.01;
      }
    }
  }

  /**
   * Hide ordinary event glyphs that land on top of one already drawn (within
   * `minSeparationPx`), so dozens of results seen edge-on stay one calm mark
   * instead of a pile of overprinted outlines. Selected and previewed glyphs
   * always draw and always claim their spot. `occupied` is shared across
   * groups; call with `emphasized` true for every group first, then false.
   */
  thinCoincidentGlyphs(
    camera: THREE.Camera,
    viewport: EventMarkersViewport,
    occupied: Map<string, Array<[number, number]>>,
    emphasized: boolean,
    minSeparationPx = 10,
  ): void {
    const cell = minSeparationPx;
    const projected = new THREE.Vector3();
    for (const visual of this.visuals) {
      const isEmphasized = !!visual.marker.selected || this.isPreview(visual.marker);
      if (isEmphasized !== emphasized) continue;
      const sprite = visual.sprites[0];
      if (!sprite?.visible) continue;
      projected.copy(sprite.position).project(camera);
      if (projected.z < -1 || projected.z > 1) continue;
      const x = (projected.x + 1) * viewport.width / 2;
      const y = (1 - projected.y) * viewport.height / 2;
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      let covered = false;
      for (let dx = -1; dx <= 1 && !covered && !emphasized; dx++) {
        for (let dy = -1; dy <= 1 && !covered; dy++) {
          covered = (occupied.get(`${cx + dx}:${cy + dy}`) ?? [])
            .some(([ox, oy]) => (ox - x) ** 2 + (oy - y) ** 2 < minSeparationPx * minSeparationPx);
        }
      }
      if (covered) {
        sprite.visible = false;
        continue;
      }
      const key = `${cx}:${cy}`;
      const list = occupied.get(key);
      if (list) list.push([x, y]);
      else occupied.set(key, [[x, y]]);
    }
  }

  /** Nearest visible sprite in canvas pixels, including distance for cross-arc picking. */
  pick(
    camera: THREE.Camera,
    screenX: number,
    screenY: number,
    width: number,
    height: number,
    radiusPx = 11,
    accept: (worldPosition: THREE.Vector3) => boolean = () => true,
  ): EventMarkerHit | null {
    let nearest: EventMarkerHit | null = null;
    const radiusSq = radiusPx * radiusPx;
    const projected = new THREE.Vector3();
    for (const visual of this.visuals) {
      for (let i = 0; i < visual.sprites.length; i++) {
        const sprite = visual.sprites[i];
        if (!sprite.visible) continue;
        projected.copy(sprite.position).project(camera);
        if (projected.z < -1 || projected.z > 1) continue;
        const dx = (projected.x + 1) * width / 2 - screenX;
        const dy = (1 - projected.y) * height / 2 - screenY;
        const d2 = dx * dx + dy * dy;
        if (d2 > radiusSq) continue;
        if (!accept(sprite.position)) continue;
        // A selected sprite renders above the others. At identical positions,
        // choose the glyph the user actually sees on top.
        const hit: EventMarkerHit = {
          marker: visual.marker,
          et: visual.spriteEpochs[i],
          boundary: i === 1 ? 'start' : i === 2 ? 'end' : undefined,
          distanceSq: d2,
          renderOrder: sprite.renderOrder,
          worldPosition: sprite.position.clone(),
        };
        if (!nearest || d2 < nearest.distanceSq - 1 ||
          (Math.abs(d2 - nearest.distanceSq) <= 1 && sprite.renderOrder >= nearest.renderOrder)) {
          nearest = hit;
        }
      }
    }
    // Spans only when no glyph is under the pointer.
    if (nearest) return nearest;
    // Test the polyline actually drawn (the trail, cut at the piece bounds),
    // so every visible bit of a span is pickable, including the stretch
    // between the last coarse sample and the trail head.
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (const visual of this.visuals) {
      if (visual.marker.temporality !== 'interval' || !visual.visibleRange) continue;
      const renderOrder = visual.marker.selected || this.isPreview(visual.marker) ? 3 : 1;
      const { line, start, end } = this.drawnSpan(visual);
      let aEt = NaN;
      let aIn = false;
      traceRange(line, start, end, (point, bEt) => {
        b.copy(point).project(camera);
        const bIn = b.z >= -1 && b.z <= 1;
        if (aIn && bIn) {
          const ax = (a.x + 1) * width / 2;
          const ay = (1 - a.y) * height / 2;
          const dx = (b.x - a.x) * width / 2;
          const dy = (a.y - b.y) * height / 2;
          const fraction = Math.max(0, Math.min(1, ((screenX - ax) * dx + (screenY - ay) * dy) / (dx * dx + dy * dy || 1)));
          const d2 = (ax + dx * fraction - screenX) ** 2 + (ay + dy * fraction - screenY) ** 2;
          const et = aEt + (bEt - aEt) * fraction;
          if (d2 <= radiusSq && (!nearest || d2 < nearest.distanceSq)) {
            const worldPosition = polylineAt(line, et, new THREE.Vector3()) ?? point.clone();
            const hit: EventMarkerHit = { marker: visual.marker, et, distanceSq: d2, renderOrder, worldPosition, span: true };
            if (accept(worldPosition) && preferHit(hit, nearest)) nearest = hit;
          }
        }
        a.copy(b);
        aEt = bEt;
        aIn = bIn;
      });
    }
    return nearest;
  }

  dispose(): void {
    this.clearVisuals();
    this.selectedStroke.dispose();
    this.previewStroke.dispose();
  }

  /** Screen length of the drawn part of an interval, in CSS pixels. */
  private projectedVisibleLength(
    visual: MarkerVisual,
    camera: THREE.Camera,
    viewport: EventMarkersViewport,
    scratch: THREE.Vector3,
  ): number {
    const range = visual.visibleRange;
    if (!range) return 0;
    let first = -1;
    let last = -1;
    for (let i = 0; i < visual.times.length; i++) {
      if (visual.times[i] < range[0] || visual.times[i] > range[1]) continue;
      if (first < 0) first = i;
      last = i;
    }
    if (first < 0 || last <= first) return 0;
    scratch.copy(visual.points[first]).project(camera);
    const ax = scratch.x * viewport.width / 2;
    const ay = scratch.y * viewport.height / 2;
    const az = scratch.z;
    scratch.copy(visual.points[last]).project(camera);
    if (az > 1 || scratch.z > 1) return Infinity;
    return Math.hypot(scratch.x * viewport.width / 2 - ax, scratch.y * viewport.height / 2 - ay);
  }

  private styleVisual(visual: MarkerVisual): void {
    const marker = visual.marker;
    const preview = this.isPreview(marker);
    const state = GLYPH_STATE[marker.selected ? 'selected' : preview ? 'preview' : 'default'];
    const color = marker.selected ? this.options.selectedColor ?? SELECTED_COLOR : marker.color ?? this.options.color ?? DEFAULT_COLOR;
    // Fallback world-unit size for callers that do not pass a viewport.
    const unitsPerPx = (this.options.markerSize ?? 0.021) / DIAMOND_QUAD_PX;
    for (let i = 0; i < visual.sprites.length; i++) {
      const sprite = visual.sprites[i];
      const material = sprite.material as THREE.SpriteMaterial;
      material.color.set(color);
      const uniforms = glyphUniforms(material);
      const diamond = i === 0;
      uniforms.eventGlyphKind.value = diamond ? 0 : 1;
      uniforms.eventGlyphFill.value = diamond ? state.fill : 0;
      uniforms.eventGlyphStrokeCssPx.value = diamond ? state.diamondStroke : state.capStroke;
      const basePx = !diamond ? CAP_QUAD_PX
        : marker.temporality === 'interval' ? INTERVAL_DIAMOND_QUAD_PX : DIAMOND_QUAD_PX;
      visual.spriteSizePx[i] = basePx * state.scale;
      const scale = visual.spriteSizePx[i] * unitsPerPx;
      sprite.scale.set(scale, scale, 1);
      sprite.renderOrder = marker.selected ? 4 : preview ? 3 : 2;
    }
  }

  private rebuildVisuals(markers: readonly EventMarker[]): void {
    this.clearVisuals();
    const markerSize = this.options.markerSize ?? 0.021;
    const intervalSamples = Math.max(2, Math.floor(this.options.intervalSamples ?? 65));

    for (const marker of markers) {
      const color = marker.selected
        ? (this.options.selectedColor ?? SELECTED_COLOR)
        : (marker.color ?? this.options.color ?? DEFAULT_COLOR);
      const visual: MarkerVisual = {
        marker: { ...marker },
        times: [],
        framePositions: null,
        sprites: [],
        spriteSampleIndices: [],
        spriteEpochs: [],
        spriteBaseOpacity: [],
        spriteSizePx: [],
        points: [],
        visibleRange: null,
        layout: 'full',
        present: [],
        pieceStart: marker.pieceStartEt ?? marker.startEt,
        pieceEnd: marker.pieceEndEt ?? marker.endEt,
      };

      if (marker.temporality === 'instant') {
        visual.times = [marker.startEt];
        visual.sprites.push(this.makeSprite(
          eventGlyphShape(marker.glyph ?? 'diamond'),
          color,
          markerSize,
          `${marker.kind}_${marker.id}`,
        ));
        visual.spriteSampleIndices.push(0);
        visual.present.push(true);
      } else {
        // Sample this line's piece; the event's midpoint is always a sample
        // on the piece that owns it, so its glyph sits exactly there.
        const { pieceStart, pieceEnd } = visual;
        const duration = pieceEnd - pieceStart;
        visual.times = Array.from(
          { length: intervalSamples },
          (_, i) => pieceStart + duration * i / (intervalSamples - 1),
        );
        const midpoint = (marker.startEt + marker.endEt) / 2;
        // A midpoint on a shared arc boundary belongs to the later piece.
        const ownsMidpoint = midpoint >= pieceStart && (midpoint < pieceEnd || pieceEnd >= marker.endEt);
        let midIndex = 0;
        if (ownsMidpoint) {
          midIndex = visual.times.findIndex((t) => t >= midpoint);
          if (Math.abs(visual.times[midIndex] - midpoint) > duration * 1e-9) visual.times.splice(midIndex, 0, midpoint);
        }
        visual.sprites.push(this.makeSprite(
          eventGlyphShape(marker.glyph ?? 'diamond'),
          color,
          markerSize,
          `${marker.kind}_${marker.id}_midpoint`,
        ));
        visual.sprites.push(
          this.makeSprite('cap', color, markerSize, `${marker.kind}_${marker.id}_start`),
          this.makeSprite('cap', color, markerSize, `${marker.kind}_${marker.id}_end`),
        );
        visual.spriteSampleIndices.push(midIndex, 0, visual.times.length - 1);
        visual.present.push(ownsMidpoint, pieceStart <= marker.startEt, pieceEnd >= marker.endEt);
      }

      this.styleVisual(visual);
      for (const sprite of visual.sprites) this.add(sprite);
      this.visuals.push(visual);
    }
  }

  private makeSprite(
    shape: GlyphShape,
    color: THREE.ColorRepresentation,
    size: number,
    name: string,
  ): THREE.Sprite {
    const material = new THREE.SpriteMaterial({
      color,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: false,
    });
    const uniforms: GlyphUniforms = {
      eventGlyphKind: { value: shape === 'cap' ? 1 : 0 },
      eventGlyphFill: { value: 0 },
      eventGlyphStrokeCssPx: { value: 1.6 },
      eventGlyphDpr: { value: 1 },
    };
    material.userData.eventGlyphUniforms = uniforms;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'varying vec2 vEventUv;\nvoid main() {\n  vEventUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', `${EVENT_GLYPH_DECLARATIONS}\nvoid main() {`)
        .replace('#include <map_fragment>', EVENT_GLYPH_FRAGMENT);
    };
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(size, size, 1);
    sprite.name = name;
    sprite.visible = false;
    sprite.renderOrder = 2;
    return sprite;
  }

  private clearVisuals(): void {
    for (const visual of this.visuals) {
      for (const sprite of visual.sprites) {
        this.remove(sprite);
        (sprite.material as THREE.Material).dispose();
      }
    }
    this.visuals = [];
  }

}

/** Compare hits across every trajectory arc before choosing a scene result. */
export function pickEventMarkerGroups(
  groups: Iterable<EventMarkers>,
  camera: THREE.Camera,
  screenX: number,
  screenY: number,
  width: number,
  height: number,
  radiusPx = 11,
): EventMarkerHit | null {
  let nearest: EventMarkerHit | null = null;
  for (const group of groups) {
    if (!group.visible) continue;
    const hit = group.pick(camera, screenX, screenY, width, height, radiusPx);
    if (hit && preferHit(hit, nearest)) nearest = hit;
  }
  return nearest;
}

/** First vertex index whose time is >= `target` (`line.count` if none). */
function lowerBound(line: Polyline, target: number): number {
  let lo = 0;
  let hi = line.count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (line.time(mid) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
