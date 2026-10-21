import * as THREE from 'three';
import { clampOpacity, describeImageryLayers, layerStatus, type ImageryLayerInfo } from './ImageryLayers.js';
import type { TerrainImageryConfig } from './TerrainManager.js';
import type { SurfaceAppearance } from './SurfaceAppearance.js';
import { fetchWithRetry } from './fetchWithRetry.js';
import { cubeTileId, cubeFaceBasis } from './surface/CubeSphere.js';
import {
  CubeImageryAvailability, blockBoundingSphere, imageryTileRect, blockRectInTile, clipTrianglesToTileRect, imageryTextureTransform, imageryTileUri,
  parseImageryAddress, selectImageryBlocks, tileProjectiveBasis, validateCubeImageryManifest,
  type CubeImageryManifest, type ImageryAddress, type ImageryBlock, type Vec3,
} from './surface/CubeImagery.js';

/**
 * Experimental cube-face map imagery (#149), draped on a cube-sphere 3D Tiles
 * product independently of its geometry LOD.
 *
 * Geometry tiles stay exactly what the tile renderer selected. Per visible tile
 * this picks imagery levels from projected texel size alone
 * (`selectImageryBlocks`): imagery coarser than the tile draws an ancestor's
 * sub-rectangle on the tile's own mesh; imagery finer than the tile splits it
 * into blocks, each the tile's triangles clipped exactly to one imagery tile
 * (`clipTrianglesToTileRect`) and drawn as an extra mesh with that tile's
 * texture. Clipping adds vertices on the original triangles only, so the
 * surface, picking (which keeps using the original mesh) and the renderer's
 * tile set are unchanged; the cost is extra draws and block geometry, which
 * `stats` reports.
 *
 * Texture coordinates are the face's projective coordinates, stored per vertex
 * as `(p·a, p·b, p·n)` and divided per fragment (`tileProjectiveBasis`): exact
 * on every triangle, with no longitude, wrap or pole interpolation.
 *
 * Residency is the layer's own: a byte-budgeted LRU of textures shared by all
 * tiles, levels ≤ `residentLevel` pinned as the never-missing coarse fallback,
 * a bounded request queue rebuilt every frame from what is wanted, aborts for
 * requests nobody has wanted for a while, and failed tiles that fall back to
 * their nearest resident ancestor. CPU physical-surface queries never read it.
 */
export interface CubeImageryConfig {
  /** `imagery.json` written by `scripts/terrain/cube_imagery.py`. */
  url: string;
  /** Globe.imagery cube products, bottom to top. Shares geometry, draws and one texture budget. */
  layers?: TerrainImageryConfig[];
  /** Target projected size of one imagery texel, px. Default 1.5. */
  maxScreenTexelError?: number;
  /** Texture budget: estimated GPU bytes of resident tiles including mipmaps. Default 160 MiB. */
  maxTextureBytes?: number;
  /** Concurrent tile requests. Default 8. */
  maxConcurrentRequests?: number;
  /** Levels loaded up front and never evicted. Default 1 for one product (30 tiles, ~11 MB); 0 for a stack (six roots per source). */
  residentLevel?: number;
  /** Blocks one geometry tile may split into. Default 64. */
  maxBlocksPerTile?: number;
  /** A failed tile is not requested again for this long, ms, doubling per failure up to 16×. Default 30 000. */
  retryFailedMs?: number;
  /** Cap on the imagery level used (default: the manifest's). For fixed-level comparisons. */
  maxLevel?: number;
}

export interface CubeImageryStats {
  version: string | null;
  ready: boolean;
  /** Resident textures (all levels) and how many are pinned coarse levels. */
  textures: number;
  pinnedTextures: number;
  /** Estimated GPU bytes of resident textures (RGBA8 + mipmaps) against the budget. */
  textureBytes: number;
  maxTextureBytes: number;
  /** Requests started, bytes received, failures, aborted requests and evicted textures since creation/reset. */
  requests: number;
  bytes: number;
  failures: number;
  aborted: number;
  evicted: number;
  inFlight: number;
  /** Wanted tiles not yet requested (bounded by the wanted set of the last frame). */
  queued: number;
  failedTiles: number;
  /** A wanted tile could not start because the budget was full of textures in use. */
  budgetLimited: boolean;
  /** Last frame: geometry tiles drawn with imagery, of them split, and imagery blocks drawn. */
  tiles: number;
  splitTiles: number;
  blocks: number;
  /** Extra draws from splitting (blocks beyond one per tile) and the block geometry they hold. */
  extraDraws: number;
  blockGeometryBytes: number;
  /**
   * Blocks by displayed and wanted imagery level. Fallback blocks show a coarser
   * ancestor while theirs loads; failed blocks show one because theirs (or an
   * ancestor of it) failed and is waiting for its retry.
   */
  displayedLevels: Record<number, number>;
  wantedLevels: Record<number, number>;
  fallbackBlocks: number;
  failedBlocks: number;
  untexturedBlocks: number;
  /** Blocks without a resident mandatory-base ancestor; optional alpha cannot establish coverage. */
  baseUncoveredBlocks: number;
  maxDisplayedLevel: number;
  /** CPU ms of the last update (selection + block builds) and cumulative block-build ms. */
  updateMs: number;
  blockBuildMs: number;
}

export type CubeImageryDebug = 'none' | 'unlit' | 'level';
type TextureLoader = (url: string, signal: AbortSignal) => Promise<{ texture: THREE.Texture; bytes: number; downloadBytes: number }>;

