import * as THREE from 'three';
import {
  endpointLabel,
  formatSpatialDistance,
  resolveSpatialRelationship,
  type SpatialRelationship,
  type Universe,
} from '@cosmolabe/core';
import { EventCallout, type CalloutObstacles, type ScreenRect } from './EventCallout.js';

interface Visual {
  group: THREE.Group;
  line: THREE.LineSegments;
  marks: THREE.Points;
  arrow?: THREE.ArrowHelper;
  callout: EventCallout;
  color: string;
}

/** Scene rendering for semantic spatial relationships owned by the core model. */
export class SpatialRelationshipLayer {
  private readonly root = new THREE.Group();
  private readonly visuals = new Map<string, Visual>();
  private relationships: readonly SpatialRelationship[] = [];

  constructor(
    private readonly universe: Universe,
    private readonly scaleFactor: number,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
    private readonly calloutContainer: HTMLElement,
    private readonly obstacles: () => CalloutObstacles,
  ) { this.root.layers.set(2); }

  attach(scene: THREE.Scene): void { scene.add(this.root); }

  setRelationships(relationships: readonly SpatialRelationship[]): void {
    this.relationships = relationships;
    const ids = new Set(relationships.map(r => r.id));
    for (const [id, visual] of this.visuals) if (!ids.has(id)) this.remove(id, visual);
  }

  update(et: number, originKm: readonly [number, number, number]): ScreenRect[] {
    const occupied: ScreenRect[] = [];
    for (const relationship of this.relationships) {
      let visual = this.visuals.get(relationship.id);
      if (!visual) visual = this.create(relationship);
      this.updateColor(visual, relationship.color ?? '#82aabd');
      visual.group.visible = relationship.visible !== false;
      if (!visual.group.visible) { visual.callout.hide(); continue; }
      const resolved = resolveSpatialRelationship(this.universe, relationship, et);
      if (!resolved || (relationship.kind === 'angle' && resolved.angleDeg === undefined) ||
          (relationship.kind === 'direction' && resolved.distanceKm === 0)) {
        visual.group.visible = false;
        visual.callout.hide();
        continue;
      }
      const point = (p: readonly number[]) => new THREE.Vector3(
        (p[0] - originKm[0]) * this.scaleFactor,
        (p[1] - originKm[1]) * this.scaleFactor,
        (p[2] - originKm[2]) * this.scaleFactor,
      );
      const source = point(resolved.source), target = point(resolved.target);
      const vertex = relationship.kind === 'angle' && resolved.vertex ? point(resolved.vertex) : undefined;
      visual.line.geometry.setFromPoints(vertex ? anglePoints(source, vertex, target) : [source, target]);
      visual.line.visible = relationship.kind !== 'direction';
      visual.marks.geometry.setFromPoints(vertex ? [source, vertex, target] : [source, target]);

      let anchor = source.clone().lerp(target, 0.5);
      let title: string;
      let detail: string;
      if (relationship.kind === 'angle') {
        anchor = vertex!;
        title = `${endpointLabel(relationship.source)} – ${endpointLabel(relationship.vertex)} – ${endpointLabel(relationship.target)}`;
        detail = `${resolved.angleDeg!.toFixed(2)}°`;
      } else {
        title = `${endpointLabel(relationship.source)} → ${endpointLabel(relationship.target)}`;
        detail = relationship.kind === 'distance'
          ? `3D chord · ${formatSpatialDistance(resolved.distanceKm!)}`
          : relationship.showDistance === false ? 'Direction' : formatSpatialDistance(resolved.distanceKm!);
      }
      visual.callout.setLiveContent({ lines: [title, detail], color: visual.color, tone: relationship.emphasized ? 'selected' : 'preview', feature: 'point' });
      (visual.line.material as THREE.LineBasicMaterial).opacity = relationship.emphasized ? 1 : 0.55;
      (visual.marks.material as THREE.PointsMaterial).size = relationship.emphasized ? 6 : 4;
      const projected = anchor.clone().project(this.camera);
      const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
      const screenAnchor = projected.z >= -1 && projected.z <= 1
        ? { x: (projected.x + 1) * width / 2, y: (1 - projected.y) * height / 2 } : null;
      const base = this.obstacles();
      const box = visual.callout.update(screenAnchor, { width, height }, {
        ...base, rects: [...base.rects, ...occupied.map(rect => ({ ...rect, weight: 3 }))],
      });
      if (box) occupied.push(box);

      if (visual.arrow) {
        for (const material of [visual.arrow.line.material, visual.arrow.cone.material]) {
          const m = material as THREE.Material;
          m.transparent = true;
          m.opacity = relationship.emphasized ? 1 : 0.55;
        }
        const direction = target.clone().sub(source);
        const length = direction.length();
        visual.arrow.position.copy(source);
        visual.arrow.setDirection(direction.normalize());
        const headLength = directionHeadLength(this.camera, target, length, height);
        visual.arrow.setLength(length, headLength, headLength * 0.45);
      }
    }
    return occupied;
  }

