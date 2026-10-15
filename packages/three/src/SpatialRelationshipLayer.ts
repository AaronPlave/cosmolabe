import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { endpointLabel, formatSpatialDistance, formatSpatialSpeed, referenceVectorLabel, resolveSpatialEndpoint, resolveSpatialRelationship, type ResolvedSpatialRelationship, type SpatialEndpoint, type SpatialRelationship, type Universe } from '@cosmolabe/core';
import { EventCallout, type CalloutObstacles, type ScreenRect } from './EventCallout.js';
import { clipSegmentInFront } from './EventMarkers.js';
import { MeasurementArrow } from './MeasurementArrow.js';

export interface SpatialInteraction {
  /** Consume an endpoint-pick gesture, including a miss, before any scene selection. */
  beforePick: (x: number, y: number) => boolean;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  picking: () => boolean;
  /** A surface endpoint pick shares the Point Probe cursor and frame-time budget. */
  surfacePicking?: () => boolean;
  onOpenEditor?: (id: string) => void;
  onClearSelection?: () => void;
  labelIcon?: (kind: SpatialRelationship['kind']) => SVGSVGElement;
  previewIntervalMs?: () => number;
  preview?: (x: number, y: number) => void;
  clearPreview?: () => void;
}
interface Visual {
  kind: SpatialRelationship['kind'];
  group: THREE.Group;
  stroke: Stroke;
  arc: Stroke;
  marks: THREE.Points;
  arrow?: MeasurementArrow;
  /** Frame axes: one stroke and one tip letter per axis, X, Y, Z. */
  axes?: Array<{ stroke: Stroke; letter: HTMLSpanElement }>;
  callout: EventCallout;
  label: HTMLButtonElement;
  labelSize: { width: number; height: number };
  labelObserver: ResizeObserver | null;
  labelText: string;
  labelCandidate?: number;
  labelValue: HTMLSpanElement;
  hitSegments: THREE.Vector3[];
  box: ScreenRect | null;
}

/** One relationship's world-space geometry and wording for the current view. */
interface Shape {
  segments: THREE.Vector3[];
  arc: THREE.Vector3[];
  axes: THREE.Vector3[][];
  /** Picked as geometry but not drawn by the main stroke (an arrow's cone). */
  pickExtra: THREE.Vector3[];
  marks: THREE.Vector3[];
  /** Tip kept clear of compact labels, as an arrowhead is. */
  tip?: THREE.Vector3;
  anchor: THREE.Vector3;
  labelAnchor: THREE.Vector3;
  /** Where the compact label goes when its anchor is off screen (an angle's vertex). */
  labelFallback?: THREE.Vector3;
  compact: string;
  title: string;
  detail: string;
  /** Faint legs leave the arc as the angle's subject. */
  faintSegments?: boolean;
}

/** Muted versions of the body-axes convention: red X, green Y, blue Z. Letters carry the same meaning. */
export const AXIS_COLORS = ['#cf8a7c', '#93bd84', '#84a8d6'] as const;
const KIND_NAMES: Record<SpatialRelationship['kind'], string> = {
  distance: 'distance measurement', direction: 'direction measurement', angle: 'angle measurement',
  velocity: 'velocity', axes: 'frame axes', 'vector-angle': 'angle between directions',
};

/** Fixed-capacity fat segments: actual CSS-pixel width, not WebGL's ignored linewidth. */
class Stroke {
  readonly line: LineSegments2;
  readonly material: LineMaterial;
  private readonly buffer: THREE.InstancedInterleavedBuffer;
  width = 1.5;
  readonly halo?: LineSegments2;
  constructor(contrast = false) {
    const geometry = new LineSegmentsGeometry().setPositions(new Float32Array(128 * 6));
    this.buffer = (geometry.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute).data as THREE.InstancedInterleavedBuffer;
    this.material = new LineMaterial({ color: '#82aabd', linewidth: 1.5, transparent: true, depthTest: false, depthWrite: false, worldUnits: false });
    this.line = new LineSegments2(geometry, this.material);
    this.line.frustumCulled = false;
    this.line.renderOrder = 100;
    this.line.onBeforeRender = renderer => {
      renderer.getDrawingBufferSize(this.material.resolution);
      this.material.linewidth = this.width * renderer.getPixelRatio();
    };
    if (contrast) {
      const material = new LineMaterial({ color: '#06090c', transparent: true, opacity: 0.5, depthTest: false, depthWrite: false, worldUnits: false });
      this.halo = new LineSegments2(geometry, material);
      this.halo.frustumCulled = false; this.halo.renderOrder = 99;
      this.halo.onBeforeRender = renderer => {
        renderer.getDrawingBufferSize(material.resolution);
        material.linewidth = (this.width + 1.3) * renderer.getPixelRatio();
      };
    }
  }
  write(points: readonly THREE.Vector3[], origin: THREE.Vector3): void {
    const data = this.buffer.array;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      data[i * 3] = p.x - origin.x; data[i * 3 + 1] = p.y - origin.y; data[i * 3 + 2] = p.z - origin.z;
    }
    this.line.geometry.instanceCount = points.length / 2;
    this.buffer.needsUpdate = true;
    this.line.visible = points.length > 0;
    if (this.halo) this.halo.visible = this.line.visible;
  }
  dispose(): void { this.line.geometry.dispose(); this.material.dispose(); this.halo?.material.dispose(); }
}