interface Source {
  index: number;
  baseUrl: string;
  manifest: CubeImageryManifest | null;
  availability: CubeImageryAvailability | null;
  info: ImageryLayerInfo;
  setupFailed: boolean;
}
interface Entry {
  source: Source;
  id: string;
  address: ImageryAddress;
  state: 'loading' | 'ready' | 'failed';
  texture: THREE.Texture | null;
  bytes: number;
  lastUsed: number;
  lastWanted: number;
  pinned: boolean;
  controller: AbortController | null;
  failedAt: number;
  failures: number;
}
interface SourceUniforms {
  map: { value: THREE.Texture | null };
  transform: { value: THREE.Vector4 };
  enabled: { value: number };
  level: { value: number };
  srgb: { value: number };
  opacity: { value: number };
  bounded: { value: number };
  bounds: { value: THREE.Vector4 };
}
interface Uniforms {
  layers: SourceUniforms[];
  cubeImageryToBody: { value: THREE.Matrix3 };
  cubeImageryMap: { value: THREE.Texture | null };
  cubeImageryTransform: { value: THREE.Vector4 };
  cubeImageryEnabled: { value: number };
  cubeImageryLevel: { value: number };
  cubeImageryDebug: { value: number };
  cubeImagerySrgb: { value: number };
}
interface Block { mesh: THREE.Mesh; material: THREE.Material; uniforms: Uniforms; lastUsed: number; bytes: number }
interface MeshRecord {
  mesh: THREE.Mesh;
  material: THREE.Material;
  uniforms: Uniforms;
  /** The material's onBeforeCompile and program key before imagery was added, reused by block materials. */
  baseCompile: THREE.Material['onBeforeCompile'];
  cacheKey: () => string;
  radiusRangeKm: [number, number];
  blocks: Map<string, Block>;
  styleAttributes?: Array<THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined>;
  styleVersions?: number[];
}
interface TileRecord { scene: THREE.Object3D; address: ImageryAddress; meshes: MeshRecord[] }

// Picking uses the original triangles when clipped blocks replace their draw.
// This tracks only the source's local draw visibility; ancestors still decide LOD visibility.
const splitSources = new WeakSet<THREE.Object3D>();
export function isDrawnCubeImagerySource(object: THREE.Object3D): boolean { return splitSources.has(object); }

const CACHE_KEY = '_cubeimg_v1';
const DEBUG_CODE: Record<CubeImageryDebug, number> = { none: 0, unlit: 1, level: 2 };
const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _v = new THREE.Vector3(), _frustum = new THREE.Frustum(), _sphere = new THREE.Sphere();

const VERTEX_PARS = 'attribute vec3 cubeImageryUvw;\nvarying vec3 vCubeImageryUvw;\n';
const FRAGMENT_PARS = `varying vec3 vCubeImageryUvw;
uniform sampler2D cubeImageryMap;
uniform vec4 cubeImageryTransform;
uniform float cubeImageryEnabled;
uniform float cubeImageryLevel;
uniform int cubeImageryDebug;
uniform float cubeImagerySrgb;
uniform mat3 cubeImageryToBody;
vec3 cubeImagerySrgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 cubeImageryLevelColor(float level) {
  vec3 k = vec3(0.0, 2.0, 4.0) / 3.0;
  return 0.5 + 0.5 * cos(6.2831853 * (level * 0.137 + k));
}
`;

function injectImagery(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: Uniforms): void {
  const { layers, ...flat } = uniforms;
  Object.assign(shader.uniforms, flat);
  layers.forEach((u, i) => {
    for (const [key, uniform] of Object.entries(u)) shader.uniforms[`cubeLayer${i}_${key}`] = uniform;
  });
  shader.vertexShader = VERTEX_PARS + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvCubeImageryUvw = cubeImageryUvw;');
  const pars = layers.map((_, i) => `uniform sampler2D cubeLayer${i}_map;
    uniform vec4 cubeLayer${i}_transform; uniform float cubeLayer${i}_enabled;
    uniform float cubeLayer${i}_bounded; uniform vec4 cubeLayer${i}_bounds; uniform float cubeLayer${i}_level; uniform float cubeLayer${i}_srgb; uniform float cubeLayer${i}_opacity;`).join('\n');
  let fragment = FRAGMENT_PARS + pars + '\n' + shader.fragmentShader;
  fragment = fragment.replace('void main() {', 'void main() {\n  vec4 cubeImageryTexel = vec4(0.0);');
  const coordinates = `
  vec2 cubeImageryLonLat = vec2(0.0);
  if (${layers.map((_, i) => `(cubeLayer${i}_enabled > 0.5 && cubeLayer${i}_bounded > 0.5)`).join(' || ')}) {
    vec3 direction = cubeImageryToBody * vCubeImageryUvw;
    cubeImageryLonLat = degrees(vec2(atan(direction.y, direction.x), atan(direction.z, length(direction.xy))));
  }`;
  const samples = layers.map((_, i) => `
  if (cubeLayer${i}_enabled > 0.5) {
    vec2 cubeImagerySt = vCubeImageryUvw.xy / vCubeImageryUvw.z * cubeLayer${i}_transform.xy + cubeLayer${i}_transform.zw;
    vec4 sampleValue = texture2D(cubeLayer${i}_map, cubeImagerySt);
    float alpha = sampleValue.a * cubeLayer${i}_opacity;
    if (cubeLayer${i}_bounded > 0.5) {
      vec4 bounds = cubeLayer${i}_bounds;
      float lon = cubeImageryLonLat.x, lat = cubeImageryLonLat.y;
      bool coveredLon = bounds.x <= bounds.z ? lon >= bounds.x && lon <= bounds.z : lon >= bounds.x || lon <= bounds.z;
      if (!coveredLon || lat < bounds.y || lat > bounds.w) alpha = 0.0;
    }
    vec3 cubeImageryColor = cubeLayer${i}_srgb > 0.5 ? cubeImagerySrgbToLinear(sampleValue.rgb) : sampleValue.rgb;
    diffuseColor.rgb = mix(diffuseColor.rgb, cubeImageryColor, alpha);
    cubeImageryTexel.rgb = mix(cubeImageryTexel.rgb, sampleValue.rgb, alpha);
    cubeImageryTexel.a = alpha + cubeImageryTexel.a * (1.0 - alpha);
  }`).join('\n');
  fragment = fragment.replace('#include <map_fragment>', '#include <map_fragment>\n' + coordinates + samples);
  // Debug views write the texel itself (unlit, no tone mapping or colour conversion),
  // or its imagery level as a hue, after every other fragment chunk.
  fragment = fragment.replace('#include <dithering_fragment>', `#include <dithering_fragment>
  if (cubeImageryDebug == 1) gl_FragColor = vec4(cubeImageryTexel.rgb, 1.0);
  else if (cubeImageryDebug == 2) gl_FragColor = vec4(cubeImageryEnabled > 0.5 ? cubeImageryLevelColor(cubeImageryLevel) * (0.35 + 0.65 * dot(cubeImageryTexel.rgb, vec3(0.333))) : vec3(0.15), 1.0);`);
  shader.fragmentShader = fragment;
}

