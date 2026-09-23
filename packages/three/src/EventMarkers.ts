import * as THREE from 'three';
import type { Body, GeometryEvent } from '@cosmolabe/core';
import type { PositionResolver } from './TrajectoryLine.js';

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
}

export interface EventMarkerHit {
  marker: EventMarker;
  et: number;
  distanceSq: number;
  renderOrder: number;
  boundary?: 'start' | 'end';
  worldPosition: THREE.Vector3;
}

/** @deprecated Event kinds are open strings; use `EventMarker['kind']`. */
export type EventMarkerType = EventMarker['kind'];

export interface EventMarkersOptions {
  markerSize?: number;
  intervalSamples?: number;
  color?: THREE.ColorRepresentation;
  selectedColor?: THREE.ColorRepresentation;
}

interface MarkerVisual {
  marker: EventMarker;
  times: number[];
  framePositions: Array<[number, number, number]> | null;
  sprites: THREE.Sprite[];
  spriteSampleIndices: number[];
  spriteEpochs: number[];
  spriteBaseOpacity: number[];
  points: THREE.Vector3[];
  visibleRange: readonly [number, number] | null;
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

/** Draws event instants and intervals in one rendered trajectory line's frame. */
export class EventMarkers extends THREE.Object3D {
  readonly body: Body;
  private visuals: MarkerVisual[] = [];
  private readonly options: EventMarkersOptions;
  private preview: { id: string; queryId: string } | null = null;

  constructor(body: Body, options: EventMarkersOptions = {}) {
    super();
    this.body = body;
    this.name = `${body.name}_events`;
    this.options = options;
  }

  setMarkers(markers: readonly EventMarker[]): void {
    this.rebuildVisuals(markers);
  }

  setPreview(preview: { id: string; queryId: string } | null): void {
    this.preview = preview;
    for (const visual of this.visuals) this.styleVisual(visual);
  }

