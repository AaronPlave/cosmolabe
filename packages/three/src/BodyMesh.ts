import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { DDSLoader } from 'three/examples/jsm/loaders/DDSLoader.js';
import { parseCmod, type CmodTextureResolver } from './CmodLoader.js';
import type { Body } from '@spicecraft/core';

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
  private modelContainer: THREE.Object3D | null = null;
  private loadedModel = false;
  /** Base scale applied to the model container (before dynamic sizing) */
  private modelBaseScale = 1;
  /** Fixed rotation from model-native axes to body frame (composed with SPICE attitude) */
  meshRotationQ = new THREE.Quaternion();
  /** Orientation axes helper (red=X/prime meridian, green=Y, blue=Z/pole) */
  private axesHelper: THREE.AxesHelper | null = null;
  private axesVisible = false;
  /** Scene scale factor (km → scene units). Set each frame by updatePosition. */
  scaleFactor = 1;
  /**
   * Axis ratios for triaxial ellipsoid in geometry space [geoX, geoY, geoZ].
   * Maps body-fixed [rx, ry, rz] → geometry axes accounting for the Globe pre-rotation
   * (geometry Y = body-fixed Z pole). Default [1,1,1] for spherical bodies.
   */
  private ellipsoidRatios: [number, number, number] = [1, 1, 1];

  get hasModel(): boolean { return this.modelContainer !== null; }
  get isModelVisible(): boolean { return this.modelContainer?.visible ?? false; }

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
    // Globe bodies get higher segment count for texture quality
    const isGlobe = body.geometryType === 'Globe';
    const wSegs = isGlobe ? 64 : 32;
    const hSegs = isGlobe ? 48 : 24;
    const geometry = new THREE.SphereGeometry(this.displayRadius, wSegs, hSegs);
    const color = DEFAULT_BODY_COLORS[body.classification ?? ''] ?? 0xcccccc;
    const material = new THREE.MeshPhongMaterial({ color });

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
          console.warn(`[SpiceCraft] Failed to parse .cmod for ${this.body.name}`);
          return;
        }
        object = parsed;
      } else {
        console.warn(`[SpiceCraft] Unsupported model format: .${ext} for ${this.body.name}`);
        return;
      }
    } catch (e) {
      console.warn(`[SpiceCraft] Failed to load model for ${this.body.name}: ${e instanceof Error ? e.message : e}`);
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
        for (const mat of mats) {
          // Strip log depth chunks — model uses standard hardware depth
          mat.onBeforeCompile = (shader: { vertexShader: string; fragmentShader: string }) => {
            shader.vertexShader = shader.vertexShader
              .replace('#include <logdepthbuf_pars_vertex>', '')
              .replace('#include <logdepthbuf_vertex>', '');
            shader.fragmentShader = shader.fragmentShader
              .replace('#include <logdepthbuf_pars_fragment>', '')
              .replace('#include <logdepthbuf_fragment>', '');
          };
          mat.customProgramCacheKey = () => 'model_nologdepth';
        }
      }
    });

    // Replace placeholder sphere with loaded model
    this.mesh.visible = false;
    this.modelContainer = object;
    this.add(object);

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
      }
    } catch {
      // Rotation data not available at this time (e.g. CK gap) — keep last orientation
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
    // console.log(`[SpiceCraft] Model ${this.body.name}: bbox size (${bboxSize.x.toFixed(2)}, ${bboxSize.y.toFixed(2)}, ${bboxSize.z.toFixed(2)}), center (${bboxCenter.x.toFixed(2)}, ${bboxCenter.y.toFixed(2)}, ${bboxCenter.z.toFixed(2)})`);

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
    // console.log(`[SpiceCraft] Model meshes (${meshInfos.length} total, ${allVertices.length} verts):`);
    for (const m of meshInfos.sort((a, b) => b.vertexCount - a.vertexCount).slice(0, 15)) {
      const c = m.center;
      const n = m.avgNormal;
      // console.log(`  "${m.name}": ${m.vertexCount} verts, center=(${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)}), normal=(${n.x.toFixed(3)},${n.y.toFixed(3)},${n.z.toFixed(3)}), coherence=${m.coherence.toFixed(3)}`);
    }

    // 2. Compute centroid
    const centroid = new THREE.Vector3();
    for (const v of allVertices) centroid.add(v);
    centroid.divideScalar(allVertices.length);
    // console.log(`[SpiceCraft] Centroid: (${centroid.x.toFixed(2)},${centroid.y.toFixed(2)},${centroid.z.toFixed(2)})`);

    // 3. Identify features by mesh name (case-insensitive substring match)
    const findMesh = (keywords: string[]) =>
      meshInfos.find(m => keywords.some(k => m.name.toLowerCase().includes(k)));

    const dishMesh = findMesh(['dish', 'hga', 'antenna_main']);
    const huygensMesh = findMesh(['huygens']);

    if (dishMesh) {
      // HGA boresight: direction from centroid toward the dish center (outward from spacecraft)
      const hgaDir = dishMesh.center.clone().sub(centroid).normalize();
      // console.log(`[SpiceCraft] HGA dish: "${dishMesh.name}" at (${dishMesh.center.x.toFixed(2)},${dishMesh.center.y.toFixed(2)},${dishMesh.center.z.toFixed(2)}), boresight dir=(${hgaDir.x.toFixed(3)},${hgaDir.y.toFixed(3)},${hgaDir.z.toFixed(3)})`);

      // Second constraint: Huygens probe position → body +X, or fallback to geometric analysis
      let secondDir: THREE.Vector3;
      let secondBodyDir: THREE.Vector3;
      if (huygensMesh) {
        secondDir = huygensMesh.center.clone().sub(centroid).normalize();
        secondBodyDir = new THREE.Vector3(1, 0, 0); // Huygens = body +X
        // console.log(`[SpiceCraft] Huygens: "${huygensMesh.name}" at (${huygensMesh.center.x.toFixed(2)},${huygensMesh.center.y.toFixed(2)},${huygensMesh.center.z.toFixed(2)}), dir=(${secondDir.x.toFixed(3)},${secondDir.y.toFixed(3)},${secondDir.z.toFixed(3)})`);
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
        // console.log(`[SpiceCraft] Boom tip: (${tip.x.toFixed(2)},${tip.y.toFixed(2)},${tip.z.toFixed(2)}), dir=(${secondDir.x.toFixed(3)},${secondDir.y.toFixed(3)},${secondDir.z.toFixed(3)})`);
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
      // console.log(`[SpiceCraft] Computed meshRotation [w,x,y,z]: [${q.w.toFixed(4)}, ${q.x.toFixed(4)}, ${q.y.toFixed(4)}, ${q.z.toFixed(4)}]`);
    } else {
      // console.log(`[SpiceCraft] No dish mesh found — cannot compute meshRotation analytically`);
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
  }

  /**
   * Load textures for Globe geometry (baseMap and/or normalMap).
   * Supports DDS (S3TC compressed) and standard image formats (PNG, JPG).
   */
  async loadGlobeTextures(baseMapUrl?: string, normalMapUrl?: string): Promise<void> {
    const material = this.mesh.material as THREE.MeshPhongMaterial;

    if (baseMapUrl) {
      try {
        const texture = await this.loadTexture(baseMapUrl);
        this.applyBaseMap(material, texture, baseMapUrl);
      } catch (e) {
        console.warn(`[SpiceCraft] Failed to load baseMap for ${this.body.name}:`, e);
      }
    }

    if (normalMapUrl) {
      try {
        const texture = await this.loadTexture(normalMapUrl);
        material.normalMap = texture;
        material.needsUpdate = true;
        console.log(`[SpiceCraft] Loaded normalMap for ${this.body.name}: ${normalMapUrl}`);
      } catch (e) {
        console.warn(`[SpiceCraft] Failed to load normalMap for ${this.body.name}:`, e);
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
    const material = this.mesh.material as THREE.MeshPhongMaterial;

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
      console.warn(`[SpiceCraft] Failed to load tiled baseMap for ${this.body.name}:`, e);
    }
  }

  private applyBaseMap(material: THREE.MeshPhongMaterial, texture: THREE.Texture, label: string): void {
    texture.colorSpace = THREE.SRGBColorSpace;
    material.map = texture;
    material.color.setHex(0xffffff);
    if (this.body.classification === 'star' || this.body.geometryData?.emissive === true) {
      material.emissiveMap = texture;
      material.emissive.setHex(0xffffff);
    }
    material.needsUpdate = true;
    console.log(`[SpiceCraft] Loaded baseMap for ${this.body.name}: ${label}`);
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

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    if (this.axesHelper) {
      this.axesHelper.geometry.dispose();
      (this.axesHelper.material as THREE.Material).dispose();
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
