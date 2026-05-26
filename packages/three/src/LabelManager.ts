import * as THREE from 'three';
import type { Body } from '@cosmolabe/core';
import type { BodyMesh } from './BodyMesh.js';

export interface LabelManagerOptions {
  /** Font size in pixels */
  fontSize?: number;
  /** Scale factor for label size in scene */
  labelScale?: number;
  /** Disable the screen-space collision pass that hides overlapping lower-priority labels. */
  disableCollision?: boolean;
  /**
   * Minimum gap between the body's screen-projected silhouette and its label,
   * in pixels. Acts as a floor so labels for tiny markers (spacecraft dots,
   * ground station pins) hug their visual instead of being pushed to the
   * stale `displayRadius`. Default 12.
   */
  minLabelOffsetPx?: number;
  /**
   * Start fading the label once the body's on-screen silhouette grows beyond
   * this many pixels (NASA Eyes-style — once the body is clearly identifiable
   * by shape, the label becomes clutter). Applied only to bodies with a
   * visible silhouette (Globe + Mesh). Default 80.
   */
  selfSizeFadeStartPx?: number;
  /**
   * Fully hide the label once the body's silhouette exceeds this many pixels.
   * Linear fade between `selfSizeFadeStartPx` and this value. Default 200.
   */
  selfSizeFadeEndPx?: number;
}

interface LabelEntry {
  sprite: THREE.Sprite;
  bodyMesh: BodyMesh;
  priority: number;
  // Scratch fields updated each frame by update() so the collision pass
  // doesn't reproject.
  screenX: number;
  screenY: number;
  widthPx: number;
  heightPx: number;
  occlusionOpacity: number;
  // Smoothed 0..1 fade governing the collision pass — independent of the
  // occlusion fade so the two smoothings don't fight in steady state. 1 =
  // fully visible w.r.t. collisions; 0 = fully hidden by an overlapping
  // higher-priority label.
  collisionFade: number;
  // 0..1 NASA-Eyes-style fade: 1 when the body is small enough to need a
  // label, 0 once it's visually identifiable by its own silhouette. Computed
  // each frame from the projected screen size. Final material.opacity =
  // occlusionOpacity * collisionFade * selfSizeFade * opacityMultiplier.
  selfSizeFade: number;
  // Caller-controlled multiplier on top of the automated fades. Used by
  // host apps to dim non-selected labels alongside their non-selected
  // markers / trajectories without fighting the automated occlusion +
  // collision + self-size fades. Default 1 (no effect).
  opacityMultiplier: number;
}

/** Priority for keeping a label visible when bboxes overlap. Higher wins. */
function priorityFor(body: Body): number {
  switch (body.classification) {
    case 'star': return 100;
    case 'planet': return 95;
    case 'moon': return 85;
    case 'spacecraft': return 80;
    case 'asteroid':
    case 'comet': return 70;
    case 'instrument': return 0; // already hidden in update()
    case 'barycenter': return 20;
    case 'other': return 50; // ground stations, surface infrastructure
    default: return 60;
  }
}

export class LabelManager {
  private readonly labels = new Map<string, LabelEntry>();
  private readonly fontSize: number;
  private readonly labelScale: number;
  private readonly disableCollision: boolean;
  private readonly minLabelOffsetPx: number;
  private readonly selfSizeFadeStartPx: number;
  private readonly selfSizeFadeEndPx: number;
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly _ray = new THREE.Vector3();
  private readonly _toOccluder = new THREE.Vector3();
  private readonly _projected = new THREE.Vector3();
  private readonly _corner = new THREE.Vector3();
  private readonly _bodyScreen = new THREE.Vector3();
  private readonly _pinnedNames = new Set<string>();
  private _globalVisible = true;

