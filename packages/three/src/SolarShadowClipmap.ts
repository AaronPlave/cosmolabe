import * as THREE from 'three';
import { bodyFixedToGeodetic, geodeticToBodyFixed, type TerrainDatum } from './TerrainSampler.js';
import { sunDirectionAt } from './SurfaceIllumination.js';

/**
 * Terrain-cast solar shadows for physical surfaces (#205): a height clipmap
 * filled from **source terrain** (not from drawn tiles) and a per-fragment
 * horizon march against it. Design and evidence: docs/terrain-solar-visibility.md.
 * `TerrainSunVisibility.ts` is the CPU ground truth this shader is measured against.
 *
 * Frame. One fixed *anchor* frame (east, north, up at a surface point, body
 * fixed) holds every level. Texels are **gnomonic**: the texel at tangent offset
 * (e, n) stores the terrain's geocentric radius, minus the anchor radius `Rc`, along the
 * direction through the tangent plane point (e, n). That makes the sphere exact at
 * any range: a ray point is looked up by projecting its radial direction, so no
 * flat-ground approximation and no curvature term to get wrong.
 *
 * Levels. Nested squares, each re-centred independently in whole texels with
 * hysteresis. Texel validity is a second channel: missing source terrain is
 * `unknown`, never lit or shadowed.
 *
 * Horizons. A GPU pass marches from every texel centre toward the Sun through each level at its own resolution and
 * stores the result (a *horizon map*); terrain fragments read it filtered. See `solarShadowGlsl`.
 */

/** Terrain heights the clipmap is filled from. */
export interface ClipmapSource {
  datum: TerrainDatum;
  /**
   * Elevation above the datum, km, from resident source terrain, for a texel `texelKm` wide; null where there is none
   * (and the source should start loading it). The source must answer at **one consistent resolution** across calls with
   * the same `texelKm`: a mosaic of tiles of different LOD has steps at its seams, and at a low Sun a step of tens of
   * metres is a wall that casts a shadow hundreds of metres long.
   */
  elevationKm(latDeg: number, lonDeg: number, texelKm: number): number | null;
  /**
   * The finest sample spacing, km, the source has there (omit when not known). Where it is coarser than
   * `MAX_SOURCE_CELL_KM` the terrain is not used for shadows: see that constant.
   */
  cellKm?(latDeg: number, lonDeg: number): number;
  /** Changes whenever resident data may have changed. */
  readonly revision: number;
}

export interface ClipmapLevelConfig {
  /** Half-width of the level's square, km. */
  halfKm: number;
  /** Texels per side. */
  size: number;
}

export interface SolarShadowConfig {
  /** Finest to coarsest, at most four. Default: 8 km @ 62 m, 24 km @ 0.19 km, 80 km @ 0.62 km, 320 km @ 2.5 km. */
  levels?: ClipmapLevelConfig[];
  /** CPU time per frame spent filling a level, ms. Default 3. */
  budgetMs?: number;
  /** Self-shadow tolerance, km: terrain must stand this far above the Sun ray to shade. Default 0.002. */
  biasKm?: number;
  /** March quality preset. Default `high`. */
  quality?: SolarShadowQuality;
  /** Camera altitude above which the effect is off, km. Default: the outer level's half-width. */
  maxAltitudeKm?: number;
  /**
   * Terrain height, km above the reference sphere, that terrain *not in the clipmap* may reach. While a level has
   * unknown texels a ray is not called clear until it rises above this. Default 10 (lunar/Martian global relief).
   */
  unknownReliefKm?: number;
}

export const DEFAULT_CLIPMAP_LEVELS: readonly ClipmapLevelConfig[] = [
  { halfKm: 8, size: 256 }, { halfKm: 24, size: 256 }, { halfKm: 80, size: 256 }, { halfKm: 320, size: 256 },
];
/** Horizon-pass loop bound (the `high` preset's step count); see `solarShadowGlsl`. */
export const SOLAR_SHADOW_MAX_STEPS = 720;
/**
 * Horizon-pass quality: a step is `stepTexels` texels of the level it is in (never more than one, so the march reads
 * every texel of the data it crosses), and a ray stops after `maxSteps` (with one-texel steps, 420 still reach the
 * outer level's edge). The pass runs per clipmap texel when the data or the Sun moved, not per pixel, so this sets that
 * background pass's GPU time, not the frame's.
 */
export const SOLAR_SHADOW_QUALITY = {
  high: { stepTexels: 0.75, maxSteps: 720 },
  medium: { stepTexels: 1, maxSteps: 540 },
  low: { stepTexels: 1, maxSteps: 420 },
} as const;
export type SolarShadowQuality = keyof typeof SOLAR_SHADOW_QUALITY;
const REBUILD_FRACTION = 0.25;
/** Gnomonic texels stretch by 1/cos² away from the anchor: 3 % at 10°. A reset discards every level, so it must be rare. */
const ANCHOR_RESET_DEG = 10;
const REVISION_REBUILD_MS = 2000;
/**
 * Coarsest height data that casts shadows, km. A shadow is a projection of the terrain's shape: from heights kilometres
 * apart it is a projection of their triangles, polygons that the imagery and normals drawn over that terrain do not have
 * (the demo Moon product is 6.8 km apart outside its polar and regional detail). Such terrain neither casts nor
 * receives terrain shadows: it is drawn lit and shaded by slope, and debug view 2 marks it as it marks missing data.
 * 1 km keeps the demo product's south-polar detail to 0.85 km (within about 150 km of Shackleton; farther terrain is
 * too low over the curve to shade the polar sites at the Sun's polar elevations) and drops its 1.7 km and coarser tiles,
 * whose shadows are visibly faceted from a few tens of km. Facets up to the source spacing remain within that limit.
 */
export const MAX_SOURCE_CELL_KM = 1;
const SUN_RADIUS_KM = 695_700;
/** Horizon maps re-rendered per frame while the Sun moves (one level costs about 1–3 ms on an M4 Max). */
const HORIZON_LEVELS_PER_FRAME = 2;
/** A Sun this far from a level's map (a seek, not playback) re-renders every level that frame. */
const HORIZON_SEEK_RAD = 1 * Math.PI / 180;
const DEG = Math.PI / 180;

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export interface TangentFrame { up: V3; east: V3; north: V3 }

/** East/north/up (body fixed, Z the pole) at a unit direction. Defined at the poles too. */
export function tangentFrame(up: V3): TangentFrame {
  const lon = Math.atan2(up[1], up[0]);
  const east: V3 = [-Math.sin(lon), Math.cos(lon), 0];
  return { up, east, north: cross(up, east) };
}

/** Body-fixed unit direction through the tangent-plane point (eKm, nKm) at radius `rcKm`. */
export function gnomonicDirection(f: TangentFrame, eKm: number, nKm: number, rcKm: number): V3 {
  const v: V3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) v[i] = f.east[i] * eKm + f.north[i] * nKm + f.up[i] * rcKm;
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** The tangent-plane coordinates of a body-fixed direction (inverse of `gnomonicDirection`); null at/over 90°. */
export function gnomonicCoordinates(f: TangentFrame, dir: V3, rcKm: number): [number, number] | null {
  const u = dot(dir, f.up);
  return u > 1e-6 ? [dot(dir, f.east) * rcKm / u, dot(dir, f.north) * rcKm / u] : null;
}