/** Scene rendering and forgiving screen-space picking for saved measurements. */
export class SpatialRelationshipLayer {
  private readonly root = new THREE.Group();
  private readonly visuals = new Map<string, Visual>();
  private relationships: readonly SpatialRelationship[] = [];
  private interaction: SpatialInteraction | null = null;
  private readonly ring = hollowMarkerTexture();
  private readonly feedback = new THREE.Points(pointGeometry(4), new THREE.PointsMaterial({ color: '#e4ebef', size: 12, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95, map: this.ring }));
  private previewEndpoint: SpatialEndpoint | null = null;
  private draftEndpoints: readonly SpatialEndpoint[] = [];
  private visible = true;

  constructor(
    private readonly universe: Universe,
    private readonly scaleFactor: number,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
    private readonly calloutContainer: HTMLElement,
    private readonly obstacles: () => CalloutObstacles,
    /** A body's axes length in km, as its mesh draws it (`BodyMesh.axesLengthKm`). */
    private readonly bodyAxesLengthKm: (bodyName: string) => number | undefined = () => undefined,
  ) {
    this.root.layers.set(2);
    this.feedback.layers.set(2); this.feedback.renderOrder = 104; this.feedback.frustumCulled = false;
    this.root.add(this.feedback);
  }
  setPickPreview(endpoint: SpatialEndpoint | null): void { this.previewEndpoint = endpoint; }
  setDraftEndpoints(endpoints: readonly SpatialEndpoint[]): void { this.draftEndpoints = endpoints; }
  setVisible(visible: boolean): void {
    this.visible = visible; this.root.visible = visible;
    if (!visible) for (const visual of this.visuals.values()) {
      visual.callout.hide(); visual.label.style.display = 'none'; visual.box = null;
      for (const axis of visual.axes ?? []) axis.letter.style.display = 'none';
    }
  }
  attach(scene: THREE.Scene): void { scene.add(this.root); }
  setInteraction(interaction: SpatialInteraction): void { this.interaction = interaction; }
  setRelationships(relationships: readonly SpatialRelationship[]): void {
    this.relationships = relationships;
    const kinds = new Map(relationships.map(r => [r.id, r.kind]));
    for (const [id, visual] of this.visuals) {
      // An edit can change kind while keeping identity. Recreate kind-specific objects.
      if (kinds.get(id) !== visual.kind) this.remove(id, visual);
    }
  }
  /** Cards/labels outrank geometry. On near-equal strokes, keep the current selection. */
  pick(x: number, y: number, radius = 9): string | null {
    const hits: Array<{ id: string; distance: number }> = [];
    for (const item of this.relationships) {
      const v = this.visuals.get(item.id);
      if (!v?.group.visible) continue;
      if (v.box && x >= v.box.x0 && x <= v.box.x1 && y >= v.box.y0 && y <= v.box.y1) return item.id;
      const distance = projectedStrokeDistance(v.hitSegments, this.camera, this.canvas.clientWidth, this.canvas.clientHeight, x, y);
      if (distance <= radius) hits.push({ id: item.id, distance });
    }
    return nearestMeasurementHit(hits, this.relationships.find(r => r.selected)?.id ?? null);
  }

