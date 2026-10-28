import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer/three';

import { siteMeshPlacement, type SiteMeshConfig } from './SiteMeshPlacement.js';

export type SurfaceTileConfig = SiteMeshConfig;

/** Layer for the camera-relative surface tile render pass. */
export const SURFACE_TILE_LAYER = 3;

const _tmpVec = /* @__PURE__ */ new THREE.Vector3();

/**
 * Positions a local-frame 3D tileset on a planetary body's surface.
 *
 * Each tileset has one versioned, fixed local-to-body transform. Its source
 * axes and metre units are established offline, never inferred from glTF's
 * up-axis flag. Global terrain LOD does not participate in placement.
 *
 * Rendering uses camera-relative rendering (CRR): tile positions are computed in
 * float64 (JS numbers), the camera position is subtracted, and the small delta is
 * cast to float32 for the GPU. This gives full precision at any viewing distance.
 */
export class SurfaceTileOverlay {
  readonly tiles: TilesRenderer;
  /** Separate scene group; receives body rotation and scale each frame. */
  readonly group: THREE.Group;
  readonly name: string;
  /**
   * ECEF position of tile center in body-fixed km, Y-up.
   * Used for camera-relative rendering: rotated by body quaternion, scaled,
   * then subtracted from camera position — all in float64.
   */
  readonly ecefPositionKm: THREE.Vector3;
  /** Explicitly display-only; globe terrain owns all physical queries. */
  readonly physicalQueryPolicy = 'visual-only' as const;
  readonly registration: SiteMeshConfig['registration'];
  readonly coverage: SiteMeshConfig['coverage'];
  readonly priority: number;
  private readonly envelope: THREE.Sphere;
  private disposed = false;

