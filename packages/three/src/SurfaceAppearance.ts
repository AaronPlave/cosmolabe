import * as THREE from 'three';
import { bodyFixedToGeodetic, type TerrainDatum } from './TerrainSampler.js';

export type ElevationPalette = 'terrain' | 'blue-gold' | 'grayscale';
export interface SurfaceAppearanceSettings {
  hillshade: boolean;
  azimuthDeg: number;
  elevationDeg: number;
  contrast: number;
  imageryMix: number;
  elevationTint: boolean;
  palette: ElevationPalette;
  tintOpacity: number;
  minKm: number;
  maxKm: number;
}
export const DEFAULT_SURFACE_APPEARANCE: Readonly<SurfaceAppearanceSettings> = Object.freeze({
  hillshade: false, azimuthDeg: 315, elevationDeg: 45, contrast: 1,
  imageryMix: 0, elevationTint: false, palette: 'terrain', tintOpacity: 0.8,
  minKm: -10, maxKm: 15,
});
export const ELEVATION_PALETTES: Record<ElevationPalette, readonly [string, string, string]> = {
  terrain: ['#244c65', '#c3af78', '#fff4db'],
  'blue-gold': ['#244b83', '#91c6c4', '#f4d06b'],
  grayscale: ['#252525', '#959595', '#ffffff'],
};

export function normalizeSurfaceAppearance(s: SurfaceAppearanceSettings): SurfaceAppearanceSettings {
  const clamp = (n: number, low: number, high: number, fallback: number) =>
    Number.isFinite(n) ? Math.max(low, Math.min(high, n)) : fallback;
  const minKm = clamp(s.minKm, -1000, 1000, -10);
  return {
    hillshade: !!s.hillshade, elevationTint: !!s.elevationTint,
    azimuthDeg: clamp(s.azimuthDeg, 0, 360, 315), elevationDeg: clamp(s.elevationDeg, 5, 90, 45),
    contrast: clamp(s.contrast, 0.25, 3, 1), imageryMix: clamp(s.imageryMix, 0, 1, 0),
    palette: Object.hasOwn(ELEVATION_PALETTES, s.palette) ? s.palette : 'terrain',
    tintOpacity: clamp(s.tintOpacity, 0, 1, 0.8), minKm,
    maxKm: Math.max(minKm + 0.001, clamp(s.maxKm, -1000, 1000, 15)),
  };
}

type Shader = { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> };

export function renderedHeightKm(point: THREE.Vector3, datum: TerrainDatum): number {
  if (datum.heightConvention === 'geodetic-normal') {
    return bodyFixedToGeodetic({ xKm: point.x, yKm: point.y, zKm: point.z }, datum).heightKm ?? 0;
  }
  const shape = datum.referenceShape;
  const r = point.length();
  if (shape.kind === 'sphere') return r - shape.radiusKm;
  const [a, b, c] = shape.radiiKm;
  const reference = r / Math.sqrt((point.x / a) ** 2 + (point.y / b) ** 2 + (point.z / c) ** 2);
  return r - reference;
}

/** Styling only: cached quantized-mesh geometry is in tile-local metres, ECEF Z north.
 * Position attributes, normals, geometry indices, LOD and physical sampling stay untouched.
 * No shader additions or extra attributes until a style is enabled. */
export class SurfaceAppearance {
  private settings: SurfaceAppearanceSettings = { ...DEFAULT_SURFACE_APPEARANCE };
  private readonly meshes = new Map<THREE.Mesh, { matrix: THREE.Matrix4; materials: THREE.Material[] }>();
  private readonly uniforms = {
    saLight: { value: new THREE.Vector3() }, saContrast: { value: 1 },
    saImageryMix: { value: 0 }, saOpacity: { value: 0.8 }, saRange: { value: new THREE.Vector2(-10, 15) },
    saLow: { value: new THREE.Color() }, saMid: { value: new THREE.Color() }, saHigh: { value: new THREE.Color() },
    saUpScale: { value: new THREE.Vector3(1, 1, 1) },
  };

  constructor(readonly datum: TerrainDatum) {
    if (datum.referenceShape.kind === 'ellipsoid') {
      const [a, b, c] = datum.referenceShape.radiiKm;
      this.uniforms.saUpScale.value.set(1, (a / b) ** 2, (a / c) ** 2);
    }
    this.updateUniforms();
  }
  get current(): SurfaceAppearanceSettings { return { ...this.settings }; }
  get active(): boolean { return this.settings.hillshade || this.settings.elevationTint; }

  set(settings: SurfaceAppearanceSettings): void {
    const before = this.key();
    this.settings = normalizeSurfaceAppearance(settings);
    this.updateUniforms();
    for (const [mesh, entry] of this.meshes) {
      if (this.settings.elevationTint) this.prepareHeights(mesh, entry.matrix);
      if (this.key() !== before) entry.materials.forEach(m => { m.needsUpdate = true; });
      if (!this.settings.elevationTint && mesh.geometry.hasAttribute('surfaceHeightKm')) {
        // Release GPU buffers while the attribute is still registered. Merely
        // deleting it strands its WebGL buffer across repeated on/off toggles.
        // dispose invalidates uploads, preserving the physical CPU geometry.
        mesh.geometry.dispose();
        mesh.geometry.deleteAttribute('surfaceHeightKm');
      }
    }
  }

  private key(): string {
    return this.active ? `_surface_v1_${Number(this.settings.hillshade)}_${Number(this.settings.elevationTint)}` : '';
  }

