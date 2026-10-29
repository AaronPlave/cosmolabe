import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/** Rebuild physical surface depth in an overlay/model pass's depth space.
 * Proxies borrow geometry, retain exact world transforms, and never alter the
 * authoritative meshes/materials or their logarithmic-depth scene pass. */
export class ModelSurfaceDepth {
  readonly scene = new THREE.Scene();
  private readonly material: THREE.MeshBasicMaterial;
  private readonly layer: number;
  private readonly measureDistance: boolean;
  private readonly proxies = new Map<THREE.Mesh, THREE.Mesh>();
  private readonly inverse = new THREE.Matrix4();
  private readonly local = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  /** Limit a composite pass to surfaces strictly in front of every site envelope. */
  readonly clipDistance = { value: Infinity };

  constructor(options: { logarithmicDepth?: boolean; side?: THREE.Side; layer?: number; measureDistance?: boolean; clipAtDistance?: boolean } = {}) {
    this.material = new THREE.MeshBasicMaterial({ colorWrite: false, side: options.side ?? THREE.FrontSide });
    this.layer = options.layer ?? 1;
    this.measureDistance = options.measureDistance !== false;
    this.material.onBeforeCompile = (shader) => {
      if (!options.logarithmicDepth) {
        for (const stage of ['vertexShader', 'fragmentShader'] as const) {
          shader[stage] = shader[stage].replace(/#include <logdepthbuf[^>]*>/g, '');
        }
      }
      if (options.clipAtDistance) {
        shader.uniforms.siteDepthLimit = this.clipDistance;
        shader.vertexShader = 'varying vec3 siteDepthViewPosition;\n' + shader.vertexShader.replace(
          '#include <project_vertex>', '#include <project_vertex>\nsiteDepthViewPosition = mvPosition.xyz;');
        shader.fragmentShader = 'varying vec3 siteDepthViewPosition;\nuniform float siteDepthLimit;\n' + shader.fragmentShader.replace(
          '#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (length(siteDepthViewPosition) >= siteDepthLimit) discard;');
      }
    };
    this.material.customProgramCacheKey = () => `physical_surface_${options.logarithmicDepth ? 'log' : 'linear'}_depth_${!!options.clipAtDistance}`;
  }

  /** Visible surfaces only. Returns a conservative nearest-surface distance
   * so a foreground plate is not clipped by a near plane chosen for models. */
  update(surfaces: readonly THREE.Mesh[], cameraPosition: THREE.Vector3, distanceCeiling = Infinity, renderOrigin?: THREE.Vector3): number {
    const active = new Set(surfaces);
    for (const [source, proxy] of this.proxies) {
      if (!active.has(source)) { this.scene.remove(proxy); this.proxies.delete(source); }
    }
    let nearest = distanceCeiling;
    for (const source of surfaces) {
      source.updateWorldMatrix(true, false);
      let proxy = this.proxies.get(source);
      if (!proxy) {
        proxy = new THREE.Mesh(source.geometry, this.material);
        proxy.matrixAutoUpdate = false;
        proxy.layers.set(this.layer);
        this.proxies.set(source, proxy);
        this.scene.add(proxy);
      }
      proxy.geometry = source.geometry;
      proxy.matrix.copy(source.matrixWorld);
      if (renderOrigin) proxy.matrix.setPosition(new THREE.Vector3().setFromMatrixPosition(proxy.matrix).sub(renderOrigin));
      proxy.matrixWorldNeedsUpdate = true;
      if (!this.measureDistance) continue;
      // DSK transforms are uniform scales; the minimum scale also gives a
      // conservative bound if a host supplies a nonuniform transform.
      this.inverse.copy(source.matrixWorld).invert();
      this.local.copy(cameraPosition).applyMatrix4(this.inverse);
      this.scale.setFromMatrixScale(source.matrixWorld);
      const minScale = Math.min(this.scale.x, this.scale.y, this.scale.z);
      const sphere = source.geometry.boundingSphere;
      if (sphere && Math.max(0, this.local.distanceTo(sphere.center) - sphere.radius) * minScale >= nearest) continue;
      const tree = source.geometry.boundsTree;
      const closest = tree instanceof MeshBVH ? tree.closestPointToPoint(this.local) : null;
      if (closest) {
        nearest = Math.min(nearest, closest.distance * minScale);
      }
    }
    return nearest;
  }

  dispose(): void {
    this.scene.clear();
    this.proxies.clear();
    this.material.dispose(); // Borrowed DSK geometry belongs to BodyMesh.
  }
}