export interface SolarShadowUniforms {
  /** Not a uniform: the shader variant. True when float textures filter in hardware (one fetch instead of four). */
  hardwareLinear: boolean;
  enabled: { value: number };
  debug: { value: number };
  stepTexels: { value: number };
  maxSteps: { value: number };
  viewToTan: { value: THREE.Matrix3 };
  originView: { value: THREE.Vector3 };
  sun: { value: THREE.Vector3 };
  sunRad: { value: number };
  rc: { value: number };
  hMax: { value: number };
  maxRange: { value: number };
  bias: { value: number };
  half: { value: THREE.Vector4 };
  texel: { value: THREE.Vector4 };
  valid: { value: THREE.Vector4 };
  off0: { value: THREE.Vector2 }; off1: { value: THREE.Vector2 }; off2: { value: THREE.Vector2 }; off3: { value: THREE.Vector2 };
  tex0: { value: THREE.Texture }; tex1: { value: THREE.Texture }; tex2: { value: THREE.Texture }; tex3: { value: THREE.Texture };
  /** Horizon maps (R: terrain angle above the Sun ray, G: unknown), one per level, written by `renderHorizons`. */
  hz0: { value: THREE.Texture }; hz1: { value: THREE.Texture }; hz2: { value: THREE.Texture }; hz3: { value: THREE.Texture };
}

export type SolarShadowState = 'off' | 'out-of-range' | 'building' | 'ready' | 'partial';
export type SolarShadowBuildReason = 'initial' | 'recenter' | 'new-data';
export interface SolarShadowLevelStatus {
  halfKm: number; texelKm: number; valid: boolean;
  /** Level centre in anchor tangent coordinates, km. */
  offsetKm: [number, number] | null;
  /** Why the level was last (re)built, and how many texels that build had to sample (the rest were kept). */
  lastReason: SolarShadowBuildReason | null;
  lastSampledTexels: number;
  /** Fraction of texels with no source terrain. */
  unknownFraction: number;
  /** Fraction of texels whose source terrain is too coarse to cast shadows (`MAX_SOURCE_CELL_KM`). */
  coarseFraction: number;
  builds: number;
  /** CPU time of the last completed build (sum over its frames), ms. */
  lastBuildMs: number;
  /** Angle between the Sun its horizon map was rendered for and the current Sun, degrees; null before the first render. */
  horizonSunLagDeg: number | null;
}
export interface SolarShadowStatus {
  state: SolarShadowState;
  levels: SolarShadowLevelStatus[];
  /** Times the anchor frame was replaced (every level then starts over). */
  anchorResets: number;
  /** Level horizon maps re-rendered so far (data, placement, quality or Sun changed). */
  horizonRenders: number;
  /** Farthest terrain the shadow can see, km: the outer level's half-width. */
  rangeKm: number;
  /** Fragments the shader cannot answer (outside every level, unknown texels) are drawn lit and labelled by debug mode 2. */
  unknownDrawnLit: true;
}

interface Level {
  cfg: ClipmapLevelConfig;
  texelKm: number;
  texture: THREE.DataTexture;
  /** Centre in anchor tangent coordinates (km) of the data in `texture`, or null when none. */
  offset: [number, number] | null;
  back: Float32Array;
  /** Base level of the texture's data (RG), or null before the first build. */
  data: Float32Array | null;
  building: {
    offset: [number, number]; row: number; unknown: number; coarse: number; known: number; sum: number; ms: number;
    reason: SolarShadowBuildReason; kept: Uint8Array; sampled: number;
  } | null;
  lastReason: SolarShadowBuildReason | null;
  lastSampledTexels: number;
  builtRevision: number;
  builtAtMs: number;
  unknownFraction: number;
  coarseFraction: number;
  hMax: number;
  builds: number;
  lastBuildMs: number;
}

export interface SolarShadowFrame {
  camera: THREE.Camera;
  bodyPosition: THREE.Vector3;
  /** Body-fixed (Z north) to scene axes. */
  bodyToScene: THREE.Quaternion;
  sunPosition: THREE.Vector3;
  /** Scene units per km. */
  scaleFactor: number;
  /** Scene point the surface views are centred on (e.g. the orbit target); defaults to the camera. */
  focus?: THREE.Vector3;
}

const _inv = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

export class SolarShadowClipmap {
  readonly uniforms: SolarShadowUniforms;
  private readonly levels: Level[];
  private readonly budgetMs: number;
  private readonly maxAltitudeKm: number;
  private readonly unknownReliefKm: number;
  private anchor: { frame: TangentFrame; rcKm: number } | null = null;
  private state: SolarShadowState = 'off';
  private anchorResets = 0;
  /** Bumped whenever what the horizon maps depend on changes, other than the Sun. */
  private dataVersion = 0;
  private horizon: {
    targets: THREE.WebGLRenderTarget[]; scene: THREE.Scene; camera: THREE.Camera; material: THREE.ShaderMaterial;
    /** Per level, what its map was rendered from: its own data/placement, everything else's, and the Sun. */
    at: { own: string; version: number; sun: THREE.Vector3; seq: number }[];
    renders: number;
  } | null = null;

  constructor(
    private readonly source: ClipmapSource,
    config: SolarShadowConfig = {},
    /** The device filters float textures (`OES_texture_float_linear`): bilinear taps cost one fetch, not four. */
    private readonly hardwareLinear = false,
  ) {
    const cfgs = (config.levels?.length ? config.levels : DEFAULT_CLIPMAP_LEVELS).slice(0, 4);
    for (const l of cfgs) {
      if (!(l.halfKm > 0) || !Number.isInteger(l.size) || l.size < 4 || (l.size & (l.size - 1)) !== 0) {
        throw new Error('Solar shadow clipmap levels need halfKm > 0 and a power-of-two size >= 4.');
      }
    }
    this.budgetMs = config.budgetMs ?? 3;
    this.unknownReliefKm = config.unknownReliefKm ?? 10;
    this._quality = config.quality ?? 'high';
    this.maxAltitudeKm = config.maxAltitudeKm ?? cfgs[cfgs.length - 1].halfKm;
    this.levels = cfgs.map(cfg => this.makeLevel(cfg));
    const dummy = () => placeholder();
    const U = this.levels;
    this.uniforms = {
      hardwareLinear: this.hardwareLinear,
      enabled: { value: 0 }, debug: { value: 0 }, ...qualityUniforms(config.quality ?? 'high'),
      viewToTan: { value: new THREE.Matrix3() }, originView: { value: new THREE.Vector3() },
      sun: { value: new THREE.Vector3(0, 0, 1) }, sunRad: { value: 0.00465 }, rc: { value: 1 },
      hMax: { value: 0 }, maxRange: { value: cfgs[cfgs.length - 1].halfKm * 2 },
      bias: { value: config.biasKm ?? 0.002 },
      half: { value: new THREE.Vector4(U[0]?.cfg.halfKm ?? 0, U[1]?.cfg.halfKm ?? 0, U[2]?.cfg.halfKm ?? 0, U[3]?.cfg.halfKm ?? 0) },
      texel: { value: new THREE.Vector4(U[0]?.texelKm ?? 1, U[1]?.texelKm ?? 1, U[2]?.texelKm ?? 1, U[3]?.texelKm ?? 1) },
      valid: { value: new THREE.Vector4() },
      off0: { value: new THREE.Vector2() }, off1: { value: new THREE.Vector2() }, off2: { value: new THREE.Vector2() }, off3: { value: new THREE.Vector2() },
      tex0: { value: U[0]?.texture ?? dummy() }, tex1: { value: U[1]?.texture ?? dummy() }, tex2: { value: U[2]?.texture ?? dummy() }, tex3: { value: U[3]?.texture ?? dummy() },
      hz0: { value: dummy() }, hz1: { value: dummy() }, hz2: { value: dummy() }, hz3: { value: dummy() },
    };
  }

