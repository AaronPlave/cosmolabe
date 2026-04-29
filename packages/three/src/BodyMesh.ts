import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { DDSLoader } from 'three/examples/jsm/loaders/DDSLoader.js';
import { parseCmod, type CmodTextureResolver } from './CmodLoader.js';
import { TerrainManager, type TerrainConfig } from './TerrainManager.js';
import { injectShadowIntoShader, makeShadowUniforms, type ShadowUniforms } from './EclipseShadow.js';
import { SurfaceTileOverlay, type SurfaceTileConfig } from './SurfaceTileOverlay.js';
import type { Body } from '@cosmolabe/core';

const DEFAULT_BODY_COLORS: Record<string, number> = {
  star: 0xffdd44,
  planet: 0x8888cc,
  moon: 0xaaaaaa,
  spacecraft: 0x44ff44,
  asteroid: 0x886644,
  comet: 0x668899,
  barycenter: 0x444444,
};

/** Resolve a model source path to a URL or blob URL for loading */
export type ModelResolver = (source: string) => string | undefined;

/** Check if an ArrayBuffer starts with the DDS magic bytes "DDS " (0x44445320) */
function isDDSMagic(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const h = new Uint8Array(buffer, 0, 4);
  return h[0] === 0x44 && h[1] === 0x44 && h[2] === 0x53 && h[3] === 0x20;
}

const _tmpQ = new THREE.Quaternion();


export class BodyMesh extends THREE.Object3D {
  readonly body: Body;
  readonly mesh: THREE.Mesh;
  /** Display radius in km (before scale factor). Updated when a model with known size loads. */
  displayRadius: number;
  /** Container for loaded 3D model (replaces placeholder sphere) */
  modelContainer: THREE.Object3D | null = null;
  private loadedModel = false;
  /** Base scale applied to the model container (before dynamic sizing) */
  private modelBaseScale = 1;
  /** Fixed rotation from model-native axes to body frame (composed with SPICE attitude) */
  meshRotationQ = new THREE.Quaternion();
  /** Orientation axes helper (red=X/prime meridian, green=Y, blue=Z/pole) */
  private axesHelper: THREE.AxesHelper | null = null;
  private axesVisible = false;
  /** Lat/lon grid overlay */
  private gridLines: THREE.Group | null = null;
  private gridVisible = false;
  /** Scene scale factor (km → scene units). Set each frame by updatePosition. */
  scaleFactor = 1;
  /** Streaming terrain manager (3D Tiles). Null if no terrain configured. */
  private terrainManager: TerrainManager | null = null;
  /** Whether terrain tiles are currently visible (vs static sphere fallback) */
  private terrainVisible = false;
  /** Surface tile overlays (local-frame tilesets positioned on the globe) */
  private surfaceOverlays: SurfaceTileOverlay[] = [];
  /** Frame counter for throttling terrain elevation sampling */
  private terrainSampleFrame = 0;
  /** Whether eclipse shadow receiving is enabled on this body's materials */
  private shadowEnabled = false;
  /** Suppress repeated rotation-failure warnings after first occurrence */
  private _rotationFailed = false;
  /** Shared uniform values — patched into every compiled shader by reference */
  private readonly shadowUniforms: ShadowUniforms = makeShadowUniforms();
  /**
   * Axis ratios for triaxial ellipsoid in geometry space [geoX, geoY, geoZ].
   * Maps body-fixed [rx, ry, rz] → geometry axes accounting for the Globe pre-rotation
   * (geometry Y = body-fixed Z pole). Default [1,1,1] for spherical bodies.
   */
  readonly ellipsoidRatios: [number, number, number] = [1, 1, 1];

  get hasModel(): boolean { return this.modelContainer !== null; }
  get isModelVisible(): boolean { return this.modelContainer?.visible ?? false; }
  get hasShadowReceiving(): boolean { return this.shadowEnabled; }

  /** Apply a multiplier on top of the model's base scale (for minBodyPixels) */
  setModelScale(multiplier: number): void {
    if (this.modelContainer) {
      this.modelContainer.scale.setScalar(this.modelBaseScale * multiplier);
    }
  }

  /** Show or hide the loaded model */
  setModelVisible(visible: boolean): void {
    if (this.modelContainer) {
      this.modelContainer.visible = visible;
    }
  }

