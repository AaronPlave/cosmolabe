import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
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
  /** Orientation axes helper (red=X/prime meridian, green=Y, blue=Z/pole) */
  private axesHelper: THREE.AxesHelper | null = null;
  private axesVisible = false;
  /** Scene scale factor (km → scene units). Set each frame by updatePosition. */
  scaleFactor = 1;

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
    const geometry = new THREE.SphereGeometry(this.displayRadius, 32, 24);
    const color = DEFAULT_BODY_COLORS[body.classification ?? ''] ?? 0xcccccc;
    const material = new THREE.MeshPhongMaterial({ color });

    // Stars emit light
    if (body.classification === 'star') {
      (material as THREE.MeshPhongMaterial).emissive = new THREE.Color(0xffdd44);
      (material as THREE.MeshPhongMaterial).emissiveIntensity = 0.8;
    }

    this.mesh = new THREE.Mesh(geometry, material);
    this.add(this.mesh);
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

    // Apply mesh rotation (Cosmographia quaternion: [w, x, y, z])
    const meshRotation = geo.meshRotation as number[] | undefined;
    if (meshRotation && meshRotation.length >= 4) {
      object.quaternion.set(
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

    // Apply rotation if available
    const q = this.body.rotationAt(et);
    if (q) {
      // Apply to the mesh container (model or sphere)
      const target = this.modelContainer ?? this.mesh;
      target.quaternion.set(q[1], q[2], q[3], q[0]); // SPICE [w,x,y,z] → Three [x,y,z,w]

      // Apply same rotation to axes helper
      if (this.axesHelper) {
        this.axesHelper.quaternion.copy(target.quaternion);
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
      default: return 100;
    }
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