  private makeLevel(cfg: ClipmapLevelConfig): Level {
    const texture = placeholder();
    return {
      cfg, texelKm: (2 * cfg.halfKm) / cfg.size, texture, offset: null,
      back: new Float32Array(cfg.size * cfg.size * 2), data: null, building: null, lastReason: null, lastSampledTexels: 0,
      builtRevision: -1, builtAtMs: -Infinity, unknownFraction: 1, coarseFraction: 0, hMax: 0, builds: 0, lastBuildMs: 0,
    };
  }

  private _quality: SolarShadowQuality = 'high';
  get quality(): SolarShadowQuality { return this._quality; }
  /** Change the march quality preset at run time (a uniform write: no recompile). */
  setQuality(q: SolarShadowQuality): void {
    this._quality = q;
    const u = qualityUniforms(q);
    this.uniforms.stepTexels.value = u.stepTexels.value; this.uniforms.maxSteps.value = u.maxSteps.value;
    this.dataVersion++;
  }
  /** Debug view: see `SolarShadowDebugMode`. */
  setDebug(mode: SolarShadowDebugMode): void { this.uniforms.debug.value = mode; }
  /** Visual shadows are disabled by a caller (catalog off, `flood` mode). */
  setActive(active: boolean): void { this.active = active; if (!active) this.uniforms.enabled.value = 0; }
  private active = true;
  private sceneToBody: { origin: THREE.Vector3; q: THREE.Quaternion; scale: number } | null = null;

  /** One frame: choose anchor and level centres, spend the build budget, refresh uniforms. */
  update(frame: SolarShadowFrame, nowMs = performance.now()): void {
    if (!this.active) { this.state = 'off'; this.uniforms.enabled.value = 0; return; }
    const scale = frame.scaleFactor;
    // Body-fixed km position of the camera and focus.
    _q.copy(frame.bodyToScene).invert();
    const toBody = (p: THREE.Vector3): V3 => {
      _v.copy(p).sub(frame.bodyPosition).multiplyScalar(1 / scale).applyQuaternion(_q);
      return [_v.x, _v.y, _v.z];
    };
    this.sceneToBody = { origin: frame.bodyPosition.clone(), q: _q.clone(), scale };
    const cam = toBody(frame.camera.position);
    const camR = Math.hypot(...cam);
    const shape = this.source.datum.referenceShape;
    const surfaceR = shape.kind === 'sphere' ? shape.radiusKm : shape.radiiKm[0];
    if (!(camR > 0) || camR - surfaceR > this.maxAltitudeKm) { this.state = 'out-of-range'; this.uniforms.enabled.value = 0; return; }
    const focus = frame.focus ? toBody(frame.focus) : cam;
    const focusR = Math.hypot(...focus);
    if (!(focusR > 0)) { this.state = 'out-of-range'; this.uniforms.enabled.value = 0; return; }
    const focusDir: V3 = [focus[0] / focusR, focus[1] / focusR, focus[2] / focusR];

    if (!this.anchor || Math.acos(Math.min(1, dot(this.anchor.frame.up, focusDir))) > ANCHOR_RESET_DEG * DEG) this.resetAnchor(focusDir);
    const { frame: tf, rcKm } = this.anchor!;
    const g = gnomonicCoordinates(tf, focusDir, rcKm);
    if (!g) { this.state = 'out-of-range'; this.uniforms.enabled.value = 0; return; }

    this.schedule(g, nowMs);
    this.fill(nowMs);
    this.refreshUniforms(frame, tf, rcKm);
  }

  private resetAnchor(dir: V3): void {
    const frame = tangentFrame(dir);
    const lat = bodyFixedToGeodetic({ xKm: dir[0], yKm: dir[1], zKm: dir[2] }, this.source.datum);
    const p = geodeticToBodyFixed({ latDeg: lat.latDeg, lonDeg: lat.lonDeg, heightKm: 0 }, this.source.datum);
    this.anchor = { frame, rcKm: Math.hypot(p.xKm, p.yKm, p.zKm) };
    this.anchorResets++;
    this.dataVersion++;
    for (const l of this.levels) { l.offset = null; l.data = null; l.building = null; l.builtRevision = -1; l.hMax = 0; l.unknownFraction = 1; }
    this.uniforms.valid.value.set(0, 0, 0, 0);
  }

  /** Mark a level for rebuild when the focus left its hysteresis box or newly resident data may matter. */
  private schedule(focusG: [number, number], nowMs: number): void {
    const rev = this.source.revision;
    for (const l of this.levels) {
      if (l.building) continue;
      const snap = (v: number) => Math.round(v / l.texelKm) * l.texelKm;
      const want: [number, number] = [snap(focusG[0]), snap(focusG[1])];
      const off = l.offset;
      const moved = !off || Math.max(Math.abs(focusG[0] - off[0]), Math.abs(focusG[1] - off[1])) > REBUILD_FRACTION * l.cfg.halfKm;
      const stale = !moved && rev !== l.builtRevision && l.unknownFraction > 0 && nowMs - l.builtAtMs > REVISION_REBUILD_MS;
      if (moved || stale) {
        const offset = moved ? want : off!;
        l.building = {
          offset, row: 0, unknown: 0, coarse: 0, known: 0, sum: 0, ms: 0, sampled: 0,
          reason: !off ? 'initial' : moved ? 'recenter' : 'new-data', kept: this.keep(l, offset),
        };
        l.builtRevision = rev;
        // Stop at the first level started this frame: one build at a time keeps the CPU budget honest.
        break;
      }
    }
  }

  /**
   * Copy the known texels the new square shares with the current one into the build buffer. Centres move in whole
   * texels of one anchor frame, so they are the same terrain samples: a re-centre only samples the newly exposed strip,
   * and new resident data only the texels that were unknown. Returns the per-texel "kept" mask.
   */
  private keep(l: Level, offset: [number, number]): Uint8Array {
    const n = l.cfg.size, kept = new Uint8Array(n * n);
    if (!l.data || !l.offset) return kept;
    const dx = Math.round((offset[0] - l.offset[0]) / l.texelKm), dy = Math.round((offset[1] - l.offset[1]) / l.texelKm);
    for (let y = 0; y < n; y++) {
      const sy = y + dy;
      if (sy < 0 || sy >= n) continue;
      for (let x = 0; x < n; x++) {
        const sx = x + dx;
        if (sx < 0 || sx >= n) continue;
        const si = (sy * n + sx) * 2, i = (y * n + x) * 2;
        if (l.data[si + 1] > 0.5) { l.back[i] = l.data[si]; l.back[i + 1] = 1; kept[y * n + x] = 1; }
      }
    }
    return kept;
  }