  anchorFor(id: string, queryId: string, boundary?: 'start' | 'end'): THREE.Vector3 | null {
    const visual = this.visuals.find((item) => item.marker.id === id && item.marker.queryId === queryId);
    const cap = boundary === 'start' ? visual?.sprites[1] : boundary === 'end' ? visual?.sprites[2] : null;
    return (cap?.visible ? cap : visual?.sprites.find((sprite) => sprite.visible))?.position.clone() ?? null;
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
  ): void {
    for (const visual of this.visuals) {
      const { marker } = visual;
      visual.visibleRange = visibleRange;
      const inTrail = visibleRange !== null &&
        marker.startEt <= visibleRange[1] && marker.endEt >= visibleRange[0];
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
      for (let i = 0; i < visual.sprites.length; i++) {
        const sampleIndex = visual.spriteSampleIndices[i];
        visual.spriteEpochs[i] = visual.times[sampleIndex];
        visual.sprites[i].position.copy(visual.points[sampleIndex]);
        glyphUniforms(visual.sprites[i].material as THREE.SpriteMaterial).eventGlyphDpr.value = pixelRatio;
        const alpha = marker.selected || this.isPreview(marker) ? 1 : trailAlphaAt(visual.times[sampleIndex]);
        const inRange = visual.times[sampleIndex] >= clipStart && visual.times[sampleIndex] <= clipEnd;
        visual.spriteBaseOpacity[i] = inRange ? alpha : 0;
        (visual.sprites[i].material as THREE.SpriteMaterial).opacity = visual.spriteBaseOpacity[i];
        visual.sprites[i].visible = visual.spriteBaseOpacity[i] > 0;
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
  }

  /** Called after camera movement, immediately before the final marker pass. */
  applyAnchorOpacity(opacityAt: (anchor: THREE.Vector3) => number): void {
    for (const visual of this.visuals) {
      for (let i = 0; i < visual.sprites.length; i++) {
        const sprite = visual.sprites[i];
        const baseOpacity = visual.spriteBaseOpacity[i];
        if (!(baseOpacity > 0)) {
          sprite.visible = false;
          continue;
        }
        const opacity = baseOpacity * opacityAt(sprite.position);
        (sprite.material as THREE.SpriteMaterial).opacity = opacity;
        sprite.visible = opacity > 0.01;
      }
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
        if (!nearest || d2 < nearest.distanceSq - 1 ||
          (Math.abs(d2 - nearest.distanceSq) <= 1 && sprite.renderOrder >= nearest.renderOrder)) {
          nearest = {
            marker: visual.marker,
            et: visual.spriteEpochs[i],
            boundary: i === 1 ? 'start' : i === 2 ? 'end' : undefined,
            distanceSq: d2,
            renderOrder: sprite.renderOrder,
            worldPosition: sprite.position.clone(),
          };
        }
      }
      if (visual.marker.temporality !== 'interval' || !visual.visibleRange) continue;
      for (let i = 1; i < visual.points.length; i++) {
        const aEt = visual.times[i - 1];
        const bEt = visual.times[i];
        if (aEt < visual.visibleRange[0] || bEt > visual.visibleRange[1]) continue;
        const a = visual.points[i - 1].clone().project(camera);
        const b = visual.points[i].clone().project(camera);
        if (a.z < -1 || a.z > 1 || b.z < -1 || b.z > 1) continue;
        const ax = (a.x + 1) * width / 2;
        const ay = (1 - a.y) * height / 2;
        const dx = (b.x - a.x) * width / 2;
        const dy = (a.y - b.y) * height / 2;
        const fraction = Math.max(0, Math.min(1, ((screenX - ax) * dx + (screenY - ay) * dy) / (dx * dx + dy * dy || 1)));
        const d2 = (ax + dx * fraction - screenX) ** 2 + (ay + dy * fraction - screenY) ** 2;
        if (d2 > radiusSq) continue;
        const worldPosition = visual.points[i - 1].clone().lerp(visual.points[i], fraction);
        if (!accept(worldPosition)) continue;
        const renderOrder = visual.marker.selected || this.isPreview(visual.marker) ? 3 : 1;
        if (!nearest || d2 < nearest.distanceSq - 1 ||
          (Math.abs(d2 - nearest.distanceSq) <= 1 && renderOrder > nearest.renderOrder)) {
          nearest = { marker: visual.marker, et: aEt + (bEt - aEt) * fraction,
            distanceSq: d2, renderOrder,
            worldPosition };
        }
      }
    }
    return nearest;
  }

  dispose(): void {
    this.clearVisuals();
  }

  private styleVisual(visual: MarkerVisual): void {
    const marker = visual.marker;
    const preview = this.isPreview(marker);
    const color = marker.selected ? this.options.selectedColor ?? SELECTED_COLOR : marker.color ?? this.options.color ?? DEFAULT_COLOR;
    const size = this.options.markerSize ?? 0.021;
    for (let i = 0; i < visual.sprites.length; i++) {
      const sprite = visual.sprites[i];
      const material = sprite.material as THREE.SpriteMaterial;
      material.color.set(color);
      const uniforms = glyphUniforms(material);
      uniforms.eventGlyphKind.value = i === 0 ? 0 : 1;
      uniforms.eventGlyphFill.value = i === 0 ? marker.selected ? 0.28 : preview ? 0.18 : 0 : 0;
      uniforms.eventGlyphStrokeCssPx.value = marker.selected || preview ? 1.85 : 1.6;
      const scale = i === 0 ? size * (marker.selected ? 1.08 : preview ? 1.18 : 1) : size * (marker.selected || preview ? 0.82 : 0.7);
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
        points: [],
        visibleRange: null,
      };

      if (marker.temporality === 'instant') {
        visual.times = [marker.startEt];
        visual.sprites.push(this.makeSprite(
          eventGlyphShape(marker.glyph ?? 'diamond'),
          color,
          marker.selected ? markerSize * 1.28 : markerSize,
          `${marker.kind}_${marker.id}`,
        ));
        visual.spriteSampleIndices.push(0);
      } else {
        const duration = marker.endEt - marker.startEt;
        visual.times = Array.from(
          { length: intervalSamples },
          (_, i) => marker.startEt + duration * i / (intervalSamples - 1),
        );
        visual.sprites.push(this.makeSprite(
          eventGlyphShape(marker.glyph ?? 'diamond'),
          color,
          marker.selected ? markerSize * 1.08 : markerSize * 0.92,
          `${marker.kind}_${marker.id}_midpoint`,
        ));
        visual.spriteSampleIndices.push(Math.floor((intervalSamples - 1) / 2));
        visual.sprites.push(
          this.makeSprite('cap', color, markerSize * 0.72, `${marker.kind}_${marker.id}_start`),
          this.makeSprite('cap', color, markerSize * 0.72, `${marker.kind}_${marker.id}_end`),
        );
        visual.spriteSampleIndices.push(0, intervalSamples - 1);
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
    if (!hit) continue;
    if (!nearest || hit.distanceSq < nearest.distanceSq - 1 ||
      (Math.abs(hit.distanceSq - nearest.distanceSq) <= 1 && hit.renderOrder > nearest.renderOrder)) {
      nearest = hit;
    }
  }
  return nearest;
}