  update(et: number, originKm: readonly [number, number, number]): ScreenRect[] {
    const occupied: ScreenRect[] = [];
    if (!this.visible) return occupied;
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
    const origin = this.camera.position;
    const forward = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 2).negate().normalize();
    const plane = { origin, forward, minDepth: this.camera.near * 10 };
    const clip = (points: readonly THREE.Vector3[]) => {
      const result: THREE.Vector3[] = [];
      for (let i = 0; i < points.length; i += 2) {
        const a = points[i].clone(), b = points[i + 1].clone();
        if (clipSegmentInFront(a, b, plane)) result.push(a, b);
      }
      return result;
    };
    const base = this.obstacles();
    const point = (p: readonly number[]) => new THREE.Vector3((p[0] - originKm[0]) * this.scaleFactor, (p[1] - originKm[1]) * this.scaleFactor, (p[2] - originKm[2]) * this.scaleFactor);
    const shapes = new Map<string, Shape | null>();
    const resolution = new Map(); // One frame's positions, shared by every overlay.
    for (const r of this.relationships) {
      const resolved = r.visible === false ? null : resolveSpatialRelationship(this.universe, r, et, resolution);
      shapes.set(r.id, resolved ? this.shape(resolved, point, height) : null);
    }
    const geometryPaths: number[][] = [];
    const arrowheads: ScreenRect[] = [];
    // Reserve the actual strokes/cones before placing any compact label, including
    // geometry whose own label is later suppressed. This keeps priority predictable.
    for (const shape of shapes.values()) {
      if (!shape) continue;
      const projectedTip = shape.tip && projectAnchor(shape.tip, this.camera, width, height);
      if (projectedTip) arrowheads.push({ x0: projectedTip.x - 10, y0: projectedTip.y - 10, x1: projectedTip.x + 10, y1: projectedTip.y + 10 });
      const clipped = clip([...shape.segments, ...shape.arc, ...shape.axes.flat()]);
      for (let i = 0; i < clipped.length; i += 2) {
        const a = clipped[i].clone().project(this.camera), b = clipped[i + 1].clone().project(this.camera);
        if ([a.x, a.y, b.x, b.y].every(Number.isFinite)) geometryPaths.push([(a.x + 1) * width / 2, (1 - a.y) * height / 2, (b.x + 1) * width / 2, (1 - b.y) * height / 2]);
      }
    }
    const selected = this.relationships.some(r => r.selected && r.visible !== false);
    for (const relationship of [...this.relationships].sort((a, b) => Number(!!b.selected) - Number(!!a.selected))) {
      let visual = this.visuals.get(relationship.id);
      if (!visual) visual = this.create(relationship);
      visual.box = null;
      visual.label.style.display = 'none';
      for (const axis of visual.axes ?? []) axis.letter.style.display = 'none';
      visual.group.visible = relationship.visible !== false;
      const shape = shapes.get(relationship.id);
      if (!shape) { visual.group.visible = false; visual.hitSegments = []; visual.callout.hide(); continue; }
      const active = relationship.selected || relationship.emphasized;
      const highlighted = active || relationship.hovered;
      const color = relationship.kind === 'axes' ? '#c3d0d8' : relationship.color ?? '#82aabd';
      const opacity = active ? 1 : relationship.hovered ? 0.95 : selected ? 0.75 : 0.9;
      visual.group.position.copy(origin); // Camera-relative float32 vertices retain close-up precision.
      visual.stroke.width = active ? 2.5 : highlighted ? 2 : 1.5;
      visual.arc.width = active ? 2.5 : 1.8;
      for (const stroke of [visual.stroke, visual.arc]) { stroke.material.color.set(color); stroke.material.opacity = opacity; }
      if (shape.faintSegments) visual.stroke.material.opacity = opacity * 0.55;
      if (visual.stroke.halo) visual.stroke.halo.material.opacity = opacity * 0.5;
      // Opaque, antialiased arc pieces share the same color at joins. Overlapping
      // caps cannot accumulate alpha into bright beads; selection changes width.
      visual.arc.material.transparent = false; visual.arc.material.alphaToCoverage = true;
      visual.arc.material.opacity = 1; visual.arc.material.color.set(color).multiplyScalar(opacity);
      const markMaterial = visual.marks.material as THREE.PointsMaterial;
      markMaterial.color.set(color); markMaterial.size = active ? 8 : 6; markMaterial.opacity = opacity;
      if (visual.arrow && relationship.kind === 'direction') {
        const [source, tip] = shape.pickExtra;
        const vector = tip.clone().sub(source), length = vector.length();
        const head = directionHeadLength(this.camera, tip, length, height);
        visual.arrow.position.copy(source).sub(origin);
        visual.arrow.setDirection(vector.normalize());
        visual.arrow.setLength(length, head, head * 0.65);
        visual.arrow.setStyle(color, opacity);
      }
      const segments = clip(shape.segments), arc = clip(shape.arc);
      visual.stroke.write(segments, origin); visual.arc.write(arc, origin);
      const axes = shape.axes.map(clip);
      visual.axes?.forEach((axis, i) => {
        axis.stroke.width = visual.stroke.width;
        axis.stroke.material.color.set(AXIS_COLORS[i]); axis.stroke.material.opacity = opacity;
        if (axis.stroke.halo) axis.stroke.halo.material.opacity = opacity * 0.5;
        axis.stroke.write(axes[i] ?? [], origin);
        const at = shape.axes[i] && axisLetterPlacement(shape.axes[i][0], shape.axes[i][1], this.camera, width, height);
        if (!at) return;
        axis.letter.style.display = 'block';
        axis.letter.style.opacity = String(opacity);
        axis.letter.style.transform = `translate(${at.box.x0}px, ${at.box.y0}px)`;
      });
      visual.hitSegments = [...segments, ...arc, ...axes.flat(), ...clip(shape.pickExtra)];
      writePoints(visual.marks.geometry, shape.marks.filter(p => projectAnchor(p, this.camera, width, height) !== null), origin);
      const obstacles = { ...base, rects: [...base.rects, ...occupied.map(rect => ({ ...rect, weight: 3 }))] };
      if (!active) {
        visual.callout.hide();
        visual.label.dataset.hovered = String(!!relationship.hovered);
        let labelAnchor = shape.labelAnchor;
        if (shape.labelFallback && !projectAnchor(labelAnchor, this.camera, width, height)) labelAnchor = shape.labelFallback;
        const projected = projectAnchor(labelAnchor, this.camera, width, height);
        if (projected && this.placeCompactLabel(visual, projected, shape.compact, color, obstacles, width, height, geometryPaths, arrowheads)) occupied.push(visual.box!);
        continue; // Crowding suppresses a compact label, never expands it into another card.
      }
      let screenAnchor = projectAnchor(shape.anchor, this.camera, width, height);
      if (!screenAnchor) screenAnchor = [...shape.segments, ...shape.marks, ...shape.arc, ...shape.axes.flat()].map(p => projectAnchor(p, this.camera, width, height)).find(Boolean) ?? null;
      visual.callout.setLiveContent({ lines: [shape.title, shape.detail], color, tone: 'selected', feature: 'point' });
      visual.box = visual.callout.update(screenAnchor, { width, height }, obstacles);
      if (visual.box) occupied.push(visual.box);
    }
    // Preview and partial-draft handles are a separate temporary channel, never standalone inspection.
    const handles = [...this.draftEndpoints, ...(this.previewEndpoint ? [this.previewEndpoint] : [])]
      .map(endpoint => resolveSpatialEndpoint(this.universe, endpoint, et)).filter(p => p !== null).map(point)
      .filter(p => projectAnchor(p, this.camera, width, height) !== null);
    this.feedback.position.copy(origin);
    writePoints(this.feedback.geometry, handles, origin);
    this.feedback.visible = handles.length > 0;
    return occupied;
  }

  /** Geometry for one resolved relationship, or null where it is undefined (a zero-length direction). */
  private shape(resolved: ResolvedSpatialRelationship, point: (p: readonly number[]) => THREE.Vector3, height: number): Shape | null {
    const r = resolved.relationship;
    const editing = !!r.editing, highlighted = !!(r.selected || r.emphasized || r.hovered);
    const empty = { arc: [], axes: [], pickExtra: [], marks: [] };
    switch (resolved.kind) {
      case 'distance': {
        const source = point(resolved.source), target = point(resolved.target);
        const anchor = source.clone().lerp(target, 0.5);
        const detail = formatSpatialDistance(resolved.distanceKm);
        return { ...empty, segments: [source, target, ...(editing ? [] : distanceTicks(source, target, this.camera, height))],
          marks: editing ? [source, target] : [], anchor, labelAnchor: anchor, compact: detail, detail,
          title: highlighted ? `${endpointLabel(resolved.relationship.source)} ↔ ${endpointLabel(resolved.relationship.target)}` : 'Distance' };
      }
      case 'direction': {
        if (resolved.distanceKm === 0) return null;
        const rel = resolved.relationship;
        const source = point(resolved.source), target = point(resolved.target);
        const vector = target.clone().sub(source), trueLength = vector.length();
        const length = rel.fullLength ? trueLength : directionDisplayLength(this.camera, source, trueLength, height);
        const tip = source.clone().addScaledVector(vector.normalize(), length);
        return { ...empty, segments: directionShaftPoints(source, tip, directionHeadLength(this.camera, tip, length, height)),
          pickExtra: [source, tip], tip, marks: highlighted || editing ? [source] : [], // The arrowhead has no competing endpoint marker.
          anchor: source, labelAnchor: tip, compact: `To ${compactEndpointName(rel.target)}`,
          title: `Direction to ${endpointLabel(rel.target)}`,
          detail: `From ${endpointLabel(rel.source)}${rel.showDistance ? ` · ${formatSpatialDistance(resolved.distanceKm)}` : ''}` };
      }
      case 'angle': {
        if (resolved.angleDeg === undefined) return null;
        const rel = resolved.relationship;
        const source = point(resolved.source), vertex = point(resolved.vertex), target = point(resolved.target);
        const all = anglePoints(source, vertex, target, angleDisplayRadius(this.camera, vertex, Math.min(source.distanceTo(vertex), target.distanceTo(vertex)), height));
        const arc = all.slice(4), anchor = arc[Math.floor(arc.length / 2)].clone();
        const detail = `${resolved.angleDeg.toFixed(2)}°`;
        return { ...empty, segments: all.slice(0, 4), arc, faintSegments: true, marks: editing ? [source, vertex, target] : [vertex],
          anchor, labelAnchor: anchor, labelFallback: vertex, compact: detail, detail,
          title: `At ${endpointLabel(rel.vertex)} · between ${endpointLabel(rel.source)} and ${endpointLabel(rel.target)}` };
      }
      case 'velocity': {
        if (!resolved.direction) return null;
        const rel = resolved.relationship;
        const source = point(resolved.origin), direction = new THREE.Vector3(...resolved.direction);
        const length = directionDisplayLength(this.camera, source, Infinity, height);
        const tip = source.clone().addScaledVector(direction, length);
        const speed = formatSpatialSpeed(resolved.speedKmS);
        return { ...empty, segments: [source, tip, ...rateChevrons(tip, direction, directionHeadLength(this.camera, tip, length, height), this.camera)],
          tip, marks: highlighted || editing ? [source] : [], anchor: source, labelAnchor: tip, compact: speed,
          title: `Velocity of ${endpointLabel(rel.object)}`,
          detail: `Relative to ${resolved.center ? endpointLabel(resolved.center) : 'scene origin'} · ${speed}` };
      }
      case 'axes': {
        const rel = resolved.relationship;
        const source = point(resolved.origin);
        const bodyLengthKm = rel.origin.kind === 'entity' ? this.bodyAxesLength(rel.origin.bodyName) : 0;
        const length = axesDisplayLength(this.camera, source, height, bodyLengthKm * this.scaleFactor);
        const axes = resolved.axes.map(axis => [source, source.clone().addScaledVector(new THREE.Vector3(...axis), length)]);
        return { ...empty, segments: [], axes, marks: highlighted || editing ? [source] : [], anchor: source, labelAnchor: source, compact: rel.frame,
          title: `${rel.frame} axes`, detail: `At ${endpointLabel(rel.origin)}` };
      }
      case 'vector-angle': {
        if (resolved.angleDeg === undefined || !resolved.first.direction || !resolved.second.direction) return null;
        const rel = resolved.relationship;
        const vertex = point(resolved.vertex);
        const length = directionDisplayLength(this.camera, vertex, Infinity, height);
        const legs = [resolved.first.direction, resolved.second.direction].map(d => vertex.clone().addScaledVector(new THREE.Vector3(...d), length));
        const all = anglePoints(legs[0], vertex, legs[1], angleDisplayRadius(this.camera, vertex, length, height));
        const arc = all.slice(4), anchor = arc[Math.floor(arc.length / 2)].clone();
        const detail = `${resolved.angleDeg.toFixed(2)}°`;
        return { ...empty, segments: all.slice(0, 4), arc, faintSegments: true, marks: [vertex], anchor, labelAnchor: anchor, labelFallback: vertex, compact: detail,
          title: `Between ${lowerFirst(referenceVectorLabel(rel.first))} and ${lowerFirst(referenceVectorLabel(rel.second))}`, detail };
      }
    }
  }
  /** Axes at a body are as long as its mesh's own axes; a body without a mesh falls back to its radii. */
  private bodyAxesLength(bodyName: string): number {
    const fromMesh = this.bodyAxesLengthKm(bodyName);
    if (fromMesh !== undefined && fromMesh > 0) return fromMesh;
    const radii = this.universe.getBody(bodyName)?.radii;
    return radii ? Math.max(...radii) * 2 : 0;
  }
  private placeCompactLabel(v: Visual, anchor: { x: number; y: number }, text: string, color: string, obstacles: CalloutObstacles, width: number, height: number, paths: readonly number[][], arrowheads: readonly ScreenRect[]): boolean {
    v.label.style.maxWidth = `${Math.max(1, width - 12)}px`;
    if (v.labelText !== text) {
      v.labelValue.textContent = text; v.labelText = text;
      v.labelSize.width = Math.min(width - 12, text.length * 6.6 + 28);
    }
    v.label.style.color = color;
    const { width: w, height: h } = v.labelSize;
    const placement = compactLabelPlacement(anchor, { width: w, height: h }, { width, height },
      [...obstacles.rects, ...(obstacles.blockers ?? []), ...arrowheads], paths, v.labelCandidate);
    if (!placement) return false;
    const { box, candidate } = placement;
    v.labelCandidate = candidate;
    v.label.style.display = 'flex'; v.label.style.transform = `translate(${box.x0}px, ${box.y0}px)`;
    v.label.title = text; v.label.setAttribute('aria-label', `Select ${KIND_NAMES[v.kind]}: ${text}`); v.box = box;
    return true;
  }

  private create(relationship: SpatialRelationship): Visual {
    const stroke = new Stroke(relationship.kind === 'direction' || relationship.kind === 'velocity'), arc = new Stroke();
    const marks = new THREE.Points(pointGeometry(3), new THREE.PointsMaterial({ color: '#82aabd', map: this.ring, transparent: true, size: 6, sizeAttenuation: false, depthTest: false, depthWrite: false }));
    marks.frustumCulled = false; marks.renderOrder = 101;
    const group = new THREE.Group(); group.add(stroke.line, arc.line, marks);
    if (stroke.halo) group.add(stroke.halo);
    const arrow = relationship.kind === 'direction' ? new MeasurementArrow() : undefined;
    if (arrow) group.add(arrow);
    const axes = relationship.kind === 'axes' ? (['X', 'Y', 'Z'] as const).map((name, i) => {
      const axisStroke = new Stroke(true);
      group.add(axisStroke.line, axisStroke.halo!);
      const letter = document.createElement('span');
      letter.className = 'cosmolabe-axis-letter'; letter.textContent = name;
      Object.assign(letter.style, { position: 'absolute', left: '0', top: '0', display: 'none', pointerEvents: 'none', color: AXIS_COLORS[i],
        font: '600 12px/20px var(--font-mono, monospace)', width: '16px', height: '20px', textAlign: 'center',
        background: 'rgba(9,13,18,0.88)', borderRadius: '3px', textShadow: '0 1px 0 #000' });
      this.calloutContainer.append(letter);
      return { stroke: axisStroke, letter };
    }) : undefined;
    const label = document.createElement('button');
    label.className = 'cosmolabe-measurement-value'; label.dataset.measurementId = relationship.id;
    Object.assign(label.style, { position: 'absolute', left: '0', top: '0', display: 'none', pointerEvents: 'auto', cursor: 'pointer',
      border: '1px solid rgba(190,206,216,0.12)', borderRadius: '3px', background: 'rgba(9,13,18,0.82)', padding: '2px 5px',
      alignItems: 'center', gap: '5px', width: 'max-content', boxSizing: 'border-box', whiteSpace: 'normal', overflowWrap: 'anywhere',
      font: '400 11px/15px var(--font-mono, monospace)', fontVariantNumeric: 'tabular-nums' });
    const icon = this.interaction?.labelIcon?.(relationship.kind);
    if (icon) { icon.style.flexShrink = '0'; label.append(icon); }
    const labelValue = document.createElement('span'); label.append(labelValue);
    label.setAttribute('aria-label', `Select ${KIND_NAMES[relationship.kind]}`);
    const activate = (event: MouseEvent | KeyboardEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      if (event instanceof MouseEvent && this.interaction?.beforePick(event.clientX - rect.left, event.clientY - rect.top)) return;
      if (!this.interaction?.picking()) this.interaction?.onSelect(relationship.id);
    };
    const hover = (active: boolean) => { if (!this.interaction?.picking()) this.interaction?.onHover(active ? relationship.id : null); };
    label.onclick = event => { event.stopPropagation(); activate(event); };
    label.onmouseenter = () => hover(true); label.onmouseleave = () => hover(false);
    label.onfocus = () => hover(true); label.onblur = () => hover(false);
    this.calloutContainer.append(label);
    const callout = new EventCallout(this.calloutContainer);
    callout.setInteraction(relationship.id, activate, hover, this.interaction?.onOpenEditor ? () => this.interaction?.onOpenEditor?.(relationship.id) : undefined,
      this.interaction?.onClearSelection ? () => this.interaction?.onClearSelection?.() : undefined);
    const labelSize = { width: 66, height: 21 };
    const labelObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
      const box = entries[0]?.borderBoxSize?.[0];
      if (box?.inlineSize > 0) { labelSize.width = box.inlineSize; labelSize.height = box.blockSize; }
    });
    labelObserver?.observe(label);
    group.traverse(child => child.layers.set(2));
    this.root.add(group);
    const visual: Visual = { kind: relationship.kind, group, stroke, arc, marks, arrow, axes, callout, label, labelSize, labelObserver, labelText: '', labelValue, hitSegments: [], box: null };
    this.visuals.set(relationship.id, visual);
    return visual;
  }
  private remove(id: string, v: Visual): void {
    v.group.removeFromParent(); v.stroke.dispose(); v.arc.dispose();
    v.marks.geometry.dispose(); (v.marks.material as THREE.Material).dispose();
    v.arrow?.dispose(); v.callout.dispose();
    for (const axis of v.axes ?? []) { axis.stroke.dispose(); axis.letter.remove(); } v.labelObserver?.disconnect(); v.label.remove();
    this.visuals.delete(id);
  }
  dispose(): void {
    for (const [id, visual] of this.visuals) this.remove(id, visual);
    this.feedback.geometry.dispose(); (this.feedback.material as THREE.Material).dispose();
    this.ring.dispose(); this.root.removeFromParent();
  }
}
function overlaps(a: ScreenRect, b: ScreenRect): boolean { return Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0); }
/** Segment/rectangle clipping, padded for stroke width. No DOM layout reads. */
function strokeCrossesBox([x, y, endX, endY]: readonly number[], box: ScreenRect): boolean {
  const dx = endX - x, dy = endY - y;
  let start = 0, end = 1;
  for (const [p, q] of [[-dx, x - box.x0 + 3], [dx, box.x1 - x + 3], [-dy, y - box.y0 + 3], [dy, box.y1 - y + 3]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) start = Math.max(start, t); else end = Math.min(end, t);
    if (start > end) return false;
  }
  return true;
}
function projectAnchor(p: THREE.Vector3, camera: THREE.PerspectiveCamera, width: number, height: number): { x: number; y: number } | null {
  const projected = p.clone().project(camera);
  if (projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1) return null;
  return { x: (projected.x + 1) * width / 2, y: (1 - projected.y) * height / 2 };
}
function worldPerPixel(camera: THREE.PerspectiveCamera, point: THREE.Vector3, height: number): number {
  const depth = -point.clone().applyMatrix4(camera.matrixWorldInverse).z;
  return depth > camera.near && depth < camera.far ? 2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2) / Math.max(1, height) : 0;
}
/** Axes span at least 64 px, or the body's own axes length (scene units) when that is longer. */
export function axesDisplayLength(camera: THREE.PerspectiveCamera, origin: THREE.Vector3, height: number, bodyLength: number): number {
  return Math.max(worldPerPixel(camera, origin, height) * 64, bodyLength);
}
/** Bounded display length carries orientation only, independent of target distance. */
export function directionDisplayLength(camera: THREE.PerspectiveCamera, source: THREE.Vector3, trueLength: number, height: number): number {
  return Math.min(trueLength, worldPerPixel(camera, source, height) * 88);
}
export function directionHeadLength(camera: THREE.PerspectiveCamera, target: THREE.Vector3, length: number, height: number): number {
  return Math.min(length * 0.3, worldPerPixel(camera, target, height) * 13);
}
function distanceTicks(source: THREE.Vector3, target: THREE.Vector3, camera: THREE.PerspectiveCamera, height: number): THREE.Vector3[] {
  const forward = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2);
  const side = target.clone().sub(source).cross(forward).normalize();
  if (side.lengthSq() < 1e-12) side.setFromMatrixColumn(camera.matrixWorld, 0);
  return [source, target].flatMap(p => {
    const half = worldPerPixel(camera, p, height) * 5;
    return [p.clone().addScaledVector(side, -half), p.clone().addScaledVector(side, half)];
  });
}
function hollowMarkerTexture(): THREE.DataTexture {
  const size = 128, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot(x - 63.5, y - 63.5), i = (y * size + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255; data[i + 3] = Math.round(255 * Math.min(THREE.MathUtils.smoothstep(r, 39, 42), 1 - THREE.MathUtils.smoothstep(r, 54, 57)));
  }
  const texture = new THREE.DataTexture(data, size, size); texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter; texture.needsUpdate = true; return texture;
}
export function nearestMeasurementHit(hits: readonly { id: string; distance: number }[], selectedId: string | null): string | null {
  const sorted = [...hits].sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  if (!sorted.length) return null;
  return sorted.find(h => h.id === selectedId && h.distance <= sorted[0].distance + 1.5)?.id ?? sorted[0].id;
}
export function projectedStrokeDistance(points: readonly THREE.Vector3[], camera: THREE.PerspectiveCamera, width: number, height: number, x: number, y: number): number {
  let nearest = Infinity;
  for (let i = 0; i < points.length; i += 2) {
    const a = points[i].clone().project(camera), b = points[i + 1].clone().project(camera);
    if (!Number.isFinite(a.x + a.y + b.x + b.y)) continue;
    const ax = (a.x + 1) * width / 2, ay = (1 - a.y) * height / 2;
    const bx = (b.x + 1) * width / 2, by = (1 - b.y) * height / 2;
    const dx = bx - ax, dy = by - ay;
    const t = THREE.MathUtils.clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    nearest = Math.min(nearest, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return nearest;
}
/** A true-plane angle glyph with bounded pixel scale, capped by the physical legs. */
export function angleDisplayRadius(camera: THREE.PerspectiveCamera, vertex: THREE.Vector3, shorterLeg: number, height: number): number {
  return Math.min(Math.max(0, shorterLeg) * 0.45, worldPerPixel(camera, vertex, height) * 50);
}
/** Independent leg and arc segments; parallel legs have a stable perpendicular. */
export function anglePoints(source: THREE.Vector3, vertex: THREE.Vector3, target: THREE.Vector3, displayRadius?: number): THREE.Vector3[] {
  const a = source.clone().sub(vertex), b = target.clone().sub(vertex);
  const shorter = Math.min(a.length(), b.length());
  const radius = Math.min(shorter * 0.45, displayRadius ?? shorter * 0.16);
  const aN = a.normalize(), bN = b.normalize();
  const angle = Math.acos(THREE.MathUtils.clamp(aN.dot(bN), -1, 1));
  const axis = aN.clone().cross(bN);
  if (axis.lengthSq() < 1e-12) axis.crossVectors(aN, Math.abs(aN.x) < 0.8 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0));
  axis.normalize();
  const points = [source, vertex, vertex, target];
  for (let i = 0; i < 48; i++) for (const step of [i, i + 1]) points.push(aN.clone().applyAxisAngle(axis, angle * step / 48).multiplyScalar(radius).add(vertex));
  return points;
}

/** Two open chevrons behind the tip: a rate glyph, distinct from a direction's solid cone without relying on color. */
export function rateChevrons(tip: THREE.Vector3, direction: THREE.Vector3, headLength: number, camera: THREE.Camera): THREE.Vector3[] {
  const view = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2);
  const side = direction.clone().cross(view);
  if (side.lengthSq() < 1e-12) side.setFromMatrixColumn(camera.matrixWorld, 0);
  side.normalize().multiplyScalar(headLength * 0.5);
  return [0, 0.6].flatMap(offset => {
    const apex = tip.clone().addScaledVector(direction, -offset * headLength);
    const back = apex.clone().addScaledVector(direction, -headLength * 0.7);
    return [apex, back.clone().add(side), apex, back.clone().sub(side)];
  });
}