  /** Matrix maps mesh local coordinates into the tiles renderer's ECEF frame,
   * before its -PI/2 rotation, camera-relative origin and km-to-scene scaling. */
  attach(mesh: THREE.Mesh, matrix: THREE.Matrix4): void {
    if (this.meshes.has(mesh)) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    this.meshes.set(mesh, { matrix, materials });
    if (this.settings.elevationTint) this.prepareHeights(mesh, matrix);
    const localToBody = { value: matrix };
    for (const material of materials) {
      const previous = material.onBeforeCompile.bind(material);
      const previousKey = material.customProgramCacheKey.bind(material);
      // Snapshot the key before changing onBeforeCompile: the Three default key
      // reads that callback's source dynamically.
      const baseKey = previousKey();
      const defaultKey = material.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey;
      material.onBeforeCompile = (shader, renderer) => {
        previous(shader, renderer);
        if (this.active) this.inject(shader, localToBody);
      };
      material.customProgramCacheKey = () => (defaultKey ? baseKey : previousKey()) + this.key();
      if (this.active) material.needsUpdate = true;
    }
  }

  forget(scene: THREE.Object3D): void {
    scene.traverse(child => { this.meshes.delete(child as THREE.Mesh); });
  }

  private prepareHeights(mesh: THREE.Mesh, matrix: THREE.Matrix4): void {
    if (mesh.geometry.hasAttribute('surfaceHeightKm')) return;
    const positions = mesh.geometry.getAttribute('position');
    const heights = new Float32Array(positions.count);
    const p = new THREE.Vector3();
    for (let i = 0; i < positions.count; i++) {
      p.fromBufferAttribute(positions, i).applyMatrix4(matrix).multiplyScalar(0.001);
      heights[i] = renderedHeightKm(p, this.datum);
    }
    mesh.geometry.setAttribute('surfaceHeightKm', new THREE.BufferAttribute(heights, 1));
  }

  private updateUniforms(): void {
    const s = this.settings, az = THREE.MathUtils.degToRad(s.azimuthDeg), el = THREE.MathUtils.degToRad(s.elevationDeg);
    // Local east, north, up; azimuth clockwise from geographic north.
    this.uniforms.saLight.value.set(Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el));
    this.uniforms.saContrast.value = s.contrast;
    this.uniforms.saImageryMix.value = s.imageryMix;
    this.uniforms.saOpacity.value = s.tintOpacity;
    this.uniforms.saRange.value.set(s.minKm, s.maxKm);
    const colors = ELEVATION_PALETTES[s.palette];
    this.uniforms.saLow.value.set(colors[0]); this.uniforms.saMid.value.set(colors[1]); this.uniforms.saHigh.value.set(colors[2]);
  }

  private inject(shader: Shader, localToBody: { value: THREE.Matrix4 }): void {
    Object.assign(shader.uniforms, this.uniforms, { saLocalToBody: localToBody });
    if (this.settings.elevationTint) {
      shader.vertexShader = 'attribute float surfaceHeightKm; varying float vSAHeight;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvSAHeight = surfaceHeightKm;');
      shader.fragmentShader = `varying float vSAHeight;
uniform vec2 saRange; uniform float saOpacity; uniform vec3 saLow, saMid, saHigh;
` + shader.fragmentShader;
      // After current imagery overlays have composed diffuseColor, before lighting.
      shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `
float saT = clamp((vSAHeight - saRange.x) / (saRange.y - saRange.x), 0.0, 1.0);
vec3 saTint = saT < 0.5 ? mix(saLow, saMid, saT * 2.0) : mix(saMid, saHigh, saT * 2.0 - 1.0);
vec3 saUntintedDiffuse = diffuseColor.rgb;
diffuseColor.rgb = mix(diffuseColor.rgb, saTint, saOpacity);
#include <roughnessmap_fragment>`);
    }
    if (this.settings.hillshade) {
      shader.vertexShader = 'varying vec3 vSALocal, vSANormal; uniform mat4 saLocalToBody;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvSALocal = position; vSANormal = normal;');
      shader.fragmentShader = `varying vec3 vSALocal, vSANormal; uniform mat4 saLocalToBody;
uniform vec3 saLight, saUpScale; uniform float saContrast, saImageryMix;
` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <shadowmap_pars_fragment>',
        '#include <shadowmap_pars_fragment>\n#include <shadowmask_pars_fragment>');
      // Use the loaded mesh's smooth geometry normals, without the imagery's
      // normal map. Small tile-local positions avoid camera-origin cancellation.
      // Replace only displayed radiance, before existing eclipse/shadow/AP hooks.
      shader.fragmentShader = shader.fragmentShader.replace(/vec3 outgoingLight = [^;]+;/, `$&
vec3 saUp = normalize((saLocalToBody * vec4(vSALocal, 1.0)).xyz * saUpScale);
vec3 saEast = cross(vec3(0.0, 0.0, 1.0), saUp);
saEast = length(saEast) > 0.00001 ? normalize(saEast) : vec3(0.0, 1.0, 0.0);
vec3 saNorth = normalize(cross(saUp, saEast));
vec3 saNormal = normalize(mat3(saLocalToBody) * vSANormal);
if (dot(saNormal, saUp) < 0.0) saNormal = -saNormal;
vec3 saDirection = saEast * saLight.x + saNorth * saLight.y + saUp * saLight.z;
float saShade = clamp((max(0.0, dot(saNormal, saDirection)) - 0.5) * saContrast + 0.5, 0.0, 1.0);
vec3 saBase = mix(vec3(1.0), ${this.settings.elevationTint ? 'saUntintedDiffuse' : 'diffuseColor.rgb'}, saImageryMix);
${this.settings.elevationTint ? 'saBase = mix(saBase, saTint, saOpacity);' : ''}
outgoingLight = saBase * (0.12 + 0.88 * saShade) * getShadowMask();`);
    }
  }
}
