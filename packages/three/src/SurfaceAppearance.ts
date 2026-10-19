import * as THREE from 'three';
import { injectTerrainContours } from './TerrainContours.js';
import { bodyFixedToGeodetic, type TerrainDatum } from './TerrainSampler.js';

export type SurfaceBaseColor = 'imagery' | 'elevation' | 'neutral';
export type ElevationPalette = 'terrain' | 'blue-gold' | 'grayscale';
export interface SurfaceAppearanceSettings {
  hillshade: boolean;
  /** Visual bands on loaded geometry; spacing adapts to the screen footprint. */
  contours?: boolean;
  contourOpacity?: number;
  contourColor?: string;
  contourDensity?: number;
  azimuthDeg: number;
  elevationDeg: number;
  contrast: number;
  baseColor: SurfaceBaseColor;
  imageryAmount: number;
  palette: ElevationPalette;
  minKm: number;
  maxKm: number;
}
export const DEFAULT_SURFACE_APPEARANCE: Readonly<SurfaceAppearanceSettings> = Object.freeze({
  contours: false, contourOpacity: 0.35, contourColor: '#f2e6c9', contourDensity: 1,
  hillshade: false, azimuthDeg: 315, elevationDeg: 45, contrast: 1,
  baseColor: 'imagery', imageryAmount: 0.25, palette: 'terrain',
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
    hillshade: !!s.hillshade, baseColor: ['imagery', 'elevation', 'neutral'].includes(s.baseColor) ? s.baseColor : 'imagery',
    azimuthDeg: clamp(s.azimuthDeg, 0, 360, 315), elevationDeg: clamp(s.elevationDeg, 5, 90, 45),
    contrast: clamp(s.contrast, 0.25, 3, 1), imageryAmount: clamp(s.imageryAmount, 0, 1, 0.25),
    palette: Object.hasOwn(ELEVATION_PALETTES, s.palette) ? s.palette : 'terrain',
    contours: !!s.contours,
    contourOpacity: clamp(s.contourOpacity ?? 0.35, 0, 1, 0.35),
    contourDensity: clamp(s.contourDensity ?? 1, 0.25, 4, 1),
    contourColor: /^#[0-9a-f]{6}$/i.test(s.contourColor ?? '') ? s.contourColor : '#f2e6c9',
    minKm,
    maxKm: Math.max(minKm + 0.001, clamp(s.maxKm, -1000, 1000, 15)),
  };
}

type Shader = { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> };
interface NormalReference { attribute: THREE.BufferAttribute; index: number; normal: THREE.Vector3; weight: number; }
interface NormalNode { references: Set<NormalReference>; }
interface StyledMesh {
  visibilityRoot?: THREE.Object3D;
  derived?: boolean;
  matrix: THREE.Matrix4;
  materials: THREE.Material[];
  ready: boolean;
  normalsActive?: boolean;
  normals?: Array<[string, NormalReference]>;
}

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

/** Interpolate the same vertex height varying used by elevation colors. A
 * coarse triangle's chord height can differ from its interpolated source
 * height; range picking must match the color field the user clicked. */
export function surfaceTintHeightAtHit(hit: THREE.Intersection): number | undefined {
  const mesh = hit.object as THREE.Mesh;
  if (!mesh.isMesh || !hit.face) return undefined;
  const height = mesh.geometry.getAttribute('surfaceHeightKm');
  if (!height) return undefined;
  const positions = mesh.geometry.getAttribute('position'), { a, b, c } = hit.face;
  const weights = THREE.Triangle.getBarycoord(mesh.worldToLocal(hit.point.clone()),
    new THREE.Vector3().fromBufferAttribute(positions, a), new THREE.Vector3().fromBufferAttribute(positions, b),
    new THREE.Vector3().fromBufferAttribute(positions, c), new THREE.Vector3());
  return weights ? weights.x * height.getX(a) + weights.y * height.getX(b) + weights.z * height.getX(c) : undefined;
}

