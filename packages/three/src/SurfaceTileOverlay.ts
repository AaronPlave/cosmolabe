import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer/three';

export interface SurfaceTileConfig {
  /** Human-readable name */
  name: string;
  /** URL to tileset.json */
  url: string;
  /** Geodetic latitude in degrees */
  lat: number;
  /** Geodetic longitude in degrees (east positive) */
  lon: number;
  /** Altitude offset in km above ellipsoid to prevent z-fighting with globe terrain. Default 0.002 */
  altitudeOffset?: number;
  /** Screen-space error target. Default 8. */
  errorTarget?: number;
  /** LRU cache max bytes. Default 128MB. */
  maxCacheBytes?: number;
}

/** Layer for the camera-relative surface tile render pass. */
export const SURFACE_TILE_LAYER = 3;

const _tmpVec = /* @__PURE__ */ new THREE.Vector3();

/**
 * Positions a local-frame 3D tileset on a planetary body's surface.
 *
 * Local-frame tilesets (e.g. Dingo Gap terrain reconstructions) have their origin
 * at a site-local coordinate frame (meters, Z-up) with an identity root transform.
 * This class computes the ECEF placement transform from a geodetic lat/lon and
 * composites the tiles onto the globe alongside the globe-scale terrain.
 *
 * Rendering uses camera-relative rendering (CRR): tile positions are computed in
 * float64 (JS numbers), the camera position is subtracted, and the small delta is
 * cast to float32 for the GPU. This gives full precision at any viewing distance.
 */
export class SurfaceTileOverlay {
  readonly tiles: TilesRenderer;
  /** Group to add to BodyMesh. Gets body rotation + scaleFactor each frame. */
  readonly group: THREE.Group;
  readonly name: string;
  /**
   * ECEF position of tile center in body-fixed km, Y-up.
   * Used for camera-relative rendering: rotated by body quaternion, scaled,
   * then subtracted from camera position — all in float64.
   */
  readonly ecefPositionKm: THREE.Vector3;
  /** Geodetic coordinates for terrain elevation queries */
  readonly lat: number;
  readonly lon: number;
  readonly altitudeOffset: number;
  /**
   * Runtime radial offset (km) applied during CRR to match visible terrain surface.
   * When terrain LOD is coarse, the visible terrain may be higher than the configured
   * altitudeOffset. This shifts the tile radially so it sits on the visible terrain.
   * Set each frame by the caller based on terrain elevation queries.
   */
  terrainAdjustKm = 0;
  private disposed = false;