  /** Fill the level being built, row by row, within the frame budget. Swaps it in when complete. */
  private fill(nowMs: number): void {
    const l = this.levels.find(x => x.building);
    if (!l || !l.building || !this.anchor) { this.finishState(); return; }
    const { frame, rcKm } = this.anchor;
    const b = l.building, n = l.cfg.size, datum = this.source.datum;
    const start = performance.now();
    let rows = 0;
    // At least one row per frame, so a zero budget still makes progress.
    while (b.row < n && (rows === 0 || performance.now() - start < this.budgetMs)) {
      rows++;
      const y = b.row++;
      const nn = b.offset[1] + (y + 0.5 - n / 2) * l.texelKm;
      for (let x = 0; x < n; x++) {
        if (b.kept[y * n + x]) { b.known++; b.sum += l.back[(y * n + x) * 2]; continue; }
        b.sampled++;
        const e = b.offset[0] + (x + 0.5 - n / 2) * l.texelKm;
        const d = gnomonicDirection(frame, e, nn, rcKm);
        const pos = bodyFixedToGeodetic({ xKm: d[0] * rcKm, yKm: d[1] * rcKm, zKm: d[2] * rcKm }, datum);
        const i = (y * n + x) * 2;
        // Validity -1: too coarse. Like unknown, it fails every "has data" test, but it is final, not waiting for data.
        if ((this.source.cellKm?.(pos.latDeg, pos.lonDeg) ?? 0) > MAX_SOURCE_CELL_KM) { l.back[i + 1] = -1; b.coarse++; continue; }
        const elev = this.source.elevationKm(pos.latDeg, pos.lonDeg, l.texelKm);
        if (elev === null || !Number.isFinite(elev)) { l.back[i] = NaN; l.back[i + 1] = 0; b.unknown++; continue; }
        const p = geodeticToBodyFixed({ latDeg: pos.latDeg, lonDeg: pos.lonDeg, heightKm: elev }, datum);
        const h = Math.hypot(p.xKm, p.yKm, p.zKm) - rcKm;
        l.back[i] = h; l.back[i + 1] = 1; b.known++; b.sum += h;
      }
    }
    b.ms += performance.now() - start;
    if (b.row < n) { this.finishState(); return; }
    // Complete: unknown and too-coarse texels take the mean (a finite fill), then swap in.
    const fillValue = b.known ? b.sum / b.known : 0;
    let hMax = -Infinity;
    for (let i = 0; i < l.back.length; i += 2) {
      if (l.back[i + 1] !== 1) l.back[i] = fillValue; else hMax = Math.max(hMax, l.back[i]);
    }
    // A fresh array each build: the texture keeps the one it was given, and `back` is the next build's scratch.
    const base = l.back.slice();
    const tex = makeTexture(base, n, this.hardwareLinear);
    l.texture.dispose();
    l.texture = tex;
    l.data = base;
    l.lastReason = b.reason;
    this.dataVersion++;
    l.lastSampledTexels = b.sampled;
    l.offset = b.offset;
    l.unknownFraction = b.unknown / (n * n);
    l.coarseFraction = b.coarse / (n * n);
    l.hMax = hMax === -Infinity ? 0 : hMax;
    l.builtAtMs = nowMs;
    l.builds++;
    l.lastBuildMs = b.ms;
    l.building = null;
    this.finishState();
  }

  /** `building` only until every level has data: a level being re-centred keeps drawing its current data meanwhile. */
  private finishState(): void {
    this.state = this.levels.some(l => !l.offset) ? 'building'
      : this.levels.some(l => l.unknownFraction > 0) ? 'partial' : 'ready';
  }

  private refreshUniforms(frame: SolarShadowFrame, tf: TangentFrame, rcKm: number): void {
    const u = this.uniforms, L = this.levels;
    u.rc.value = rcKm;
    const offs = [u.off0.value, u.off1.value, u.off2.value, u.off3.value];
    const valid = [0, 0, 0, 0];
    let hMax = 0;
    const tex = [u.tex0, u.tex1, u.tex2, u.tex3];
    for (let i = 0; i < L.length; i++) {
      tex[i].value = L[i].texture;
      if (L[i].offset) { offs[i].set(L[i].offset![0], L[i].offset![1]); valid[i] = 1; hMax = Math.max(hMax, L[i].hMax); }
    }
    u.valid.value.set(valid[0], valid[1], valid[2], valid[3]);
    // Missing terrain could be as tall as `unknownReliefKm`: a ray is not clear until it clears that too.
    const anyUnknown = L.some(l => l.offset === null || l.unknownFraction > 0);
    u.hMax.value = Math.max(hMax, anyUnknown ? this.unknownReliefKm : -Infinity) + u.bias.value;
    u.enabled.value = valid.some(v => v > 0) ? 1 : 0;

    // Anchor surface point and basis in the camera's view space, scaled to km.
    const scale = frame.scaleFactor;
    const camQ = new THREE.Quaternion().setFromRotationMatrix(frame.camera.matrixWorld);
    const toView = camQ.clone().invert();
    const basisView = (v: V3) => new THREE.Vector3(v[0], v[1], v[2]).applyQuaternion(frame.bodyToScene).applyQuaternion(toView).multiplyScalar(1 / scale);
    const e = basisView(tf.east), n = basisView(tf.north), up = basisView(tf.up);
    u.viewToTan.value.set(e.x, e.y, e.z, n.x, n.y, n.z, up.x, up.y, up.z);
    const originWorld = new THREE.Vector3(tf.up[0], tf.up[1], tf.up[2]).multiplyScalar(rcKm * scale).applyQuaternion(frame.bodyToScene).add(frame.bodyPosition);
    u.originView.value.copy(originWorld).applyMatrix4(_inv.copy(frame.camera.matrixWorld).invert());

    // Sun at the anchor, in tangent axes.
    const dir = sunDirectionAt(originWorld, frame.sunPosition);
    if (dir) {
      const inv = frame.bodyToScene.clone().invert();
      const s = dir.clone().applyQuaternion(inv);
      u.sun.value.set(s.dot(new THREE.Vector3(...tf.east)), s.dot(new THREE.Vector3(...tf.north)), s.dot(new THREE.Vector3(...tf.up)));
      const distKm = originWorld.distanceTo(frame.sunPosition) / scale;
      u.sunRad.value = Math.asin(Math.min(1, SUN_RADIUS_KM / distKm));
    } else u.enabled.value = 0;
  }