/**
 * Where an axis letter goes: the tip, or else the point nearest the tip where
 * the axis is still on screen, even when both ends are off it. The segment is
 * clipped to the near plane in view space (so nothing behind the camera
 * projects mirrored), then to the viewport inset by `margin`.
 */
function projectedAxisSegment(start: THREE.Vector3, end: THREE.Vector3, camera: THREE.PerspectiveCamera, width: number, height: number) {
  const a = start.clone().applyMatrix4(camera.matrixWorldInverse), b = end.clone().applyMatrix4(camera.matrixWorldInverse);
  const near = -camera.near * 1.001; // In front of the camera is z < -near.
  if (a.z > near && b.z > near) return null;
  if (a.z > near) a.lerp(b, (a.z - near) / (a.z - b.z));
  else if (b.z > near) b.lerp(a, (b.z - near) / (b.z - a.z));
  const screen = (p: THREE.Vector3) => { p.applyMatrix4(camera.projectionMatrix); return { x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2 }; };
  return [screen(a), screen(b)] as const;
}

export function axisLetterAnchor(start: THREE.Vector3, end: THREE.Vector3, camera: THREE.PerspectiveCamera, width: number, height: number, margin = 10): { x: number; y: number } | null {
  const segment = projectedAxisSegment(start, end, camera, width, height);
  if (!segment) return null;
  const [p0, p1] = segment;
  // Liang–Barsky against the inset viewport; keep the end of the visible part nearest the tip.
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, p0.x - margin], [dx, width - margin - p0.x], [-dy, p0.y - margin], [dy, height - margin - p0.y]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return { x: p0.x + dx * t1, y: p0.y + dy * t1 };
}