  dispose(): void {
    for (const [id, visual] of this.visuals) this.remove(id, visual);
    this.root.removeFromParent();
  }

  private create(relationship: SpatialRelationship): Visual {
    const colorValue = relationship.color ?? '#82aabd';
    const color = new THREE.Color(colorValue);
    const line = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.82, depthTest: false }));
    line.renderOrder = 100;
    const marks = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color, size: 5, sizeAttenuation: false, depthTest: false }));
    marks.renderOrder = 101;
    const group = new THREE.Group(); group.add(line, marks);
    const arrow = relationship.kind === 'direction' ? new THREE.ArrowHelper(new THREE.Vector3(1,0,0), new THREE.Vector3(), 1, color) : undefined;
    if (arrow) {
      (arrow.line.material as THREE.Material).depthTest = false;
      (arrow.cone.material as THREE.Material).depthTest = false;
      group.add(arrow);
    }
    this.root.add(group);
    const visual = { group, line, marks, arrow, callout: new EventCallout(this.calloutContainer), color: colorValue };
    this.visuals.set(relationship.id, visual);
    return visual;
  }

  private updateColor(visual: Visual, color: string): void {
    if (visual.color === color) return;
    visual.color = color;
    (visual.line.material as THREE.LineBasicMaterial).color.set(color);
    (visual.marks.material as THREE.PointsMaterial).color.set(color);
    if (visual.arrow) {
      (visual.arrow.line.material as THREE.LineBasicMaterial).color.set(color);
      (visual.arrow.cone.material as THREE.MeshBasicMaterial).color.set(color);
    }
  }

  private remove(id: string, visual: Visual): void {
    visual.group.removeFromParent();
    visual.line.geometry.dispose(); (visual.line.material as THREE.Material).dispose();
    visual.marks.geometry.dispose(); (visual.marks.material as THREE.Material).dispose();
    visual.arrow?.dispose(); visual.callout.dispose();
    this.visuals.delete(id);
  }
}

/** Finite line-segment pairs for two legs and a deterministic angle arc. */
export function anglePoints(source: THREE.Vector3, vertex: THREE.Vector3, target: THREE.Vector3): THREE.Vector3[] {
  const a = source.clone().sub(vertex), b = target.clone().sub(vertex);
  const radius = Math.min(a.length(), b.length()) * 0.16;
  const aN = a.normalize(), bN = b.normalize();
  const angle = Math.acos(THREE.MathUtils.clamp(aN.dot(bN), -1, 1));
  const axis = aN.clone().cross(bN);
  if (axis.lengthSq() < 1e-12) {
    // Parallel legs still define a straight angle; choose a stable perpendicular.
    const basis = Math.abs(aN.x) < 0.8 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    axis.crossVectors(aN, basis);
  }
  axis.normalize();
  const points = [source, vertex, vertex, target];
  for (let i = 0; i < 18; i++) {
    for (const step of [i, i + 1]) points.push(aN.clone().applyAxisAngle(axis, angle * step / 18).multiplyScalar(radius).add(vertex));
  }
  return points;
}

/** Pixel-sized head at target depth, capped to fit short segments; no head behind the near plane. */
export function directionHeadLength(camera: THREE.PerspectiveCamera, target: THREE.Vector3, length: number, height: number): number {
  const depth = -target.clone().applyMatrix4(camera.matrixWorldInverse).z;
  if (depth <= camera.near || depth >= camera.far || length <= 0) return 0;
  const worldPerPixel = 2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2) / Math.max(1, height);
  return Math.min(length * 0.3, worldPerPixel * 9);
}
