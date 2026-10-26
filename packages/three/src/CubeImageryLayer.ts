import * as THREE from 'three';
import { clampOpacity, describeImageryLayers, layerStatus, type ImageryLayerInfo } from './ImageryLayers.js';
import type { TerrainImageryConfig } from './TerrainManager.js';
import type { SurfaceAppearance } from './SurfaceAppearance.js';
import { fetchWithRetry } from './fetchWithRetry.js';
import { cubeTileId, cubeFaceBasis, type CubeFace } from './surface/CubeSphere.js';
import { selectImageryBlocks } from './surface/CubeImagerySelection.js';
import { CubeImageryPages, type ImageryPage } from './CubeImageryPages.js';
import { ImageryRefinement, imageryParent, type ImageryCover } from './surface/ImageryRefinement.js';
import {
  CubeImageryAvailability, blockBoundingSphere, blockBoundingBox, boxBeyondHorizon, imageryTileRect, imageryTileUri,
  parseImageryAddress, tileProjectiveBasis, validateCubeImageryManifest, directionToTexel, texelGroundSizeKm,
  type CubeImageryManifest, type ImageryAddress, type Vec3,
} from './surface/CubeImagery.js';

/** Independent imagery trees and GPU pages, composited on authoritative terrain.
 * Neither imagery resolution nor texture arrival changes terrain geometry,
 * materials, picking targets or CPU physical-surface queries. */
export interface CubeImageryConfig {
  /** `imagery.json` written by `scripts/terrain/cube_imagery.py`. */
  url: string;
  /** Globe.imagery cube products, bottom to top. Shares geometry, draws and one texture budget. */
  layers?: TerrainImageryConfig[];
  /** Target projected size of one imagery texel, px. Default 1.5. */
  maxScreenTexelError?: number;
  /** Residency target including mipmaps: 160 MiB for one/two sources, 512 MiB
   * for larger stacks. Display references and a four-page transition reservation
   * are protected; allocated bytes and any overage are reported separately. */
  maxTextureBytes?: number;
  /** Concurrent tile requests. Default 8. */
  maxConcurrentRequests?: number;
  /** Levels loaded up front and never evicted. Default 1 for one product (30 tiles, ~11 MB); 0 for a stack (six roots per source). */
  residentLevel?: number;
  /** Deprecated selection hint; imagery no longer splits terrain geometry. */
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
  committedGroups: number;
  waitingGroups: number;
  gpuAllocatedBytes: number;
  /** Additional fixed reservation for a four-child transition, above the target. */
  transitionTextureBytes: number;
  /** Protected working-set bytes above a newly reduced residency target. */
  protectedOverBudgetBytes: number;
  uploadMs: number;
  gpuError: string | null;
  /** Errors observed before our allocation, excluded from allocation failure. */
  inheritedGlErrors: readonly number[];
  blockBuildMs: number;
}

export type CubeImageryDebug = 'none' | 'unlit' | 'level';
type TextureLoader = (url: string, signal: AbortSignal) => Promise<{ texture: THREE.Texture; bytes: number; downloadBytes: number }>;

interface Source {
  index: number; baseUrl: string; manifest: CubeImageryManifest | null;
  availability: CubeImageryAvailability | null; refinement: ImageryRefinement | null;
  cover: ImageryCover[]; info: ImageryLayerInfo; setupFailed: boolean;
}
interface Entry {
  source: Source; id: string; address: ImageryAddress;
  state: 'loading' | 'ready' | 'failed'; texture: THREE.Texture | null; transparent: boolean; opaque: boolean; uploadBlocked: boolean;
  bytes: number; lastUsed: number; lastWanted: number; pinned: boolean;
  controller: AbortController | null; failedAt: number; failures: number;
}
interface SourceUniforms {
  root: { value: number }; enabled: { value: number }; srgb: { value: number };
  fallback: { value: Int32Array };
  opacity: { value: number }; bounded: { value: number }; bounds: { value: THREE.Vector4 };
}
interface Uniforms {
  layers: SourceUniforms[];
  cubeImageryToBody: { value: THREE.Matrix3 };
  cubeGeometryAddress: { value: Int32Array };
  cubeImageryDebug: { value: number };
  cubePages: { value: THREE.DataArrayTexture | null };
  cubePageTable: { value: THREE.DataTexture | null };
  cubePagePixels: { value: THREE.Vector2 };
}
interface MeshRecord {
  mesh: THREE.Mesh; material: THREE.Material; uniforms: Uniforms;
  baseCompile: THREE.Material['onBeforeCompile']; cacheKey: () => string;
  radiusRangeKm: [number, number];
}
interface TileRecord { scene: THREE.Object3D; address: ImageryAddress; meshes: MeshRecord[] }

/** Compatibility for physical picking. All imagery now draws on original meshes. */
export function isDrawnCubeImagerySource(_object: THREE.Object3D): boolean { return false; }
const CACHE_KEY = '_cubeimg_pages_v2';
const DEBUG_CODE: Record<CubeImageryDebug, number> = { none: 0, unlit: 1, level: 2 };
const FACES: CubeFace[] = ['px','nx','py','ny','pz','nz'];
const _bodyFrustum = new THREE.Frustum(), _box = new THREE.Box3();
const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _v = new THREE.Vector3(), _frustum = new THREE.Frustum(), _sphere = new THREE.Sphere();
const containsAddress = (outer: ImageryAddress, inner: ImageryAddress) => outer.face === inner.face && outer.level <= inner.level &&
  outer.x === Math.floor(inner.x / 2 ** (inner.level - outer.level)) && outer.y === Math.floor(inner.y / 2 ** (inner.level - outer.level));