  /**
   * After `update`, each frame: re-render stale horizon maps. A level whose own data or placement changed is re-rendered
   * this frame (its map must match its texels). Others are stale when the Sun has moved by more than 1/16 of its radius
   * since their map (a shadow edge 30 km from its ridge moves 9 m) or another level's data changed; up to
   * `HORIZON_LEVELS_PER_FRAME` of them are re-rendered per frame, the Sun-stalest first, so during fast playback every
   * level lags the Sun by at most two frames and none starves. After a seek every level is re-rendered at once. Cost: one
   * march per texel of the level (256² by default), independent of screen resolution; nothing while the Sun and the
   * data hold still.
   */
  renderHorizons(renderer: THREE.WebGLRenderer): void {
    if (this.uniforms.enabled.value < 0.5) return;
    if (!this.horizon) {
      const targets = this.levels.map(l => {
        const rt = new THREE.WebGLRenderTarget(l.cfg.size, l.cfg.size, {
          type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
          minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
        });
        return rt;
      });
      const material = new THREE.ShaderMaterial({
        uniforms: { ...shaderUniforms(this.uniforms), uSsLevel: { value: 0 } },
        vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: (this.hardwareLinear ? '#define SS_HW_LINEAR\n' : '') + solarShadowGlsl + horizonPassFragment,
        depthTest: false, depthWrite: false,
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
      const mesh = new THREE.Mesh(geo, material);
      mesh.frustumCulled = false;
      const scene = new THREE.Scene();
      scene.add(mesh);
      this.horizon = { targets, scene, camera: new THREE.Camera(), material, renders: 0,
        at: targets.map(() => ({ own: '', version: -1, sun: new THREE.Vector3(), seq: -1 })) };
      const hz = [this.uniforms.hz0, this.uniforms.hz1, this.uniforms.hz2, this.uniforms.hz3];
      targets.forEach((t, i) => { hz[i].value.dispose(); hz[i].value = t.texture; });
    }
    const h = this.horizon;
    const sun = this.uniforms.sun.value, minAngle = this.uniforms.sunRad.value / 16;
    const own = (i: number) => `${this.anchorResets}:${this.levels[i].builds}`;
    const has = (i: number) => this.levels[i].offset !== null;
    const lag = (i: number) => h.at[i].sun.angleTo(sun);
    // A level whose own data or placement changed: this frame, whatever else is due.
    const due = this.levels.map((_, i) => has(i) && h.at[i].own !== own(i));
    // A seek (or the first frame): every level, this frame.
    const jumped = this.levels.some((_, i) => has(i) && lag(i) > HORIZON_SEEK_RAD);
    // Otherwise the most out-of-date, up to the per-frame budget: the Sun moved most since its map first, then those
    // that only read another level's changed data, least recently rendered first. None starves: a rendered level goes
    // to the back of the queue, so under fast playback each level re-renders every other frame.
    const sunLag = (i: number) => (lag(i) >= minAngle ? lag(i) : 0);
    const stale = this.levels.map((_, i) => i)
      .filter(i => has(i) && !due[i] && (jumped || sunLag(i) > 0 || h.at[i].version !== this.dataVersion))
      .sort((a, b) => sunLag(b) - sunLag(a) || h.at[a].seq - h.at[b].seq);
    const budget = jumped ? stale.length : Math.max(1, HORIZON_LEVELS_PER_FRAME - due.filter(Boolean).length);
    for (const i of stale.slice(0, budget)) due[i] = true;
    if (!due.some(Boolean)) return;
    const prev = renderer.getRenderTarget();
    due.forEach((d, i) => {
      if (!d) return;
      h.material.uniforms.uSsLevel.value = i;
      renderer.setRenderTarget(h.targets[i]);
      renderer.render(h.scene, h.camera);
      h.at[i] = { own: own(i), version: this.dataVersion, sun: sun.clone(), seq: h.renders };
      h.renders++;
    });
    renderer.setRenderTarget(prev);
  }

  /** Terrain heights and residency the shader sees, for diagnostics and tests (anchor-tangent km, relative to the anchor sphere). */
  get status(): SolarShadowStatus {
    return {
      state: this.state,
      levels: this.levels.map((l, i) => ({ halfKm: l.cfg.halfKm, texelKm: l.texelKm, valid: l.offset !== null,
        offsetKm: l.offset ? [l.offset[0], l.offset[1]] : null, lastReason: l.lastReason, lastSampledTexels: l.lastSampledTexels,
        unknownFraction: l.unknownFraction, coarseFraction: l.coarseFraction, builds: l.builds, lastBuildMs: l.lastBuildMs,
        horizonSunLagDeg: this.horizon && this.horizon.at[i].seq >= 0 ? this.horizon.at[i].sun.angleTo(this.uniforms.sun.value) / DEG : null })),
      anchorResets: this.anchorResets,
      horizonRenders: this.horizon?.renders ?? 0,
      rangeKm: this.levels[this.levels.length - 1].cfg.halfKm,
      unknownDrawnLit: true,
    };
  }

  /**
   * Fraction of the Sun's disk visible from a scene point at any height (a vehicle landed or flying), from this frame's
   * clipmap: the horizon pass's march on the CPU, from that point. A point below the clipmap surface marches from the
   * surface. 1 where the shadow is off or the clipmap holds no terrain there (unknown terrain is drawn lit).
   */
  sunFractionAt(scenePos: THREE.Vector3): number {
    const u = this.uniforms, a = this.anchor, m = this.sceneToBody;
    if (u.enabled.value < 0.5 || !a || !m) return 1;
    _v.copy(scenePos).sub(m.origin).multiplyScalar(1 / m.scale).applyQuaternion(m.q);
    const p: V3 = [_v.x, _v.y, _v.z], rc = a.rcKm, f = a.frame;
    const r = Math.hypot(...p);
    const up = dot(p, f.up);
    if (!(r > 0) || up <= 0) return 1;
    const g0: [number, number] = [dot(p, f.east) * rc / up, dot(p, f.north) * rc / up];
    const ground = this.find(g0);
    if (!ground) return 1;
    // The point, lifted to the clipmap surface if below it: (east, north, w) as in `ssMarch`.
    const h0 = Math.max(r - rc, ground.h);
    const sg = Math.hypot(rc, g0[0], g0[1]);
    const e0 = [g0[0] * (rc + h0) / sg, g0[1] * (rc + h0) / sg], w0 = rc * (h0 - (g0[0] ** 2 + g0[1] ** 2) / (sg + rc)) / sg;
    const sun = u.sun.value, sunRad = u.sunRad.value, step = u.stepTexels.value;
    if ((sun.x * e0[0] + sun.y * e0[1] + sun.z * (rc + w0)) / Math.hypot(e0[0], e0[1], rc + w0) < -0.2) return 0;
    let t = 0.5 * step * this.levels[ground.level].texelKm, worst = -1;
    for (let i = 0; i < u.maxSteps.value; i++) {
      const ex = e0[0] + sun.x * t, ny = e0[1] + sun.y * t, w = w0 + sun.z * t;
      const r2m = ex * ex + ny * ny + w * w + 2 * rc * w;
      const hRay = r2m / (Math.sqrt(rc * rc + r2m) + rc);
      if (t > u.maxRange.value || hRay > u.hMax.value + Math.tan(sunRad) * t) break;
      const hit = this.find([ex * rc / (rc + w), ny * rc / (rc + w)]);
      if (!hit) break;
      worst = Math.max(worst, (hit.h - hRay - u.bias.value) / t);
      t += step * this.levels[hit.level].texelKm;
    }
    return Math.min(1, Math.max(0, 0.5 - Math.atan(Math.max(-1, Math.min(1, worst))) / (2 * sunRad)));
  }

  /** `ssFind` on the CPU: (height above the anchor sphere, level) of the finest level holding terrain at g, cross-faded. */
  private find(g: [number, number]): { h: number; level: number } | null {
    const L = this.levels;
    const tap = (l: Level, ok: boolean): number | null => {
      if (!ok || !l.offset || !l.data) return null;
      const n = l.cfg.size;
      const x = (g[0] - l.offset[0]) / l.texelKm + n / 2 - 0.5, y = (g[1] - l.offset[1]) / l.texelKm + n / 2 - 0.5;
      const x0 = Math.max(0, Math.min(n - 1, Math.floor(x))), y0 = Math.max(0, Math.min(n - 1, Math.floor(y)));
      const x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1), fx = x - Math.floor(x), fy = y - Math.floor(y);
      const at = (xx: number, yy: number) => (yy * n + xx) * 2, d = l.data;
      if (d[at(x0, y0) + 1] !== 1 || d[at(x1, y0) + 1] !== 1 || d[at(x0, y1) + 1] !== 1 || d[at(x1, y1) + 1] !== 1) return null;
      const top = d[at(x0, y0)] + (d[at(x1, y0)] - d[at(x0, y0)]) * fx, bottom = d[at(x0, y1)] + (d[at(x1, y1)] - d[at(x0, y1)]) * fx;
      return top + (bottom - top) * fy;
    };
    const box = (l: Level) => l.offset ? Math.max(Math.abs(g[0] - l.offset[0]), Math.abs(g[1] - l.offset[1])) : Infinity;
    const inside = (l: Level) => box(l) < l.cfg.halfKm - l.texelKm;
    for (let i = 0; i < L.length; i++) {
      const h = tap(L[i], inside(L[i]));
      if (h === null) continue;
      const next = L[i + 1], band = next?.offset ? 0.2 * L[i].cfg.halfKm : 0;
      const w = band > 0 ? Math.min(1, Math.max(0, (L[i].cfg.halfKm - L[i].texelKm - box(L[i])) / band)) : 1;
      const h2 = w < 1 ? tap(next, inside(next)) : null;
      return { h: h2 === null ? h : h2 + (h - h2) * w, level: i };
    }
    return null;
  }

  /** Read back what the clipmap holds at a tangent-plane point, finest level first. For tests and diagnostics. */
  heightAt(eKm: number, nKm: number): { heightKm: number | null; level: number } | null {
    for (let i = 0; i < this.levels.length; i++) {
      const l = this.levels[i];
      if (!l.offset) continue;
      const x = (eKm - l.offset[0]) / l.texelKm + l.cfg.size / 2 - 0.5, y = (nKm - l.offset[1]) / l.texelKm + l.cfg.size / 2 - 0.5;
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= l.cfg.size || yi >= l.cfg.size) continue;
      const base = l.data;
      if (!base) continue;
      const k = (yi * l.cfg.size + xi) * 2;
      return { heightKm: base[k + 1] > 0.5 ? base[k] : null, level: i };
    }
    return null;
  }