  constructor(config: SurfaceTileConfig, bodyRadiusKm: number, _renderer: THREE.WebGLRenderer) {
    this.name = config.name;
    this.lat = config.lat;
    this.lon = config.lon;
    this.altitudeOffset = config.altitudeOffset ?? 0.002;
    this.tiles = new TilesRenderer(config.url);

    this.tiles.addEventListener('load-model', (e: any) => {
      const scene = e.scene as THREE.Object3D | undefined;
      if (scene) {
        // Disable Three.js frustum culling — TilesRenderer handles visibility.
        // Force DoubleSide so tiles are visible regardless of face orientation.
        scene.traverse((child: any) => {
          child.frustumCulled = false;
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
      get(target: Map<any, Function>, prop: string | symbol, receiver: any) {
        if (prop === 'get') {
          return (key: any) => {
            const cb = target.get(key);
            if (typeof cb !== 'function') return noopCb;
            return (tile: any) => {
              try { return cb(tile); } catch (e) {
                console.warn('[SpiceCraft] Error in surface tile dispose, caught to prevent stall:', (e as Error).message);
              }
            };
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });

    // Compute the ECEF placement transform for the tileset.
    // Tiles are in a local frame: meters, Z-up, identity root transform.
    //
    // Transform order (applied right-to-left to each point):
    //   RotX(-90°) × Scale(0.001) × Translate(ecef_meters) × Rotate(ENU)
    //
    // 1. ENU rotation: align local XYZ with East/North/Up at lat/lon (Z-up ECEF)
    // 2. Translate: move to ECEF position on Mars surface (Z-up meters)
    // 3. Scale: meters → km (still Z-up)
    // 4. RotX(-90°): Z-up → Y-up (matches SphereGeometry and TerrainManager convention)
    //
    // The RotX(-90°) cancels with the meshRotationQ RotX(+90°) applied via the
    // overlay group quaternion, leaving just spiceQ × ECEF — correct body-fixed
    // placement in the trajectory's inertial frame.
    const altOffset = config.altitudeOffset ?? 0.002;
    const { positionMeters, enuRotation } = computeEcefPlacement(
      config.lat, config.lon, bodyRadiusKm, altOffset,
    );

    // Store ECEF position in body-fixed km, Y-up for CRR computation.
    // Z-up ECEF → Y-up: X stays, old Z becomes Y, old Y becomes -Z.
    this.ecefPositionKm = new THREE.Vector3(
      positionMeters.x * 0.001,
      positionMeters.z * 0.001,
      -positionMeters.y * 0.001,
    );

    const zUpToYUp = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    const scale = new THREE.Matrix4().makeScale(0.001, 0.001, 0.001);
    const translate = new THREE.Matrix4().makeTranslation(
      positionMeters.x, positionMeters.y, positionMeters.z,
    );

    // mat = RotX(-90°) × Scale × Translate × ENU
    const mat = new THREE.Matrix4();
    mat.copy(zUpToYUp);
    mat.multiply(scale);
    mat.multiply(translate);
    mat.multiply(enuRotation);

    this.tiles.group.matrixAutoUpdate = false;
    this.tiles.group.matrix.copy(mat);
    this.tiles.group.matrixWorldNeedsUpdate = true;

    this.group = new THREE.Group();
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

    this.tiles.setCamera(cam);
    this.tiles.setResolutionFromRenderer(cam, renderer);

    try {
      this.tiles.update();
    } catch (e) {
      console.error('[SpiceCraft] Surface tiles update crashed:', e);
    }

    // Restore original near/far for the main render passes
    cam.near = savedNear;
    cam.far = savedFar;
    cam.updateProjectionMatrix();
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
    let dx = bodyWorldPos.x - cameraWorldPos.x;
    let dy = bodyWorldPos.y - cameraWorldPos.y;
    let dz = bodyWorldPos.z - cameraWorldPos.z;

    // Apply terrain-following radial adjustment.
    // Shifts the tile radially (along the body-to-tile direction) so it sits
    // on the visible terrain surface rather than at its configured altitude.
    if (this.terrainAdjustKm !== 0) {
      // Radial direction: ecefPositionKm normalized, rotated to world frame
      const ecefLen = this.ecefPositionKm.length();
      if (ecefLen > 0) {
        _tmpVec.copy(this.ecefPositionKm).multiplyScalar(1 / ecefLen).applyQuaternion(bodyQuaternion);
        const adjustScene = this.terrainAdjustKm * scaleFactor;
        dx += _tmpVec.x * adjustScene;
        dy += _tmpVec.y * adjustScene;
        dz += _tmpVec.z * adjustScene;
      }
    }

    // Group transform: Translation(delta) × Rotation × Scale
    // tiles.group.matrix then applies the local ECEF placement on top.
    this.group.position.set(dx, dy, dz);
    this.group.quaternion.copy(bodyQuaternion);
    this.group.scale.setScalar(scaleFactor);
    this.group.updateMatrixWorld(true);
  }

  /**
   * Distance from camera to tile center, computed in float64 for near/far.
   * Includes terrainAdjustKm radial offset.
   */
  distanceTo(
    cameraWorldPos: THREE.Vector3,
    bodyWorldPos: THREE.Vector3,
    bodyQuaternion: THREE.Quaternion,
    scaleFactor: number,
  ): number {
    _tmpVec.copy(this.ecefPositionKm).applyQuaternion(bodyQuaternion);
    let tx = bodyWorldPos.x + _tmpVec.x * scaleFactor;
    let ty = bodyWorldPos.y + _tmpVec.y * scaleFactor;
    let tz = bodyWorldPos.z + _tmpVec.z * scaleFactor;

    // Apply radial terrain adjustment
    if (this.terrainAdjustKm !== 0) {
      const ecefLen = this.ecefPositionKm.length();
      if (ecefLen > 0) {
        // _tmpVec = ecefPositionKm rotated to world frame, length = ecefLen
        // Unit radial direction in world = _tmpVec / ecefLen
        const adjustScene = this.terrainAdjustKm * scaleFactor;
        tx += (_tmpVec.x / ecefLen) * adjustScene;
        ty += (_tmpVec.y / ecefLen) * adjustScene;
        tz += (_tmpVec.z / ecefLen) * adjustScene;
      }
    }

    const dx = tx - cameraWorldPos.x;
    const dy = ty - cameraWorldPos.y;
    const dz = tz - cameraWorldPos.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tiles.dispose();
  }
}

/**
 * Compute the ECEF position (in meters) and ENU rotation matrix for a geodetic
 * lat/lon on a spherical body. Position is in meters (matching 3D Tiles convention)
 * so the Scale(0.001) in the transform chain converts to km.
 */
function computeEcefPlacement(
  latDeg: number, lonDeg: number, radiusKm: number, altOffsetKm: number,
): { positionMeters: THREE.Vector3; enuRotation: THREE.Matrix4 } {
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;

  const rMeters = (radiusKm + altOffsetKm) * 1000;
  const cosLat = Math.cos(lat);
  const sinLat = Math.sin(lat);
  const cosLon = Math.cos(lon);
  const sinLon = Math.sin(lon);

  // ECEF position on sphere (meters, Z-up)
  const x = rMeters * cosLat * cosLon;
  const y = rMeters * cosLat * sinLon;
  const z = rMeters * sinLat;

  // ENU axes at this geodetic position (unit vectors in ECEF):
  // East  = (-sinLon, cosLon, 0)
  // North = (-sinLat*cosLon, -sinLat*sinLon, cosLat)
  // Up    = (cosLat*cosLon, cosLat*sinLon, sinLat)
  const east  = new THREE.Vector3(-sinLon, cosLon, 0);
  const north = new THREE.Vector3(-sinLat * cosLon, -sinLat * sinLon, cosLat);
  const up    = new THREE.Vector3(cosLat * cosLon, cosLat * sinLon, sinLat);

  // Columns = where local X(East), Y(North), Z(Up) map to in ECEF Z-up
  const enuRotation = new THREE.Matrix4().makeBasis(east, north, up);

  return { positionMeters: new THREE.Vector3(x, y, z), enuRotation };
}