/** Fixed just beyond the visible tip, along the projected axis. No collision
 * avoidance: labels stay attached to their axes even when other labels overlap.
 * Attenuate the offset smoothly for axes pointing straight at the camera.
 */
export function axisLetterPlacement(start: THREE.Vector3, end: THREE.Vector3, camera: THREE.PerspectiveCamera,
  width: number, height: number): { box: ScreenRect } | null {
  const anchor = axisLetterAnchor(start, end, camera, width, height, 33);
  const segment = projectedAxisSegment(start, end, camera, width, height);
  if (!anchor || !segment) return null;
  const dx = segment[1].x - segment[0].x, dy = segment[1].y - segment[0].y;
  const scale = 16 / Math.max(16, Math.hypot(dx, dy));
  const x = anchor.x + dx * scale, y = anchor.y + dy * scale;
  return { box: { x0: x - 8, y0: y - 10, x1: x + 8, y1: y + 10 } };
}

function lowerFirst(text: string): string { return text.charAt(0).toLowerCase() + text.slice(1); }

function compactEndpointName(endpoint: SpatialEndpoint): string {
  if (endpoint.kind === 'entity') return endpointLabel(endpoint);
  if (endpoint.kind === 'body-fixed') return endpoint.label?.split(' (')[0] ?? `${endpoint.bodyName} point`;
  return endpoint.label ?? 'Coordinate';
}
/** The cone ends at tip; the one shaft stops at its base. */
export function directionShaftPoints(source: THREE.Vector3, tip: THREE.Vector3, headLength: number): THREE.Vector3[] {
  const vector = tip.clone().sub(source), length = vector.length();
  const shaftLength = Math.max(0, length - Math.max(0, headLength));
  return shaftLength > 0 ? [source, source.clone().addScaledVector(vector.normalize(), shaftLength)] : [];
}