  /** Set model opacity (0-1) for fade-in effect */
  setModelOpacity(opacity: number): void {
    if (!this.modelContainer) return;
    this.modelContainer.traverse((child) => {
      if (child instanceof THREE.Mesh && child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const mat of mats) {
          mat.opacity = opacity;
          mat.transparent = opacity < 1;
        }
      }
    });
  }

  constructor(body: Body) {
    super();
    this.body = body;
    this.name = body.name;

    this.displayRadius = this.getDisplayRadius();
    // Globe bodies get higher segment count for texture quality and smooth silhouettes
    // (faceted polygon edges visible through thick atmospheres like Titan's).
    // Bump up further when displacement map is present for vertex-level detail.
    const isGlobe = body.geometryType === 'Globe';
    const hasDisplacement = !!(body.geometryData?.displacementMap);
    const wSegs = isGlobe ? (hasDisplacement ? 512 : 128) : 32;
    const hSegs = isGlobe ? (hasDisplacement ? 384 : 96) : 24;
    const geometry = new THREE.SphereGeometry(this.displayRadius, wSegs, hSegs);
    const color = DEFAULT_BODY_COLORS[body.classification ?? ''] ?? 0xcccccc;
    // Globe uses StandardMaterial (PBR) for displacement map + better lighting;
    // non-Globe uses Phong (lighter weight).
    const material = isGlobe
      ? new THREE.MeshStandardMaterial({ color, metalness: 0, roughness: 0.85 })
      : new THREE.MeshPhongMaterial({ color });

    // Stars and emissive bodies (e.g. Sun with "emissive": true in Cosmographia geometry) emit light
    if (body.classification === 'star' || body.geometryData?.emissive === true) {
      material.emissive = new THREE.Color(0xffdd44);
      material.emissiveIntensity = 0.8;
    }

    this.mesh = new THREE.Mesh(geometry, material);
    this.add(this.mesh);

    // Globe bodies: pre-rotate geometry so Three.js Y-pole aligns with body-fixed Z-pole.
    // SphereGeometry has Y=pole; SPICE body-fixed frame has Z=pole.
    // rotateX(π/2) maps: geoY→bodyZ (pole), geoZ→body-Y, geoX→bodyX (prime meridian).
    // UV mapping stays correct: texture center (U=0.5) → body +X (prime meridian).
    if (isGlobe) {
      this.meshRotationQ.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

      // Triaxial ellipsoid: scale axes non-uniformly.
      // Body-fixed radii [rx, ry, rz] map to geometry axes [geoX, geoY, geoZ] as:
      //   geoX = bodyX (rx), geoY = bodyZ (rz), geoZ = bodyY (ry)
      if (body.radii) {
        const maxR = this.displayRadius;
        const [rx, ry, rz] = body.radii;
        this.ellipsoidRatios = [rx / maxR, rz / maxR, ry / maxR];
      }
    }
  }

  /**
   * Load a 3D model (GLTF/GLB/OBJ) to replace the placeholder sphere.
   * Applies size scaling, mesh offset, and mesh rotation from the geometry spec.
   */
  async loadModel(url: string, scaleFactor: number, sourcePath?: string, modelResolver?: ModelResolver): Promise<void> {
    if (this.loadedModel) return;
    this.loadedModel = true;

    const geo = this.body.geometryData ?? {};
    // Use sourcePath for extension detection (blob URLs have no extension)
    const extSource = sourcePath ?? url;
    const ext = extSource.split('.').pop()?.toLowerCase() ?? '';
    let object: THREE.Object3D;

    try {
      if (ext === 'glb' || ext === 'gltf') {
        const loader = new GLTFLoader();
        const dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath('./draco/');
        loader.setDRACOLoader(dracoLoader);
        const gltf = await loader.loadAsync(url);
        object = gltf.scene;
      } else if (ext === 'obj') {
        const loader = new OBJLoader();
        object = await loader.loadAsync(url);
      } else if (ext === 'cmod') {
        const resp = await fetch(url);
        const buf = await resp.arrayBuffer();
        // Build texture resolver: texture filenames are relative to the cmod file's directory
        let textureResolver: CmodTextureResolver | undefined;
        if (modelResolver && sourcePath) {
          const dir = sourcePath.substring(0, sourcePath.lastIndexOf('/') + 1);
          textureResolver = (texName: string) => modelResolver(dir + texName);
        }
        const parsed = await parseCmod(buf, textureResolver);
        if (!parsed) {
          console.warn(`[Cosmolabe] Failed to parse .cmod for ${this.body.name}`);
          return;
        }
        object = parsed;
      } else {
        console.warn(`[Cosmolabe] Unsupported model format: .${ext} for ${this.body.name}`);
        return;
      }
    } catch (e) {
      console.warn(`[Cosmolabe] Failed to load model for ${this.body.name}: ${e instanceof Error ? e.message : e}`);
      return;
    }

    // Store mesh rotation for composition with SPICE attitude (Cosmographia quaternion: [w, x, y, z])
    const meshRotation = geo.meshRotation as number[] | undefined;
    if (meshRotation && meshRotation.length >= 4) {
      this.meshRotationQ.set(
        meshRotation[1] as number,
        meshRotation[2] as number,
        meshRotation[3] as number,
        meshRotation[0] as number,
      );
    }

    // Compute bounding box for size scaling
    const box = new THREE.Box3().setFromObject(object);
    const objectSize = new THREE.Vector3();
    box.getSize(objectSize);
    const maxExtent = Math.max(objectSize.x, objectSize.y, objectSize.z);

    // Analyze model geometry: identify key features and suggest meshRotation
    this.analyzeModelGeometry(object, box);

    // Scale: "size" field is diameter in km; scale model to fit
    const sizeKm = (geo.size as number) ?? (geo.scale as number) ?? 0;
    if (sizeKm > 0 && maxExtent > 0) {
      this.modelBaseScale = (sizeKm / maxExtent) * scaleFactor;
      // Update displayRadius to match actual model size (diameter/2)
      this.displayRadius = sizeKm / 2;
    } else {
      // No size specified — assume model is in km, apply scene scale factor
      this.modelBaseScale = scaleFactor;
      // Update displayRadius from model's actual extent (in km)
      this.displayRadius = maxExtent / 2;
    }
    object.scale.setScalar(this.modelBaseScale);

    // Apply mesh offset (in model-native units, re-centers geometry on body position)
    const meshOffset = geo.meshOffset as number[] | undefined;
    if (meshOffset && meshOffset.length >= 3) {
      object.position.set(
        meshOffset[0] * this.modelBaseScale,
        meshOffset[1] * this.modelBaseScale,
        meshOffset[2] * this.modelBaseScale,
      );
    }

    // Multi-pass rendering: models are rendered in a separate pass (layer 1) with
    // cleared depth buffer and tight near/far, so standard hardware depth interpolation
    // handles intra-model face sorting with full precision. No log depth override needed.
    object.traverse((child) => {
      child.layers.set(1);

      if (child instanceof THREE.Mesh) {
        if (!child.material) {
          child.material = new THREE.MeshPhongMaterial({
            color: DEFAULT_BODY_COLORS[this.body.classification ?? ''] ?? 0xcccccc,
          });
        }
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        const receiveShadow = this.shadowEnabled;
        const su = this.shadowUniforms;
        for (const mat of mats) {
          // Strip log depth chunks — model uses standard hardware depth.
          // Also inject eclipse shadow uniforms when shadow receiving is enabled.
          mat.onBeforeCompile = (shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> }) => {
            shader.vertexShader = shader.vertexShader
              .replace('#include <logdepthbuf_pars_vertex>', '')
              .replace('#include <logdepthbuf_vertex>', '');
            shader.fragmentShader = shader.fragmentShader
              .replace('#include <logdepthbuf_pars_fragment>', '')
              .replace('#include <logdepthbuf_fragment>', '');
            if (receiveShadow) injectShadowIntoShader(shader, su);
          };
          mat.customProgramCacheKey = () => receiveShadow ? 'model_nologdepth_shadow_v1' : 'model_nologdepth';
        }
      }
    });

    // Replace placeholder sphere with loaded model
    this.mesh.visible = false;
    this.modelContainer = object;
    this.add(object);

  }

  /**
   * Enable eclipse shadow receiving on this body's placeholder sphere material.
   * No-op for stars and emissive bodies. Safe to call multiple times.
   * Must be called before loadModel() for the shadow to apply to loaded models.
   */
  enableShadowReceiving(): void {
    if (this.shadowEnabled) return;
    if (this.body.classification === 'star' || this.body.geometryData?.emissive === true) return;
    this.shadowEnabled = true;

    const su = this.shadowUniforms;
    const mat = this.mesh.material as THREE.Material & {
      onBeforeCompile?: (shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> }, renderer: unknown) => void;
      customProgramCacheKey?: () => string;
      needsUpdate: boolean;
    };

    // Bind to mat so prototype methods (e.g. default customProgramCacheKey which reads
    // this.onBeforeCompile) don't fail when called without a receiver.
    const prevOBC = mat.onBeforeCompile?.bind(mat);
    mat.onBeforeCompile = (shader, renderer) => {
      prevOBC?.(shader, renderer);
      injectShadowIntoShader(shader, su);
    };
    mat.customProgramCacheKey = () => '_shadow_v1';
    mat.needsUpdate = true;

    // Also enable on terrain tiles if already initialized
    this.terrainManager?.enableShadowReceiving(this.shadowUniforms);
  }

  /** Update eclipse shadow occluder uniforms for this frame. Call after body positions are updated. */
  setShadowOccluders(
    occluders: { pos: THREE.Vector3; radius: number }[],
    sunPos: THREE.Vector3,
    sunRadius: number,
  ): void {
    const u = this.shadowUniforms;
    const count = Math.min(occluders.length, 4);
    u.uShadowOccluderCount.value = count;
    u.uSunWorldPos.value.copy(sunPos);
    u.uSunRadius.value = sunRadius;
    for (let i = 0; i < count; i++) {
      u.uShadowOccluderPos.value[i].copy(occluders[i].pos);
      u.uShadowOccluderRadius.value[i] = occluders[i].radius;
    }
  }

  /** Show or hide body-fixed orientation axes (red=X/prime meridian, green=Y, blue=Z/pole). */
  showAxes(show: boolean): void {
    this.axesVisible = show;
    if (show && !this.axesHelper) {
      // Size = 2x display radius so axes extend well beyond the body surface
      const size = this.displayRadius * 2 * this.scaleFactor;
      this.axesHelper = new THREE.AxesHelper(size);
      this.axesHelper.renderOrder = 999;
      (this.axesHelper.material as THREE.Material).depthTest = false;
      this.add(this.axesHelper);
    }
    if (this.axesHelper) {
      this.axesHelper.visible = show;
    }
  }

  /** Show or hide lat/lon grid lines on the body surface.
   *  Grid spacing is 30° with equator (yellow) and prime meridian (red) highlighted.
   *  Works with triaxial ellipsoids via the same scale as the placeholder mesh. */
  showGrid(show: boolean): void {
    this.gridVisible = show;
    if (show && !this.gridLines) {
      this.gridLines = this.createGridLines();
      this.gridLines.renderOrder = 1;
      this.add(this.gridLines);
    }
    if (this.gridLines) {
      this.gridLines.visible = show;
    }
  }

  private createGridLines(): THREE.Group {
    const group = new THREE.Group();
    // Slight offset above surface to prevent z-fighting
    const radius = this.displayRadius * 1.002;
    const segs = 72; // points per line (5° per segment)

    const gridMat = new THREE.LineBasicMaterial({
      color: 0x88aaff, transparent: true, opacity: 0.3, depthTest: true, depthWrite: false,
    });
    const equatorMat = new THREE.LineBasicMaterial({
      color: 0xffaa44, transparent: true, opacity: 0.5, depthTest: true, depthWrite: false,
    });
    const primeMeridianMat = new THREE.LineBasicMaterial({
      color: 0xff4444, transparent: true, opacity: 0.5, depthTest: true, depthWrite: false,
    });

    // Helper: generate a latitude ring at the given angle (degrees)
    const makeLatLine = (latDeg: number, mat: THREE.LineBasicMaterial) => {
      const latRad = latDeg * Math.PI / 180;
      const cosLat = Math.cos(latRad);
      const sinLat = Math.sin(latRad);
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= segs; i++) {
        const lon = (i / segs) * 2 * Math.PI;
        // Geometry space: Y = pole (matches SphereGeometry)
        pts.push(new THREE.Vector3(
          radius * cosLat * Math.cos(lon),
          radius * sinLat,
          radius * cosLat * Math.sin(lon),
        ));
      }
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    };

    // Helper: generate a longitude meridian at the given angle (degrees)
    const makeLonLine = (lonDeg: number, mat: THREE.LineBasicMaterial) => {
      const lonRad = lonDeg * Math.PI / 180;
      const cosLon = Math.cos(lonRad);
      const sinLon = Math.sin(lonRad);
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= segs; i++) {
        const lat = (i / segs) * Math.PI - Math.PI / 2;
        pts.push(new THREE.Vector3(
          radius * Math.cos(lat) * cosLon,
          radius * Math.sin(lat),
          radius * Math.cos(lat) * sinLon,
        ));
      }
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    };

    // Latitude lines every 30° (excluding poles)
    for (let lat = -60; lat <= 60; lat += 30) {
      makeLatLine(lat, lat === 0 ? equatorMat : gridMat);
    }

    // Longitude lines every 30°
    for (let lon = 0; lon < 360; lon += 30) {
      makeLonLine(lon, lon === 0 ? primeMeridianMat : gridMat);
    }

    // --- Labels ---
    const labelR = this.displayRadius * 1.015;
    const labelSize = this.displayRadius * 0.06;
    const latLabelLon = 5 * Math.PI / 180; // offset from PM so labels don't overlap the line
    const lonLabelLat = 3 * Math.PI / 180; // offset above equator

    // Latitude labels (placed near prime meridian)
    const latLabels: [number, string, string][] = [
      [60, '60°N', '#88aaff'], [30, '30°N', '#88aaff'],
      [0, 'Eq', '#ffaa44'],
      [-30, '30°S', '#88aaff'], [-60, '60°S', '#88aaff'],
    ];
    for (const [latDeg, text, color] of latLabels) {
      const latRad = latDeg * Math.PI / 180;
      const sprite = this.makeTextSprite(text, color);
      sprite.position.set(
        labelR * Math.cos(latRad) * Math.cos(latLabelLon),
        labelR * Math.sin(latRad),
        labelR * Math.cos(latRad) * Math.sin(latLabelLon),
      );
      sprite.scale.set(labelSize, labelSize * 0.5, 1);
      group.add(sprite);
    }

    // Longitude labels (placed just above equator)
    for (let lon = 0; lon < 360; lon += 30) {
      const lonRad = lon * Math.PI / 180;
      const text = lon === 0 ? '0°' : `${lon}°`;
      const color = lon === 0 ? '#ff4444' : '#88aaff';
      const sprite = this.makeTextSprite(text, color);
      sprite.position.set(
        labelR * Math.cos(lonLabelLat) * Math.cos(lonRad),
        labelR * Math.sin(lonLabelLat),
        labelR * Math.cos(lonLabelLat) * Math.sin(lonRad),
      );
      sprite.scale.set(labelSize, labelSize * 0.5, 1);
      group.add(sprite);
    }

    return group;
  }

  /** Create a camera-facing text sprite for grid labels */
  private makeTextSprite(text: string, color: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.font = 'bold 28px monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 64, 32);
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: true,
      sizeAttenuation: true,
    });
    return new THREE.Sprite(material);
  }

  /** Update position from absolute coordinates (km) and apply rotation. */
  updatePosition(absolutePos: [number, number, number], et: number, scaleFactor: number): void {
    this.scaleFactor = scaleFactor;
    this.position.set(
      absolutePos[0] * scaleFactor,
      absolutePos[1] * scaleFactor,
      absolutePos[2] * scaleFactor,
    );

    // Apply rotation if available (try/catch: CK-based rotations may not cover all times)
    try {
      const q = this.body.rotationAt(et);
      if (q) {
        const target = this.modelContainer ?? this.mesh;
        // SPICE quaternion [w,x,y,z] rotates inertial → body-fixed.
        // Three.js needs local → world (body → inertial), so conjugate (negate xyz).
        const spiceQ = _tmpQ.set(-q[1], -q[2], -q[3], q[0]);
        // Compose: (body → inertial) * (model → body) = model → inertial
        target.quaternion.multiplyQuaternions(spiceQ, this.meshRotationQ);
        if (this.axesHelper) {
          this.axesHelper.quaternion.copy(spiceQ); // Axes show body frame in inertial space
        }
        if (this.gridLines && this.gridVisible) {
          this.gridLines.quaternion.copy(target.quaternion);
        }
      }
    } catch (err) {
      if (!this._rotationFailed) {
        console.warn(`[Cosmolabe] Rotation failed for "${this.body.name}":`, (err as Error)?.message ?? err);
        this._rotationFailed = true;
      }
    }
  }

  private getDisplayRadius(): number {
    if (this.body.radii) {
      return Math.max(this.body.radii[0], this.body.radii[1], this.body.radii[2]);
    }
    // Fallback display sizes by classification
    switch (this.body.classification) {
      case 'star': return 696000;    // Sun ~696,000 km
      case 'planet': return 6371;    // Earth-like default
      case 'moon': return 1737;
      case 'spacecraft': return 10;
      case 'instrument': return 1;   // Instrument on a spacecraft
      default: return 100;
    }
  }

  /**
   * Analyze model geometry to identify key spacecraft features (dish, boom)
   * and compute/log the meshRotation quaternion analytically.
   * TODO: Fix 180° Y-axis offset — computed quaternion is in the wrong hemisphere.
   * The analytical value needs premultiplication by [0,0,1,0] (180° Y) to match reality.
   */
  private analyzeModelGeometry(object: THREE.Object3D, bbox: THREE.Box3): void {
    const bboxSize = new THREE.Vector3();
    const bboxCenter = new THREE.Vector3();
    bbox.getSize(bboxSize);
    bbox.getCenter(bboxCenter);
    // console.log(`[Cosmolabe] Model ${this.body.name}: bbox size (${bboxSize.x.toFixed(2)}, ${bboxSize.y.toFixed(2)}, ${bboxSize.z.toFixed(2)}), center (${bboxCenter.x.toFixed(2)}, ${bboxCenter.y.toFixed(2)}, ${bboxCenter.z.toFixed(2)})`);

    // 1. Collect per-mesh data: name, vertex count, center, average normal, coherence
    object.updateMatrixWorld(true);
    interface MeshInfo {
      name: string;
      vertexCount: number;
      center: THREE.Vector3;
      avgNormal: THREE.Vector3;
      /** 0-1: how aligned normals are (1 = flat surface like a dish, 0 = sphere) */
      coherence: number;
    }
    const meshInfos: MeshInfo[] = [];
    const allVertices: THREE.Vector3[] = [];

    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !child.geometry) return;
      const pos = child.geometry.getAttribute('position');
      const norm = child.geometry.getAttribute('normal');
      if (!pos) return;

      const center = new THREE.Vector3();
      const normalSum = new THREE.Vector3();
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(child.matrixWorld);

      for (let i = 0; i < pos.count; i++) {
        const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
        v.applyMatrix4(child.matrixWorld);
        center.add(v);
        allVertices.push(v);

        if (norm) {
          const n = new THREE.Vector3(norm.getX(i), norm.getY(i), norm.getZ(i));
          n.applyMatrix3(normalMatrix);
          normalSum.add(n);
        }
      }

      center.divideScalar(pos.count);
      const coherence = norm ? normalSum.length() / pos.count : 0;
      const avgNormal = normalSum.normalize();

      meshInfos.push({ name: child.name || '(unnamed)', vertexCount: pos.count, center, avgNormal, coherence });
    });

    // Log meshes sorted by vertex count
    // console.log(`[Cosmolabe] Model meshes (${meshInfos.length} total, ${allVertices.length} verts):`);
    for (const m of meshInfos.sort((a, b) => b.vertexCount - a.vertexCount).slice(0, 15)) {
      const c = m.center;
      const n = m.avgNormal;
      // console.log(`  "${m.name}": ${m.vertexCount} verts, center=(${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)}), normal=(${n.x.toFixed(3)},${n.y.toFixed(3)},${n.z.toFixed(3)}), coherence=${m.coherence.toFixed(3)}`);
    }

    // 2. Compute centroid
    const centroid = new THREE.Vector3();
    for (const v of allVertices) centroid.add(v);
    centroid.divideScalar(allVertices.length);
    // console.log(`[Cosmolabe] Centroid: (${centroid.x.toFixed(2)},${centroid.y.toFixed(2)},${centroid.z.toFixed(2)})`);

    // 3. Identify features by mesh name (case-insensitive substring match)
    const findMesh = (keywords: string[]) =>
      meshInfos.find(m => keywords.some(k => m.name.toLowerCase().includes(k)));

    const dishMesh = findMesh(['dish', 'hga', 'antenna_main']);
    const huygensMesh = findMesh(['huygens']);

    if (dishMesh) {
      // HGA boresight: direction from centroid toward the dish center (outward from spacecraft)
      const hgaDir = dishMesh.center.clone().sub(centroid).normalize();
      // console.log(`[Cosmolabe] HGA dish: "${dishMesh.name}" at (${dishMesh.center.x.toFixed(2)},${dishMesh.center.y.toFixed(2)},${dishMesh.center.z.toFixed(2)}), boresight dir=(${hgaDir.x.toFixed(3)},${hgaDir.y.toFixed(3)},${hgaDir.z.toFixed(3)})`);

      // Second constraint: Huygens probe position → body +X, or fallback to geometric analysis
      let secondDir: THREE.Vector3;
      let secondBodyDir: THREE.Vector3;
      if (huygensMesh) {
        secondDir = huygensMesh.center.clone().sub(centroid).normalize();
        secondBodyDir = new THREE.Vector3(1, 0, 0); // Huygens = body +X
        // console.log(`[Cosmolabe] Huygens: "${huygensMesh.name}" at (${huygensMesh.center.x.toFixed(2)},${huygensMesh.center.y.toFixed(2)},${huygensMesh.center.z.toFixed(2)}), dir=(${secondDir.x.toFixed(3)},${secondDir.y.toFixed(3)},${secondDir.z.toFixed(3)})`);
      } else {
        // Fallback: farthest vertex from centroid (likely boom tip) → body +Y
        let maxDist = 0;
        let tip = centroid.clone();
        for (const v of allVertices) {
          const d = v.distanceTo(centroid);
          if (d > maxDist) { maxDist = d; tip = v.clone(); }
        }
        secondDir = tip.clone().sub(centroid).normalize();
        secondBodyDir = new THREE.Vector3(0, 1, 0); // boom = body +Y
        // console.log(`[Cosmolabe] Boom tip: (${tip.x.toFixed(2)},${tip.y.toFixed(2)},${tip.z.toFixed(2)}), dir=(${secondDir.x.toFixed(3)},${secondDir.y.toFixed(3)},${secondDir.z.toFixed(3)})`);
      }

      // 4. Compute rotation from two direction pairs:
      //    modelDir1 → bodyDir1 (HGA boresight → +Z)
      //    modelDir2 → bodyDir2 (Huygens → +X, or boom → +Y)
      const bodyHGA = new THREE.Vector3(0, 0, 1); // HGA boresight = body +Z

      // Orthonormalize model frame (primary: HGA direction)
      const mA = hgaDir.clone();
      const mB = secondDir.clone().sub(mA.clone().multiplyScalar(secondDir.dot(mA))).normalize();
      const mC = new THREE.Vector3().crossVectors(mA, mB);

      // Orthonormalize body frame (primary: +Z)
      const bA = bodyHGA.clone();
      const bB = secondBodyDir.clone().sub(bA.clone().multiplyScalar(secondBodyDir.dot(bA))).normalize();
      const bC = new THREE.Vector3().crossVectors(bA, bB);

      // Rotation = bodyFrame * modelFrame^(-1)
      const modelFrame = new THREE.Matrix4().makeBasis(mA, mB, mC);
      const bodyFrame = new THREE.Matrix4().makeBasis(bA, bB, bC);
      const rotation = bodyFrame.clone().multiply(modelFrame.clone().invert());

      const q = new THREE.Quaternion().setFromRotationMatrix(rotation);
      // console.log(`[Cosmolabe] Computed meshRotation [w,x,y,z]: [${q.w.toFixed(4)}, ${q.x.toFixed(4)}, ${q.y.toFixed(4)}, ${q.z.toFixed(4)}]`);
    } else {
      // console.log(`[Cosmolabe] No dish mesh found — cannot compute meshRotation analytically`);
    }
  }

  /**
   * Apply scale factor to the placeholder mesh, accounting for triaxial ellipsoid ratios.
   * Use this instead of `mesh.scale.setScalar()` to preserve oblateness.
   */
  applyMeshScale(factor: number): void {
    this.mesh.scale.set(
      factor * this.ellipsoidRatios[0],
      factor * this.ellipsoidRatios[1],
      factor * this.ellipsoidRatios[2],
    );
    // When terrain is active, grid lines are scaled separately in updateTerrain()
    // to stay above the terrain surface (the mesh is shrunk 0.5% below terrain).
    if (this.gridLines && this.gridVisible && !this.terrainVisible) {
      this.gridLines.scale.set(
        factor * this.ellipsoidRatios[0],
        factor * this.ellipsoidRatios[1],
        factor * this.ellipsoidRatios[2],
      );
    }
  }

  /** Whether this body has streaming terrain active */
  get hasTerrain(): boolean { return this.terrainManager !== null; }

  /** Get the terrain tile group for raycasting (null if no terrain or not visible) */
  get terrainTileGroup(): THREE.Object3D | null {
    return this.terrainManager?.group ?? null;
  }

  /** Toggle debug tile bounds on terrain */
  setTerrainDebug(show: boolean): void {
    this.terrainManager?.setDebug(show);
  }

  /** Sample terrain elevation at a given lat/lon. Returns elevation (km above reference) and angular distance, or null. */
  sampleTerrainElevation(latDeg: number, lonDeg: number): { elevationKm: number; angularDistDeg: number } | null {
    return this.terrainManager?.sampleElevationKm(latDeg, lonDeg, this.displayRadius) ?? null;
  }

  /** Log terrain tile stats to console */
  logTerrainStats(): void {
    this.terrainManager?.logStats();
  }

  /**
   * Initialize streaming terrain tiles for this globe body.
   * Creates a TerrainManager and adds its group as a child of this BodyMesh.
   */
  initTerrain(config: TerrainConfig, renderer: THREE.WebGLRenderer): void {
    if (this.terrainManager) return; // Already initialized
    this.terrainManager = new TerrainManager(config, this.displayRadius, renderer);
    if (this.shadowEnabled) this.terrainManager.enableShadowReceiving(this.shadowUniforms);
    this.add(this.terrainManager.group);
    // Terrain starts hidden; updateTerrain will show it based on camera distance
    this.terrainManager.group.visible = false;

    // Downgrade the static sphere — it's now just a distant fallback.
    // Remove displacement map (invisible at distance, causes z-fighting with terrain).
    const mat = this.mesh.material as THREE.MeshStandardMaterial;
    if (mat.displacementMap) {
      mat.displacementMap.dispose();
      mat.displacementMap = null;
      mat.displacementScale = 0;
      mat.displacementBias = 0;
      mat.needsUpdate = true;
    }
    // Swap to a lower-segment sphere (32x24 is plenty for distant views)
    const oldGeo = this.mesh.geometry;
    this.mesh.geometry = new THREE.SphereGeometry(this.displayRadius, 64, 48);
    oldGeo.dispose();
  }

  /**
   * Per-frame terrain update. Handles tile LOD streaming and sphere↔tiles transition.
   * @param camera Scene camera
   * @param renderer WebGL renderer
   * @param screenPixels How many pixels the body subtends on screen
   */
  updateTerrain(camera: THREE.Camera, renderer: THREE.WebGLRenderer, screenPixels: number): void {
    if (!this.terrainManager) return;

    // Two thresholds: pre-load starts fetching tiles while sphere is still showing,
    // so by the time we swap, higher-LOD tiles are already cached → less pop-in.
    const TERRAIN_PRELOAD_PX = 40;
    const TERRAIN_SHOW_PX = 80;

    if (screenPixels >= TERRAIN_SHOW_PX) {
      // Show terrain tiles. At orbital distances, keep the static sphere slightly
      // shrunk (0.5%) behind tiles as a fallback during tile loading transitions.
      // At ground level (screenPixels > 2000), hide the sphere entirely — it sits
      // km below the actual terrain surface (e.g., 12+ km at Dingo Gap) and would
      // be visible through tile gaps at oblique viewing angles.
      if (!this.terrainVisible) {
        this.terrainManager.group.visible = true;
        this.terrainVisible = true;
      }
      // At ground level the shrunk sphere sits km below terrain and is visible
      // through tile gaps at oblique angles. Hide it when within 1% of body radius.
      const camDistKm = camera.position.distanceTo(this.position) / this.scaleFactor;
      const altAboveSphere = camDistKm - this.displayRadius;
      if (Math.abs(altAboveSphere) < this.displayRadius * 0.01) {
        this.mesh.visible = false;
      } else {
        this.applyMeshScale(this.scaleFactor * 0.995);
      }

      // Scale grid lines above terrain surface (not shrunk with the mesh).
      // 0.5% above terrain clears typical topography while staying close to surface.
      if (this.gridLines && this.gridVisible) {
        const gridScale = this.scaleFactor * 1.005;
        this.gridLines.scale.set(
          gridScale * this.ellipsoidRatios[0],
          gridScale * this.ellipsoidRatios[1],
          gridScale * this.ellipsoidRatios[2],
        );
      }

      // Apply the same rotation as the static mesh so terrain aligns with body orientation
      this.terrainManager.group.quaternion.copy(this.mesh.quaternion);
      // Apply scene scale factor to the terrain group
      this.terrainManager.group.scale.setScalar(this.scaleFactor);

      // Force world matrix update before tile LOD computation.
      // setCamera() uses the group's world matrix to transform the camera into tile space.
      // Without this, it uses stale matrices from the previous frame's render pass,
      // causing incorrect LOD selection after panning/zooming.
      this.terrainManager.group.updateMatrixWorld(true);

      // Update tile LOD — pass body center position so the coverage camera
      // can ensure tiles load even when the main camera faces away.
      this.terrainManager.update(camera, renderer, this.position);
    } else if (screenPixels >= TERRAIN_PRELOAD_PX) {
      // Pre-load zone: update tile LOD (fetches tiles) but keep sphere visible.
      // Terrain group stays hidden — we're just warming the cache.
      if (this.terrainVisible) {
        this.terrainManager.group.visible = false;
        this.terrainVisible = false;
        this.mesh.visible = true;
      }
      this.terrainManager.group.quaternion.copy(this.mesh.quaternion);
      this.terrainManager.group.scale.setScalar(this.scaleFactor);
      this.terrainManager.group.updateMatrixWorld(true);
      this.terrainManager.update(camera, renderer, this.position);
    } else if (this.terrainVisible) {
      // Camera is far — hide terrain, show static sphere
      this.terrainManager.group.visible = false;
      this.terrainVisible = false;
      this.mesh.visible = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Surface tile overlays (local-frame tilesets positioned on the globe)
  // ---------------------------------------------------------------------------

  get hasSurfaceTiles(): boolean { return this.surfaceOverlays.length > 0; }

  /** Get all surface tile overlays (for CRR render pass). */
  getSurfaceOverlays(): SurfaceTileOverlay[] {
    return this.surfaceOverlays;
  }

  /**
   * Create a surface tile overlay for this body (e.g. Dingo Gap high-res terrain).
   * The overlay group is NOT added to this BodyMesh — the caller (UniverseRenderer)
   * adds it to a separate scene for camera-relative rendering.
   */
  addSurfaceTiles(config: SurfaceTileConfig, renderer: THREE.WebGLRenderer): SurfaceTileOverlay {
    const overlay = new SurfaceTileOverlay(config, this.displayRadius, renderer);
    this.surfaceOverlays.push(overlay);
    overlay.group.visible = false;
    return overlay;
  }

  /**
   * Per-frame update for surface tile overlays. Sets the correct world-space
   * transform (body position + rotation + scale) for TilesRenderer LOD/frustum
   * computation, then streams tiles. The CRR render pass in UniverseRenderer
   * later overrides the position for camera-relative rendering.
   *
   * Note: overlay groups live in a separate tileScene (not parented to this
   * BodyMesh), so we must set position explicitly.
   */
  updateSurfaceTiles(camera: THREE.Camera, renderer: THREE.WebGLRenderer, screenPixels: number): void {
    if (this.surfaceOverlays.length === 0) return;
    this.terrainSampleFrame++;

    // Show surface tiles earlier than terrain — start loading tiles when the body
    // is at least 20 px on screen so they're ready by the time the user zooms in.
    const visible = screenPixels >= 20;
    for (const overlay of this.surfaceOverlays) {
      overlay.group.visible = visible;
      if (!visible) continue;

      // Terrain-following: snap tile altitude to sit slightly INSIDE the global terrain.
      // Since the CRR render pass clears depth first (tileScene renders on top of
      // main scene), being slightly inside eliminates the visible floating gap.
      // The -0.005 km (-5m) inset ensures overlap even when the global terrain
      // is at a slightly different height than the sampled elevation.
      if (this.terrainSampleFrame % 5 === 0) {
        const terrainSample = this.sampleTerrainElevation(overlay.lat, overlay.lon);
        if (terrainSample != null && terrainSample.angularDistDeg < 0.5) {
          overlay.terrainAdjustKm = terrainSample.elevationKm - overlay.altitudeOffset - 0.005;
        }
      }

      // Set full world transform for LOD computation (no parent provides position).
      // Apply the terrain radial adjustment here too, so TilesRenderer's frustum
      // culling and SSE computation use the adjusted position — not the configured
      // altitude which may be km below the visible terrain at coarse LOD.
      overlay.group.position.copy(this.position);
      if (overlay.terrainAdjustKm !== 0) {
        const ecefLen = overlay.ecefPositionKm.length();
        if (ecefLen > 0) {
          const adjustScene = overlay.terrainAdjustKm * this.scaleFactor;
          // Radial direction: ECEF position normalized, rotated to world frame
          const rx = overlay.ecefPositionKm.x / ecefLen;
          const ry = overlay.ecefPositionKm.y / ecefLen;
          const rz = overlay.ecefPositionKm.z / ecefLen;
          // Apply body quaternion to get world-frame direction (inline to avoid allocation)
          const q = this.mesh.quaternion;
          const ix = q.w * rx + q.y * rz - q.z * ry;
          const iy = q.w * ry + q.z * rx - q.x * rz;
          const iz = q.w * rz + q.x * ry - q.y * rx;
          const iw = -q.x * rx - q.y * ry - q.z * rz;
          const wx = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
          const wy = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
          const wz = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
          overlay.group.position.x += wx * adjustScene;
          overlay.group.position.y += wy * adjustScene;
          overlay.group.position.z += wz * adjustScene;
        }
      }
      overlay.group.quaternion.copy(this.mesh.quaternion);
      overlay.group.scale.setScalar(this.scaleFactor);
      overlay.group.updateMatrixWorld(true);

      overlay.update(camera, renderer);
    }
  }

  /** Restore overlay group transforms to parented mode after CRR render pass. */
  updateSurfaceTileTransforms(): void {
    for (const overlay of this.surfaceOverlays) {
      overlay.group.quaternion.copy(this.mesh.quaternion);
      overlay.group.scale.setScalar(this.scaleFactor);
      overlay.group.updateMatrixWorld(true);
    }
  }

  /**
   * Load textures for Globe geometry (baseMap, normalMap, displacementMap).
   * Supports DDS (S3TC compressed) and standard image formats (PNG, JPG).
   */
  async loadGlobeTextures(
    baseMapUrl?: string,
    normalMapUrl?: string,
    displacementMapUrl?: string,
    displacementScale?: number,
    displacementBias?: number,
    bumpMapUrl?: string,
    bumpScale?: number,
  ): Promise<void> {
    const material = this.mesh.material as THREE.MeshPhongMaterial | THREE.MeshStandardMaterial;

    if (baseMapUrl) {
      try {
        const texture = await this.loadTexture(baseMapUrl);
        this.applyBaseMap(material, texture, baseMapUrl);
      } catch (e) {
        console.warn(`[Cosmolabe] Failed to load baseMap for ${this.body.name}:`, e);
      }
    }

    if (normalMapUrl) {
      try {
        const texture = await this.loadTexture(normalMapUrl);
        material.normalMap = texture;
        material.needsUpdate = true;
        console.log(`[Cosmolabe] Loaded normalMap for ${this.body.name}: ${normalMapUrl}`);
      } catch (e) {
        console.warn(`[Cosmolabe] Failed to load normalMap for ${this.body.name}:`, e);
      }
    }

    if (displacementMapUrl) {
      try {
        const texture = await this.loadTexture(displacementMapUrl);
        texture.colorSpace = THREE.LinearSRGBColorSpace;
        material.displacementMap = texture;
        material.displacementScale = displacementScale ?? 10;
        material.displacementBias = displacementBias ?? 0;
        material.needsUpdate = true;
        console.log(`[Cosmolabe] Loaded displacementMap for ${this.body.name}: ${displacementMapUrl} (scale=${material.displacementScale}, bias=${material.displacementBias})`);

        // Auto-generate a normal map from displacement when no explicit normal or bump map
        // is provided. Bump maps use screen-space derivatives (dFdx/dFdy) which are zoom-
        // dependent — craters lose shadow detail when you zoom in. Normal maps store the
        // actual surface normal per texel, so shading is consistent at every zoom level.
        if (!bumpMapUrl && !normalMapUrl && 'normalMap' in material) {
          const normalTex = this.generateNormalMapFromHeight(texture, bumpScale ?? 3);
          if (normalTex) {
            material.normalMap = normalTex;
            material.normalScale = new THREE.Vector2(1, 1);
            material.needsUpdate = true;
            console.log(`[Cosmolabe] Auto-generated normalMap from displacementMap for ${this.body.name}`);
          }
        }
      } catch (e) {
        console.warn(`[Cosmolabe] Failed to load displacementMap for ${this.body.name}:`, e);
      }
    }

    if (bumpMapUrl) {
      try {
        const texture = await this.loadTexture(bumpMapUrl);
        texture.colorSpace = THREE.LinearSRGBColorSpace;
        // Generate a normal map from bump texture for zoom-independent shading
        const normalTex = this.generateNormalMapFromHeight(texture, bumpScale ?? 5);
        if (normalTex && 'normalMap' in material) {
          material.normalMap = normalTex;
          material.normalScale = new THREE.Vector2(1, 1);
          material.needsUpdate = true;
          console.log(`[Cosmolabe] Generated normalMap from bumpMap for ${this.body.name}`);
        } else {
          // Fallback to bump map if normal generation fails
          material.bumpMap = texture;
          material.bumpScale = bumpScale ?? 1;
          material.needsUpdate = true;
        }
      } catch (e) {
        console.warn(`[Cosmolabe] Failed to load bumpMap for ${this.body.name}:`, e);
      }
    }
  }

  /**
   * Load a tiled texture (NameTemplate or MultiWMS level-0 tiles) and apply as baseMap.
   * Level 0 has 2 columns × 1 row; the two tiles are stitched into a single equirectangular map.
   * For image tiles (JPG/PNG): stitched on a 2D canvas.
   * For DDS tiles: rendered via Three.js to a RenderTarget.
   */
  async loadTiledBaseMap(tileUrls: [string, string], renderer: THREE.WebGLRenderer): Promise<void> {
    const material = this.mesh.material as THREE.MeshPhongMaterial | THREE.MeshStandardMaterial;

    // Detect format: extension for regular URLs, magic bytes for blob URLs
    let isDDS: boolean;
    if (!tileUrls[0].startsWith('blob:')) {
      isDDS = tileUrls[0].split('.').pop()?.toLowerCase() === 'dds';
    } else {
      const probe = await fetch(tileUrls[0]);
      const probeBuf = await probe.arrayBuffer();
      isDDS = isDDSMagic(probeBuf);
    }

    try {
      if (isDDS) {
        // DDS tiles: manual fetch + parse (DDSLoader.loadAsync can silently hang)
        const loadDDS = async (url: string) => {
          const resp = await fetch(url);
          const buf = await resp.arrayBuffer();
          const loader = new DDSLoader();
          const texData = loader.parse(buf, false);
          const tex = new THREE.CompressedTexture(
            texData.mipmaps, texData.width, texData.height,
            texData.format as THREE.CompressedPixelFormat,
          );
          tex.minFilter = texData.mipmaps.length === 1 ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.needsUpdate = true;
          return tex;
        };
        const [tex0, tex1] = await Promise.all([
          loadDDS(tileUrls[0]),
          loadDDS(tileUrls[1]),
        ]);

        // Determine tile dimensions from the compressed texture
        const w = tex0.image.width;
        const h = tex0.image.height;
        const rt = new THREE.WebGLRenderTarget(w * 2, h);
        const cam = new THREE.OrthographicCamera(0, 2, 1, 0, -1, 1);
        const scene = new THREE.Scene();

        // Two quads: left tile [0,1] and right tile [1,2]
        for (let i = 0; i < 2; i++) {
          const mat = new THREE.MeshBasicMaterial({ map: i === 0 ? tex0 : tex1 });
          const plane = new THREE.PlaneGeometry(1, 1);
          const mesh = new THREE.Mesh(plane, mat);
          mesh.position.set(i + 0.5, 0.5, 0);
          scene.add(mesh);
        }

        const savedRT = renderer.getRenderTarget();
        renderer.setRenderTarget(rt);
        renderer.clear();
        renderer.render(scene, cam);
        renderer.setRenderTarget(savedRT);

        // Clean up temp scene
        scene.traverse(c => {
          if (c instanceof THREE.Mesh) { c.geometry.dispose(); (c.material as THREE.Material).dispose(); }
        });
        tex0.dispose();
        tex1.dispose();

        rt.texture.colorSpace = THREE.SRGBColorSpace;
        this.applyBaseMap(material, rt.texture, `tiled[${tileUrls[0]},${tileUrls[1]}]`);
      } else {
        // Image tiles (JPG/PNG): stitch on a canvas
        const [img0, img1] = await Promise.all(tileUrls.map(url =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = url;
          })
        ));

        const canvas = document.createElement('canvas');
        canvas.width = img0.width + img1.width;
        canvas.height = Math.max(img0.height, img1.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img0, 0, 0);
        ctx.drawImage(img1, img0.width, 0);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        this.applyBaseMap(material, texture, `tiled[${tileUrls[0]},${tileUrls[1]}]`);
      }
    } catch (e) {
      console.warn(`[Cosmolabe] Failed to load tiled baseMap for ${this.body.name}:`, e);
    }
  }

  private applyBaseMap(material: THREE.MeshPhongMaterial | THREE.MeshStandardMaterial, texture: THREE.Texture, label: string): void {
    texture.colorSpace = THREE.SRGBColorSpace;
    material.map = texture;
    material.color.setHex(0xffffff);
    if (this.body.classification === 'star' || this.body.geometryData?.emissive === true) {
      material.emissiveMap = texture;
      material.emissive.setHex(0xffffff);
    }
    material.needsUpdate = true;
    console.log(`[Cosmolabe] Loaded baseMap for ${this.body.name}: ${label}`);
  }

  private async loadTexture(url: string): Promise<THREE.Texture> {
    // Non-blob URLs: detect format from file extension
    if (!url.startsWith('blob:')) {
      const ext = url.split('.').pop()?.toLowerCase();
      if (ext === 'dds') return this.loadDDSTexture(url);
      return new THREE.TextureLoader().loadAsync(url);
    }
    // Blob URLs have no extension — fetch and detect DDS from magic bytes
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const buffer = await response.arrayBuffer();
    if (isDDSMagic(buffer)) {
      return this.parseDDSBuffer(buffer);
    }
    // Non-DDS (JPG/PNG): TextureLoader handles blob URLs natively
    return new THREE.TextureLoader().loadAsync(url);
  }

  /**
   * Load a DDS texture with manual fetch + parse.
   * DDSLoader.loadAsync can silently hang (Promise never resolves/rejects) when
   * the DDS parser throws inside FileLoader's callback. Manual fetch gives us
   * proper error handling.
   */
  private async loadDDSTexture(url: string): Promise<THREE.CompressedTexture> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const buffer = await response.arrayBuffer();
    return this.parseDDSBuffer(buffer);
  }

  private parseDDSBuffer(buffer: ArrayBuffer): THREE.CompressedTexture {
    const loader = new DDSLoader();
    const texData = loader.parse(buffer, false);
    const texture = new THREE.CompressedTexture(
      texData.mipmaps,
      texData.width,
      texData.height,
      texData.format as THREE.CompressedPixelFormat,
    );
    texture.minFilter = texData.mipmaps.length === 1
      ? THREE.LinearFilter
      : THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
  }

  /**
   * Generate a tangent-space normal map from a height/displacement texture on a 2D canvas.
   * Unlike bump maps (which use screen-space derivatives and are zoom-dependent), normal maps
   * store the actual surface normal per texel — shading is consistent at every zoom level.
   *
   * @param heightTexture The grayscale height texture to derive normals from
   * @param strength Controls the steepness of normals (higher = more dramatic shadows)
   */
  private generateNormalMapFromHeight(heightTexture: THREE.Texture, strength: number): THREE.CanvasTexture | null {
    const img = heightTexture.image as HTMLImageElement | undefined;
    if (!img) return null;

    // Get image dimensions (works for HTMLImageElement and ImageBitmap)
    const w = img.naturalWidth ?? img.width;
    const h = img.naturalHeight ?? img.height;
    if (!w || !h) return null;

    // Read height data from source image
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = w;
    srcCanvas.height = h;
    const srcCtx = srcCanvas.getContext('2d')!;
    srcCtx.drawImage(img as CanvasImageSource, 0, 0);
    const srcData = srcCtx.getImageData(0, 0, w, h).data;

    // Output normal map
    const outCanvas = document.createElement('canvas');
    outCanvas.width = w;
    outCanvas.height = h;
    const outCtx = outCanvas.getContext('2d')!;
    const outImg = outCtx.createImageData(w, h);
    const out = outImg.data;

    // Sample height at (x, y) — wraps horizontally (equirectangular), clamps vertically
    const getH = (x: number, y: number) => {
      x = ((x % w) + w) % w;
      y = Math.max(0, Math.min(h - 1, y));
      return srcData[(y * w + x) * 4] / 255;
    };

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Sobel-like gradient from neighboring texels
        const hL = getH(x - 1, y);
        const hR = getH(x + 1, y);
        const hU = getH(x, y - 1);
        const hD = getH(x, y + 1);

        const dx = (hR - hL) * strength;
        const dy = (hD - hU) * strength;

        // Tangent-space normal
        const len = Math.sqrt(dx * dx + dy * dy + 1);
        const nx = -dx / len;
        const ny = -dy / len;
        const nz = 1 / len;

        // Encode [-1,1] → [0,255]
        const idx = (y * w + x) * 4;
        out[idx]     = (nx * 0.5 + 0.5) * 255;
        out[idx + 1] = (ny * 0.5 + 0.5) * 255;
        out[idx + 2] = (nz * 0.5 + 0.5) * 255;
        out[idx + 3] = 255;
      }
    }

    outCtx.putImageData(outImg, 0, 0);
    const normalTexture = new THREE.CanvasTexture(outCanvas);
    normalTexture.colorSpace = THREE.LinearSRGBColorSpace;
    console.log(`[Cosmolabe] Generated ${w}x${h} normal map for ${this.body.name} (strength=${strength})`);
    return normalTexture;
  }

  dispose(): void {
    for (const overlay of this.surfaceOverlays) overlay.dispose();
    this.surfaceOverlays.length = 0;
    this.terrainManager?.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    if (this.axesHelper) {
      this.axesHelper.geometry.dispose();
      (this.axesHelper.material as THREE.Material).dispose();
    }
    if (this.gridLines) {
      this.gridLines.traverse((child) => {
        if (child instanceof THREE.Line) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
        if (child instanceof THREE.Sprite) {
          child.material.map?.dispose();
          child.material.dispose();
        }
      });
    }
    if (this.modelContainer) {
      this.modelContainer.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (Array.isArray(child.material)) {
            child.material.forEach(m => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
    }
  }
}