/** Fetch + off-thread decode into a mipmapped, unconverted texture whose t = 0 is the file's bottom row. */
async function loadImageBitmapTexture(url: string, signal: AbortSignal): Promise<{ texture: THREE.Texture; bytes: number; downloadBytes: number }> {
  // Transient errors retry here; what still fails falls back to an ancestor and is retried later.
  const response = await fetchWithRetry(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  if (signal.aborted) { bitmap.close(); throw new DOMException('Aborted', 'AbortError'); }
  const texture = new THREE.Texture(bitmap as unknown as HTMLImageElement);
  texture.flipY = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return { texture, bytes: Math.round(bitmap.width * bitmap.height * 4 * 4 / 3), downloadBytes: blob.size };
}

/** Conservative spherical-cap test; exact source clipping happens per fragment. */
export function cubeBlockOverlapsBounds(address: ImageryAddress, bounds: readonly number[] | null): boolean {
  if (!bounds) return true;
  const { centre, radius } = blockBoundingSphere(address, [1, 1]);
  const length = Math.hypot(...centre), angular = Math.asin(Math.min(1, radius / length));
  const lat = Math.atan2(centre[2], Math.hypot(centre[0], centre[1]));
  const rad = Math.PI / 180;
  if (lat + angular < bounds[1] * rad || lat - angular > bounds[3] * rad) return false;
  if (Math.abs(lat) + angular >= Math.PI / 2) return true;
  const lon = Math.atan2(centre[1], centre[0]) / rad;
  const span = Math.asin(Math.min(1, Math.sin(angular) / Math.cos(lat))) / rad;
  const west = bounds[0], east = bounds[2] < west ? bounds[2] + 360 : bounds[2];
  return [-360, 0, 360].some(offset => lon + span + offset >= west && lon - span + offset <= east);
}

export class CubeImageryLayer {
  /** Shared terrain styling; blocks retain interpolated source fields. */
  surfaceAppearance: SurfaceAppearance | null = null;
  manifest: CubeImageryManifest | null = null;
  readonly ready: Promise<void>;
  private availability: CubeImageryAvailability | null = null;
  private readonly entries = new Map<string, Entry>();
  private readonly tiles = new Map<object, TileRecord>();
  private readonly shared = { debug: { value: 0 }, srgb: { value: 1 } };
  private readonly manifestAbort = new AbortController();
  private readonly options: Required<Omit<CubeImageryConfig, 'url' | 'maxLevel' | 'layers'>> & { maxLevel: number | undefined };
  private readonly loadTexture: TextureLoader;
  private readonly sources: Source[];
  private readonly order: Source[];
  private retryManifests: () => void = () => {};
  private frame = 0;
  private anisotropy = 1;
  private disposed = false;
  private counters = { requests: 0, bytes: 0, failures: 0, aborted: 0, evicted: 0, blockBuildMs: 0 };
  private last: Omit<CubeImageryStats, 'version' | 'ready' | 'textures' | 'pinnedTextures' | 'textureBytes' | 'maxTextureBytes' | 'requests' | 'bytes' | 'failures' | 'aborted' | 'evicted' | 'inFlight' | 'failedTiles' | 'blockBuildMs' | 'blockGeometryBytes'> = {
    queued: 0, budgetLimited: false, tiles: 0, splitTiles: 0, blocks: 0, extraDraws: 0,
    displayedLevels: {}, wantedLevels: {}, fallbackBlocks: 0, failedBlocks: 0, untexturedBlocks: 0, baseUncoveredBlocks: 0, maxDisplayedLevel: -1, updateMs: 0,
  };

  constructor(config: CubeImageryConfig, deps: { fetchManifest?: (url: string) => Promise<CubeImageryManifest>; loadTexture?: TextureLoader; radiusKm?: number } = {}) {
    this.options = {
      maxScreenTexelError: config.maxScreenTexelError ?? 1.5,
      maxTextureBytes: config.maxTextureBytes ?? 160 * 2 ** 20,
      maxConcurrentRequests: config.maxConcurrentRequests ?? 8,
      residentLevel: config.residentLevel ?? ((config.layers?.length ?? 1) > 1 ? 0 : 1),
      maxBlocksPerTile: config.maxBlocksPerTile ?? 64,
      retryFailedMs: config.retryFailedMs ?? 30_000,
      maxLevel: config.maxLevel,
    };
    const configs = config.layers ?? [{ type: 'cube' as const, url: config.url }];
    if (configs.length === 0 || configs.length > 4) throw new Error('Cube imagery supports one to four sources');
    this.sources = describeImageryLayers(configs, 1).map((info, index) => ({
      index, info, baseUrl: new URL(configs[index].url, globalThis.location?.href ?? 'http://localhost/').href,
      manifest: null, availability: null, setupFailed: false,
    }));
    this.order = [...this.sources];
    this.loadTexture = deps.loadTexture ?? loadImageBitmapTexture;
    // Only the mandatory base waits out an outage. Optional sources settle after
    // four attempts and retry only through retryFailed(), avoiding background storms.
    const fetchManifest = deps.fetchManifest ?? (async (url: string, required = false) => {
      const response = await fetchWithRetry(url, { signal: this.manifestAbort.signal }, { tries: required ? Infinity : 4 });
      if (!response.ok) throw new Error(`Cube imagery manifest ${url}: HTTP ${response.status}`);
      return response.json() as Promise<CubeImageryManifest>;
    });
    const baseManifest = fetchManifest(this.sources[0].baseUrl, true).then(validateCubeImageryManifest);
    const loading = new Set<Source>();
    const loadSource = async (source: Source): Promise<void> => {
      loading.add(source);
      try {
        const manifest = await (source.index === 0 ? baseManifest : fetchManifest(source.baseUrl).then(validateCubeImageryManifest));
        const reference = await baseManifest;
        if (this.disposed) return;
        if (reference.bodyId !== manifest.bodyId || reference.registration.crsId !== manifest.registration.crsId ||
          reference.tileSize !== manifest.tileSize || reference.gutter !== manifest.gutter) {
          throw new Error('Cube imagery sources must share body, registration, tile size and gutter');
        }
        // Optional sources never establish readiness or replace the base reference.
        if (source.index === 0) this.manifest = manifest;
        source.manifest = manifest;
        source.availability = this.availabilityFor(manifest);
        source.setupFailed = false;
        source.info.maxLevel = manifest.maxLevel;
        source.info.minZoom = manifest.minLevel;
        source.info.metersPerPixel = deps.radiusKm ? 2 * deps.radiusKm * 1000 / (manifest.tileSize * 2 ** manifest.maxLevel) : null;
        source.info.attribution ||= manifest.source.attribution ?? '';
        this.rebuildAvailability();
      } catch (error) {
        source.setupFailed = true;
        if (source.index === 0) throw error;
      } finally {
        loading.delete(source);
      }
    };
    this.retryManifests = () => {
      if (this.disposed || !this.manifest) return;
      for (const source of this.sources) if (source.index > 0 && source.setupFailed && !loading.has(source)) {
        void loadSource(source).then(() => { if (!this.disposed) this.schedule(this.coarseWanted()); });
      }
    };
    this.ready = Promise.all(this.sources.map(loadSource)).then(() => { if (!this.disposed) this.schedule(this.coarseWanted()); });
  }

  /** Source state uses the same Globe.imagery UI contract as geographic overlays. */
  get imageryLayers(): ImageryLayerInfo[] {
    return this.order.map(({ info, setupFailed }) => ({ ...info, bounds: info.bounds ? [...info.bounds] : null,
      status: layerStatus(info.requests, info.failedTiles, setupFailed), view: info.view ? { ...info.view } : null }));
  }

  setLayerVisible(id: string, visible: boolean): boolean {
    const source = this.sources.find(s => s.info.id === id);
    if (!source || !source.info.optional || source.info.visible === visible) return false;
    source.info.visible = visible;
    if (!visible) {
      for (const [key, entry] of this.entries) if (entry.source === source) {
        entry.controller?.abort(); this.releaseTexture(entry); this.entries.delete(key);
      }
    }
    this.rebuildAvailability();
    return true;
  }

  setLayerOpacity(id: string, opacity: number): boolean {
    const source = this.sources.find(s => s.info.id === id);
    if (!source) return false;
    const wasActive = source.info.opacity > 0;
    source.info.opacity = clampOpacity(opacity);
    if (wasActive !== (source.info.opacity > 0)) this.rebuildAvailability();
    return true;
  }

  moveLayer(id: string, toIndex: number): boolean {
    const index = this.order.findIndex(s => s.info.id === id);
    if (index <= 0 || !Number.isInteger(toIndex) || toIndex < 1 || toIndex >= this.order.length || index === toIndex) return false;
    this.order.splice(toIndex, 0, this.order.splice(index, 1)[0]);
    return true;
  }

  private rebuildAvailability(): void {
    const active = this.sources.filter(s => s.info.visible && s.info.opacity > 0 && s.manifest);
    this.availability = active.length ? new CubeImageryAvailability(active.flatMap(s => s.manifest!.tiles)
      .filter(id => Number(id.split('/')[1]) <= (this.options.maxLevel ?? Infinity)),
      Math.min(...active.map(s => s.manifest!.minLevel)), Math.min(this.options.maxLevel ?? Infinity, Math.max(...active.map(s => s.manifest!.maxLevel)))) : this.manifest ? this.availabilityFor({ ...this.manifest, maxLevel: 0, tiles: this.manifest.tiles.filter(id => Number(id.split('/')[1]) === 0) }) : null;
  }

  /**
   * Change the texel target, level cap or texture budget live, without touching
   * geometry (used to compare imagery levels over one fixed tile set).
   */
  setOptions(options: Pick<CubeImageryConfig, 'maxScreenTexelError' | 'maxLevel' | 'maxTextureBytes'>): void {
    if (options.maxScreenTexelError != null) this.options.maxScreenTexelError = options.maxScreenTexelError;
    if (options.maxTextureBytes != null) this.options.maxTextureBytes = options.maxTextureBytes;
    if ('maxLevel' in options) {
      this.options.maxLevel = options.maxLevel;
      for (const s of this.sources) if (s.manifest) s.availability = this.availabilityFor(s.manifest);
      this.rebuildAvailability();
    }
  }

  set debug(mode: CubeImageryDebug) { this.shared.debug.value = DEBUG_CODE[mode]; }
  get debug(): CubeImageryDebug { return (Object.keys(DEBUG_CODE) as CubeImageryDebug[]).find(k => DEBUG_CODE[k] === this.shared.debug.value) ?? 'none'; }

  /** Register a loaded cube geometry tile. `scene` holds meshes in tile-set (body-fixed metre) coordinates. */
  addTile(key: object, scene: THREE.Object3D, address: ImageryAddress): void {
    if (this.disposed || this.tiles.has(key)) return;
    const record: TileRecord = { scene, address, meshes: [] };
    const basis = tileProjectiveBasis(address);
    scene.updateMatrixWorld(true);
    const sceneParentInverse = scene.parent ? _inv.copy(scene.parent.matrixWorld).invert() : null;
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material) || !mesh.geometry?.getAttribute('position')) return;
      // Mesh → tile-set frame (body-fixed metres), independent of where the scene is attached now.
      _m.copy(mesh.matrixWorld);
      if (sceneParentInverse) _m.premultiply(sceneParentInverse);
      const position = mesh.geometry.getAttribute('position');
      const uvw = new Float32Array(position.count * 3);
      // Skirts (after the surface triangles, on vertices after the surface's) hang far
      // below the surface; texel distances use the surface's radius range only.
      const surfaceTriangles = mesh.geometry.userData?.surfaceTriangles, index = mesh.geometry.index;
      let surfaceVertices = position.count;
      if (typeof surfaceTriangles === 'number' && index) {
        surfaceVertices = 0;
        for (let i = 0; i < 3 * surfaceTriangles; i++) surfaceVertices = Math.max(surfaceVertices, index.getX(i) + 1);
      }
      let rMin = Infinity, rMax = -Infinity;
      for (let i = 0; i < position.count; i++) {
        _v.fromBufferAttribute(position, i).applyMatrix4(_m);
        const p: Vec3 = [_v.x, _v.y, _v.z];
        const r = Math.hypot(p[0], p[1], p[2]);
        if (i < surfaceVertices) { rMin = Math.min(rMin, r); rMax = Math.max(rMax, r); }
        uvw[3 * i] = p[0] * basis.a[0] + p[1] * basis.a[1] + p[2] * basis.a[2];
        uvw[3 * i + 1] = p[0] * basis.b[0] + p[1] * basis.b[1] + p[2] * basis.b[2];
        uvw[3 * i + 2] = p[0] * basis.n[0] + p[1] * basis.n[1] + p[2] * basis.n[2];
      }
      mesh.geometry.setAttribute('cubeImageryUvw', new THREE.BufferAttribute(uvw, 3));
      const material = mesh.material;
      const baseCompile = material.onBeforeCompile;
      // Material.copy carries neither onBeforeCompile nor an own cache key, so block clones get both from here.
      const baseKey = material.customProgramCacheKey.bind(material);
      const defaultKey = material.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey;
      const snapshot = baseKey();
      const cacheKey = () => (defaultKey ? snapshot : baseKey()) + CACHE_KEY + this.sources.length;
      const uniforms = this.makeUniforms(address);
      this.attachImagery(material, baseCompile, cacheKey, uniforms);
      record.meshes.push({ mesh, material, uniforms, baseCompile, cacheKey, radiusRangeKm: [rMin / 1000, rMax / 1000], blocks: new Map() });
    });
    this.tiles.set(key, record);
  }

  /** Drop every block, e.g. after the tiles' draw ranges change; visible tiles rebuild theirs next update. */
  invalidateBlocks(): void {
    for (const record of this.tiles.values()) for (const m of record.meshes) for (const id of [...m.blocks.keys()]) this.disposeBlock(m, id);
  }

  /** Forget a tile the renderer disposed: its blocks' geometry and materials go with it. */
  removeTile(key: object): void {
    const record = this.tiles.get(key);
    if (!record) return;
    for (const m of record.meshes) {
      splitSources.delete(m.mesh);
      for (const id of [...m.blocks.keys()]) this.disposeBlock(m, id);
    }
    this.tiles.delete(key);
  }

  /**
   * Once per frame after the tile renderer's update. `tileSetMatrixWorld` maps
   * the tile set's body-fixed metres to world; `camera` drives frustum and
   * distance (a sane near/far one); `pixelAngleRad` is one screen pixel at the
   * view centre. `useImagery` false (another debug view owns the materials)
   * restores the original meshes.
   */
  update(camera: THREE.Camera, tileSetMatrixWorld: THREE.Matrix4, pixelAngleRad: number, renderer: THREE.WebGLRenderer | null, useImagery = true): void {
    if (this.disposed || !this.manifest || !this.availability) return;
    const start = performance.now();
    this.frame++;
    if (renderer) this.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const toBody = _inv.copy(tileSetMatrixWorld).invert();
    camera.updateMatrixWorld();
    _v.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(toBody);
    const cameraKm: Vec3 = [_v.x / 1000, _v.y / 1000, _v.z / 1000];
    _frustum.setFromProjectionMatrix(_m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const scale = tileSetMatrixWorld.getMaxScaleOnAxis();
    const inView = (centre: Vec3, radius: number) => {
      _sphere.center.set(centre[0] * 1000, centre[1] * 1000, centre[2] * 1000).applyMatrix4(tileSetMatrixWorld);
      _sphere.radius = radius * 1000 * scale;
      return _frustum.intersectsSphere(_sphere);
    };
    const wanted = new Map<string, number>();
    const stats = { tiles: 0, splitTiles: 0, blocks: 0, displayedLevels: {} as Record<number, number>, wantedLevels: {} as Record<number, number>,
      fallbackBlocks: 0, failedBlocks: 0, untexturedBlocks: 0, baseUncoveredBlocks: 0, maxDisplayedLevel: -1 };
    for (const s of this.sources) s.info.view = s.info.visible ? { inCoverage: false, zoomLevel: null, missingTiles: 0, degradedTiles: 0, cacheFull: false } : null;
    const { tileSize } = this.manifest;
    const culledStats = { ...stats, displayedLevels: {}, wantedLevels: {} };
    for (const record of this.tiles.values()) {
      // A tile is drawn this frame exactly when the renderer has its scene attached.
      if (!record.scene.parent) continue;
      // One the terrain's main-view cull hid is not drawn by the main camera, but
      // may be by the instrument view: it gets the best resident imagery at its own
      // level, unsplit and requesting nothing, and stays out of the drawn stats.
      const culled = !record.scene.visible;
      const s = culled ? culledStats : stats;
      for (const m of record.meshes) {
        // Reclip only when source style fields change (activation, visibility or
        // LOD neighbours). Uniform-only edits do not rebuild geometry.
        if (this.surfaceAppearance && (this.surfaceAppearance.active || m.styleAttributes)) {
          const attributes = ['surfaceHeightKm', 'surfaceReliefNormal', 'surfaceGround'].map(n => m.mesh.geometry.getAttribute(n));
          const versions = attributes.map(a => a instanceof THREE.BufferAttribute ? a.version : 0);
          if (attributes.some((a, i) => a !== m.styleAttributes?.[i] || versions[i] !== m.styleVersions?.[i])) {
            for (const id of [...m.blocks.keys()]) this.disposeBlock(m, id);
            m.styleAttributes = attributes.some(Boolean) ? attributes : undefined;
            m.styleVersions = versions;
          }
        }
        if (!useImagery) { this.unsplit(m); continue; }
        const leaves = selectImageryBlocks({ geometry: record.address, radiusRangeKm: m.radiusRangeKm, cameraKm, pixelAngleRad,
          maxScreenTexelError: this.options.maxScreenTexelError, tileSize, availability: this.availability, maxBlocks: this.options.maxBlocksPerTile,
          inView: culled ? () => false : inView });
        s.tiles++;
        const whole = leaves.length === 1 && leaves[0].level === record.address.level;
        if (whole) {
          this.unsplit(m);
          this.show(record.address, leaves[0], m.uniforms, wanted, s);
          continue;
        }
        stats.splitTiles++;
        m.mesh.visible = false;
        splitSources.add(m.mesh);
        const live = new Set<string>();
        for (const leaf of leaves) {
          const id = cubeTileId(leaf);
          live.add(id);
          const block = m.blocks.get(id) ?? this.buildBlock(record, m, leaf, id);
          // Fade uniforms are shared with the source callback, but clones
          // also need its current compile-time fade switch on every frame.
          const sourceDefines = (m.material as THREE.Material & { defines?: Record<string, unknown> }).defines;
          const blockDefines = (block.material as THREE.Material & { defines?: Record<string, unknown> }).defines;
          if (sourceDefines && blockDefines && blockDefines.FEATURE_FADE !== sourceDefines.FEATURE_FADE) {
            blockDefines.FEATURE_FADE = sourceDefines.FEATURE_FADE;
            block.material.needsUpdate = true;
          }
          block.mesh.visible = true;
          block.lastUsed = this.frame;
          this.show(record.address, leaf, block.uniforms, wanted, stats);
        }
        for (const [id, block] of m.blocks) if (!live.has(id)) block.mesh.visible = false;
      }
    }
    // Blocks unused for ~2 s are rebuilt on demand rather than held.
    for (const record of this.tiles.values()) for (const m of record.meshes) {
      for (const [id, block] of m.blocks) if (this.frame - block.lastUsed > 120) this.disposeBlock(m, id);
    }
    // Coarse fallback participates in the same queue and reservations as fine imagery.
    for (const [id, priority] of this.coarseWanted()) wanted.set(id, priority);
    const queued = this.schedule(wanted);
    for (const s of this.sources) if (s.info.view) s.info.view.cacheFull = queued.budgetLimited;
    this.last = { ...stats, queued: queued.count, budgetLimited: queued.budgetLimited, extraDraws: stats.blocks - stats.tiles,
      updateMs: performance.now() - start };
  }

  get stats(): CubeImageryStats {
    let textures = 0, pinned = 0, bytes = 0, inFlight = 0, failed = 0, blockBytes = 0;
    for (const e of this.entries.values()) {
      if (e.state === 'ready') { textures++; bytes += e.bytes; if (e.pinned) pinned++; }
      else if (e.state === 'loading') inFlight++;
      else failed++;
    }
    for (const record of this.tiles.values()) for (const m of record.meshes) for (const b of m.blocks.values()) blockBytes += b.bytes;
    return { version: this.manifest?.source.version ?? null, ready: !!this.manifest, textures, pinnedTextures: pinned, textureBytes: bytes,
      maxTextureBytes: this.options.maxTextureBytes, ...this.counters, inFlight, failedTiles: failed, blockGeometryBytes: blockBytes, ...this.last };
  }

  /** Include resident shader textures in the shared terrain memory diagnostics. */
  forEachResidentTexture(visit: (texture: THREE.Texture) => void): void {
    for (const entry of this.entries.values()) if (entry.texture) visit(entry.texture);
  }

  resetCounters(): void { this.counters = { requests: 0, bytes: 0, failures: 0, aborted: 0, evicted: 0, blockBuildMs: 0 }; }

  /** Forget failures so the next frames retry them (e.g. after a network outage). */
  retryFailed(): void {
    for (const [id, e] of this.entries) if (e.state === 'failed') this.entries.delete(id);
    this.retryManifests();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.manifestAbort.abort();
    for (const key of [...this.tiles.keys()]) this.removeTile(key);
    for (const e of this.entries.values()) { e.controller?.abort(); this.releaseTexture(e); }
    this.entries.clear();
  }

  // -------------------------------------------------------------------------

  private coarseWanted(): Map<string, number> {
    const wanted = new Map<string, number>();
    for (const source of this.sources) if (source.info.visible && source.info.opacity > 0 && source.manifest) {
      for (const id of source.manifest.tiles) if (Number(id.split('/')[1]) <= this.options.residentLevel) {
        wanted.set(`${source.index}:${id}`, -100 + Number(id.split('/')[1]));
      }
    }
    return wanted;
  }

  private availabilityFor(manifest: CubeImageryManifest): CubeImageryAvailability {
    const maxLevel = Math.min(manifest.maxLevel, this.options.maxLevel ?? Infinity);
    return new CubeImageryAvailability(manifest.tiles.filter(id => Number(id.split('/')[1]) <= maxLevel), manifest.minLevel, maxLevel);
  }

  private makeUniforms(address: ImageryAddress): Uniforms {
    const [n, u, v] = cubeFaceBasis(address.face), { u0, v0, size } = imageryTileRect(address);
    const toBody = new THREE.Matrix3().set(u[0] * size, v[0] * size, n[0] + u0*u[0] + v0*v[0],
      u[1] * size, v[1] * size, n[1] + u0*u[1] + v0*v[1], u[2] * size, v[2] * size, n[2] + u0*u[2] + v0*v[2]);
    return {
      cubeImageryToBody: { value: toBody },
      layers: this.sources.map(() => ({ map: { value: null }, transform: { value: new THREE.Vector4() }, enabled: { value: 0 },
        level: { value: 0 }, srgb: { value: 1 }, opacity: { value: 1 }, bounded: { value: 0 }, bounds: { value: new THREE.Vector4(-180, -90, 180, 90) } })),
      cubeImageryMap: { value: null }, cubeImageryTransform: { value: new THREE.Vector4(1, 1, 0, 0) },
      cubeImageryEnabled: { value: 0 }, cubeImageryLevel: { value: 0 },
      cubeImageryDebug: this.shared.debug, cubeImagerySrgb: this.shared.srgb,
    };
  }

  private attachImagery(material: THREE.Material, baseCompile: THREE.Material['onBeforeCompile'], cacheKey: () => string, uniforms: Uniforms): void {
    material.onBeforeCompile = (shader, renderer) => {
      baseCompile.call(material, shader, renderer);
      injectImagery(shader, uniforms);
    };
    material.customProgramCacheKey = cacheKey;
    material.needsUpdate = true;
  }

  /** Point a material at the best resident tile for `leaf`, and want the tile it should have. */
  private show(geometry: ImageryAddress, leaf: ImageryBlock, uniforms: Uniforms, wanted: Map<string, number>, stats: { blocks: number; displayedLevels: Record<number, number>; wantedLevels: Record<number, number>; fallbackBlocks: number; failedBlocks: number; untexturedBlocks: number; baseUncoveredBlocks: number; maxDisplayedLevel: number }): void {
    stats.blocks++;
    stats.wantedLevels[leaf.image.level] = (stats.wantedLevels[leaf.image.level] ?? 0) + 1;
    let maxShown = -1, fallback = false, failedBlock = false, baseCovered = false;
    for (let i = 0; i < this.order.length; i++) {
      const source = this.order[i], u = uniforms.layers[i];
      u.enabled.value = 0;
      if (!source.info.visible || source.info.opacity <= 0 || !source.manifest || !source.availability || !cubeBlockOverlapsBounds(leaf, source.info.bounds)) continue;
      const image = source.availability.deepestAncestor(leaf.image);
      if (!image) continue;
      const wantId = `${source.index}:${cubeTileId(image)}`;
      const failed = this.failedAbove(image, source);
      if ((leaf.inView || image.level <= this.options.residentLevel) && !failed) wanted.set(wantId, Math.min(wanted.get(wantId) ?? Infinity, image.level * 64 - Math.min(leaf.desiredLevel, 63)));
      let shown: Entry | null = null;
      for (let level = image.level; level >= 0 && !shown; level--) {
        const shift = image.level - level;
        const e = this.entries.get(`${source.index}:${cubeTileId({ face: image.face, level, x: image.x >> shift, y: image.y >> shift })}`);
        if (e?.state === 'ready') shown = e;
      }
      const e = this.entries.get(wantId);
      if (e) e.lastWanted = this.frame;
      const view = source.info.view;
      if (leaf.inView && view) {
        view.inCoverage = true;
        view.zoomLevel = Math.max(view.zoomLevel ?? 0, shown?.address.level ?? 0);
        if (failed) view.missingTiles++;
        if (failed && shown && shown.address.level < image.level) view.degradedTiles++;
      }
      if (!shown) continue;
      // The mandatory base is the coverage guarantee. Optional sources may
      // contain alpha/nodata even when their textures are resident.
      if (source.index === 0) baseCovered = true;
      shown.lastUsed = this.frame;
      if (shown.address.level < image.level && leaf.inView) { if (failed) failedBlock = true; else fallback = true; }
      maxShown = Math.max(maxShown, shown.address.level);
      if (shown.texture && shown.texture.anisotropy !== this.anisotropy) { shown.texture.anisotropy = this.anisotropy; shown.texture.needsUpdate = true; }
      u.map.value = shown.texture;
      u.transform.value.fromArray(imageryTextureTransform(geometry, shown.address, source.manifest.tileSize, source.manifest.gutter));
      u.enabled.value = 1;
      u.level.value = shown.address.level;
      u.srgb.value = source.manifest.colorSpace === 'srgb' ? 1 : 0;
      u.opacity.value = source.info.opacity;
      u.bounded.value = source.info.bounds ? 1 : 0;
      u.bounds.value.fromArray(source.info.bounds ?? [-180, -90, 180, 90]);
    }
    uniforms.cubeImageryEnabled.value = maxShown >= 0 ? 1 : 0;
    uniforms.cubeImageryLevel.value = maxShown;
    if (!baseCovered) stats.baseUncoveredBlocks++;
    if (maxShown < 0) stats.untexturedBlocks++;
    else {
      stats.displayedLevels[maxShown] = (stats.displayedLevels[maxShown] ?? 0) + 1;
      stats.maxDisplayedLevel = Math.max(stats.maxDisplayedLevel, maxShown);
    }
    if (fallback) stats.fallbackBlocks++;
    if (failedBlock) stats.failedBlocks++;
  }

  private unsplit(m: MeshRecord): void {
    splitSources.delete(m.mesh);
    m.mesh.visible = true;
    for (const block of m.blocks.values()) block.mesh.visible = false;
  }

  private buildBlock(record: TileRecord, m: MeshRecord, leaf: ImageryAddress, id: string): Block {
    const t0 = performance.now();
    const g = m.mesh.geometry;
    const names = ['position', 'normal', 'cubeImageryUvw', 'surfaceHeightKm', 'surfaceReliefNormal', 'surfaceGround'].filter(n => g.getAttribute(n));
    const attributes = names.map(n => { const a = g.getAttribute(n) as THREE.BufferAttribute; return { array: a.array, itemSize: a.itemSize }; });
    // Only what the tile draws: its draw range excludes skirts when they are hidden.
    const index = g.index ? g.index.array.subarray(g.drawRange.start, Math.min(g.index.count, g.drawRange.start + g.drawRange.count)) : null;
    const clipped = clipTrianglesToTileRect(attributes, names.indexOf('cubeImageryUvw'), index, blockRectInTile(record.address, leaf));
    const geometry = new THREE.BufferGeometry();
    names.forEach((n, i) => geometry.setAttribute(n, new THREE.BufferAttribute(clipped.attributes[i], attributes[i].itemSize)));
    geometry.setIndex(new THREE.BufferAttribute(clipped.index, 1));
    geometry.boundingSphere = g.boundingSphere?.clone() ?? null;
    const material = m.material.clone();
    const uniforms = this.makeUniforms(record.address);
    this.attachImagery(material, m.baseCompile, m.cacheKey, uniforms);
    const mesh = new THREE.Mesh(geometry, material);
    this.surfaceAppearance?.attachDerived(mesh, m.mesh);
    mesh.name = `cube-imagery-block ${id}`;
    m.mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    mesh.frustumCulled = false;
    mesh.receiveShadow = m.mesh.receiveShadow;
    mesh.renderOrder = m.mesh.renderOrder;
    // Picking keeps using the (hidden) original mesh: same surface, no duplicate hits.
    mesh.raycast = () => {};
    (m.mesh.parent ?? record.scene).add(mesh);
    // TilesGroup pushes world matrices to tile scenes only when the group moves or a
    // tile becomes visible, so a mesh added afterwards must compute its own once.
    mesh.updateMatrixWorld(true);
    const bytes = clipped.attributes.reduce((s, a) => s + a.byteLength, 0) + clipped.index.byteLength;
    const block: Block = { mesh, material, uniforms, lastUsed: this.frame, bytes };
    m.blocks.set(id, block);
    this.counters.blockBuildMs += performance.now() - t0;
    return block;
  }

  private disposeBlock(m: MeshRecord, id: string): void {
    const block = m.blocks.get(id);
    if (!block) return;
    this.surfaceAppearance?.forget(block.mesh);
    block.mesh.removeFromParent();
    block.mesh.geometry.dispose();
    block.material.dispose();
    m.blocks.delete(id);
  }

  /** Start wanted loads in priority order within the request and texture budgets; abort and evict what nobody wants. */
  private schedule(wanted: Map<string, number>): { count: number; budgetLimited: boolean } {
    for (const e of this.entries.values()) {
      if (e.state === 'loading' && !e.pinned && !wanted.has(e.id) && this.frame - e.lastWanted > 30) {
        e.controller?.abort();
        this.entries.delete(e.id);
        this.counters.aborted++;
      }
    }
    // An outstanding request holds its estimated bytes until it completes, fails or is
    // aborted (it then leaves 'loading'), so staggered completions cannot overshoot the budget.
    const estimate = this.manifest ? Math.round((this.manifest.tileSize + 2 * this.manifest.gutter) ** 2 * 4 * 4 / 3) : 0;
    let used = 0, loading = 0;
    for (const e of this.entries.values()) {
      if (e.state === 'ready') used += e.bytes;
      else if (e.state === 'loading') { loading++; used += estimate; }
    }
    const now = performance.now();
    const missing = [...wanted].filter(([id]) => {
      const e = this.entries.get(id);
      return !e || (e.state === 'failed' && this.retryDue(e, now));
    }).sort((a, b) => a[1] - b[1]);
    let budgetLimited = false, started = 0;
    for (const [id] of missing) {
      if (loading >= this.options.maxConcurrentRequests) break;
      if (used + estimate > this.options.maxTextureBytes) used -= this.evict(used + estimate - this.options.maxTextureBytes);
      if (used + estimate > this.options.maxTextureBytes) { budgetLimited = true; break; }
      this.request(id, Number(id.split(':')[1].split('/')[1]) <= this.options.residentLevel);
      used += estimate; loading++; started++;
    }
    if (used > this.options.maxTextureBytes) this.evict(used - this.options.maxTextureBytes);
    return { count: missing.length - started, budgetLimited };
  }

  private retryDue(e: Entry, now = performance.now()): boolean {
    return now - e.failedAt > this.options.retryFailedMs * 2 ** (Math.min(e.failures, 5) - 1);
  }

  /** Whether `a` or one of its ancestors failed and is not yet due for a retry. */
  private failedAbove(a: ImageryAddress, source: Source): boolean {
    for (let level = a.level; level >= 0; level--) {
      const shift = a.level - level;
      const e = this.entries.get(`${source.index}:${cubeTileId({ face: a.face, level, x: a.x >> shift, y: a.y >> shift })}`);
      if (e?.state === 'failed' && !this.retryDue(e)) return true;
      if (e?.state === 'ready') return false;
    }
    return false;
  }

  /** Evict least recently used, unpinned textures not drawn this frame. Returns bytes freed. */
  private evict(need: number): number {
    const candidates = [...this.entries.values()].filter(e => e.state === 'ready' && !e.pinned && e.lastUsed < this.frame).sort((a, b) => a.lastUsed - b.lastUsed);
    let freed = 0;
    for (const e of candidates) {
      if (freed >= need) break;
      freed += e.bytes;
      this.releaseTexture(e);
      this.entries.delete(e.id);
      this.counters.evicted++;
    }
    return freed;
  }

  private request(id: string, pinned: boolean): void {
    if (!this.manifest) return;
    const controller = new AbortController();
    const [sourceId, tileId] = id.split(':');
    const source = this.sources[Number(sourceId)];
    if (!source.manifest) return;
    const address = parseImageryAddress(tileId);
    const failures = this.entries.get(id)?.failures ?? 0;
    const entry: Entry = { source, id, address, state: 'loading', texture: null, bytes: 0, lastUsed: 0, lastWanted: this.frame, pinned, controller, failedAt: 0, failures };
    this.entries.set(id, entry);
    this.counters.requests++;
    source.info.requests++;
    const url = new URL(imageryTileUri(source.manifest.uri, address), source.baseUrl).href;
    this.loadTexture(url, controller.signal).then(({ texture, bytes, downloadBytes }) => {
      if (this.disposed || this.entries.get(id) !== entry) { texture.dispose(); (texture.image as ImageBitmap | null)?.close?.(); return; }
      const span = source.manifest!.tileSize + 2 * source.manifest!.gutter;
      if (bytes > Math.round(span * span * 4 * 4 / 3)) {
        texture.dispose(); (texture.image as ImageBitmap | null)?.close?.();
        throw new Error('Cube imagery texture exceeds its manifest reservation');
      }
      entry.state = 'ready';
      entry.texture = texture;
      entry.bytes = bytes;
      entry.controller = null;
      entry.lastUsed = this.frame;
      this.counters.bytes += downloadBytes;
    }).catch((err: unknown) => {
      if (this.entries.get(id) !== entry) return;
      if ((err as { name?: string })?.name === 'AbortError') { this.entries.delete(id); return; }
      entry.state = 'failed';
      entry.failedAt = performance.now();
      entry.failures++;
      entry.controller = null;
      this.counters.failures++;
      source.info.failedTiles++;
    });
  }

  private releaseTexture(e: Entry): void {
    if (!e.texture) return;
    e.texture.dispose();
    (e.texture.image as ImageBitmap | null)?.close?.();
    e.texture = null;
  }
}
