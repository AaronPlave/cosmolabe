import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer/three';
import { QuantizedMeshPlugin, ImageOverlayPlugin, XYZTilesOverlay, TilesFadePlugin, DebugTilesPlugin, XYZTilesPlugin } from '3d-tiles-renderer/three/plugins';

export interface TerrainImageryConfig {
  /** XYZ tile URL template with {x}, {y}, {z} placeholders */
  url: string;
  /** Max zoom level available. Default 8. */
  levels?: number;
  /** Tile pixel dimension. Default 256. */
  dimension?: number;
  /** Projection identifier. Default 'EPSG:4326'. */
  projection?: string;
}

export interface TerrainConfig {
  /** Terrain source type. 'imagery' uses XYZ image tiles projected onto an ellipsoid (no terrain mesh needed). */
  type: 'quantized-mesh' | 'cesium-ion' | '3dtiles' | 'imagery';
  /** Base URL for quantized-mesh or 3dtiles tileset.json */
  url?: string;
  /** Cesium Ion asset ID (for type: 'cesium-ion') */
  cesiumIonAssetId?: number;
  /** Cesium Ion API token (for type: 'cesium-ion') */
  cesiumIonToken?: string;
  /** Imagery overlay to drape on terrain */
  imagery?: TerrainImageryConfig;
  /** Screen-space error threshold — higher = coarser tiles. Default 6. */
  errorTarget?: number;
  /** LRU cache max bytes. Default 256MB. */
  maxCacheBytes?: number;
  /** URL of a heightmap to derive per-pixel normals from.
   *  Applied to terrain tiles to smooth shadow boundaries at the terminator. */
  normalMapUrl?: string;
  /** Normal map strength (higher = more dramatic shadows). Default 3. */
  normalMapStrength?: number;
}

/**
 * Manages streaming terrain tiles for a planetary body.
 * Wraps 3DTilesRendererJS's TilesRenderer with appropriate plugins
 * and coordinate transforms for non-Earth bodies.
 */
const _camPos = /* @__PURE__ */ new THREE.Vector3();

export class TerrainManager {
  readonly tiles: TilesRenderer;
  /** Group to add to the scene. Positioned at body center, transforms meters→km and Z-up→Y-up. */
  readonly group: THREE.Group;
  private readonly isImageryOnly: boolean;
  private disposed = false;
  /** Global equirectangular normal map derived from heightmap. Applied per-tile with UV transforms. */
  private normalMap: THREE.CanvasTexture | null = null;
  private debugPlugin: DebugTilesPlugin | null = null;
  /** Coverage camera: ensures tiles load for the body's visible hemisphere
   *  even when the main camera's frustum doesn't include the body. */
  private coverageCam: THREE.PerspectiveCamera | null = null;
  /** Terrain camera: mirrors main camera with terrain-appropriate near/far.
   *  The scene camera's near/far can have extreme ratios (1e-12/1e6) that
   *  produce degenerate frustum planes in the tiles renderer's SAT test. */
  private terrainCam: THREE.PerspectiveCamera | null = null;