/** Fixed point capacity lets empty/unselected markers grow into edit handles. */
function pointGeometry(capacity: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
  geometry.setDrawRange(0, 0);
  return geometry;
}
function writePoints(geometry: THREE.BufferGeometry, points: readonly THREE.Vector3[], origin: THREE.Vector3): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < points.length; i++) position.setXYZ(i, points[i].x - origin.x, points[i].y - origin.y, points[i].z - origin.z);
  position.needsUpdate = true;
  geometry.setDrawRange(0, points.length);
}

/** Prefer above the tip with a 14 CSS-pixel gap, then right/below/left.
 * Keep a collision-free alternative until it actually needs to move; camera
 * motion must not snap labels back merely because the first choice opens up. */
export function compactLabelPlacement(anchor: { x: number; y: number }, size: { width: number; height: number },
  viewport: { width: number; height: number }, blockers: readonly ScreenRect[], paths: readonly number[][],
  previous?: number): { box: ScreenRect; candidate: number } | null {
  const { width: w, height: h } = size;
  const candidates = [[-w / 2, -h - 14], [14, -h / 2], [-w / 2, 14], [-w - 14, -h / 2]];
  const order = previous !== undefined && previous >= 0 && previous < 4 ? [previous, ...[0, 1, 2, 3].filter(i => i !== previous)] : [0, 1, 2, 3];
  for (const candidate of order) {
    const [dx, dy] = candidates[candidate];
    const x0 = anchor.x + dx, y0 = anchor.y + dy;
    const box = { x0, y0, x1: x0 + w, y1: y0 + h };
    if (x0 < 6 || y0 < 6 || box.x1 > viewport.width - 6 || box.y1 > viewport.height - 6 ||
      blockers.some(b => overlaps(box, b)) || paths.some(path => strokeCrossesBox(path, box))) continue;
    return { box, candidate };
  }
  return null;
}
