import * as THREE from 'three';
import {
  endpointLabel,
  formatSpatialDistance,
  resolveSpatialRelationship,
  type SpatialRelationship,
  type Universe,
} from '@cosmolabe/core';

interface Visual { group: THREE.Group; line: THREE.Line; arrow?: THREE.ArrowHelper; label: THREE.Sprite }

/** Scene rendering for semantic spatial relationships owned by the core model. */
export class SpatialRelationshipLayer {
  private readonly root = new THREE.Group();
  private readonly visuals = new Map<string, Visual>();
  private relationships: readonly SpatialRelationship[] = [];

  constructor(private readonly universe: Universe, private readonly scaleFactor: number) {
    this.root.layers.set(2);
  }

  attach(scene: THREE.Scene): void { scene.add(this.root); }

  setRelationships(relationships: readonly SpatialRelationship[]): void {
    this.relationships = relationships;
    const ids = new Set(relationships.map(r => r.id));
    for (const [id, visual] of this.visuals) if (!ids.has(id)) this.remove(id, visual);
  }

  update(et: number, originKm: readonly [number, number, number]): void {
    for (const relationship of this.relationships) {
      let visual = this.visuals.get(relationship.id);
      if (!visual) visual = this.create(relationship);
      visual.group.visible = relationship.visible !== false;
      if (!visual.group.visible) continue;
      const resolved = resolveSpatialRelationship(this.universe, relationship, et);
      if (!resolved) { visual.group.visible = false; continue; }
      const point = (p: readonly number[]) => new THREE.Vector3(
        (p[0] - originKm[0]) * this.scaleFactor,
        (p[1] - originKm[1]) * this.scaleFactor,
        (p[2] - originKm[2]) * this.scaleFactor,
      );
      const source = point(resolved.source), target = point(resolved.target);
      const points = relationship.kind === 'angle' && resolved.vertex
        ? [source, point(resolved.vertex), target]
        : [source, target];
      visual.line.geometry.setFromPoints(points);
      visual.label.position.copy(relationship.kind === 'angle' && resolved.vertex ? point(resolved.vertex) : source.clone().lerp(target, 0.5));
      let text: string;
      if (relationship.kind === 'angle') text = `${endpointLabel(relationship.source)} – ${endpointLabel(relationship.vertex)} – ${endpointLabel(relationship.target)}\n${resolved.angleDeg?.toFixed(2)}°`;
      else text = `${endpointLabel(relationship.source)} → ${endpointLabel(relationship.target)}\n${relationship.kind === 'distance' ? '3D chord · ' : ''}${formatSpatialDistance(resolved.distanceKm ?? 0)}`;
      updateLabel(visual.label, text, relationship.color ?? '#67d9ff');
      if (visual.arrow) {
        const direction = target.clone().sub(source);
        const length = direction.length();
        visual.arrow.position.copy(source);
        if (length > 0) visual.arrow.setDirection(direction.normalize());
        visual.arrow.setLength(length, Math.min(length * 0.16, 0.012), Math.min(length * 0.08, 0.006));
      }
    }
  }

  dispose(): void {
    for (const [id, visual] of this.visuals) this.remove(id, visual);
    this.root.removeFromParent();
  }

  private create(relationship: SpatialRelationship): Visual {
    const color = new THREE.Color(relationship.color ?? '#67d9ff');
    const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.82, depthTest: false }));
    line.renderOrder = 100;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }));
    label.scale.set(0.08, 0.025, 1);
    label.renderOrder = 101;
    const group = new THREE.Group(); group.add(line, label);
    const arrow = relationship.kind === 'direction' ? new THREE.ArrowHelper(new THREE.Vector3(1,0,0), new THREE.Vector3(), 1, color) : undefined;
    if (arrow) {
      (arrow.line.material as THREE.Material).depthTest = false;
      (arrow.cone.material as THREE.Material).depthTest = false;
      group.add(arrow);
    }
    this.root.add(group);
    const visual = { group, line, arrow, label };
    this.visuals.set(relationship.id, visual);
    return visual;
  }

  private remove(id: string, visual: Visual): void {
    visual.group.removeFromParent();
    visual.line.geometry.dispose();
    (visual.line.material as THREE.Material).dispose();
    (visual.label.material as THREE.SpriteMaterial).map?.dispose();
    visual.label.material.dispose();
    visual.arrow?.dispose();
    this.visuals.delete(id);
  }
}

function updateLabel(sprite: THREE.Sprite, text: string, color: string): void {
  const material = sprite.material as THREE.SpriteMaterial;
  const previous = material.userData.text as string | undefined;
  if (previous === text) return;
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  ctx.fillStyle = 'rgba(8, 13, 20, .88)'; ctx.roundRect(3, 3, 506, 122, 12); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
  ctx.font = '28px ui-monospace, monospace'; ctx.fillStyle = '#f2f6fa';
  text.split('\n').forEach((line, i) => ctx.fillText(line, 18, 43 + i * 40));
  material.map?.dispose(); material.map = new THREE.CanvasTexture(canvas); material.needsUpdate = true; material.userData.text = text;
}