  dispose(): void {
    for (const l of this.levels) l.texture.dispose();
    if (this.horizon) {
      for (const t of this.horizon.targets) t.dispose();
      this.horizon.material.dispose();
      (this.horizon.scene.children[0] as THREE.Mesh).geometry.dispose();
    }
  }
}

function makeTexture(data: Float32Array, size: number, linear: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGFormat, THREE.FloatType);
  t.generateMipmaps = false;
  // Taps filter bilinearly in hardware when float textures allow it, else by hand (texelFetch), so the extension is
  // optional.
  t.minFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;
  t.magFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

function qualityUniforms(q: SolarShadowQuality) {
  const p = SOLAR_SHADOW_QUALITY[q];
  return { stepTexels: { value: p.stepTexels }, maxSteps: { value: p.maxSteps } };
}

function placeholder(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Float32Array([0, 0]), 1, 1, THREE.RGFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * Debug view: 0 off; 1 Sun visibility; 2 visibility with unknown or too-coarse terrain tinted magenta; 3 frame/data alignment (green:
 * rendered surface within 10 m of the clipmap); 4 neutral grey albedo lit by the Sun with terrain shadows (no imagery,
 * no baked lighting); 5 the same without terrain shadows; 6 the normal image with terrain shadows bypassed while the
 * clipmap keeps updating (an A/B "off" that does not pause the clipmap).
 */
export type SolarShadowDebugMode = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * GLSL shared by the horizon pass and the terrain shader.
 *
 * Horizon pass (`ssMarch`, one fragment per clipmap texel, run only when the data or the Sun moved): from the terrain
 * point at the texel centre, march toward the Sun and keep the largest angle by which terrain stands above the Sun ray.
 * - Ray points are tracked as (east, north, w) with w above the anchor sphere. Height above the sphere is
 *   `(e²+n²+w²+2·Rc·w)/(|q|+Rc)`, which never subtracts two ~Rc values (float32 would lose metres).
 * - Each tap reads the finest level holding terrain there, bilinearly, at that level's own resolution, and the next
 *   step is `stepTexels` (at most 1) of its texel: a ridge is seen as the data has it, with no max-reduction or
 *   dilation (which
 *   inflate rough terrain, and inflate it more where the data are finer, so a finer level's box became a plateau
 *   casting shadows from its edges). The receiver stands on that same surface. Levels cross-fade over the outer 20 % of
 *   a level, so the surface has no seam.
 * - Where a level is still waiting for source tiles the next coarser level answers; terrain no level holds is unknown.
 *
 * Terrain shader (`solarShadowVisibility`): the fragment's horizon angle is the bilinear horizon map of the finest
 * level holding it (cross-faded like the data), and its Sun visibility the visible fraction of the Sun's disk (linear
 * across the diameter, as `sunFraction` in TerrainSunVisibility.ts). One filtered fetch per fragment, no noise: the
 * cost does not grow with screen resolution, and the shadow is a texture on the terrain, so it cannot shimmer as the
 * camera moves.
 */