const VERTEX_PARS = 'attribute vec3 cubeImageryUvw;\nvarying vec3 vCubeImageryUvw;\n';
const FRAGMENT_PARS = `
varying vec3 vCubeImageryUvw;
uniform highp sampler2DArray cubePages;
uniform highp isampler2D cubePageTable;
uniform vec2 cubePagePixels;
uniform ivec3 cubeGeometryAddress;
uniform mat3 cubeImageryToBody;
uniform int cubeImageryDebug;
ivec4 cubePageRead(int index) { return texelFetch(cubePageTable, ivec2(index % 1024, index / 1024), 0); }
ivec4 cubePageFind(int root, ivec4 fallback, vec2 uv) {
  ivec4 page = fallback;
  int node = root;
  vec2 local = clamp(uv, vec2(0.0), vec2(0.99999994));
  for (int depth = 0; depth <= 30; depth++) {
    if (node < 0) break;
    ivec4 image = cubePageRead(node * 2 + 1);
    if (image.x != -1) page = image;
    ivec2 quadrant = ivec2(floor(local * 2.0));
    local = fract(local * 2.0);
    ivec4 children = cubePageRead(node * 2);
    node = children[quadrant.x + 2 * quadrant.y];
  }
  return page;
}
vec2 cubePageUv(ivec4 page, vec2 local) {
  int shift = page.y - cubeGeometryAddress.x;
  if (shift >= 0) {
    ivec2 offset = page.zw - (cubeGeometryAddress.yz << shift);
    return local * exp2(float(shift)) - vec2(offset);
  }
  ivec2 offset = cubeGeometryAddress.yz - (page.zw << (-shift));
  return (local + vec2(offset)) * exp2(float(shift));
}
vec3 cubeImagerySrgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 cubeImageryLevelColor(float level) {
  return 0.5 + 0.5 * cos(6.2831853 * (level * 0.137 + vec3(0.0, 2.0, 4.0) / 3.0));
}
`;
function injectImagery(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: Uniforms): void {
  const { layers, ...flat } = uniforms;
  Object.assign(shader.uniforms, flat);
  layers.forEach((u, i) => { for (const [key, uniform] of Object.entries(u)) shader.uniforms[`cubeLayer${i}_${key}`] = uniform; });
  if (shader.vertexShader.includes(VERTEX_PARS)) return;
  shader.vertexShader = VERTEX_PARS + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvCubeImageryUvw = cubeImageryUvw;');
  const pars = layers.map((_, i) => `uniform int cubeLayer${i}_root; uniform ivec4 cubeLayer${i}_fallback; uniform float cubeLayer${i}_enabled;
    uniform float cubeLayer${i}_bounded; uniform vec4 cubeLayer${i}_bounds;
    uniform float cubeLayer${i}_srgb; uniform float cubeLayer${i}_opacity;`).join('\n');
  let fragment = FRAGMENT_PARS + pars + '\n' + shader.fragmentShader;
  fragment = fragment.replace('void main() {', 'void main() {\n  vec4 cubeImageryTexel = vec4(0.0); float shownLevel = -1.0;');
  const coordinates = `
    vec2 tileUv = vCubeImageryUvw.xy / vCubeImageryUvw.z;
    vec2 faceDx = dFdx(tileUv), faceDy = dFdy(tileUv);
    vec3 direction = cubeImageryToBody * vCubeImageryUvw;
    vec2 lonLat = degrees(vec2(atan(direction.y, direction.x), atan(direction.z, length(direction.xy))));`;
  const samples = layers.map((_, i) => `
    if (cubeLayer${i}_enabled > 0.5) {
      ivec4 page = cubePageFind(cubeLayer${i}_root, cubeLayer${i}_fallback, tileUv);
      if (page.x >= 0) {
        vec2 st = cubePageUv(page, tileUv) * cubePagePixels.x + cubePagePixels.y;
        // Explicit gradients avoid undefined implicit derivatives at quadtree boundaries.
        vec2 dx = faceDx * exp2(float(page.y - cubeGeometryAddress.x)) * cubePagePixels.x;
        vec2 dy = faceDy * exp2(float(page.y - cubeGeometryAddress.x)) * cubePagePixels.x;
        vec4 sampleValue = textureGrad(cubePages, vec3(st, float(page.x)), dx, dy);
        float alpha = sampleValue.a * cubeLayer${i}_opacity;
        if (cubeLayer${i}_bounded > 0.5) {
          vec4 b = cubeLayer${i}_bounds;
          bool longitude = b.x <= b.z ? lonLat.x >= b.x && lonLat.x <= b.z : lonLat.x >= b.x || lonLat.x <= b.z;
          if (!longitude || lonLat.y < b.y || lonLat.y > b.w) alpha = 0.0;
        }
        vec3 color = cubeLayer${i}_srgb > 0.5 ? cubeImagerySrgbToLinear(sampleValue.rgb) : sampleValue.rgb;
        diffuseColor.rgb = mix(diffuseColor.rgb, color, alpha);
        cubeImageryTexel.rgb = mix(cubeImageryTexel.rgb, sampleValue.rgb, alpha);
        cubeImageryTexel.a = alpha + cubeImageryTexel.a * (1.0 - alpha);
        if (alpha > 0.0) shownLevel = float(page.y);
      }
    }`).join('\n');
  fragment = fragment.replace('#include <map_fragment>', '#include <map_fragment>\n' + coordinates + samples);
  fragment = fragment.replace('#include <dithering_fragment>', `#include <dithering_fragment>
    if (cubeImageryDebug == 1) gl_FragColor = vec4(cubeImageryTexel.rgb, 1.0);
    else if (cubeImageryDebug == 2) gl_FragColor = vec4(shownLevel >= 0.0 ? cubeImageryLevelColor(shownLevel) * (0.35 + 0.65 * dot(cubeImageryTexel.rgb, vec3(0.333))) : vec3(0.15), 1.0);`);
  shader.fragmentShader = fragment;
}

/** Exact alpha proof, never downsampled. Unknown/unreadable images remain real
 * pages. A fully transparent source tile can replace its parent without storing
 * millions of invisible texels or concealing lower-source imagery. */