/** Styling only: known planetary geometry is in tile-local metres, ECEF Z north.
 * Position attributes, normals, geometry indices, LOD and physical sampling stay untouched.
 * No shader additions or extra attributes until a style is enabled. */
export class SurfaceAppearance {
  private settings: SurfaceAppearanceSettings = { ...DEFAULT_SURFACE_APPEARANCE };
  private readonly meshes = new Map<THREE.Mesh, StyledMesh>();
  private readonly normalNodes = new Map<string, NormalNode>();
  private readonly uniforms = {
    saLight: { value: new THREE.Vector3() }, saContrast: { value: 1 },
    saImageryAmount: { value: 0.25 }, saRange: { value: new THREE.Vector2(-10, 15) },
    saLow: { value: new THREE.Color() }, saMid: { value: new THREE.Color() }, saHigh: { value: new THREE.Color() },
    saContourColor: { value: new THREE.Color() }, saContourOpacity: { value: 0.35 }, saContourDensity: { value: 1 },
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
  get active(): boolean { return !!this.settings.contours || this.settings.hillshade || this.settings.baseColor !== 'imagery'; }

  set(settings: SurfaceAppearanceSettings): void {
    const before = this.key();
    this.settings = normalizeSurfaceAppearance(settings);
    this.updateUniforms();
    if (!this.settings.hillshade) this.normalNodes.clear();
    for (const [mesh, entry] of this.meshes) {
      if (!this.settings.hillshade) { entry.normals = undefined; entry.normalsActive = false; }
      entry.ready = this.isPrepared(mesh);
      if (this.key() !== before) entry.materials.forEach(m => { m.needsUpdate = true; });
      const unused = [
        ...(!this.needsHeights ? ['surfaceHeightKm'] : []),
        ...(!this.settings.hillshade && !this.settings.contours ? ['surfaceGround'] : []),
        ...(!this.settings.hillshade ? ['surfaceReliefNormal'] : []),
      ].filter(name => mesh.geometry.hasAttribute(name));
      if (unused.length) {
        // Release GPU buffers while the attribute is still registered. Merely
        // deleting it strands its WebGL buffer across repeated on/off toggles.
        // dispose invalidates uploads, preserving the physical CPU geometry.
        mesh.geometry.dispose();
        unused.forEach(name => mesh.geometry.deleteAttribute(name));
      }
    }
  }

  private get needsHeights(): boolean { return !!this.settings.contours || this.settings.baseColor === 'elevation'; }

  private isPrepared(mesh: THREE.Mesh): boolean {
    return (!this.needsHeights || mesh.geometry.hasAttribute('surfaceHeightKm')) &&
      (!this.settings.contours || mesh.geometry.hasAttribute('surfaceGround')) &&
      (!this.settings.hillshade || mesh.geometry.hasAttribute('surfaceReliefNormal'));
  }

  /** Prepare visible tiles only, yielding between tiles after a small frame budget.
   * Until ready a tile retains its ordinary imagery shader. One tile is atomic. */
  update(budgetMs = 4): { meshes: number; vertices: number; elapsedMs: number; maxTileMs: number } {
    const start = performance.now();
    let meshes = 0, vertices = 0, maxTileMs = 0;
    const visibleMeshes: Array<[THREE.Mesh, StyledMesh]> = [];
    const touched = new Set<NormalNode>();
    // Reconcile all prepared tiles before the preparation budget can yield.
    // Cached hidden parents must leave the shared field immediately; already
    // prepared children/parents rejoin on every visibility transition.
    if (this.active) for (const [mesh, entry] of this.meshes) {
      if (entry.derived) continue;
      let visible = !entry.visibilityRoot || !!entry.visibilityRoot.parent;
      for (let object: THREE.Object3D | null = entry.visibilityRoot ?? mesh; object; object = object.parent) {
        if (!object.visible) { visible = false; break; }
      }
      if (this.settings.hillshade) this.setNormalContributions(entry, visible, touched);
      if (visible && !entry.ready) visibleMeshes.push([mesh, entry]);
    }
    touched.forEach(node => this.publishNormal(node));
    for (const [mesh, entry] of visibleMeshes) {
      const tileStart = performance.now();
      if (this.needsHeights) this.prepareHeights(mesh, entry.matrix);
      if (this.settings.contours) this.prepareGroundMask(mesh);
      if (this.settings.hillshade) this.prepareReliefNormals(mesh, entry);
      entry.ready = true;
      entry.materials.forEach(m => { m.needsUpdate = true; });
      meshes++;
      vertices += mesh.geometry.getAttribute('position').count;
      maxTileMs = Math.max(maxTileMs, performance.now() - tileStart);
      if (performance.now() - start >= budgetMs) break;
    }
    return { meshes, vertices, elapsedMs: performance.now() - start, maxTileMs };
  }

  private key(): string {
    return this.active ? `_surface_v6_${Number(this.settings.hillshade)}_${this.settings.baseColor}_${Number(!!this.settings.contours)}` : '';
  }

  /** Matrix maps mesh local coordinates into the tiles renderer's ECEF frame,
   * before its -PI/2 rotation, camera-relative origin and km-to-scene scaling. */
  attach(mesh: THREE.Mesh, matrix: THREE.Matrix4, visibilityRoot?: THREE.Object3D, derived = false): void {
    if (this.meshes.has(mesh)) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const entry: StyledMesh = { matrix, materials, ready: false, visibilityRoot, derived };
    this.meshes.set(mesh, entry);
    entry.ready = this.isPrepared(mesh);
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
        if (this.active && entry.ready) this.inject(shader, localToBody);
      };
      material.customProgramCacheKey = () => (defaultKey ? baseKey : previousKey()) + (entry.ready ? this.key() : '');
      if (this.active) material.needsUpdate = true;
    }
  }

  /** Imagery clips these attributes barycentrically on the original triangles.
   * Never recompute heights or normals on the clipped topology. */
  attachDerived(mesh: THREE.Mesh, source: THREE.Mesh): void {
    const entry = this.meshes.get(source);
    if (entry) this.attach(mesh, entry.matrix, entry.visibilityRoot, true);
  }

  private surfaceRange(geometry: THREE.BufferGeometry): { start: number; count: number } {
    const triangles = geometry.userData.surfaceTriangles;
    return Number.isSafeInteger(triangles) && triangles > 0
      ? { start: 0, count: triangles * 3 }
      : geometry.groups[0] ?? { start: 0, count: geometry.index?.count ?? geometry.getAttribute('position').count };
  }

  private setNormalContributions(entry: StyledMesh, active: boolean, touched: Set<NormalNode>): void {
    if (!entry.normals || !!entry.normalsActive === active) return;
    entry.normalsActive = active;
    for (const [key, ref] of entry.normals) {
      let node = this.normalNodes.get(key);
      if (active) {
        if (!node) { node = { references: new Set() }; this.normalNodes.set(key, node); }
        node.references.add(ref);
      } else if (node) {
        node.references.delete(ref);
        if (!node.references.size) this.normalNodes.delete(key);
      }
      if (node) touched.add(node);
    }
  }

  forget(scene: THREE.Object3D): void {
    const touched = new Set<NormalNode>();
    scene.traverse(child => {
      const mesh = child as THREE.Mesh, entry = this.meshes.get(mesh);
      if (entry) this.setNormalContributions(entry, false, touched);
      this.meshes.delete(mesh);
    });
    touched.forEach(node => this.publishNormal(node));
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

  private prepareGroundMask(mesh: THREE.Mesh): void {
    const geometry = mesh.geometry;
    if (geometry.hasAttribute('surfaceGround')) return;
    const mask = new Float32Array(geometry.getAttribute('position').count);
    const surface = this.surfaceRange(geometry);
    for (let i = surface.start; i < surface.start + surface.count; i++) {
      mask[geometry.index ? geometry.index.getX(i) : i] = 1;
    }
    // Skirts/bottom caps hide cracks; they are not terrain slopes. Avoid
    // converting their vertical faces into artificial dark tile outlines.
    geometry.setAttribute('surfaceGround', new THREE.BufferAttribute(mask, 1));
  }

  /** Area-weighted relief-normal corrections share contributions at matching geographic
   * vertices across visible tiles. Skirts never contribute to ground normals.
   * Angular keys absorb roundoff and small cross-LOD height differences. This
   * subtracts the same triangle on the datum to remove coarse curvature bias.
   * The shader adds analytic local up after interpolation, so a smooth datum
   * has no artificial triangular relief. Physical geometry stays unchanged. */
  private prepareReliefNormals(mesh: THREE.Mesh, entry: StyledMesh): void {
    if (entry.normals) return;
    this.prepareGroundMask(mesh);
    const geometry = mesh.geometry, positions = geometry.getAttribute('position');
    const ground = geometry.getAttribute('surfaceGround');
    const sums = new Float64Array(positions.count * 3), weights = new Float64Array(positions.count);
    const world = new Float64Array(positions.count * 3), reference = new Float64Array(positions.count * 3);
    const shape = this.datum.referenceShape;
    const radii = shape.kind === 'sphere' ? [shape.radiusKm, shape.radiusKm, shape.radiusKm] : shape.radiiKm;
    const point = new THREE.Vector3();
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(entry.matrix);
      point.toArray(world, i * 3);
      const factor = Math.hypot(point.x / (radii[0] * 1000), point.y / (radii[1] * 1000), point.z / (radii[2] * 1000));
      point.multiplyScalar(factor > 0 ? 1 / factor : 0).toArray(reference, i * 3);
    }
    const edgeCounts = new Map<number, number>();
    const { start, count } = this.surfaceRange(geometry);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), face = new THREE.Vector3();
    const ra = new THREE.Vector3(), rb = new THREE.Vector3(), rc = new THREE.Vector3(), referenceFace = new THREE.Vector3();
    const index = (i: number) => geometry.index ? geometry.index.getX(i) : i;
    for (let i = start; i < start + count; i += 3) {
      const ia = index(i), ib = index(i + 1), ic = index(i + 2);
      a.fromArray(world, ia * 3); b.fromArray(world, ib * 3); c.fromArray(world, ic * 3);
      ra.fromArray(reference, ia * 3); rb.fromArray(reference, ib * 3); rc.fromArray(reference, ic * 3);
      face.crossVectors(b.sub(a), c.sub(a));
      referenceFace.crossVectors(rb.sub(ra), rc.sub(ra));
      const area = face.length();
      if (face.dot(a) < 0) face.negate();
      if (referenceFace.dot(ra) < 0) referenceFace.negate();
      // The same large flat triangle on a smooth reference ellipsoid has
      // curvature/triangulation bias too. Subtract it before averaging relief.
      // A constant-height sphere therefore contributes zero at every LOD.
      if (area > 0 && referenceFace.lengthSq() > 0) {
        face.divideScalar(area).sub(referenceFace.normalize()).multiplyScalar(area);
        for (const vertex of [ia, ib, ic]) {
          sums[vertex * 3] += face.x; sums[vertex * 3 + 1] += face.y; sums[vertex * 3 + 2] += face.z;
          weights[vertex] += area;
        }
      }
      for (const [u, v] of [[ia, ib], [ib, ic], [ic, ia]]) {
        const key = Math.min(u, v) * positions.count + Math.max(u, v);
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      }
    }
    const boundary = new Set<number>();
    for (const [key, count] of edgeCounts) if (count === 1) {
      boundary.add(Math.floor(key / positions.count)); boundary.add(key % positions.count);
    }
    const attribute = new THREE.BufferAttribute(new Float32Array(positions.count * 3), 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('surfaceReliefNormal', attribute);
    entry.normals = [];
    const normal = new THREE.Vector3();
    const groundKeys = new Set<string>();
    const groundVertexKeys = new Map<number, string>();
    for (let i = 0; i < positions.count; i++) {
      if (!ground.getX(i)) continue;
      normal.set(sums[i * 3], sums[i * 3 + 1], sums[i * 3 + 2]);
      const weight = weights[i] || 1;
      attribute.setXYZ(i, normal.x / weight, normal.y / weight, normal.z / weight);
      // Interior vertices already have their complete triangle neighbourhood.
      // Retain cross-tile references only at boundaries to bound CPU memory.
      if (!boundary.has(i)) continue;
      point.fromBufferAttribute(positions, i).applyMatrix4(entry.matrix);
      const key = this.normalKey(point);
      groundKeys.add(key);
      groundVertexKeys.set(i, key);
      const ref = { attribute, index: i, normal: normal.clone(), weight: weights[i] };
      entry.normals.push([key, ref]);
    }
    // The cube builder joins each lower skirt vertex to its original ground
    // edge. Use that topology to survive float32 angular roundoff at key bins;
    // a skirt is a displaced copy, not another terrain slope.
    const skirtKeys = new Map<number, { key: string; distance: number }>();
    if (Number.isSafeInteger(geometry.userData.surfaceTriangles) && geometry.index) {
      for (let i = start + count; i < geometry.index.count; i += 3) {
        const vertices = [index(i), index(i + 1), index(i + 2)];
        for (const skirt of vertices) {
          if (ground.getX(skirt)) continue;
          a.fromArray(world, skirt * 3).normalize();
          for (const top of vertices) {
            const key = groundVertexKeys.get(top);
            if (!key) continue;
            b.fromArray(world, top * 3).normalize();
            const distance = a.distanceToSquared(b);
            if (distance < (skirtKeys.get(skirt)?.distance ?? Infinity)) skirtKeys.set(skirt, { key, distance });
          }
        }
      }
    }
    // Duplicate skirt vertices inherit the corresponding ground normal. They
    // add no triangle contribution, so crack-hiding walls cannot bias slopes
    // or acquire a separate lighting stripe along an otherwise smooth edge.
    for (let i = 0; i < positions.count; i++) {
      if (ground.getX(i)) continue;
      point.fromBufferAttribute(positions, i).applyMatrix4(entry.matrix);
      const key = skirtKeys.get(i)?.key ?? this.normalKey(point);
      if (!groundKeys.has(key)) continue;
      const ref = { attribute, index: i, normal: new THREE.Vector3(), weight: 0 };
      entry.normals.push([key, ref]);
    }
    const touched = new Set<NormalNode>();
    this.setNormalContributions(entry, true, touched);
    touched.forEach(node => this.publishNormal(node));
  }

  private normalKey(pointMetres: THREE.Vector3): string {
    const position = bodyFixedToGeodetic({ xKm: pointMetres.x * 0.001, yKm: pointMetres.y * 0.001, zKm: pointMetres.z * 0.001 }, this.datum);
    const latitude = Math.round(position.latDeg * 1e5);
    // At the pole all meridians identify one vertex; ±180 is also one meridian.
    const longitude = Math.abs(latitude) === 9000000 ? 0 : Math.round(position.lonDeg * 1e5);
    return `${latitude},${longitude === 18000000 ? -18000000 : longitude}`;
  }

  private publishNormal(node: NormalNode): void {
    // Recompute from current owners to avoid accumulated subtraction error
    // after repeated LOD transitions and cache eviction.
    const sum = new THREE.Vector3();
    let weight = 0;
    for (const ref of node.references) { sum.add(ref.normal); weight += ref.weight; }
    const length = weight || 1;
    for (const ref of node.references) {
      ref.attribute.setXYZ(ref.index, sum.x / length, sum.y / length, sum.z / length);
      ref.attribute.needsUpdate = true;
    }
  }

  private updateUniforms(): void {
    const s = this.settings, az = THREE.MathUtils.degToRad(s.azimuthDeg), el = THREE.MathUtils.degToRad(s.elevationDeg);
    // Local east, north, up; azimuth clockwise from geographic north.
    this.uniforms.saLight.value.set(Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el));
    this.uniforms.saContourColor.value.set(s.contourColor ?? '#f2e6c9');
    this.uniforms.saContourOpacity.value = s.contourOpacity ?? 0.35;
    this.uniforms.saContourDensity.value = s.contourDensity ?? 1;
    this.uniforms.saContrast.value = s.contrast;
    this.uniforms.saImageryAmount.value = s.imageryAmount;
    this.uniforms.saRange.value.set(s.minKm, s.maxKm);
    const colors = ELEVATION_PALETTES[s.palette];
    this.uniforms.saLow.value.set(colors[0]); this.uniforms.saMid.value.set(colors[1]); this.uniforms.saHigh.value.set(colors[2]);
  }

  private inject(shader: Shader, localToBody: { value: THREE.Matrix4 }): void {
    Object.assign(shader.uniforms, this.uniforms, { saLocalToBody: localToBody, saContourLocalToBody: localToBody });
    if (this.needsHeights) {
      shader.vertexShader = 'attribute float surfaceHeightKm; varying float vSAHeight;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvSAHeight = surfaceHeightKm;');
      shader.fragmentShader = 'varying float vSAHeight;\n' + shader.fragmentShader;
    }
    if (this.settings.baseColor === 'elevation') {
      shader.fragmentShader = `uniform vec2 saRange; uniform float saImageryAmount; uniform vec3 saLow, saMid, saHigh;
` + shader.fragmentShader;
      // After current imagery overlays have composed diffuseColor, before lighting.
      shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `
float saT = clamp((vSAHeight - saRange.x) / (saRange.y - saRange.x), 0.0, 1.0);
vec3 saTint = saT < 0.5 ? mix(saLow, saMid, saT * 2.0) : mix(saMid, saHigh, saT * 2.0 - 1.0);
diffuseColor.rgb = mix(saTint, diffuseColor.rgb, saImageryAmount);
#include <roughnessmap_fragment>`);
    }
    if (this.settings.baseColor === 'neutral') {
      shader.fragmentShader = 'uniform float saImageryAmount;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>',
        'diffuseColor.rgb = mix(vec3(1.0), diffuseColor.rgb, saImageryAmount);\n#include <roughnessmap_fragment>');
    }
    if (this.settings.contours) injectTerrainContours(shader);
    if (this.settings.hillshade) {
      shader.vertexShader = 'attribute vec3 surfaceReliefNormal; varying vec3 vSALocal, vSAReliefNormal; uniform mat4 saLocalToBody;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvSALocal = position; vSAReliefNormal = surfaceReliefNormal;');
      shader.fragmentShader = `varying vec3 vSALocal, vSAReliefNormal; uniform mat4 saLocalToBody;
uniform vec3 saLight, saUpScale; uniform float saContrast;
` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <shadowmap_pars_fragment>',
        '#include <shadowmap_pars_fragment>\n#include <shadowmask_pars_fragment>');
      // Shared smooth normals avoid tile-local averaging discontinuities.
      // Tile-local coordinates keep the light frame independent of world origin.
      // Replace only displayed radiance, before existing eclipse/shadow/AP hooks.
      shader.fragmentShader = shader.fragmentShader.replace(/vec3 outgoingLight = [^;]+;/, `$&
vec3 saUp = normalize((saLocalToBody * vec4(vSALocal, 1.0)).xyz * saUpScale);
vec3 saEast = cross(vec3(0.0, 0.0, 1.0), saUp);
saEast = length(saEast) > 0.00001 ? normalize(saEast) : vec3(0.0, 1.0, 0.0);
vec3 saNorth = normalize(cross(saUp, saEast));
vec3 saNormal = normalize(saUp + vSAReliefNormal);
if (dot(saNormal, saUp) < 0.0) saNormal = -saNormal;
vec3 saDirection = saEast * saLight.x + saNorth * saLight.y + saUp * saLight.z;
float saShade = clamp((max(0.0, dot(saNormal, saDirection)) - 0.5) * saContrast + 0.5, 0.0, 1.0);
outgoingLight = diffuseColor.rgb * (0.12 + 0.88 * saShade) * getShadowMask();`);
    }
  }
}