export const solarShadowGlsl = `
uniform float uSsEnabled;
uniform float uSsDebug;
uniform float uSsStepTexels;
uniform float uSsMaxSteps;
uniform mat3 uSsViewToTan;
uniform vec3 uSsOriginView;
uniform vec3 uSsSun;
uniform float uSsSunRad;
uniform float uSsRc;
uniform float uSsHMax;
uniform float uSsMaxRange;
uniform float uSsBias;
uniform vec4 uSsHalf;
uniform vec4 uSsTexel;
uniform vec4 uSsValid;
uniform vec2 uSsOff0;
uniform vec2 uSsOff1;
uniform vec2 uSsOff2;
uniform vec2 uSsOff3;
uniform sampler2D uSsTex0;
uniform sampler2D uSsTex1;
uniform sampler2D uSsTex2;
uniform sampler2D uSsTex3;
uniform sampler2D uSsHz0;
uniform sampler2D uSsHz1;
uniform sampler2D uSsHz2;
uniform sampler2D uSsHz3;

float ssHalf(int l) { return uSsHalf[l]; }
float ssTexel(int l) { return uSsTexel[l]; }
vec2 ssOff(int l) { return l == 0 ? uSsOff0 : (l == 1 ? uSsOff1 : (l == 2 ? uSsOff2 : uSsOff3)); }
bool ssValidL(int l) { return uSsValid[l] > 0.5; }
int ssSize(int l) { return int(floor(2.0 * ssHalf(l) / ssTexel(l) + 0.5)); }
vec2 ssUv(int l, vec2 g) { return (g - ssOff(l)) / (2.0 * ssHalf(l)) + 0.5; }
// Chebyshev distance of g from level l's centre, km.
float ssBox(int l, vec2 g) { vec2 d = abs(g - ssOff(l)); return max(d.x, d.y); }
// Width of the outer band over which level l fades into the next coarser level (0 when there is none).
float ssBand(int l) { return l < 3 && ssValidL(l + 1) ? 0.2 * ssHalf(l) : 0.0; }

vec2 ssTexelAt(int l, ivec2 ij) {
  if (l == 0) return texelFetch(uSsTex0, ij, 0).rg;
  if (l == 1) return texelFetch(uSsTex1, ij, 0).rg;
  if (l == 2) return texelFetch(uSsTex2, ij, 0).rg;
  return texelFetch(uSsTex3, ij, 0).rg;
}

// (height above the anchor sphere, validity) of level l at g, bilinear (by hand when float textures do not filter).
// Validity is below 1 if any of the four texels is unknown.
vec2 ssTap(int l, vec2 g) {
#ifdef SS_HW_LINEAR
  vec2 uv = ssUv(l, g);
  if (l == 0) return texture(uSsTex0, uv).rg;
  if (l == 1) return texture(uSsTex1, uv).rg;
  if (l == 2) return texture(uSsTex2, uv).rg;
  return texture(uSsTex3, uv).rg;
#else
  int n = ssSize(l);
  vec2 x = ssUv(l, g) * float(n) - 0.5;
  vec2 f = x - floor(x);
  ivec2 i0 = ivec2(floor(x));
  ivec2 hi = ivec2(n - 1);
  vec2 a = ssTexelAt(l, clamp(i0, ivec2(0), hi));
  vec2 b = ssTexelAt(l, clamp(i0 + ivec2(1, 0), ivec2(0), hi));
  vec2 c = ssTexelAt(l, clamp(i0 + ivec2(0, 1), ivec2(0), hi));
  vec2 d = ssTexelAt(l, clamp(i0 + ivec2(1, 1), ivec2(0), hi));
  return vec2(mix(mix(a.x, b.x, f.x), mix(c.x, d.x, f.x), f.y), min(min(a.y, b.y), min(c.y, d.y)));
#endif
}

// Level l holds terrain at g: inside its box (less one texel) with all four bilinear texels known.
bool ssHas(int l, vec2 g) { return ssValidL(l) && ssBox(l, g) < ssHalf(l) - ssTexel(l) && ssTap(l, g).y > 0.999; }

// Finest level holding terrain at the gnomonic point g; -1 when none. Where a finer level is still waiting for source
// tiles (a strip just exposed by a re-centre) the coarser one answers, so the shadow there sharpens when the data
// arrive instead of popping from lit to shadowed.
int ssLevel(vec2 g) {
  for (int l = 0; l < 4; l++) if (ssHas(l, g)) return l;
  return -1;
}

// Weight of level l (vs l + 1) at g: 1 inside, falling to 0 across the band (1 where l + 1 holds nothing there).
float ssWeight(int l, vec2 g) {
  float band = ssBand(l);
  return band > 0.0 && ssHas(l + 1, g) ? clamp((ssHalf(l) - ssTexel(l) - ssBox(l, g)) / band, 0.0, 1.0) : 1.0;
}

// Height above the anchor sphere at g (level l = ssLevel(g)), cross-faded into the next coarser level.
float ssHeight(vec2 g, int l) {
  float h = ssTap(l, g).x;
  float w = ssWeight(l, g);
  return w < 1.0 ? mix(ssTap(l + 1, g).x, h, w) : h;
}

// ssLevel and ssHeight in one pass (one fetch inside a level, two in its band): (height, level), level -1 if none.
vec2 ssFind(vec2 g) {
  for (int l = 0; l < 4; l++) {
    if (!ssValidL(l) || ssBox(l, g) >= ssHalf(l) - ssTexel(l)) continue;
    vec2 s = ssTap(l, g);
    if (s.y < 0.999) continue;
    float band = ssBand(l);
    float w = band > 0.0 ? clamp((ssHalf(l) - ssTexel(l) - ssBox(l, g)) / band, 0.0, 1.0) : 1.0;
    if (w < 1.0 && ssBox(l + 1, g) < ssHalf(l + 1) - ssTexel(l + 1)) {
      vec2 s2 = ssTap(l + 1, g);
      if (s2.y > 0.999) s.x = mix(s2.x, s.x, w);
    }
    return vec2(s.x, float(l));
  }
  return vec2(0.0, -1.0);
}

// Debug: rendered surface height minus the clipmap's at this fragment, km (0 when frames and data agree);
// NaN where the clipmap holds nothing. A frame or scale mistake shows here as a large constant offset.
float solarShadowDelta(vec3 viewPos) {
  vec3 p = uSsViewToTan * (viewPos - uSsOriginView);
  vec2 g0 = p.xy * uSsRc / (uSsRc + p.z);
  int l0 = ssLevel(g0);
  if (l0 < 0) return 0.0 / 0.0;
  float r2m = dot(p.xy, p.xy) + p.z * p.z + 2.0 * uSsRc * p.z;
  float hRendered = r2m / (sqrt(uSsRc * uSsRc + r2m) + uSsRc);
  return hRendered - ssHeight(g0, l0);
}

// Horizon pass: (largest terrain angle above the Sun ray, radians, clamped to ±1; 1 if the march met unknown terrain
// before the known terrain hid the whole Sun)
// for the receiver on the clipmap surface at gnomonic point g0, height h0.
vec2 ssMarch(vec2 g0, float h0) {
  float rc = uSsRc;
  float unknown = 0.0;
  float sg = sqrt(rc * rc + dot(g0, g0));
  vec2 e0 = g0 * ((rc + h0) / sg);
  float w0 = rc * (h0 - dot(g0, g0) / (sg + rc)) / sg;
  float sinEl = dot(uSsSun, normalize(vec3(e0, rc + w0)));
  if (sinEl < -0.2) return vec2(1.0, 0.0);
  vec3 sun = uSsSun;
  float t = 0.5 * uSsStepTexels * ssTexel(max(ssLevel(g0), 0));
  float worst = -1.0;
  for (int i = 0; i < ${SOLAR_SHADOW_MAX_STEPS}; i++) {
    if (float(i) >= uSsMaxSteps) break;
    vec2 ee = e0 + sun.xy * t;
    float w = w0 + sun.z * t;
    float r2m = dot(ee, ee) + w * w + 2.0 * rc * w;
    float hRay = r2m / (sqrt(rc * rc + r2m) + rc);
    // Done once the Sun's lower limb, not just its centre, clears the highest terrain: terrain under the ray by less
    // than the Sun's radius still hides part of the disk.
    if (t > uSsMaxRange || hRay > uSsHMax + tan(uSsSunRad) * t) break;
    vec2 f = ssFind(ee * rc / (rc + w));
    // Unknown matters only while the Sun is not yet fully hidden: more terrain can only hide more of it.
    if (f.y < 0.0) { unknown = worst < tan(uSsSunRad) ? 1.0 : 0.0; break; }
    worst = max(worst, (f.x - hRay - uSsBias) / t);
    t += uSsStepTexels * ssTexel(int(f.y));
  }
  return vec2(clamp(worst, -1.0, 1.0), unknown);
}

// (horizon angle, unknown) at g from level l's horizon map.
vec2 ssHorizonAt(int l, vec2 g) {
  if (l == 0) return texture(uSsHz0, ssUv(0, g)).xy;
  if (l == 1) return texture(uSsHz1, ssUv(1, g)).xy;
  if (l == 2) return texture(uSsHz2, ssUv(2, g)).xy;
  return texture(uSsHz3, ssUv(3, g)).xy;
}

// Fraction of the Sun disk visible from the fragment at view-space position viewPos; unknown = 1 when the march met
// terrain the clipmap does not hold (the answer then uses only the known terrain).
float solarShadowVisibility(vec3 viewPos, out float unknown) {
  unknown = 0.0;
  vec3 p = uSsViewToTan * (viewPos - uSsOriginView);
  vec2 g0 = p.xy * uSsRc / (uSsRc + p.z);
  int l0 = ssLevel(g0);
  if (l0 < 0) { unknown = 1.0; return 1.0; }
  vec2 hz = ssHorizonAt(l0, g0);
  float w = ssWeight(l0, g0);
  if (w < 1.0) hz = mix(ssHorizonAt(l0 + 1, g0), hz, w);
  if (hz.y > 0.01) unknown = 1.0;
  // Sun-ray elevation is not part of the angle: the Sun centre and the terrain are measured from the same ray.
  return clamp(0.5 - atan(hz.x) / (2.0 * uSsSunRad), 0.0, 1.0);
}
`;