function imageAlphaClass(texture: THREE.Texture): 'transparent' | 'opaque' | 'mixed' | 'unknown' {
  let data: Uint8Array | Uint8ClampedArray | undefined;
  if (texture instanceof THREE.DataTexture && texture.format === THREE.RGBAFormat && texture.type === THREE.UnsignedByteType) {
    data = texture.image.data as Uint8Array;
  } else if (typeof OffscreenCanvas !== 'undefined' && typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) {
    try {
      const canvas = new OffscreenCanvas(texture.image.width, texture.image.height), context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return 'unknown';
      context.drawImage(texture.image, 0, 0); data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch { return 'unknown'; }
  }
  if (!data?.length) return 'unknown';
  let zero = false, full = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] === 0) zero = true; else if (data[i] === 255) full = true; else return 'mixed';
    if (zero && full) return 'mixed';
  }
  return full ? 'opaque' : 'transparent';
}
/** Fetch + off-thread decode into a mipmapped, unconverted texture whose t = 0 is the file's bottom row. */
async function loadImageBitmapTexture(url: string, signal: AbortSignal, expectedSpan: number): Promise<{ texture: THREE.Texture; bytes: number; downloadBytes: number }> {
  // Transient errors retry here; what still fails falls back to an ancestor and is retried later.
  const response = await fetchWithRetry(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  if (signal.aborted) { bitmap.close(); throw new DOMException('Aborted', 'AbortError'); }
  if (bitmap.width !== expectedSpan || bitmap.height !== expectedSpan) {
    bitmap.close(); throw new Error('Cube imagery dimensions do not match the declared tile and gutter');
  }
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

/** A proof for request suppression, rather than the looser overlap cull. */
export function cubeBlockInsideBounds(address: ImageryAddress, bounds: readonly number[] | null): boolean {
  if (!bounds) return true;
  const { centre, radius } = blockBoundingSphere(address, [1, 1]);
  const angular = Math.asin(Math.min(1, radius / Math.hypot(...centre)));
  const rad = Math.PI / 180, lat = Math.atan2(centre[2], Math.hypot(centre[0], centre[1]));
  if (lat - angular < bounds[1] * rad || lat + angular > bounds[3] * rad) return false;
  if (Math.abs(lat) + angular >= Math.PI / 2) return false;
  const lon = Math.atan2(centre[1], centre[0]) / rad;
  const span = Math.asin(Math.min(1, Math.sin(angular) / Math.cos(lat))) / rad;
  const west = bounds[0], east = bounds[2] < west ? bounds[2] + 360 : bounds[2];
  return [-360, 0, 360].some(offset => lon - span + offset >= west && lon + span + offset <= east);
}

/** Unknown pixels never establish opacity. Scan the original decoded alpha,
 * including gutters, once per texture; a downsample could erase small holes. */
export class CubeImageryLayer {
  surfaceAppearance: SurfaceAppearance | null = null;
  manifest: CubeImageryManifest | null = null;
  readonly ready: Promise<void>;
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
  private pages: CubeImageryPages | null = null;
  // Integer samplers require an integer texture even before the manifest/pool
  // is ready. Three's null-texture fallback is floating-point and invalidates
  // a draw even when every imagery layer is disabled by its uniform.
  private readonly emptyPages = (() => {
    const array = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
    array.needsUpdate = true; return array;
  })();
  private readonly emptyPageTable = (() => {
    const table = new THREE.DataTexture(new Int32Array(4).fill(-1), 1, 1, THREE.RGBAIntegerFormat, THREE.IntType);
    table.needsUpdate = true; return table;
  })();
  private contextCanvas: HTMLCanvasElement | null = null;
  private readonly contextLost = () => { this.emptyPages.dispose(); this.emptyPageTable.dispose(); };
  private pageBudget = -1;
  private gpuError: string | null = null;
  private uploadsPaused = false;
  private readonly reserved = new Set<string>();
  private readonly cacheReferences = new Set<string>();
  private selectionKey = '';
  private readonly selectionCache = new Map<number, ImageryAddress[]>();
  private readonly visibilityCache = new Map<string, boolean>();
  private readonly errorCache = new Map<string, number>();
  private readonly materialBindings = new WeakMap<THREE.Material, Uniforms>();
  private readonly coverageCache = new Map<string, boolean>();
  private coverageStyleKey = '';
  private readonly coverKeys = new Map<number, string>();
  private readonly horizonRadiusKm: () => number;
  private disposed = false;
  private counters = { requests: 0, bytes: 0, failures: 0, aborted: 0, evicted: 0, blockBuildMs: 0 };
  private last = {
    queued: 0, budgetLimited: false, tiles: 0, splitTiles: 0, blocks: 0, extraDraws: 0,
    displayedLevels: {} as Record<number, number>, wantedLevels: {} as Record<number, number>,
    fallbackBlocks: 0, failedBlocks: 0, untexturedBlocks: 0, baseUncoveredBlocks: 0, maxDisplayedLevel: -1, updateMs: 0,
    committedGroups: 0, waitingGroups: 0,
  };
  constructor(config: CubeImageryConfig, deps: { fetchManifest?: (url: string) => Promise<CubeImageryManifest>; loadTexture?: TextureLoader; radiusKm?: number; horizonRadiusKm?: () => number } = {}) {
    this.horizonRadiusKm = deps.horizonRadiusKm ?? (() => 0);
    this.options = {
      maxScreenTexelError: config.maxScreenTexelError ?? 1.5,
      maxTextureBytes: config.maxTextureBytes ?? ((config.layers?.length ?? 1) > 2 ? 512 : 160) * 2 ** 20,
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
      manifest: null, availability: null, refinement: null, cover: [], setupFailed: false,
    }));
    this.order = [...this.sources];
    this.loadTexture = deps.loadTexture ?? ((url, signal) => loadImageBitmapTexture(url, signal, this.manifest!.tileSize + 2 * this.manifest!.gutter));
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
        source.refinement = new ImageryRefinement(manifest.tiles);
        source.setupFailed = false;
        source.info.maxLevel = manifest.maxLevel;
        source.info.minZoom = manifest.minLevel;
        source.info.metersPerPixel = deps.radiusKm ? 2 * deps.radiusKm * 1000 / (manifest.tileSize * 2 ** manifest.maxLevel) : null;
        source.info.attribution ||= manifest.source.attribution ?? '';
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
        void loadSource(source).then(() => { if (!this.disposed) this.schedule(this.coarseWanted().map(id => [id]), new Set()); });
      }
    };
    this.ready = Promise.all(this.sources.map(loadSource)).then(() => { if (!this.disposed) this.schedule(this.coarseWanted().map(id => [id]), new Set()); });
  }

  /** Source state uses the same Globe.imagery UI contract as geographic overlays. */
  get imageryLayers(): ImageryLayerInfo[] {
    return this.order.map(source => {
      const { info, setupFailed } = source;
      const failedTiles = [...this.entries.values()].filter(e => e.source === source && e.state === 'failed').length;
      return { ...info, failedTiles, bounds: info.bounds ? [...info.bounds] : null,
        status: layerStatus(info.requests, failedTiles, setupFailed), view: info.view ? { ...info.view } : null };
    });
  }

  setLayerVisible(id: string, visible: boolean): boolean {
    const source = this.sources.find(s => s.info.id === id);
    if (!source || !source.info.optional || source.info.visible === visible) return false;
    source.info.visible = visible;
    source.cover = [];
    if (source.manifest) source.refinement = new ImageryRefinement(source.manifest.tiles);
    if (!visible) {
      for (const [key, entry] of this.entries) if (entry.source === source) {
        entry.controller?.abort(); this.releaseTexture(entry); this.entries.delete(key);
      }
    }
    return true;
  }

  setLayerOpacity(id: string, opacity: number): boolean {
    const source = this.sources.find(s => s.info.id === id);
    if (!source) return false;
    const wasActive = source.info.opacity > 0;
    source.info.opacity = clampOpacity(opacity);
    if (!wasActive && source.info.opacity > 0 && source.manifest) source.refinement = new ImageryRefinement(source.manifest.tiles);
    return true;
  }

  moveLayer(id: string, toIndex: number): boolean {
    const index = this.order.findIndex(s => s.info.id === id);
    if (index <= 0 || !Number.isInteger(toIndex) || toIndex < 1 || toIndex >= this.order.length || index === toIndex) return false;
    this.order.splice(toIndex, 0, this.order.splice(index, 1)[0]);
    return true;
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
      for (const s of this.sources) if (s.manifest) { s.availability = this.availabilityFor(s.manifest); s.refinement?.resetHysteresis(); }
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
      // Snapshot the default program key before wrapping its compile hook.
      const baseKey = material.customProgramCacheKey.bind(material);
      const defaultKey = material.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey;
      const snapshot = baseKey();
      const cacheKey = () => (defaultKey ? snapshot : baseKey()) + CACHE_KEY + this.sources.length;
      const uniforms = this.attachImagery(material, baseCompile, cacheKey, this.makeUniforms(address));
      record.meshes.push({ mesh, material, uniforms, baseCompile, cacheKey, radiusRangeKm: [rMin / 1000, rMax / 1000], });
    });
    this.tiles.set(key, record);
  }

  /** Imagery owns no derived terrain geometry. Kept for the terrain draw-range API. */
  invalidateBlocks(): void {}

  removeTile(key: object): void { this.tiles.delete(key); }

  update(camera: THREE.Camera, tileSetMatrixWorld: THREE.Matrix4, pixelAngleRad: number, renderer: THREE.WebGLRenderer | null, useImagery = true): void {
    if (renderer && this.contextCanvas !== renderer.domElement) {
      this.contextCanvas?.removeEventListener('webglcontextlost', this.contextLost);
      this.contextCanvas = renderer.domElement;
      this.contextCanvas?.addEventListener('webglcontextlost', this.contextLost);
    }
    if (this.disposed || !this.manifest || renderer?.getContext().isContextLost()) return;
    const start = performance.now(); this.frame++;
    const span = this.manifest.tileSize + 2 * this.manifest.gutter;
    const tileBytes = Math.round(span * span * 4 * 4 / 3);
    if ((!this.pages && !this.gpuError) || this.pageBudget !== this.options.maxTextureBytes) {
      const gl = renderer?.getContext() as WebGL2RenderingContext | undefined;
      const layerLimit = gl ? gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number : 2048;
      // Bounded transition headroom allows a sibling group to complete without
      // evicting its displayed parent. The residency target is not a display cap.
      for (const e of this.entries.values()) if (this.pages && !e.pinned && e.state === 'ready' && !this.cacheReferences.has(e.id)) {
        this.releaseTexture(e); this.entries.delete(e.id); this.counters.evicted++;
      }
      const capacity = Math.min(layerLimit, Math.max(this.coarseWanted().length + 4, Math.floor(this.options.maxTextureBytes / tileBytes) + 4,
        // A live target reduction cannot destroy the committed cover. Retire
        // unreferenced history first; report the protected working set honestly.
        this.pages ? [...this.entries.values()].filter(e => e.state !== 'failed').length : 0));
      if (capacity !== this.pages?.capacity) {
        let candidateCapacity = capacity, allocationError = '';
        for (;;) {
          const replacement = new CubeImageryPages(span, candidateCapacity);
          let usable = !renderer || replacement.initialize(renderer);
          if (usable) for (const e of this.entries.values()) if (e.state === 'ready' && e.texture) {
            if (e.transparent) replacement.transparent(e.id);
            else if (!replacement.upload(e.id, e.texture, renderer)) { usable = false; break; }
          }
          if (usable) {
            const previous = this.pages; this.pages = replacement; previous?.dispose();
            this.gpuError = candidateCapacity < capacity ? `GPU capacity limited (${allocationError}); using a smaller coherent image pool` : null;
            break;
          }
          allocationError = replacement.lastError ?? 'cached page upload failed';
          replacement.dispose();
          const minimum = Math.min(layerLimit, this.coarseWanted().length + 4);
          if (this.pages || candidateCapacity <= minimum) {
            this.gpuError = 'Image GPU allocation/upload failed; retained the previous cover'; break;
          }
          // With no previous GPU cover, reduce allocation conservatively instead
          // of retrying the same oversized pool every rendered frame. Never
          // reduce or dispose an existing displayed pool on an allocation error.
          candidateCapacity = Math.max(minimum, Math.floor(candidateCapacity * 0.75));
        }
      } else {
        this.gpuError = null;
      }
      this.pageBudget = this.options.maxTextureBytes;
    }
    const pages = this.pages;
    if (!pages) {
      for (const e of this.entries.values()) { e.controller?.abort(); this.releaseTexture(e); }
      this.entries.clear();
      this.last = { ...this.last, baseUncoveredBlocks: 1, untexturedBlocks: 1, budgetLimited: true };
      return;
    }
    if (renderer && pages.contextGeneration(renderer)) {
      this.uploadsPaused = false; this.gpuError = null;
      for (const e of this.entries.values()) e.uploadBlocked = false;
    }
    // A decoded texture is not yet usable by the shader. Upload before the
    // replacement tree observes readiness, then publish one coherent page table.
    for (const e of this.entries.values()) if (!this.uploadsPaused && e.state === 'ready' && e.texture && !e.uploadBlocked) {
      if (e.transparent) pages.transparent(e.id);
      else if (!pages.upload(e.id, e.texture, renderer)) {
        e.uploadBlocked = true; this.uploadsPaused = true;
        this.gpuError = `Image page upload failed (${pages.lastError}); retained usable ancestors. Retry explicitly or restore the GPU context.`;
      }
    }
    const toBody = _inv.copy(tileSetMatrixWorld).invert();
    camera.updateMatrixWorld();
    _v.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(toBody);
    const cameraKm: Vec3 = [_v.x / 1000, _v.y / 1000, _v.z / 1000];
    _frustum.setFromProjectionMatrix(_m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    _bodyFrustum.setFromProjectionMatrix(_m.multiply(tileSetMatrixWorld));
    const scale = tileSetMatrixWorld.getMaxScaleOnAxis(), innerRadiusKm = this.horizonRadiusKm();
    const drawn = [...this.tiles.values()].filter(t => t.scene.parent && t.scene.visible);
    const ranges = drawn.flatMap(t => t.meshes.map(m => m.radiusRangeKm));
    const radiusRangeKm: [number, number] = ranges.length ? [Math.min(...ranges.map(r => r[0])), Math.max(...ranges.map(r => r[1]))] : [0, 0];
    const selectionKey = [useImagery, pixelAngleRad, this.options.maxLevel, this.options.maxScreenTexelError,
      ...cameraKm, innerRadiusKm, ..._bodyFrustum.planes.flatMap(p => [p.normal.x, p.normal.y, p.normal.z, p.constant]),
      ...drawn.flatMap(t => [cubeTileId(t.address), ...t.meshes.flatMap(m => m.radiusRangeKm)])].join(',');
    if (selectionKey !== this.selectionKey) {
      this.selectionKey = selectionKey; this.selectionCache.clear(); this.visibilityCache.clear(); this.errorCache.clear();
    }
    // Image ownership is independent of terrain. Its culling envelope must still
    // bound the actual local physical surface, not every mountain on the globe.
    const envelopes = new Map<string, [number, number]>();
    const geometryLeaves = new Set(drawn.map(tile => cubeTileId(tile.address)));
    for (const tile of drawn) for (const mesh of tile.meshes) {
      let a = tile.address;
      for (;;) {
        const id = cubeTileId(a), previous = envelopes.get(id), r = mesh.radiusRangeKm;
        envelopes.set(id, previous ? [Math.min(previous[0], r[0]), Math.max(previous[1], r[1])] : [...r]);
        if (!a.level) break; a = imageryParent(a);
      }
    }
    const localRanges = new Map<string, readonly [number, number]>();
    const rangeFor = (address: ImageryAddress): readonly [number, number] => {
      const key = cubeTileId(address), cached = localRanges.get(key); if (cached) return cached;
      let a = address, result: readonly [number, number] = radiusRangeKm;
      for (;;) { const r = envelopes.get(cubeTileId(a)); if (r) { result = r; break; } if (!a.level) break; a = imageryParent(a); }
      localRanges.set(key, result); return result;
    };
    const visible = (a: ImageryAddress): boolean => {
      const key = cubeTileId(a), cached = this.visibilityCache.get(key); if (cached !== undefined) return cached;
      const result = visibleUncached(a); this.visibilityCache.set(key, result); return result;
    };
    const visibleUncached = (a: ImageryAddress): boolean => {
      let ancestor = a, covered = envelopes.has(cubeTileId(a));
      while (!covered && ancestor.level > 0) { ancestor = imageryParent(ancestor); covered = geometryLeaves.has(cubeTileId(ancestor)); }
      if (!covered) return false;
      const localRange = rangeFor(a), sphere = blockBoundingSphere(a, localRange);
      _sphere.center.set(...sphere.centre).multiplyScalar(1000).applyMatrix4(tileSetMatrixWorld);
      _sphere.radius = sphere.radius * 1000 * scale;
      if (!_frustum.intersectsSphere(_sphere)) return false;
      const box = blockBoundingBox(a, localRange);
      _box.min.fromArray(box.min).multiplyScalar(1000); _box.max.fromArray(box.max).multiplyScalar(1000);
      return _bodyFrustum.intersectsBox(_box) && !boxBeyondHorizon(box, cameraKm, innerRadiusKm);
    };
    const protectedIds = new Set<string>(), groups: string[][] = this.coarseWanted().map(id => [id]);
    const gpuPages: ImageryPage[] = [], displayed: Record<number, number> = {}, wanted: Record<number, number> = {};
    let committedGroups = 0, waitingGroups = 0, baseUncoveredBlocks = 0, fallbackBlocks = 0, failedBlocks = 0;
    const sourceFrames: Array<{ source: Source; targets: ImageryAddress[] }> = [];
    const coverageStyleKey = this.order.map(s => `${s.index}/${s.info.visible}/${s.info.opacity}`).join(';');
    if (coverageStyleKey !== this.coverageStyleKey || this.coverageCache.size > 8192) {
      this.coverageStyleKey = coverageStyleKey; this.coverageCache.clear();
    }
    // Resolve upper committed cover first, so lower-source occlusion uses this
    // frame's actual alpha/readiness state, including newly revealed nodata.
    for (const source of [...this.order].reverse()) {
      const priorFallbacks = fallbackBlocks, priorFailures = failedBlocks;
      source.info.view = source.info.visible ? { inCoverage: false, zoomLevel: null, missingTiles: 0, degradedTiles: 0, cacheFull: false } : null;
      if (!source.info.visible || source.info.opacity <= 0 || !source.manifest || !source.refinement) { source.cover = []; continue; }
      const sourceVisible = (a: ImageryAddress) => visible(a) && cubeBlockOverlapsBounds(a, source.info.bounds);
      const targets: ImageryAddress[] = this.selectionCache.get(source.index) ?? [];
      if (!this.selectionCache.has(source.index) && useImagery && drawn.length) for (const face of FACES) {
        const leaves = selectImageryBlocks({ geometry: { face, level: 0, x: 0, y: 0 }, radiusRangeKm, radiusRangeFor: rangeFor, cameraKm, pixelAngleRad,
          maxScreenTexelError: this.options.maxScreenTexelError, tileSize: source.manifest.tileSize,
          availability: source.availability!, maxBlocks: 4096, inView: (_c, _r, a) => sourceVisible(a) });
        targets.push(...leaves.filter(l => l.inView).map(l => l.image));
      }
      this.selectionCache.set(source.index, targets);
      const exposed = targets.filter(a => !this.coveredByUpperSource(a, source));
      const id = (a: ImageryAddress) => `${source.index}:${cubeTileId(a)}`;
      const usable = (a: ImageryAddress) => this.entries.get(id(a))?.state === 'ready' && pages.has(id(a));
      const retainSplit = (a: ImageryAddress) => {
        if (a.level >= (this.options.maxLevel ?? source.manifest!.maxLevel)) return false;
        const key = cubeTileId(a); let error = this.errorCache.get(key);
        if (error === undefined) {
          const range = rangeFor(a), sphere = blockBoundingSphere(a, range), rect = imageryTileRect(a);
          const distance = Math.max(Math.hypot(...cameraKm.map((v, i) => v - sphere.centre[i])) - sphere.radius, 1e-6);
          const u = Math.min(Math.max(0, rect.u0), rect.u0 + rect.size), v = Math.min(Math.max(0, rect.v0), rect.v0 + rect.size);
          error = texelGroundSizeKm(a.level, u, v, range[1], source.manifest!.tileSize) / (distance * pixelAngleRad);
          this.errorCache.set(key, error);
        }
        // Separate refinement/coarsening thresholds, followed by a quiet-frame
        // delay. This stabilizes slow threshold crossings as well as reversals.
        return error > this.options.maxScreenTexelError * 0.7;
      };
      const frame = source.refinement.update(exposed, usable, this.frame, sourceVisible,
        a => this.entries.get(id(a))?.state === 'failed', retainSplit);
      source.cover = frame.cover.filter(c => !this.coveredByUpperSource(c.patch, source));
      const coverKey = source.cover.map(c => `${cubeTileId(c.patch)}=${cubeTileId(c.image)}`).join(';');
      if (this.coverKeys.get(source.index) !== coverKey) { this.coverKeys.set(source.index, coverKey); this.coverageCache.clear(); }
      committedGroups += frame.committed; waitingGroups += frame.waiting;
      sourceFrames.push({ source, targets });
      // All sources establish a ready root before deeper refinement. Then groups
      // compete by depth/error, not by a source-wide resolution quota.
      for (const target of exposed) {
        wanted[target.level] = (wanted[target.level] ?? 0) + 1;
        const root = { ...target, level: 0, x: 0, y: 0 };
        if (source.refinement.ancestor(root) && !usable(root)) groups.push([id(root)]);
      }
      for (const group of frame.loading) groups.push(group.map(id));
      // Base roots also service culled terrain in an instrument view. Optional
      // roots are retained by actual page references, never assumed opaque.
      const cover = [...source.cover];
      for (const face of FACES) {
        const root = { face, level: 0, x: 0, y: 0 };
        if (usable(root)) cover.unshift({ patch: root, image: root });
      }
      for (const c of cover) {
        const key = id(c.image); protectedIds.add(key);
        const entry = this.entries.get(key)!; entry.lastUsed = this.frame;
        gpuPages.push({ ...c, source: source.index, slot: pages.slot(key) });
      }
      for (const c of source.cover) displayed[c.image.level] = (displayed[c.image.level] ?? 0) + 1;
      for (const target of targets) {
        const root = this.entries.get(`${source.index}:${target.face}/0/0/0`);
        const covering = source.cover.filter(c => containsAddress(c.patch, target) || containsAddress(target, c.patch));
        const complete = (a: ImageryAddress, candidates: ImageryCover[]): boolean => {
          if (!sourceVisible(a)) return true;
          if (candidates.some(c => containsAddress(c.patch, a))) return true;
          const descendants = candidates.filter(c => containsAddress(a, c.patch));
          if (!descendants.length) return false;
          return Array.from({ length: 4 }, (_, i) => ({ face: a.face, level: a.level + 1, x: a.x * 2 + (i & 1), y: a.y * 2 + (i >> 1) })).every(c => complete(c, descendants));
        };
        if (source.index === 0 && !(root?.state === 'ready' && pages.has(root.id)) && !complete(target, covering)) baseUncoveredBlocks++;
        if (!this.coveredByUpperSource(target, source) &&
          (covering.length ? covering.some(c => c.image.level < target.level) : !root || root.address.level < target.level)) fallbackBlocks++;
        if (this.entries.get(id(target))?.state === 'failed') failedBlocks++;
      }
      if (source.info.view) {
        source.info.view.inCoverage = targets.length > 0;
        source.info.view.zoomLevel = source.cover.length ? Math.max(...source.cover.map(c => c.image.level)) : null;
        source.info.view.degradedTiles = fallbackBlocks - priorFallbacks;
        source.info.view.missingTiles = failedBlocks - priorFailures;
      }
    }
    pages.publish(gpuPages);
    for (const tile of this.tiles.values()) for (const m of tile.meshes) {
      m.uniforms.cubePages.value = pages.array;
      // Keep the uniform object compiled into the material stable even when
      // resizing/replacing the GPU pool creates a different page table owner.
      m.uniforms.cubePageTable.value = pages.tableUniform.value;
      m.uniforms.cubePagePixels.value.set(this.manifest.tileSize / span, this.manifest.gutter / span);
      for (let i = 0; i < this.order.length; i++) {
        const s = this.order[i], u = m.uniforms.layers[i];
        const binding = pages.binding(s.index, tile.address);
        u.root.value = binding.root; u.fallback.value.set(binding.image);
        u.enabled.value = useImagery && s.info.visible && s.info.opacity > 0 && (binding.root >= 0 || binding.image[0] !== -1) ? 1 : 0;
        u.srgb.value = s.manifest?.colorSpace === 'srgb' ? 1 : 0;
        u.opacity.value = s.info.opacity; u.bounded.value = s.info.bounds ? 1 : 0;
        u.bounds.value.fromArray(s.info.bounds ?? [-180, -90, 180, 90]);
      }
    }
    // Prioritize complete coarse feedback across all layers, followed by local
    // sibling replacement. Order is deterministic even if downloads finish late.
    const priority = (group: string[]) => {
      const [sourceId, tileId] = group[0].split(':'), level = parseImageryAddress(tileId).level;
      return level === 0 ? -1000 : (this.order.length - 1 - this.order.indexOf(this.sources[Number(sourceId)])) * 100 + level;
    };
    groups.sort((a, b) => priority(a) - priority(b));
    const queued = this.schedule(groups, protectedIds);
    queued.budgetLimited ||= this.gpuError !== null;
    for (const { source } of sourceFrames) if (source.info.view) source.info.view.cacheFull = queued.budgetLimited;
    const maxDisplayedLevel = Math.max(-1, ...Object.keys(displayed).map(Number));
    this.last = { ...queued, queued: queued.count, tiles: drawn.reduce((n, t) => n + t.meshes.length, 0), splitTiles: 0,
      blocks: gpuPages.length, extraDraws: 0, displayedLevels: displayed, wantedLevels: wanted,
      fallbackBlocks, failedBlocks, untexturedBlocks: baseUncoveredBlocks, baseUncoveredBlocks, maxDisplayedLevel,
      committedGroups, waitingGroups, updateMs: performance.now() - start };
  }

  private displayedAt(source: Source, point: ImageryAddress): Entry | null {
    if (point.level < 30) {
      const scale = 2 ** (30 - point.level);
      point = { ...point, level: 30, x: point.x * scale + scale / 2, y: point.y * scale + scale / 2 };
    }
    let best: ImageryCover | undefined;
    for (const c of source.cover) {
      const shift = point.level - c.patch.level;
      if (shift >= 0 && c.patch.face === point.face && c.patch.x === Math.floor(point.x / 2 ** shift) && c.patch.y === Math.floor(point.y / 2 ** shift) && (!best || c.patch.level > best.patch.level)) best = c;
    }
    if (best) return this.entries.get(`${source.index}:${cubeTileId(best.image)}`) ?? null;
    return this.entries.get(`${source.index}:${point.face}/0/0/0`)?.state === 'ready' ? this.entries.get(`${source.index}:${point.face}/0/0/0`)! : null;
  }

  /** Suppress only provably hidden work: original decoded alpha must be 255
   * over the entire patch (including gutters), upper opacity exactly one, and
   * declared bounds must contain it. Partial/unknown alpha never proves cover. */
  private coveredByUpperSource(address: ImageryAddress, source: Source): boolean {
    const cacheKey = `${source.index}:${cubeTileId(address)}`, cached = this.coverageCache.get(cacheKey);
    if (cached !== undefined) return cached;
    for (const upper of this.order.slice(this.order.indexOf(source) + 1)) {
      if (!upper.info.visible || upper.info.opacity !== 1 || !cubeBlockInsideBounds(address, upper.info.bounds)) continue;
      const complete = (a: ImageryAddress, candidates: ImageryCover[]): boolean => {
        const containing = candidates.find(c => containsAddress(c.patch, a));
        if (containing) return this.entries.get(`${upper.index}:${cubeTileId(containing.image)}`)?.opaque === true;
        const descendants = candidates.filter(c => containsAddress(a, c.patch));
        if (!descendants.length) return false;
        return Array.from({ length: 4 }, (_, i) => ({ face: a.face, level: a.level + 1, x: a.x * 2 + (i & 1), y: a.y * 2 + (i >> 1) })).every(c => complete(c, descendants));
      };
      if (complete(address, upper.cover)) { this.coverageCache.set(cacheKey, true); return true; }
    }
    this.coverageCache.set(cacheKey, false); return false;
  }

  /** Diagnostic read of the committed shader cover, not merely a ready cache tile. */
  sampleAt(direction: Vec3): Array<{ id: string; enabled: number; level: number; address: ImageryAddress | null; texture: THREE.Texture | null; opacity: number; coveredByOpaqueUpper: boolean }> {
    const point = directionToTexel(direction, 30, 1, 0).address;
    return this.order.map(source => {
      const e = this.displayedAt(source, point);
      return { id: source.info.id, enabled: source.info.visible && source.info.opacity > 0 && !!e && !!this.pages?.has(e.id) && cubeBlockOverlapsBounds(point, source.info.bounds) ? 1 : 0,
        level: e?.address.level ?? -1, address: e?.address ?? null, texture: e?.texture ?? null, opacity: source.info.opacity,
        coveredByOpaqueUpper: this.coveredByUpperSource(point, source) };
    });
  }

  get stats(): CubeImageryStats {
    let textures = 0, pinnedTextures = 0, textureBytes = 0, inFlight = 0, failedTiles = 0;
    for (const e of this.entries.values()) {
      if (e.state === 'ready') { textures++; textureBytes += e.bytes; if (e.pinned) pinnedTextures++; }
      else if (e.state === 'loading') inFlight++; else failedTiles++;
    }
    return { version: this.manifest?.source.version ?? null, ready: !!this.manifest, textures, pinnedTextures, textureBytes, inFlight, failedTiles,
      maxTextureBytes: this.options.maxTextureBytes, ...this.counters, ...this.last, blockGeometryBytes: 0,
      transitionTextureBytes: this.pages ? Math.round(this.pages.span ** 2 * 4 * 4 / 3) * 4 : 0,
      protectedOverBudgetBytes: this.pages ? Math.max(0, Math.round(this.pages.span ** 2 * 4 * 4 / 3) * (this.pages.capacity - 4) - this.options.maxTextureBytes) : 0,
      gpuAllocatedBytes: this.pages ? Math.round(this.pages.span ** 2 * 4 * 4 / 3) * this.pages.capacity + (this.pages.tableUniform.value.image.data?.byteLength ?? 0) : 0, uploadMs: this.pages?.uploadMs ?? 0, gpuError: this.gpuError, inheritedGlErrors: this.pages?.inheritedGlErrors ?? [] };
  }
  forEachResidentTexture(visit: (texture: THREE.Texture) => void): void {
    if (this.pages) { visit(this.pages.array); visit(this.pages.tableUniform.value); }
  }
  resetCounters(): void { this.counters = { requests: 0, bytes: 0, failures: 0, aborted: 0, evicted: 0, blockBuildMs: 0 }; }
  retryFailed(): void {
    for (const [id, e] of this.entries) if (e.state === 'failed') this.entries.delete(id);
    for (const e of this.entries.values()) e.uploadBlocked = false;
    this.uploadsPaused = false;
    this.retryManifests();
    if (this.gpuError) { this.gpuError = null; this.pageBudget = -1; }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.manifestAbort.abort();
    this.contextCanvas?.removeEventListener('webglcontextlost', this.contextLost);
    for (const e of this.entries.values()) { e.controller?.abort(); this.releaseTexture(e); }
    this.entries.clear(); this.tiles.clear(); this.pages?.dispose(); this.emptyPageTable.dispose(); this.emptyPages.dispose();
  }

  private coarseManifest: CubeImageryManifest | null = null;
  private coarseIds: string[] = [];
  private coarseWanted(): string[] {
    const manifest = this.sources[0]?.manifest ?? null;
    // The native inventory and residentLevel do not change during navigation.
    // Scanning every native tile here (including once per request) dominated
    // the MoonFall trace despite returning the same small resident set.
    if (manifest !== this.coarseManifest) {
      this.coarseManifest = manifest;
      this.coarseIds = manifest ? manifest.tiles.filter(id => Number(id.split('/')[1]) <= this.options.residentLevel)
        .map(id => `0:${id}`).sort((a, b) => Number(a.split('/')[1]) - Number(b.split('/')[1])) : [];
    }
    return this.coarseIds;
  }
  private availabilityFor(manifest: CubeImageryManifest): CubeImageryAvailability {
    const maxLevel = Math.max(manifest.minLevel, Math.min(manifest.maxLevel, this.options.maxLevel ?? Infinity));
    const inventory = manifest.tiles.filter(id => Number(id.split('/')[1]) <= maxLevel);
    return new CubeImageryAvailability(new ImageryRefinement(inventory).topology, manifest.minLevel, maxLevel);
  }
  private makeUniforms(address: ImageryAddress): Uniforms {
    const [n, u, v] = cubeFaceBasis(address.face), { u0, v0, size } = imageryTileRect(address);
    return {
      cubeImageryToBody: { value: new THREE.Matrix3().set(u[0] * size, v[0] * size, n[0] + u0*u[0] + v0*v[0], u[1] * size, v[1] * size, n[1] + u0*u[1] + v0*v[1], u[2] * size, v[2] * size, n[2] + u0*u[2] + v0*v[2]) },
      cubeGeometryAddress: { value: new Int32Array([address.level, address.x, address.y]) },
      layers: this.sources.map(() => ({ root: { value: -1 }, fallback: { value: new Int32Array([-1, 0, 0, 0]) }, enabled: { value: 0 }, srgb: { value: 1 }, opacity: { value: 1 }, bounded: { value: 0 }, bounds: { value: new THREE.Vector4(-180, -90, 180, 90) } })),
      cubeImageryDebug: this.shared.debug, cubePages: { value: this.pages?.array ?? this.emptyPages }, cubePageTable: { value: this.pages?.tableUniform.value ?? this.emptyPageTable }, cubePagePixels: { value: new THREE.Vector2() },
    };
  }
  private attachImagery(material: THREE.Material, baseCompile: THREE.Material['onBeforeCompile'], cacheKey: () => string, uniforms: Uniforms): Uniforms {
    const previous = this.materialBindings.get(material);
    if (previous) {
      previous.cubeImageryToBody.value.copy(uniforms.cubeImageryToBody.value);
      previous.cubeGeometryAddress.value.set(uniforms.cubeGeometryAddress.value);
      return previous;
    }
    this.materialBindings.set(material, uniforms);
    material.onBeforeCompile = (shader, renderer) => { baseCompile.call(material, shader, renderer); injectImagery(shader, uniforms); };
    material.customProgramCacheKey = cacheKey; material.needsUpdate = true;
    return uniforms;
  }
  private schedule(groups: string[][], protectedIds: Set<string>): { count: number; budgetLimited: boolean } {
    groups = [...new Map(groups.map(g => [[...g].sort().join(';'), [...new Set(g)]])).values()];
    const wanted = new Set(groups.flat());
    if (this.uploadsPaused) return { count: [...wanted].filter(id => !this.entries.has(id)).length, budgetLimited: true };
    this.cacheReferences.clear();
    for (const id of [...wanted, ...protectedIds]) this.cacheReferences.add(id);
    for (const id of this.reserved) if (!wanted.has(id) || this.entries.has(id)) this.reserved.delete(id);
    for (const e of this.entries.values()) {
      if (wanted.has(e.id)) e.lastWanted = this.frame;
      if (e.state === 'loading' && !e.pinned && !wanted.has(e.id) && this.frame - e.lastWanted > 30) {
        e.controller?.abort(); this.entries.delete(e.id); this.counters.aborted++;
      }
    }
    const estimate = this.manifest ? Math.round((this.manifest.tileSize + 2 * this.manifest.gutter) ** 2 * 4 * 4 / 3) : 0;
    let loading = [...this.entries.values()].filter(e => e.state === 'loading').length;
    const capacity = this.pages?.capacity ?? Math.max(this.coarseWanted().length + 4, Math.floor(this.options.maxTextureBytes / estimate) + 4);
    let budgetLimited = false;
    for (const group of groups) {
      const missing = group.filter(id => !this.entries.has(id) || (this.entries.get(id)?.state === 'failed' && this.retryDue(this.entries.get(id)!)));
      if (!missing.length) continue;
      // A failed sibling preserves its parent; don't repeatedly download the
      // remaining siblings of that failed replacement on every frame.
      if (group.some(id => this.entries.get(id)?.state === 'failed' && !this.retryDue(this.entries.get(id)!))) continue;
      const count = () => new Set([...this.entries.values()].filter(e => e.state !== 'failed' && !e.transparent).map(e => e.id).concat([...this.reserved])).size;
      const additional = missing.filter(id => !this.reserved.has(id)).length;
      if (count() + additional > capacity) {
        const candidates = [...this.entries.values()].filter(e => e.state === 'ready' && !e.pinned && !protectedIds.has(e.id) && !wanted.has(e.id)).sort((a,b) => a.lastUsed-b.lastUsed);
        for (const e of candidates) {
          if (count() + additional <= capacity) break;
          this.releaseTexture(e); this.entries.delete(e.id); this.counters.evicted++;
        }
      }
      if (count() + additional > capacity) { budgetLimited = true; continue; }
      for (const id of missing) this.reserved.add(id);
      for (const id of missing) {
        if (loading >= this.options.maxConcurrentRequests) break;
        this.reserved.delete(id); this.request(id, this.coarseWanted().includes(id)); loading++;
      }
    }
    return { count: [...wanted].filter(id => !this.entries.has(id)).length, budgetLimited };
  }
  private retryDue(e: Entry): boolean { return e.failures < 4 && performance.now() - e.failedAt > this.options.retryFailedMs * 2 ** (Math.min(e.failures, 5) - 1); }
  private request(id: string, pinned: boolean): void {
    const [sourceId, tileId] = id.split(':'), source = this.sources[Number(sourceId)];
    if (!source.manifest) return;
    const address = parseImageryAddress(tileId), controller = new AbortController();
    const entry: Entry = { source, id, address, state: 'loading', texture: null, transparent: false, opaque: false, uploadBlocked: false, bytes: 0, lastUsed: 0, lastWanted: this.frame, pinned, controller, failedAt: 0, failures: this.entries.get(id)?.failures ?? 0 };
    this.entries.set(id, entry); this.counters.requests++; source.info.requests++;
    const url = new URL(imageryTileUri(source.manifest.uri, address), source.baseUrl).href;
    this.loadTexture(url, controller.signal).then(({ texture, bytes, downloadBytes }) => {
      if (this.disposed || this.entries.get(id) !== entry) { texture.dispose(); (texture.image as ImageBitmap | null)?.close?.(); return; }
      const span = source.manifest!.tileSize + 2 * source.manifest!.gutter;
      if (bytes > Math.round(span * span * 4 * 4 / 3)) {
        texture.dispose(); (texture.image as ImageBitmap | null)?.close?.(); throw new Error('Cube imagery texture exceeds its manifest reservation');
      }
      const alpha = imageAlphaClass(texture); entry.transparent = alpha === 'transparent'; entry.opaque = alpha === 'opaque';
      if (entry.transparent) {
        texture.dispose(); (texture.image as ImageBitmap | null)?.close?.();
        entry.texture = new THREE.DataTexture(new Uint8Array(4), 1, 1);
      } else entry.texture = texture;
      entry.state = 'ready'; entry.bytes = entry.transparent ? 0 : bytes; entry.controller = null;
      this.counters.bytes += downloadBytes;
    }).catch((error: unknown) => {
      if (this.entries.get(id) !== entry) return;
      if ((error as { name?: string })?.name === 'AbortError') { this.entries.delete(id); return; }
      entry.state = 'failed'; entry.failedAt = performance.now(); entry.failures++; entry.controller = null;
      this.counters.failures++; source.info.failedTiles++;
    });
  }
  private releaseTexture(e: Entry): void {
    this.pages?.forget(e.id);
    e.texture?.dispose(); (e.texture?.image as ImageBitmap | null)?.close?.(); e.texture = null;
  }
}
