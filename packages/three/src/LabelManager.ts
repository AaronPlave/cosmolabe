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
  private readonly _ray = new THREE.Vector3();
  private readonly _toOccluder = new THREE.Vector3();
  private _globalVisible = true;

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
      depthTest: false,
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
    sprite.layers.set(2); // OVERLAY_LAYER — excluded from instrument PiP

    this.labels.set(name, { sprite, bodyMesh });
  }

  setLabelVisible(name: string, visible: boolean): void {
    const entry = this.labels.get(name);
    if (entry) entry.sprite.visible = visible && this._globalVisible;
  }

  setAllVisible(visible: boolean): void {
    this._globalVisible = visible;
    for (const entry of this.labels.values()) {
      entry.sprite.visible = visible;
    }
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

  update(bodyMeshes: BodyMesh[], camera: THREE.Camera, _rendererSize: { width: number; height: number }): void {
    if (!this._globalVisible) return;

    this.right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    this.up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();

    // Scale labels with FOV so they shrink when zoomed in (narrow FOV).
    // At the default 60° FOV, fovScale = 1. At 5° FOV, fovScale ≈ 0.08.
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 60;
    const fovScale = fov / 60;

    const camPos = camera.position;

    for (const entry of this.labels.values()) {
      const bm = entry.bodyMesh;
      const sprite = entry.sprite;
      const mat = sprite.material as THREE.SpriteMaterial;

      // Hide instrument labels (e.g. ISS NAC on Cassini) — they clutter at planet scale
      if (bm.body.classification === 'instrument') {
        sprite.visible = false;
        continue;
      }

      // Rescale sprite for current FOV
      const texture = mat.map!;
      const img = texture.image as { width: number; height: number };
      const aspect = img.width / img.height;
      const height = (this.fontSize / 600) * this.labelScale * fovScale;
      sprite.scale.set(height * aspect, height, 1);

      // Offset label to start at the body's silhouette edge.
      // Use the larger of: body's world-space radius, or a small fraction of camera distance
      // (so labels are readable even when the body is a tiny dot).
      const distToBody = bm.position.distanceTo(camPos);
      const worldRadius = bm.displayRadius * bm.scaleFactor;
      const offsetScale = Math.max(worldRadius * 1.3, distToBody * 0.015 * fovScale);

      sprite.position.copy(bm.position);
      sprite.position.addScaledVector(this.right, offsetScale);
      sprite.position.addScaledVector(this.up, -offsetScale * 0.15);

      this.applyOcclusionFade(sprite, bm.position, distToBody, bodyMeshes, camPos, bm);

      // Add to scene if not already
      if (!sprite.parent) {
        bm.parent?.add(sprite);
      }
    }
  }

  /**
   * Compute and apply occlusion-based opacity fade for a label sprite.
   * Uses ray-sphere intersection to determine if the labeled position is behind
   * any body, with smoothstep fade at the limb and temporal smoothing.
   * Public so UniverseRenderer can also apply it to sensor frustum labels.
   */
  applyOcclusionFade(
    sprite: THREE.Sprite,
    worldPos: THREE.Vector3,
    distToPos: number,
    bodyMeshes: BodyMesh[],
    camPos: THREE.Vector3,
    excludeBody?: BodyMesh,
  ): void {
    const ray = this._ray;
    const toOcc = this._toOccluder;
    ray.subVectors(worldPos, camPos).normalize();

    // For surface-locked bodies (rovers, landers), don't check the parent as occluder.
    // Surface-locked bodies sit on or slightly below the parent's reference sphere
    // (e.g., Curiosity is ~5 km inside the Mars 3396.19 km sphere because Gale Crater
    // is below the IAU datum). Any ray from camera to such a body passes through the
    // parent's sphere, which would otherwise fade the label even when it's clearly
    // visible on the front-facing surface.
    const excludeParentName = excludeBody?.body.geometryData?.surfaceLock
      ? excludeBody.body.parentName
      : undefined;

    let fade = 1.0;
    for (const other of bodyMeshes) {
      if (other === excludeBody) continue;
      if (excludeParentName && other.body.name === excludeParentName) continue;
      // Only large bodies (planets, moons, large asteroids) can meaningfully occlude.
      // Skip spacecraft/instrument body meshes — they are colocated with their parent
      // and would false-positive via ray-through-center at zero closest approach.
      if (other.displayRadius < 50) continue;
      const occR = other.displayRadius * other.scaleFactor;
      if (occR < 1e-6) continue;

      toOcc.subVectors(other.position, camPos);
      const distToOccSq = toOcc.lengthSq();
      // Camera inside the occluder sphere — skip (nothing should be occluded)
      if (distToOccSq <= occR * occR) continue;

      const tProj = toOcc.dot(ray);

      // Closest approach of the infinite ray to the occluder center
      const closestSq = distToOccSq - tProj * tProj;
      const closest = Math.sqrt(Math.max(0, closestSq));

      if (closest >= occR) continue; // ray misses sphere entirely

      // Ray intersects sphere — check if the intersection overlaps [0, distToPos]
      const halfChord = Math.sqrt(Math.max(0, occR * occR - closestSq));
      const tEntry = tProj - halfChord;
      const tExit = tProj + halfChord;
      if (tExit <= 0 || tEntry >= distToPos) continue; // sphere is behind camera or beyond body

      // Body is behind this occluder. Fade based on penetration depth.
      // At the limb (closest ≈ occR): fade toward 1.0 (barely occluded)
      // Deep inside (closest ≈ 0): fade toward 0.0 (fully occluded)
      const fadeDepth = occR * 0.04;
      const penetration = occR - closest;
      const t = Math.max(0, 1 - penetration / fadeDepth);
      const smooth = t * t * (3 - 2 * t);
      fade = Math.min(fade, smooth);
    }

    // Temporal smoothing to prevent pop/flicker at the occlusion boundary
    const mat = sprite.material as THREE.SpriteMaterial;
    const prev = sprite.userData._labelOpacity as number | undefined;
    const smoothed = prev != null ? prev + (fade - prev) * 0.25 : fade;
    mat.opacity = smoothed;
    sprite.userData._labelOpacity = smoothed;
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

  /**
   * Screen-space label picking: project each label to screen coordinates and
   * return the closest label within `maxPixelDist` of the given screen position.
   * This is far more reliable than 3D raycasting for sizeAttenuation:false sprites.
   */
  pickNearest(
    screenX: number,
    screenY: number,
    camera: THREE.Camera,
    canvasWidth: number,
    canvasHeight: number,
    maxPixelDist = 20,
  ): string | undefined {
    const projected = new THREE.Vector3();
    let bestName: string | undefined;
    let bestDist = maxPixelDist;

    for (const [name, entry] of this.labels) {
      const sprite = entry.sprite;
      if (!sprite.visible || !sprite.parent) continue;

      // Project label world position to screen pixels
      projected.copy(sprite.position);
      sprite.parent.localToWorld(projected);
      projected.project(camera);

      // Skip labels behind camera
      if (projected.z > 1) continue;

      const sx = (projected.x * 0.5 + 0.5) * canvasWidth;
      const sy = (-projected.y * 0.5 + 0.5) * canvasHeight;

      // Compute approximate label width in pixels from sprite scale.
      // Sprite scale is normalized to ~600px viewport; reverse that to get screen pixels.
      const aspect = sprite.scale.x / sprite.scale.y;
      const labelHeightPx = sprite.scale.y * 600 / this.labelScale;
      const labelWidthPx = labelHeightPx * aspect;

      // Label is anchored at left-center (center = 0, 0.5), so the clickable
      // region extends from (sx, sy) rightward by labelWidthPx, and ±halfHeight.
      const halfH = labelHeightPx * 0.5;
      // Expand the hitbox slightly for easier clicking
      const padX = 6;
      const padY = 4;
      const dx = screenX < sx - padX ? sx - padX - screenX
        : screenX > sx + labelWidthPx + padX ? screenX - sx - labelWidthPx - padX
        : 0;
      const dy = screenY < sy - halfH - padY ? sy - halfH - padY - screenY
        : screenY > sy + halfH + padY ? screenY - sy - halfH - padY
        : 0;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < bestDist) {
        bestDist = dist;
        bestName = name;
      }
    }

    return bestName;
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