  /**
   * @param config Terrain source configuration
   * @param bodyRadiusKm Mean body radius in km (used to set ellipsoid)
   * @param renderer WebGL renderer (needed for ImageOverlayPlugin texture rendering)
   */
  constructor(config: TerrainConfig, bodyRadiusKm: number, renderer: THREE.WebGLRenderer) {
    this.isImageryOnly = config.type === 'imagery';

    // For imagery-only mode, no tileset URL needed — XYZTilesPlugin generates geometry.
    // For terrain modes, QuantizedMeshPlugin needs the base URL (it fetches layer.json).
    this.tiles = new TilesRenderer(this.isImageryOnly ? undefined : config.url);

    // Upstream bug guard: multiple plugins (QuantizedMeshPlugin, ImageOverlayPlugin)
    // access tile.children.length in disposeTile without null checks. During LRU cache
    // eviction, tile.children can be null. Register a guard plugin FIRST so its
    // disposeTile runs before the others and ensures children is always an array.
    this.tiles.registerPlugin({
      disposeTile(tile: any) {
        if (!tile.children) tile.children = [];
      },
    } as any);

    if (this.isImageryOnly) {
      // Imagery-only mode: XYZTilesPlugin generates ellipsoid geometry with draped image tiles.
      // No terrain mesh needed — imagery is projected directly onto the ellipsoid surface.
      const img = config.imagery!;
      this.tiles.registerPlugin(new XYZTilesPlugin({
        url: img.url,
        levels: img.levels ?? 8,
        shape: 'ellipsoid',
        useRecommendedSettings: true,
      }));
    } else {
      if (config.type === 'quantized-mesh') {
        this.tiles.registerPlugin(new QuantizedMeshPlugin({
          useRecommendedSettings: true,
        }));
      }

      // Imagery overlay: drape XYZ image tiles onto terrain geometry
      if (config.imagery) {
        const img = config.imagery;
        const overlay = new XYZTilesOverlay({
          url: img.url,
          levels: img.levels ?? 8,
          dimension: img.dimension ?? 256,
          projection: img.projection ?? 'EPSG:4326',
          color: 0xffffff,
          opacity: 1,
        });
        this.tiles.registerPlugin(new ImageOverlayPlugin({
          overlays: [overlay],
          renderer,
          enableTileSplitting: false,
        }));
      }
    }

    // Fade between LOD transitions to smooth color differences between zoom levels.
    this.tiles.registerPlugin(new TilesFadePlugin({ fadeDuration: 300 }));

    // Upstream bug: QuantizedMeshPlugin.expandChildren always pushes new children
    // without checking if children already exist. When a tile is evicted from the LRU
    // cache, disposeTile removes virtual children but keeps real ones. When the tile
    // is re-loaded, expandChildren creates duplicates. The old children have .traversal
    // (from preprocessing) but the new ones don't, causing TypeError crashes in the
    // traversal that silently abort the entire update cycle — no tiles get queued.
    //
    // Fix: skip only if all 4 quadtree children are present. If < 4, some virtual
    // children were removed during eviction — clear and re-expand to fill the gaps.
    // The cleared children get re-preprocessed on the next traversal cycle.
    const qmPlugin = (this.tiles as any).getPluginByName('QUANTIZED_MESH_PLUGIN');
    if (qmPlugin && qmPlugin.expandChildren) {
      const origExpand = qmPlugin.expandChildren.bind(qmPlugin);
      qmPlugin.expandChildren = (tile: any) => {
        if (tile.children && tile.children.length >= 4) return;
        // Clear partial children to prevent duplicates, then re-expand.
        tile.children = [];
        origExpand(tile);
      };
    }

    // Customize tile materials as they load
    this.tiles.addEventListener('load-model', (event: { scene: THREE.Object3D; tile: any }) => {
      this.customizeTileMaterial(event.scene, event.tile);
    });

    // Log tile load errors — helps diagnose terrain culling at deep zoom levels
    this.tiles.addEventListener('load-error', (event: any) => {
      console.warn('[SpiceCraft:Terrain] Tile load error:', event.url, event.error?.message);
    });

    // Load heightmap and generate per-pixel normal map for terrain tiles.
    // Smooths out the faceted vertex-normal shading from coarse tile geometry.
    if (config.normalMapUrl) {
      this.loadNormalMap(config.normalMapUrl, config.normalMapStrength ?? 1.5);
    }

    // Set ellipsoid to the body's radius (in meters, which is what 3D Tiles uses)
    const radiusM = bodyRadiusKm * 1000;
    this.tiles.ellipsoid.radius.set(radiusM, radiusM, radiusM);

    // Only override errorTarget if explicitly set in config.
    // QuantizedMeshPlugin's useRecommendedSettings already sets errorTarget=2.
    if (config.errorTarget != null) {
      this.tiles.errorTarget = config.errorTarget;
    } else if (this.isImageryOnly) {
      // Imagery-only: match the quantized-mesh default. Going lower (e.g. 1)
      // causes more zoom-level mixing, which shows as color seams in composite
      // imagery sources where adjacent zoom levels have different color grading.
      this.tiles.errorTarget = 2;
    }
    this.tiles.lruCache.maxBytesSize = config.maxCacheBytes ?? 512 * 1024 * 1024;
    this.tiles.downloadQueue.maxJobs = 12;
    this.tiles.parseQueue.maxJobs = 6;

    // Upstream bug: ThreeJS TilesRenderer.disposeTile crashes when
    // engineData.geometry/materials/textures are null (tile was partially loaded
    // or already disposed). Guard by ensuring arrays exist before the original runs.
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

    // Upstream bugs cause crashes inside dispose callbacks during LRU cache eviction.
    // The cache's unloadUnusedContent uses forEach to splice+dispose items. If any
    // dispose callback throws, the forEach aborts — orphaning remaining items and
    // stalling all future tile loading. Proxy the callbacks Map so every dispose
    // callback returned by .get() is individually wrapped in try-catch.
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
                console.warn('[SpiceCraft] Error in tile dispose, caught to prevent stall:', (e as Error).message);
              }
            };
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });

    // The tiles.group contains tile meshes in meters, Z-up (3D Tiles convention).
    // We need to transform to spicecraft's coordinate system: km, Y-up.
    // Wrap in a parent group that applies the conversion.
    this.group = new THREE.Group();
    this.group.name = 'terrain';

    // Scale: meters → km
    const mToKm = 0.001;
    this.tiles.group.scale.setScalar(mToKm);

    // Rotate: Z-up → Y-up (rotate -90° around X)
    this.tiles.group.rotation.x = -Math.PI / 2;

    this.group.add(this.tiles.group);
  }

  /**
   * Call once per frame to update tile LOD based on camera position.
   * @param camera Scene camera
   * @param renderer WebGL renderer
   * @param bodyWorldPos World-space position of the body center (for coverage camera)
   */
  update(camera: THREE.Camera, renderer: THREE.WebGLRenderer, bodyWorldPos?: THREE.Vector3): void {
    if (this.disposed) return;

    // Compute terrain-appropriate near/far from camera-to-body distance.
    // The scene camera can have extreme near/far ratios (e.g. 1e-12 / 1e6)
    // which make projection matrix rows 3 and 4 nearly identical. When
    // 3d-tiles-renderer extracts frustum planes via SAT, the far plane
    // (row4 - row3) collapses to zero → NaN after normalization → the root
    // tile's bounding volume fails the frustum test → 0 tiles rendered.
    _camPos.setFromMatrixPosition(camera.matrixWorld);
    const distToBody = bodyWorldPos ? _camPos.distanceTo(bodyWorldPos) : 0;
    // near/far in scene space: near = 0.1% of body distance, far = 100× body distance.
    // This keeps the ratio ≤ 1e5, well within Float64 precision for frustum extraction.
    const terrainNear = Math.max(1e-8, distToBody * 0.001);
    const terrainFar = Math.max(distToBody * 100, 1e-2);

    // Terrain camera: mirrors main camera but with terrain-appropriate near/far.
    const mainCam = camera as THREE.PerspectiveCamera;
    if (!this.terrainCam) {
      this.terrainCam = new THREE.PerspectiveCamera(mainCam.fov, mainCam.aspect, terrainNear, terrainFar);
    }
    const tc = this.terrainCam;
    // Use a wider FOV than the main camera so terrain tiles load beyond the
    // view edges. At close range (near surface), camera rotation can quickly
    // expose new terrain; pre-loading with a wider frustum prevents gaps.
    tc.fov = Math.min(mainCam.fov * 1.5, 120);
    tc.aspect = mainCam.aspect;
    tc.near = terrainNear;
    tc.far = terrainFar;
    tc.updateProjectionMatrix();
    tc.position.copy(_camPos);
    tc.quaternion.copy(mainCam.quaternion);
    tc.updateMatrixWorld();

    this.tiles.setCamera(tc);
    this.tiles.setResolutionFromRenderer(tc, renderer);

    // Coverage cameras: ensure tiles load for the full visible hemisphere.
    // At close range (near surface), the terrain camera only sees ±45° from
    // the view direction, missing terrain at the sides and horizon. Two wide
    // coverage cameras cover the full sphere:
    //   1. Nadir camera: 178° FOV looking at body center → covers 0°-89° from nadir
    //   2. Zenith camera: 178° FOV looking away from body center → covers horizon+
    // Together they ensure no terrain gap at the horizon (90° from nadir).
    if (bodyWorldPos) {
      if (!this.coverageCam) {
        this.coverageCam = new THREE.PerspectiveCamera(178, 1, terrainNear, terrainFar);
      }
      const cc = this.coverageCam;
      // Coverage camera looks toward body center. When near the surface, tiles
      // directly below are at ~0 distance — terrainNear (computed for the
      // horizontal terrain camera) would clip them. Use a much smaller near
      // so all surface tiles pass the frustum test.
      cc.near = Math.max(1e-10, terrainNear * 0.001);
      cc.far = Math.max(distToBody * 2, terrainFar);
      cc.updateProjectionMatrix();
      cc.position.copy(_camPos);
      cc.up.copy(camera.up);
      cc.lookAt(bodyWorldPos);
      cc.updateMatrixWorld();
      this.tiles.setCamera(cc);
      this.tiles.setResolutionFromRenderer(cc, renderer);
    }

    try {
      this.tiles.update();
    } catch (e) {
      console.error('[SpiceCraft] tiles.update() crashed:', e);
    }
  }

  /**
   * Sample terrain elevation at a given geodetic position by finding the closest
   * loaded terrain vertex. Returns height in km above the reference sphere, or null
   * if no terrain is loaded near that position.
   *
   * Also returns the angular distance (degrees) of the closest vertex for diagnostics.
   */
  sampleElevationKm(latDeg: number, lonDeg: number, bodyRadiusKm: number): { elevationKm: number; angularDistDeg: number } | null {
    const lat = latDeg * Math.PI / 180;
    const lon = lonDeg * Math.PI / 180;
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    const cosLon = Math.cos(lon);
    const sinLon = Math.sin(lon);

    // Target direction in ECEF Z-up (unit vector)
    const targetX = cosLat * cosLon;
    const targetY = cosLat * sinLon;
    const targetZ = sinLat;

    let closestDist = Infinity;
    let closestRadiusKm = 0;

    // tiles.group.matrixWorld⁻¹ × child.matrixWorld gives us the child's
    // transform in tiles.group's child space, which is ECEF meters Z-up
    // (that's what the QuantizedMeshLoader outputs).
    const groupInv = new THREE.Matrix4().copy(this.tiles.group.matrixWorld).invert();
    const localMat = new THREE.Matrix4();
    const v = new THREE.Vector3();

    this.tiles.group.traverse((child: any) => {
      if (!child.isMesh || !child.geometry) return;
      const pos = child.geometry.getAttribute('position');
      if (!pos) return;

      localMat.multiplyMatrices(groupInv, child.matrixWorld);

      // Sample every 4th vertex to keep per-frame cost reasonable.
      // At step=4, each 65×65 tile contributes ~1056 samples — still dense
      // enough to find a vertex within ~0.01° of any target lat/lon.
      for (let i = 0; i < pos.count; i += 4) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
        v.applyMatrix4(localMat);
        // v is now in ECEF meters, Z-up
        const r = v.length();
        if (r < 1) continue;
        // Direction in ECEF Z-up
        const dx = v.x / r - targetX;
        const dy = v.y / r - targetY;
        const dz = v.z / r - targetZ;
        const angDist = dx * dx + dy * dy + dz * dz;
        if (angDist < closestDist) {
          closestDist = angDist;
          closestRadiusKm = r / 1000;
        }
      }
    });

    if (closestDist === Infinity) return null;
    // angDist² ≈ 2(1 - cos θ) ≈ θ² for small θ; convert to degrees
    const angularDistDeg = Math.sqrt(closestDist) * (180 / Math.PI);
    return { elevationKm: closestRadiusKm - bodyRadiusKm, angularDistDeg };
  }

  /** Log tile renderer stats to console for debugging */
  logStats(): void {
    const t = this.tiles as any;
    const cache = t.lruCache as any;
    const queue = t.downloadQueue as any;

    console.table({
      visibleTiles: t.visibleTiles?.size ?? '?',
      activeTiles: t.activeTiles?.size ?? '?',
      errorTarget: t.errorTarget,
      cacheMB: `${((cache.cachedBytes ?? 0) / (1024 * 1024)).toFixed(1)} / ${(cache.maxBytesSize / (1024 * 1024)).toFixed(0)}`,
      downloading: queue.currJobs ?? '?',
      queued: queue.items?.length ?? '?',
    });

    // Active tile depth and error
    const depthCounts: Record<number, number> = {};
    let maxErr = 0, minErr = Infinity;
    t.activeTiles?.forEach((tile: any) => {
      const depth = tile.internal?.depth ?? -1;
      depthCounts[depth] = (depthCounts[depth] || 0) + 1;
      const err = tile.traversal?.error ?? 0;
      if (err > maxErr) maxErr = err;
      if (err < minErr) minErr = err;
    });
    console.log('[SpiceCraft] Active tiles by depth:', depthCounts,
      '| error range:', minErr.toFixed(2), '-', maxErr.toFixed(2));
  }

  /** Toggle debug tile bounds visualization. Lazily registers the plugin on first enable. */
  setDebug(show: boolean): void {
    if (show && !this.debugPlugin) {
      this.debugPlugin = new DebugTilesPlugin({ displayBoxBounds: true, displayRegionBounds: true });
      this.tiles.registerPlugin(this.debugPlugin);
    } else if (this.debugPlugin) {
      this.debugPlugin.displayBoxBounds = show;
      this.debugPlugin.displayRegionBounds = show;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.terrainCam) {
      this.tiles.deleteCamera(this.terrainCam);
      this.terrainCam = null;
    }
    if (this.coverageCam) {
      this.tiles.deleteCamera(this.coverageCam);
      this.coverageCam = null;
    }
    this.normalMap?.dispose();
    this.tiles.dispose();
  }

  // ---------------------------------------------------------------------------
  // Normal map from heightmap — per-pixel surface normals for smooth terminators
  // ---------------------------------------------------------------------------

  private async loadNormalMap(url: string, strength: number): Promise<void> {
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.crossOrigin = 'anonymous';
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = url;
      });

      this.normalMap = this.generateNormalMap(img, strength);
      console.log(`[SpiceCraft] Generated terrain normal map from heightmap (${this.normalMap.image.width}x${this.normalMap.image.height})`);

      // Retroactively apply to tiles that loaded before the normal map was ready
      this.tiles.forEachLoadedModel((scene: THREE.Object3D, tile: any) => {
        this.applyNormalMap(scene, tile);
      });
    } catch (e) {
      console.warn('[SpiceCraft] Failed to load terrain normal map source:', e);
    }
  }

  /**
   * Generate a tangent-space normal map from a heightmap image.
   * Caps resolution at 4096px wide for performance (~32MB working memory).
   */
  private generateNormalMap(img: HTMLImageElement, strength: number): THREE.CanvasTexture {
    const maxDim = 4096;
    let w = img.naturalWidth ?? img.width;
    let h = img.naturalHeight ?? img.height;
    if (w > maxDim) {
      h = Math.round(h * maxDim / w);
      w = maxDim;
    }

    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = w;
    srcCanvas.height = h;
    const srcCtx = srcCanvas.getContext('2d')!;
    srcCtx.drawImage(img, 0, 0, w, h);
    const srcData = srcCtx.getImageData(0, 0, w, h).data;

    const outCanvas = document.createElement('canvas');
    outCanvas.width = w;
    outCanvas.height = h;
    const outCtx = outCanvas.getContext('2d')!;
    const outImg = outCtx.createImageData(w, h);
    const out = outImg.data;

    // Sample height, wrapping horizontally (equirectangular), clamping vertically
    const getH = (x: number, y: number) => {
      x = ((x % w) + w) % w;
      y = Math.max(0, Math.min(h - 1, y));
      return srcData[(y * w + x) * 4] / 255;
    };

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const hL = getH(x - 1, y);
        const hR = getH(x + 1, y);
        const hU = getH(x, y - 1);
        const hD = getH(x, y + 1);
        const dx = (hR - hL) * strength;
        const dy = (hD - hU) * strength;
        const len = Math.sqrt(dx * dx + dy * dy + 1);
        const idx = (y * w + x) * 4;
        out[idx]     = (-dx / len * 0.5 + 0.5) * 255;
        out[idx + 1] = (-dy / len * 0.5 + 0.5) * 255;
        out[idx + 2] = (1 / len * 0.5 + 0.5) * 255;
        out[idx + 3] = 255;
      }
    }

    outCtx.putImageData(outImg, 0, 0);
    const tex = new THREE.CanvasTexture(outCanvas);
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
  }

  /**
   * Set material properties on a loaded tile, blend normals toward sphere, and apply normal map.
   */
  private customizeTileMaterial(scene: THREE.Object3D, tile: any): void {
    // Disable Three.js frustum culling — TilesRenderer handles visibility.
    // The main camera's extreme near/far ratio (up to 10^14 with log depth)
    // can produce degenerate frustum planes that incorrectly cull tiles.
    scene.traverse((child) => { child.frustumCulled = false; });

    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !child.material) return;

      // Imagery-only tiles use MeshBasicMaterial (unlit). Swap to MeshStandardMaterial
      // to match the placeholder sphere's lighting response.
      if (this.isImageryOnly && child.material instanceof THREE.MeshBasicMaterial && child.material.map) {
        const basic = child.material;
        child.material = new THREE.MeshStandardMaterial({
          map: basic.map,
          transparent: false,
          metalness: 0,
          roughness: 0.85,
        });
        basic.dispose();
        // Imagery-only tiles from XYZTilesPlugin already have correct sphere normals
        // on their generated ellipsoid geometry — skip the expensive per-vertex blend.
        return;
      }

      // Blend vertex normals toward sphere normals for surface vertices only.
      // (terrain tiles only — imagery-only tiles skip this via early return above)
      this.blendSphereNormals(child, 0.6);

      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) {
        if ('roughness' in mat) (mat as THREE.MeshStandardMaterial).roughness = 0.85;
        if ('metalness' in mat) (mat as THREE.MeshStandardMaterial).metalness = 0;
      }
    });

    if (this.normalMap) {
      this.applyNormalMap(scene, tile);
    }
  }

  /**
   * Blend vertex normals toward sphere normals for surface vertices.
   * Skirt vertices (geometry groups 2+) are left unchanged.
   *
   * Vertex positions in quantized mesh are ECEF relative to tile center
   * (mesh.position holds the center offset). Adding it back gives the absolute
   * ECEF position, and normalizing that gives the ellipsoid surface direction.
   *
   * @param blendFactor 0 = pure vertex normal, 1 = pure sphere normal
   */
  private blendSphereNormals(mesh: THREE.Mesh, blendFactor: number): void {
    const geom = mesh.geometry;
    const pos = geom.getAttribute('position');
    const norm = geom.getAttribute('normal');
    if (!pos || !norm) return;

    // Find the index range for surface vertices (group 0).
    // Groups: 0=surface, 1=bottom cap (if solid), 2+=skirts
    const groups = geom.groups;
    let surfaceVertexEnd = pos.count; // default: all vertices are surface
    if (groups.length > 0) {
      // Surface group is the first one. Find max vertex index used by surface triangles.
      const surfaceGroup = groups[0];
      const index = geom.index;
      if (index && surfaceGroup) {
        let maxIdx = 0;
        const start = surfaceGroup.start;
        const end = start + surfaceGroup.count;
        for (let i = start; i < end; i++) {
          const idx = index.getX(i);
          if (idx > maxIdx) maxIdx = idx;
        }
        surfaceVertexEnd = maxIdx + 1;
      }
    }

    // Tile center in ECEF — mesh.position is set by QuantizedMeshLoader
    const cx = mesh.position.x;
    const cy = mesh.position.y;
    const cz = mesh.position.z;

    const sphere = new THREE.Vector3();
    const vertex = new THREE.Vector3();

    for (let i = 0; i < surfaceVertexEnd; i++) {
      // Absolute ECEF position = relative position + tile center
      sphere.set(
        pos.getX(i) + cx,
        pos.getY(i) + cy,
        pos.getZ(i) + cz,
      ).normalize();

      // Existing vertex normal
      vertex.set(norm.getX(i), norm.getY(i), norm.getZ(i));

      // Blend: lerp toward sphere normal, then renormalize
      vertex.lerp(sphere, blendFactor).normalize();

      norm.setXYZ(i, vertex.x, vertex.y, vertex.z);
    }
    norm.needsUpdate = true;
  }

  /**
   * Apply the global normal map to a tile's material with per-tile UV offset/repeat.
   * Uses the tile's bounding volume region (EPSG:4326 radians) to compute the
   * transform from tile-local UVs to global equirectangular coordinates.
   */
  private applyNormalMap(scene: THREE.Object3D, tile: any): void {
    if (!this.normalMap) return;

    // boundingVolume.region = [west, south, east, north, minHeight, maxHeight] in radians
    const region = tile?.boundingVolume?.region as number[] | undefined;
    if (!region || region.length < 4) return;

    const [west, south, east, north] = region;
    const TWO_PI = 2 * Math.PI;

    // Map tile UV → global equirectangular UV for the normal map.
    // Normal map: U = (lon + π) / 2π, V = (π/2 - lat) / π
    // Tile UV: u ∈ [0,1] west→east, v ∈ [0,1] south→north
    const repeatX = (east - west) / TWO_PI;
    const offsetX = (west + Math.PI) / TWO_PI;
    const repeatY = -(north - south) / Math.PI;  // negative: tile v goes S→N, texture V goes N→S
    const offsetY = (Math.PI / 2 - south) / Math.PI;

    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !child.material) return;
      const mat = child.material as THREE.MeshStandardMaterial;
      if (!('normalMap' in mat)) return;

      // Clone texture — shares GPU data (same source), gets its own offset/repeat
      const normalTex = this.normalMap!.clone();
      normalTex.offset.set(offsetX, offsetY);
      normalTex.repeat.set(repeatX, repeatY);
      normalTex.updateMatrix();

      mat.normalMap = normalTex;
      mat.normalScale = new THREE.Vector2(0.5, 0.5);
      mat.needsUpdate = true;
    });
  }
}
