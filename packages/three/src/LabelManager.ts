import * as THREE from 'three';
import type { BodyMesh } from './BodyMesh.js';

export interface LabelManagerOptions {
  /** Font size in pixels */
  fontSize?: number;
  /** Scale factor for label size in scene */
  labelScale?: number;
}

interface LabelEntry {
  sprite: THREE.Sprite;
  bodyMesh: BodyMesh;
}

export class LabelManager {
  private readonly labels = new Map<string, LabelEntry>();
  private readonly fontSize: number;
  private readonly labelScale: number;
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();

  constructor(_container: HTMLElement, options: LabelManagerOptions = {}) {
    this.fontSize = options.fontSize ?? 14;
    this.labelScale = options.labelScale ?? 1;
  }

  addLabel(bodyMesh: BodyMesh): void {
    const name = bodyMesh.body.name;
    const lc = bodyMesh.body.labelColor;
    const color = lc
      ? `rgb(${Math.round(lc[0] * 255)},${Math.round(lc[1] * 255)},${Math.round(lc[2] * 255)})`
      : '#cccccc';

    // Render at 2x resolution for retina crispness
    const textureFontSize = this.fontSize * 4;
    const texture = this.createTextTexture(name, color, textureFontSize);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      sizeAttenuation: false,
    });
    const sprite = new THREE.Sprite(material);

    // Scale so it appears ~fontSize pixels tall on screen
    const aspect = texture.image.width / texture.image.height;
    const height = (this.fontSize / 600) * this.labelScale; // normalized to ~600px viewport
    sprite.scale.set(height * aspect, height, 1);
    sprite.center.set(0, 0.5); // anchor at left-center

    sprite.renderOrder = 999;

    this.labels.set(name, { sprite, bodyMesh });
  }

  setLabelVisible(name: string, visible: boolean): void {
    const entry = this.labels.get(name);
    if (entry) entry.sprite.visible = visible;
  }

  removeLabel(name: string): void {
    const entry = this.labels.get(name);
    if (entry) {
      entry.sprite.removeFromParent();
      (entry.sprite.material as THREE.SpriteMaterial).map?.dispose();
      (entry.sprite.material as THREE.Material).dispose();
      this.labels.delete(name);
    }
  }

  update(_bodyMeshes: BodyMesh[], camera: THREE.Camera, _rendererSize: { width: number; height: number }): void {
    this.right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    this.up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();

    // Scale labels with FOV so they shrink when zoomed in (narrow FOV).
    // At the default 60° FOV, fovScale = 1. At 5° FOV, fovScale ≈ 0.08.
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 60;
    const fovScale = fov / 60;

    for (const entry of this.labels.values()) {
      const bm = entry.bodyMesh;
      const sprite = entry.sprite;

      // Hide instrument labels (e.g. ISS NAC on Cassini) — they clutter at planet scale
      if (bm.body.classification === 'instrument') {
        sprite.visible = false;
        continue;
      }

      // Rescale sprite for current FOV
      const texture = (sprite.material as THREE.SpriteMaterial).map!;
      const img = texture.image as { width: number; height: number };
      const aspect = img.width / img.height;
      const height = (this.fontSize / 600) * this.labelScale * fovScale;
      sprite.scale.set(height * aspect, height, 1);

      // Offset label to start at the body's silhouette edge.
      // Use the larger of: body's world-space radius, or a small fraction of camera distance
      // (so labels are readable even when the body is a tiny dot).
      const dist = bm.position.distanceTo(camera.position);
      const worldRadius = bm.displayRadius * bm.scaleFactor;
      const offsetScale = Math.max(worldRadius * 1.3, dist * 0.015 * fovScale);

      sprite.position.copy(bm.position);
      sprite.position.addScaledVector(this.right, offsetScale);
      sprite.position.addScaledVector(this.up, -offsetScale * 0.15);

      // Add to scene if not already
      if (!sprite.parent) {
        bm.parent?.add(sprite);
      }
    }
  }

  /** Get all label sprites (for raycasting / picking) */
  getSprites(): THREE.Sprite[] {
    return Array.from(this.labels.values()).map(e => e.sprite);
  }

  /** Resolve a hit object to a body name, or undefined if not a label sprite */
  resolveSprite(object: THREE.Object3D): string | undefined {
    for (const [name, entry] of this.labels) {
      if (entry.sprite === object) return name;
    }
    return undefined;
  }

  dispose(): void {
    for (const entry of this.labels.values()) {
      entry.sprite.removeFromParent();
      (entry.sprite.material as THREE.SpriteMaterial).map?.dispose();
      (entry.sprite.material as THREE.Material).dispose();
    }
    this.labels.clear();
  }

  private createTextTexture(text: string, color: string, fontSize: number): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const font = `${fontSize}px monospace`;
    ctx.font = font;
    const metrics = ctx.measureText(text);

    const padding = Math.ceil(fontSize * 0.3);
    canvas.width = Math.ceil(metrics.width) + padding * 2;
    canvas.height = fontSize + padding * 2;

    // Re-set font after canvas resize
    ctx.font = font;
    ctx.textBaseline = 'top';

    // Black glow for readability (like CSS text-shadow: 0 0 4px black)
    ctx.shadowColor = 'black';
    ctx.shadowBlur = fontSize * 0.15;
    ctx.fillStyle = color;
    // Multiple passes for stronger glow
    ctx.fillText(text, padding, padding);
    ctx.fillText(text, padding, padding);

    // Final crisp pass
    ctx.shadowBlur = 0;
    ctx.fillText(text, padding, padding);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    return texture;
  }
}