/** The horizon pass: one fragment per texel of level `uSsLevel`, writing `ssMarch` for its centre. */
const horizonPassFragment = `
uniform float uSsLevel;
void main() {
  int l = int(uSsLevel + 0.5);
  vec2 g = ssOff(l) + ((floor(gl_FragCoord.xy) + 0.5) / float(ssSize(l)) - 0.5) * 2.0 * ssHalf(l);
  // The receiver stands on the same (cross-faded, finest available) surface the march reads: its own level's texel
  // alone would sit above or below the terrain right beside it wherever levels differ, and shadow itself.
  int lr = ssLevel(g);
  gl_FragColor = lr < 0 ? vec4(-1.0, 1.0, 0.0, 1.0) : vec4(ssMarch(g, ssHeight(g, lr)), 0.0, 1.0);
}`;

function shaderUniforms(u: SolarShadowUniforms): Record<string, { value: unknown }> {
  return {
    uSsEnabled: u.enabled, uSsDebug: u.debug, uSsStepTexels: u.stepTexels, uSsMaxSteps: u.maxSteps, uSsViewToTan: u.viewToTan, uSsOriginView: u.originView, uSsSun: u.sun,
    uSsSunRad: u.sunRad, uSsRc: u.rc, uSsHMax: u.hMax, uSsMaxRange: u.maxRange, uSsBias: u.bias, uSsHalf: u.half,
    uSsTexel: u.texel, uSsValid: u.valid, uSsOff0: u.off0, uSsOff1: u.off1, uSsOff2: u.off2, uSsOff3: u.off3,
    uSsTex0: u.tex0, uSsTex1: u.tex1, uSsTex2: u.tex2, uSsTex3: u.tex3, uSsHz0: u.hz0, uSsHz1: u.hz1, uSsHz2: u.hz2, uSsHz3: u.hz3,
  };
}

/** Wire the Sun visibility into a MeshStandard/Physical fragment shader: only the direct terms are attenuated. */
export function injectSolarShadowIntoShader(
  shader: { fragmentShader: string; uniforms?: Record<string, unknown> },
  u: SolarShadowUniforms,
): void {
  const end = '#include <lights_fragment_end>';
  const opaque = '#include <opaque_fragment>';
  if (!shader.fragmentShader.includes(end) || !shader.fragmentShader.includes(opaque)) {
    throw new Error('Solar shadow: Three.js lights_fragment_end/opaque_fragment hook changed.');
  }
  if (shader.fragmentShader.includes('solarShadowVisibility')) return;
  if (shader.uniforms) Object.assign(shader.uniforms, shaderUniforms(u));
  const main = /void main\(\s*\)\s*\{/;
  if (!main.test(shader.fragmentShader)) throw new Error('Solar shadow: fragment shader has no main().');
  shader.fragmentShader = (u.hardwareLinear ? '#define SS_HW_LINEAR\n' : '') + solarShadowGlsl + shader.fragmentShader.replace(main, 'void main() {\n  float solarVis = 1.0; float solarUnknown = 0.0;')
    .replace(end, `${end}
#if NUM_DIR_LIGHTS > 0
// Debug views show the Sun fraction on every fragment: the rendered normal (which varies with mesh LOD) only gates the cost.
if (uSsEnabled > 0.5 && uSsDebug < 5.5 && (uSsDebug > 0.5 || dot(normal, directionalLights[0].direction) > 0.0)) {
  solarVis = solarShadowVisibility(-vViewPosition, solarUnknown);
  reflectedLight.directDiffuse *= solarVis;
  reflectedLight.directSpecular *= solarVis;
}
#endif`)
    .replace(opaque, `if (uSsDebug > 0.5 && uSsDebug < 5.5 && uSsEnabled > 0.5) {
  outgoingLight = vec3(solarVis);
  if (uSsDebug > 1.5 && solarUnknown > 0.5) outgoingLight = mix(outgoingLight, vec3(1.0, 0.0, 1.0), 0.6);
  if (uSsDebug > 2.5 && uSsDebug < 3.5) {
    float d = solarShadowDelta(-vViewPosition);
    outgoingLight = d != d ? vec3(1.0, 0.0, 1.0) : (abs(d) < 0.01 ? vec3(0.0, 1.0, 0.0) : (d > 0.0 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0)));
  }
#if NUM_DIR_LIGHTS > 0
  if (uSsDebug > 3.5) {
    float nl = max(dot(normal, directionalLights[0].direction), 0.0);
    outgoingLight = vec3(0.03 + 0.85 * nl * (uSsDebug > 4.5 ? 1.0 : solarVis));
  }
#endif
}
${opaque}`);
}