  constructor(config: SurfaceTileConfig) {
    const mat = siteMeshPlacement(config);
    this.name = config.name;
    this.registration = structuredClone(config.registration);
    this.coverage = structuredClone(config.coverage);
    this.envelope = new THREE.Box3(new THREE.Vector3().fromArray(config.coverage.min),
      new THREE.Vector3().fromArray(config.coverage.max)).applyMatrix4(mat).getBoundingSphere(new THREE.Sphere());
    this.priority = config.priority ?? 0;
    this.tiles = new TilesRenderer(config.url);

    this.tiles.addEventListener('load-model', (e: any) => {
      const scene = e.scene as THREE.Object3D | undefined;
      if (scene) {
        // Disable Three.js frustum culling — TilesRenderer handles visibility.
        // Force DoubleSide so tiles are visible regardless of face orientation.
        scene.traverse((child: any) => {
          child.frustumCulled = false;
          // Three's nested groups replace inherited groupOrder. Propagate the
          // site's order through the loaded hierarchy so inner glTF groups do
          // not silently erase the catalog's coincident-site priority.
          child.renderOrder = this.priority;
          if (child.isMesh && child.material) {
            child.material.side = THREE.DoubleSide;
          }
        });
      }
    });
    this.tiles.addEventListener('load-error', (e: any) => {
      console.error(`[SurfaceTiles:${config.name}] Load error:`, e.url, e.error?.message);
    });

    // Upstream bug guard: plugins access tile.children.length in disposeTile
    // without null checks. During LRU eviction tile.children can be null.
    this.tiles.registerPlugin({
      disposeTile(tile: any) {
        if (!tile.children) tile.children = [];
      },
    } as any);

    if (config.errorTarget != null) {
      this.tiles.errorTarget = config.errorTarget;
    } else {
      this.tiles.errorTarget = 2;
    }
    this.tiles.lruCache.maxBytesSize = config.maxCacheBytes ?? 128 * 1024 * 1024;
    this.tiles.lruCache.minBytesSize = this.tiles.lruCache.maxBytesSize * .75;
    this.tiles.downloadQueue.maxJobs = 8;
    this.tiles.parseQueue.maxJobs = 4;

    // Upstream bug guard: disposeTile crashes when engineData fields are null
    const origDisposeTile = (this.tiles as any).disposeTile.bind(this.tiles);
    (this.tiles as any).disposeTile = (tile: any) => {
      const ed = tile?.engineData;
      if (ed?.scene) {
        if (!ed.geometry) ed.geometry = [];
        if (!ed.materials) ed.materials = [];
        if (!ed.textures) ed.textures = [];
      }
      return origDisposeTile(tile);
    };

    // Upstream bug: LRU cache dispose callback errors stall all future loading
    const cache = this.tiles.lruCache as any;
    const origCallbacks = cache.callbacks;
    const noopCb = () => {};
    cache.callbacks = new Proxy(origCallbacks, {
      get(target: Map<any, (tile: unknown) => unknown>, prop: string | symbol, receiver: any) {
        if (prop === 'get') {
          return (key: any) => {
            const cb = target.get(key);
            if (typeof cb !== 'function') return noopCb;
            return (tile: any) => {
              try { return cb(tile); } catch (e) {
                console.warn('[Cosmolabe] Error in surface tile dispose, caught to prevent stall:', (e as Error).message);
              }
            };
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });

    // Float64 body-fixed placement, including source units and axis convention.
    this.ecefPositionKm = new THREE.Vector3().setFromMatrixPosition(mat);

    this.tiles.group.matrixAutoUpdate = false;
    this.tiles.group.renderOrder = this.priority;
    this.tiles.group.matrix.copy(mat);
    this.tiles.group.matrixWorldNeedsUpdate = true;

    this.group = new THREE.Group();
    this.group.renderOrder = this.priority;
    this.group.name = `surface-tiles-${config.name}`;
    this.group.add(this.tiles.group);
  }

  /**
   * Per-frame update. Temporarily adjusts camera near/far to sane values
   * before calling TilesRenderer.update() — the main scene's extreme near/far
   * ratio (up to 10^16 when close to a body surface) creates degenerate frustum
   * planes that cause TilesRenderer to incorrectly frustum-cull tiles.
   */
  update(camera: THREE.Camera, renderer: THREE.WebGLRenderer): void {
    if (this.disposed) return;

    const cam = camera as THREE.PerspectiveCamera;

    // Save and override near/far for TilesRenderer LOD computation.
    // The main scene's dynamic near/far can be 1e-11..1e6 (ratio 10^16) which
    // creates numerically degenerate frustum planes. Use a tight range that
    // covers the surface tile's bounding volume without precision issues.
    const savedNear = cam.near;
    const savedFar = cam.far;
    cam.near = 1e-8;   // ~10 meters in scene units
    cam.far = 1e-1;    // ~100,000 km in scene units
    cam.updateProjectionMatrix();

    try {
      this.tiles.setCamera(cam);
      this.tiles.setResolutionFromRenderer(cam, renderer);
      this.tiles.update();
    } catch (e) {
      console.error('[Cosmolabe] Surface tiles update crashed:', e);
    } finally {
      cam.near = savedNear;
      cam.far = savedFar;
      cam.updateProjectionMatrix();
    }
  }

  /**
   * Set camera-relative transform for the surface tile render pass.
   * The overlay group lives in a separate tileScene (not parented to BodyMesh),
   * so we compute the full world position in float64 (JS numbers), subtract
   * the camera position, and set the small delta as the group position.
   * This gives full float32 precision on the GPU at any viewing distance.
   */
  setCameraRelativeTransform(
    bodyWorldPos: THREE.Vector3,
    bodyQuaternion: THREE.Quaternion,
    scaleFactor: number,
    cameraWorldPos: THREE.Vector3,
  ): void {
    // Camera-relative body center position (all float64 via JS numbers).
    // The tiles.group.matrix handles the ECEF offset from body center to
    // tile location, so we only need to offset the body center here.
    const dx = bodyWorldPos.x - cameraWorldPos.x;
    const dy = bodyWorldPos.y - cameraWorldPos.y;
    const dz = bodyWorldPos.z - cameraWorldPos.z;

    // Group transform: Translation(delta) × Rotation × Scale
    // tiles.group.matrix then applies the local ECEF placement on top.
    this.group.position.set(dx, dy, dz);
    this.group.quaternion.copy(bodyQuaternion);
    this.group.scale.setScalar(scaleFactor);
    this.group.updateMatrixWorld(true);
  }

  /**
   * Distance from camera to tile center, computed in float64 for near/far.
   */
  distanceTo(
    cameraWorldPos: THREE.Vector3,
    bodyWorldPos: THREE.Vector3,
    bodyQuaternion: THREE.Quaternion,
    scaleFactor: number,
  ): number {
    _tmpVec.copy(this.ecefPositionKm).applyQuaternion(bodyQuaternion);
    const tx = bodyWorldPos.x + _tmpVec.x * scaleFactor;
    const ty = bodyWorldPos.y + _tmpVec.y * scaleFactor;
    const tz = bodyWorldPos.z + _tmpVec.z * scaleFactor;

    const dx = tx - cameraWorldPos.x;
    const dy = ty - cameraWorldPos.y;
    const dz = tz - cameraWorldPos.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Proven foreground depth can be retained without depth-fighting the cube
   * under this display envelope. Inside it, composite remains a visual policy,
   * not evidence that local triangles are physically in front of the cube. */
  foregroundDistanceTo(camera: THREE.Vector3, body: THREE.Vector3, rotation: THREE.Quaternion, scale: number): number {
    const center = this.envelope.center.clone().applyQuaternion(rotation).multiplyScalar(scale).add(body);
    return Math.max(0, camera.distanceTo(center) - this.envelope.radius * scale);
  }

  /** Explicit recovery after a source outage; retain the same placement. */
  retryFailed(): void {
    if (this.disposed) return;
    // 0.4.27's resetFailedTiles traverses unprocessed descendants and reads
    // tile.internal unconditionally. After eviction, some descendants have
    // never been prepared. Guard its callback without preparing the entire
    // tree or inventing runtime metadata for those source nodes.
    const traverse = this.tiles.traverse;
    this.tiles.traverse = (before, ...rest) => traverse.call(this.tiles,
      before ? (tile, parent, depth) => (tile as { internal?: unknown }).internal
        ? before(tile, parent, depth) : false : null, ...rest);
    try {
      this.tiles.resetFailedTiles();
    } finally {
      this.tiles.traverse = traverse;
    }
  }

  /** Conservative near-hemisphere gate for the explicit composite pass. Do not
   * let a visual-only reconstruction paint through the far side of a planet.
   * Near the site, allow the full local envelope, including below-datum cameras. */
  visibleFrom(camera: THREE.Vector3, body: THREE.Vector3, rotation: THREE.Quaternion, scale: number): boolean {
    const radius = this.ecefPositionKm.length();
    if (radius === 0) return false;
    _tmpVec.copy(camera).sub(body).divideScalar(scale).applyQuaternion(rotation.clone().invert());
    const envelopeKm = Math.hypot(...this.coverage.min, ...this.coverage.max) * 0.001;
    return _tmpVec.distanceTo(this.ecefPositionKm) <= envelopeKm * 2
      || _tmpVec.dot(this.ecefPositionKm) / radius + envelopeKm >= radius;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tiles.dispose();
    this.group.removeFromParent();
  }
}