  constructor(_container: HTMLElement, options: LabelManagerOptions = {}) {
    this.fontSize = options.fontSize ?? 14;
    this.labelScale = options.labelScale ?? 1;
    this.disableCollision = options.disableCollision ?? false;
    this.minLabelOffsetPx = options.minLabelOffsetPx ?? 12;
    this.selfSizeFadeStartPx = options.selfSizeFadeStartPx ?? 80;
    this.selfSizeFadeEndPx = options.selfSizeFadeEndPx ?? 200;
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

    this.labels.set(name, {
      sprite,
      bodyMesh,
      priority: priorityFor(bodyMesh.body),
      screenX: 0,
      screenY: 0,
      widthPx: 0,
      heightPx: 0,
      occlusionOpacity: 1,
      collisionFade: 1,
      selfSizeFade: 1,
      opacityMultiplier: 1,
    });
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

  /**
   * Set a multiplicative factor on this label's final opacity. Composes on
   * top of the automated occlusion / self-size / collision fades, so host
   * apps can dim non-selected labels (or boost a focused one) without
   * stomping the manager's internal fade logic. Default 1.
   */
  setLabelOpacityMultiplier(name: string, multiplier: number): void {
    const entry = this.labels.get(name);
    if (entry) entry.opacityMultiplier = multiplier;
  }

  /**
   * Pin a label so the collision pass never hides it (it still blocks lower-
   * priority labels from drawing over it). Use for the currently selected /
   * tracked body so the user's focus always reads, even if a higher-priority
   * planet would otherwise win the collision arbitration. Occlusion (label
   * behind a body) is unaffected — a pinned label still fades when geometry
   * blocks it.
   */
  setLabelPinned(name: string, pinned: boolean): void {
    if (pinned) this._pinnedNames.add(name);
    else this._pinnedNames.delete(name);
  }

  /** Clear all pinned labels (e.g. on selection clear). */
  clearPinnedLabels(): void {
    this._pinnedNames.clear();
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

  update(bodyMeshes: BodyMesh[], camera: THREE.Camera, rendererSize: { width: number; height: number }): void {
    if (!this._globalVisible) return;

    this.right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    this.up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();

    // Scale labels with FOV so they shrink when zoomed in (narrow FOV).
    // At the default 60° FOV, fovScale = 1. At 5° FOV, fovScale ≈ 0.08.
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 60;
    const fovScale = fov / 60;
    const fovRad = (fov * Math.PI) / 180;
    const tanHalfFov = Math.tan(fovRad / 2);
    const heightPx = Math.max(rendererSize.height, 1);

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

      // Place the label outside the body's on-screen silhouette, measured in
      // **screen pixels** so it works for both planet-sized world bodies and
      // tiny screen-pixel markers (spacecraft dots, ground-station pins). The
      // legacy `displayRadius * scaleFactor` formula put the label at the body's
      // world-space radius, which for a SpacecraftMarker (displayRadius=50km,
      // visible footprint 10px) parked the label far off to the side at close
      // range. Convert distance + FOV to world-units-per-pixel at the body's
      // depth, place the label at max(silhouettePx + 4, minLabelOffsetPx).
      //
      // For bodies rendered by a custom BodyVisualizer (anything that's not a
      // built-in Globe/Mesh — e.g. SpacecraftMarker dots, GroundStation pins),
      // `displayRadius` doesn't match what the user sees: the visualizer
      // typically draws at constant screen-pixel size while displayRadius
      // stays at a body-frame km value. Skip the silhouette term for those
      // and rely on minLabelOffsetPx to hug the visualizer.
      const distToBody = bm.position.distanceTo(camPos);
      const worldPerPx = (2 * distToBody * tanHalfFov) / heightPx;
      // For Globe bodies (Earth, Moon, Sun, etc.), `displayRadius` correctly
      // characterizes the visible silhouette — they're spheres at full scale.
      // For Mesh-loaded bodies (GLB/OBJ models with arbitrary shape — Cassini's
      // booms, Clipper's solar panels), `displayRadius` only captures the
      // bbox max-extent half — which is invariant to orientation and undercount
      // the actual screen extent when the long axis isn't aligned with the
      // body's frame. Project the loaded model's local bbox corners to screen
      // each frame and take the max radial distance from the body center.
      let silhouettePx = 0;
      const isGlobe = bm.body.geometryType === 'Globe';
      const isMesh = bm.body.geometryType === 'Mesh';
      if (isGlobe) {
        silhouettePx = (bm.displayRadius * bm.scaleFactor) / Math.max(worldPerPx, 1e-9);
      } else if (isMesh && bm.modelLocalBox && bm.modelContainer && bm.isModelVisible) {
        // Body center in screen pixels — corner offsets are measured from here.
        this._bodyScreen.copy(bm.position).project(camera);
        const bodyScreenX = (this._bodyScreen.x * 0.5 + 0.5) * rendererSize.width;
        const bodyScreenY = (-this._bodyScreen.y * 0.5 + 0.5) * rendererSize.height;
        const lb = bm.modelLocalBox;
        const m = bm.modelContainer.matrixWorld;
        const corners: ReadonlyArray<readonly [number, number, number]> = [
          [lb.min.x, lb.min.y, lb.min.z], [lb.max.x, lb.min.y, lb.min.z],
          [lb.min.x, lb.max.y, lb.min.z], [lb.max.x, lb.max.y, lb.min.z],
          [lb.min.x, lb.min.y, lb.max.z], [lb.max.x, lb.min.y, lb.max.z],
          [lb.min.x, lb.max.y, lb.max.z], [lb.max.x, lb.max.y, lb.max.z],
        ];
        let maxDistSq = 0;
        for (const c of corners) {
          this._corner.set(c[0], c[1], c[2]).applyMatrix4(m).project(camera);
          const sx = (this._corner.x * 0.5 + 0.5) * rendererSize.width;
          const sy = (-this._corner.y * 0.5 + 0.5) * rendererSize.height;
          const dx = sx - bodyScreenX;
          const dy = sy - bodyScreenY;
          const d2 = dx * dx + dy * dy;
          if (d2 > maxDistSq) maxDistSq = d2;
        }
        silhouettePx = Math.sqrt(maxDistSq);
      }
      // Custom-visualizer bodies (SpacecraftMarker dots, GroundStation pins) and
      // anything else fall through to minLabelOffsetPx — those visualizers draw
      // at constant screen-pixel size and the body's `displayRadius` says
      // nothing useful about what the user sees.
      const offsetPx = silhouettePx + this.minLabelOffsetPx;
      const offsetWorld = offsetPx * worldPerPx;

      sprite.position.copy(bm.position);
      sprite.position.addScaledVector(this.right, offsetWorld);
      // Constant 2px nudge down so the left-center-anchored sprite sits
      // visually balanced against the body's center. Was -offsetScale*0.15
      // before, which pushed labels well below center for big bodies.
      sprite.position.addScaledVector(this.up, -2 * worldPerPx);

      this.applyOcclusionFade(sprite, bm.position, distToBody, bodyMeshes, camPos, bm);
      entry.occlusionOpacity = mat.opacity;

      // NASA-Eyes-style fade: once the body's silhouette is large enough to
      // be visually identifiable, drop the label. Only applies to bodies
      // that *have* a meaningful silhouette (Globe + Mesh); custom-visualizer
      // bodies (SC dots, GS pins) stay at constant tiny pixel size so their
      // label is the only ID signal — never self-size-fade them. Pinned
      // labels (selected/tracked) also skip the fade — explicit user focus
      // beats "you can see it."
      let selfSizeFade = 1;
      const hasSilhouette = isGlobe || isMesh;
      if (hasSilhouette && !this._pinnedNames.has(bm.body.name)) {
        const start = this.selfSizeFadeStartPx;
        const end = this.selfSizeFadeEndPx;
        if (silhouettePx > start) {
          const range = Math.max(end - start, 1);
          selfSizeFade = Math.max(0, 1 - (silhouettePx - start) / range);
        }
      }
      entry.selfSizeFade = selfSizeFade;
      // Bake into mat.opacity now so the disable-collision path also fades
      // correctly. The collision pass below overwrites this with the unified
      // formula (occlusion * collisionFade * selfSizeFade * opacityMultiplier)
      // for entries it visits. Don't touch userData — applyOcclusionFade
      // owns that for its own temporal smoothing.
      mat.opacity = entry.occlusionOpacity * selfSizeFade * entry.opacityMultiplier;

      // Stash the projected screen position + pixel size for the collision pass.
      this._projected.copy(sprite.position);
      sprite.parent?.localToWorld(this._projected);
      this._projected.project(camera);
      const behind = this._projected.z > 1;
      entry.screenX = (this._projected.x * 0.5 + 0.5) * rendererSize.width;
      entry.screenY = (-this._projected.y * 0.5 + 0.5) * rendererSize.height;
      // Sprite scale.y is normalized to ~600px viewport in this.fontSize/600;
      // reverse to recover the on-screen pixel height. (Stays in sync with the
      // labelScale * fovScale rescale above.)
      const labelHeightPx = (height * 600) / this.labelScale;
      const labelWidthPx = labelHeightPx * aspect;
      entry.heightPx = labelHeightPx;
      entry.widthPx = labelWidthPx;
      // Mark behind-camera labels as untouchable by the collision pass; their
      // bbox is meaningless.
      if (behind) {
        entry.widthPx = 0;
        entry.heightPx = 0;
      }

      // Add to scene if not already
      if (!sprite.parent) {
        bm.parent?.add(sprite);
      }
    }

    if (!this.disableCollision) {
      this.runCollisionPass(camPos);
    }
  }

  /**
   * Screen-space collision pass. Walks labels in priority-desc, distance-asc
   * order and identifies any whose bbox (padded by `collisionPaddingPx`)
   * overlaps an already-placed bbox. Updates each entry's `collisionFade`
   * toward 0 (collides) or 1 (clear) with temporal smoothing, then writes
   * `material.opacity = occlusionOpacity * collisionFade`.
   *
   * The collision fade is tracked separately from the occlusion fade so the
   * two smoothings don't fight in steady state — an earlier version multiplied
   * opacity in-place each frame which produced a ~0.2 ghosted equilibrium for
   * colliding labels instead of full hide.
   *
   * Labels already faded near-zero by occlusion are skipped entirely — they
   * don't block other labels (so a back-of-Earth ground station doesn't
   * suppress a front-of-Earth spacecraft label sitting at the same XY).
   */
  private static readonly _collisionPaddingPx = 4;
  private static readonly _fadeRate = 0.18;

  private runCollisionPass(camPos: THREE.Vector3): void {
    const entries: Array<LabelEntry & { _camDist: number; _pinned: boolean }> = [];
    for (const entry of this.labels.values()) {
      if (!entry.sprite.visible) continue;
      if (entry.widthPx <= 0 || entry.heightPx <= 0) continue;
      // Already-occluded labels are non-blocking and non-blocked.
      if (entry.occlusionOpacity < 0.05) {
        // Decay collisionFade toward 1 while invisible so reappearing from
        // behind a body doesn't pop bright before re-running the collision
        // logic against current bbox neighbors.
        entry.collisionFade += (1 - entry.collisionFade) * LabelManager._fadeRate;
        continue;
      }
      const dist = entry.bodyMesh.position.distanceTo(camPos);
      const pinned = this._pinnedNames.has(entry.bodyMesh.body.name);
      entries.push(Object.assign(entry, { _camDist: dist, _pinned: pinned }));
    }
    // Pinned labels first (so their bbox lands in `placed` before anything
    // can outrank them), then by classification priority, then closest-to-camera.
    entries.sort((a, b) => {
      if (a._pinned !== b._pinned) return a._pinned ? -1 : 1;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a._camDist - b._camDist;
    });

    const pad = LabelManager._collisionPaddingPx;
    const rate = LabelManager._fadeRate;
    const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
    for (const entry of entries) {
      const halfH = entry.heightPx * 0.5;
      // Sprite anchored at left-center, so bbox extends right from screenX.
      // Pad on all sides so labels that are merely *adjacent* (within a few
      // px) also collide — looks cleaner than rows of touching text.
      const x0 = entry.screenX - pad;
      const x1 = entry.screenX + entry.widthPx + pad;
      const y0 = entry.screenY - halfH - pad;
      const y1 = entry.screenY + halfH + pad;

      // Pinned labels never collide — they always survive. Still added to
      // `placed` below so they block lower-priority labels from overlapping.
      let collides = false;
      if (!entry._pinned) {
        for (const p of placed) {
          if (x0 < p.x1 && x1 > p.x0 && y0 < p.y1 && y1 > p.y0) {
            collides = true;
            break;
          }
        }
      }

      const target = collides ? 0 : 1;
      entry.collisionFade += (target - entry.collisionFade) * rate;
      const mat = entry.sprite.material as THREE.SpriteMaterial;
      // Unified opacity: intrinsic occlusion × NASA-Eyes self-size fade ×
      // collision-pass arbitration × host-supplied multiplier. Each channel
      // is independent so they compose cleanly instead of fighting in
      // steady state.
      mat.opacity =
        entry.occlusionOpacity *
        entry.selfSizeFade *
        entry.collisionFade *
        entry.opacityMultiplier;
      if (!collides) placed.push({ x0, y0, x1, y1 });
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

    // For surface-locked bodies (rovers, landers, ground stations), the parent
    // body needs special handling. The ray-sphere test would either:
    //   - flicker at the limb (label position is right on the parent's silhouette,
    //     so closest-approach jitters across the threshold each frame), or
    //   - falsely fade visible front-side labels (the ray from camera to a surface
    //     point necessarily passes through the parent's sphere from the camera's POV).
    // Instead, we do a hemisphere check: dot(ray_dir, surface_normal). If the ray
    // is going into the surface (back-facing), the label is occluded; otherwise
    // it's visible. Smoothstep gives a clean limb fade with no numerical jitter.
    const excludeParentName = excludeBody?.body.geometryData?.surfaceLock
      ? excludeBody.body.parentName
      : undefined;
    let surfaceHemiFade = 1.0;
    if (excludeParentName) {
      const parent = bodyMeshes.find((b) => b.body.name === excludeParentName);
      if (parent) {
        const nx = worldPos.x - parent.position.x;
        const ny = worldPos.y - parent.position.y;
        const nz = worldPos.z - parent.position.z;
        const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (nLen > 1e-12) {
          // ray.dot(outwardNormal): positive ⇒ ray goes into surface ⇒ back-facing
          const dot = (ray.x * nx + ray.y * ny + ray.z * nz) / nLen;
          // Smooth fade across a narrow band centered on the limb (dot ≈ 0).
          // Width chosen so the fade extends ~5° around the silhouette.
          const fadeWidth = 0.087; // sin(5°)
          // dot < -fadeWidth ⇒ fully visible (1); dot > +fadeWidth ⇒ fully hidden (0)
          const t = Math.max(0, Math.min(1, (dot + fadeWidth) / (2 * fadeWidth)));
          const smooth = t * t * (3 - 2 * t);
          surfaceHemiFade = 1 - smooth;
        }
      }
    }

    let fade = surfaceHemiFade;
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
      // Skip labels that aren't actually rendering — occluded by a body
      // (back-of-Earth ground stations / spacecraft), collision-faded, or
      // self-size-faded. Without this the picker happily returns labels you
      // can't see, so e.g. double-clicking Earth could "track" a satellite
      // on the far side.
      const mat = sprite.material as THREE.SpriteMaterial;
      if (mat.opacity < 0.05) continue;

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
