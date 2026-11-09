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
 * hysteresis, each carrying a **max-reduced** mip chain, so a march step is
 * conservative (can over-shadow a ridge narrower than the step, never leak light).
 * Texel validity is a second channel (min-reduced): missing source terrain is
 * `unknown`, never lit or shadowed.
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
  /** Finest to coarsest, at most three. Default: 8 km @ 62 m, 64 km @ 0.5 km, 320 km @ 2.5 km. */
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
  { halfKm: 8, size: 256 }, { halfKm: 64, size: 256 }, { halfKm: 320, size: 256 },
];
/** Shader loop bound (the `high` preset's step count); see `solarShadowGlsl`. */
export const SOLAR_SHADOW_MAX_STEPS = 160;
/**
 * March quality: each step is at least `stepGrowth` of the distance travelled (reach grows geometrically, and a
 * ridge may be dilated by about one step), and a ray stops after `maxSteps`. Fewer, longer steps cost less per
 * fragment and move shadow edges further toward the occluder; they never let light through a ridge.
 */
export const SOLAR_SHADOW_QUALITY = {
  high: { stepGrowth: 0.04, maxSteps: 160 },
  medium: { stepGrowth: 0.055, maxSteps: 128 },
  low: { stepGrowth: 0.08, maxSteps: 96 },
} as const;
export type SolarShadowQuality = keyof typeof SOLAR_SHADOW_QUALITY;
const REBUILD_FRACTION = 0.25;
const ANCHOR_RESET_DEG = 2;
const REVISION_REBUILD_MS = 2000;
const SUN_RADIUS_KM = 695_700;
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

/** Max-reduce height (R) and min-reduce validity (G) down to 1×1. `base` is size×size RG. */
export function buildMaxMips(base: Float32Array, size: number): { data: Float32Array; width: number; height: number }[] {
  const out = [{ data: base, width: size, height: size }];
  let cur = out[0];
  while (cur.width > 1) {
    const w = cur.width >> 1;
    const next = new Float32Array(w * w * 2);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
      let h = -Infinity, k = 1;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const i = ((2 * y + dy) * cur.width + 2 * x + dx) * 2;
        // An invalid texel's height is a fill value; it must not lift the max of valid neighbours.
        if (cur.data[i + 1] > 0.5) h = Math.max(h, cur.data[i]);
        k = Math.min(k, cur.data[i + 1]);
      }
      if (h === -Infinity) { // all four invalid: keep a finite fill
        h = cur.data[((2 * y) * cur.width + 2 * x) * 2];
      }
      next[(y * w + x) * 2] = h;
      next[(y * w + x) * 2 + 1] = k;
    }
    cur = { data: next, width: w, height: w };
    out.push(cur);
  }
  return out;
}

export interface SolarShadowUniforms {
  /** Not a uniform: the shader variant. True when float textures filter in hardware (one fetch instead of four). */
  hardwareLinear: boolean;
  enabled: { value: number };
  debug: { value: number };
  jitter: { value: number };
  stepGrowth: { value: number };
  maxSteps: { value: number };
  viewToTan: { value: THREE.Matrix3 };
  originView: { value: THREE.Vector3 };
  sun: { value: THREE.Vector3 };
  sunRad: { value: number };
  rc: { value: number };
  hMax: { value: number };
  maxRange: { value: number };
  bias: { value: number };
  half: { value: THREE.Vector3 };
  texel: { value: THREE.Vector3 };
  maxLod: { value: THREE.Vector3 };
  valid: { value: THREE.Vector3 };
  off0: { value: THREE.Vector2 }; off1: { value: THREE.Vector2 }; off2: { value: THREE.Vector2 };
  tex0: { value: THREE.Texture }; tex1: { value: THREE.Texture }; tex2: { value: THREE.Texture };
}

export type SolarShadowState = 'off' | 'out-of-range' | 'building' | 'ready' | 'partial';
export interface SolarShadowLevelStatus {
  halfKm: number; texelKm: number; valid: boolean;
  /** Fraction of texels with no source terrain. */
  unknownFraction: number;
  builds: number;
  /** CPU time of the last completed build (sum over its frames), ms. */
  lastBuildMs: number;
}
export interface SolarShadowStatus {
  state: SolarShadowState;
  levels: SolarShadowLevelStatus[];
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
  building: { offset: [number, number]; row: number; unknown: number; known: number; sum: number; ms: number } | null;
  builtRevision: number;
  builtAtMs: number;
  unknownFraction: number;
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
  private dirtyRevision = -1;

  constructor(
    private readonly source: ClipmapSource,
    config: SolarShadowConfig = {},
    /** The device filters float textures (`OES_texture_float_linear`): bilinear taps cost one fetch, not four. */
    private readonly hardwareLinear = false,
  ) {
    const cfgs = (config.levels?.length ? config.levels : DEFAULT_CLIPMAP_LEVELS).slice(0, 3);
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
      enabled: { value: 0 }, debug: { value: 0 }, jitter: { value: 1 }, ...qualityUniforms(config.quality ?? 'high'),
      viewToTan: { value: new THREE.Matrix3() }, originView: { value: new THREE.Vector3() },
      sun: { value: new THREE.Vector3(0, 0, 1) }, sunRad: { value: 0.00465 }, rc: { value: 1 },
      hMax: { value: 0 }, maxRange: { value: cfgs[cfgs.length - 1].halfKm * 2 },
      bias: { value: config.biasKm ?? 0.002 },
      half: { value: new THREE.Vector3(U[0]?.cfg.halfKm ?? 0, U[1]?.cfg.halfKm ?? 0, U[2]?.cfg.halfKm ?? 0) },
      texel: { value: new THREE.Vector3(U[0]?.texelKm ?? 1, U[1]?.texelKm ?? 1, U[2]?.texelKm ?? 1) },
      maxLod: { value: new THREE.Vector3(...[0, 1, 2].map(i => U[i] ? Math.log2(U[i].cfg.size) : 0)) },
      valid: { value: new THREE.Vector3() },
      off0: { value: new THREE.Vector2() }, off1: { value: new THREE.Vector2() }, off2: { value: new THREE.Vector2() },
      tex0: { value: U[0]?.texture ?? dummy() }, tex1: { value: U[1]?.texture ?? dummy() }, tex2: { value: U[2]?.texture ?? dummy() },
    };
  }

  private makeLevel(cfg: ClipmapLevelConfig): Level {
    const texture = placeholder();
    return {
      cfg, texelKm: (2 * cfg.halfKm) / cfg.size, texture, offset: null,
      back: new Float32Array(cfg.size * cfg.size * 2), building: null,
      builtRevision: -1, builtAtMs: -Infinity, unknownFraction: 1, hMax: 0, builds: 0, lastBuildMs: 0,
    };
  }

  private _quality: SolarShadowQuality = 'high';
  get quality(): SolarShadowQuality { return this._quality; }
  /** Change the march quality preset at run time (a uniform write: no recompile). */
  setQuality(q: SolarShadowQuality): void {
    this._quality = q;
    const u = qualityUniforms(q);
    this.uniforms.stepGrowth.value = u.stepGrowth.value; this.uniforms.maxSteps.value = u.maxSteps.value;
  }
  /** Per-pixel jitter of the march's first step (default on): hides banding as grain. */
  setJitter(on: boolean): void { this.uniforms.jitter.value = on ? 1 : 0; }
  /** Debug view: 0 off, 1 visibility, 2 visibility with unknown tinted magenta, 3 frame/data alignment (green: rendered surface within 10 m of the clipmap). */
  setDebug(mode: 0 | 1 | 2 | 3): void { this.uniforms.debug.value = mode; }
  /** Visual shadows are disabled by a caller (catalog off, `flood` mode). */
  setActive(active: boolean): void { this.active = active; if (!active) this.uniforms.enabled.value = 0; }
  private active = true;

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
    for (const l of this.levels) { l.offset = null; l.building = null; l.builtRevision = -1; l.hMax = 0; l.unknownFraction = 1; }
    this.uniforms.valid.value.set(0, 0, 0);
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
        l.building = { offset: moved ? want : off!, row: 0, unknown: 0, known: 0, sum: 0, ms: 0 };
        l.builtRevision = rev;
        // Stop at the first level started this frame: one build at a time keeps the CPU budget honest.
        break;
      }
    }
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
        const e = b.offset[0] + (x + 0.5 - n / 2) * l.texelKm;
        const d = gnomonicDirection(frame, e, nn, rcKm);
        const pos = bodyFixedToGeodetic({ xKm: d[0] * rcKm, yKm: d[1] * rcKm, zKm: d[2] * rcKm }, datum);
        const elev = this.source.elevationKm(pos.latDeg, pos.lonDeg, l.texelKm);
        const i = (y * n + x) * 2;
        if (elev === null || !Number.isFinite(elev)) { l.back[i] = NaN; l.back[i + 1] = 0; b.unknown++; continue; }
        const p = geodeticToBodyFixed({ latDeg: pos.latDeg, lonDeg: pos.lonDeg, heightKm: elev }, datum);
        const h = Math.hypot(p.xKm, p.yKm, p.zKm) - rcKm;
        l.back[i] = h; l.back[i + 1] = 1; b.known++; b.sum += h;
      }
    }
    b.ms += performance.now() - start;
    if (b.row < n) { this.finishState(); return; }
    // Complete: unknown texels take the mean (a finite fill), then mips, then swap in.
    const fillValue = b.known ? b.sum / b.known : 0;
    let hMax = -Infinity;
    for (let i = 0; i < l.back.length; i += 2) {
      if (l.back[i + 1] === 0) l.back[i] = fillValue; else hMax = Math.max(hMax, l.back[i]);
    }
    const mips = buildMaxMips(l.back, n);
    // A fresh array each build: the texture keeps the one it was given, and `back` is the next build's scratch.
    const base = mips[0].data.slice();
    const tex = makeTexture(base, n, mips.map((m, k) => k === 0 ? { ...m, data: base } : m), this.hardwareLinear);
    l.texture.dispose();
    l.texture = tex;
    l.offset = b.offset;
    l.unknownFraction = b.unknown / (n * n);
    l.hMax = hMax === -Infinity ? 0 : hMax;
    l.builtAtMs = nowMs;
    l.builds++;
    l.lastBuildMs = b.ms;
    l.building = null;
    this.finishState();
  }

  private finishState(): void {
    const valid = this.levels.filter(l => l.offset !== null);
    this.state = valid.length === 0 ? 'building'
      : this.levels.some(l => l.building || !l.offset) ? 'building'
        : this.levels.some(l => l.unknownFraction > 0) ? 'partial' : 'ready';
  }

  private refreshUniforms(frame: SolarShadowFrame, tf: TangentFrame, rcKm: number): void {
    const u = this.uniforms, L = this.levels;
    u.rc.value = rcKm;
    const offs = [u.off0.value, u.off1.value, u.off2.value];
    const valid = [0, 0, 0];
    let hMax = 0;
    const tex = [u.tex0, u.tex1, u.tex2];
    for (let i = 0; i < L.length; i++) {
      tex[i].value = L[i].texture;
      if (L[i].offset) { offs[i].set(L[i].offset![0], L[i].offset![1]); valid[i] = 1; hMax = Math.max(hMax, L[i].hMax); }
    }
    u.valid.value.set(valid[0], valid[1], valid[2]);
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

  /** Terrain heights and residency the shader sees, for diagnostics and tests (anchor-tangent km, relative to the anchor sphere). */
  get status(): SolarShadowStatus {
    return {
      state: this.state,
      levels: this.levels.map(l => ({ halfKm: l.cfg.halfKm, texelKm: l.texelKm, valid: l.offset !== null,
        unknownFraction: l.unknownFraction, builds: l.builds, lastBuildMs: l.lastBuildMs })),
      rangeKm: this.levels[this.levels.length - 1].cfg.halfKm,
      unknownDrawnLit: true,
    };
  }

  /** Read back what the clipmap holds at a tangent-plane point, finest level first. For tests and diagnostics. */
  heightAt(eKm: number, nKm: number): { heightKm: number | null; level: number } | null {
    for (let i = 0; i < this.levels.length; i++) {
      const l = this.levels[i];
      if (!l.offset) continue;
      const x = (eKm - l.offset[0]) / l.texelKm + l.cfg.size / 2 - 0.5, y = (nKm - l.offset[1]) / l.texelKm + l.cfg.size / 2 - 0.5;
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= l.cfg.size || yi >= l.cfg.size) continue;
      const base = (l.texture.image as { data?: Float32Array }).data;
      if (!base) continue;
      const k = (yi * l.cfg.size + xi) * 2;
      return { heightKm: base[k + 1] > 0.5 ? base[k] : null, level: i };
    }
    return null;
  }

  dispose(): void { for (const l of this.levels) l.texture.dispose(); }
}

function makeTexture(
  base: Float32Array, size: number,
  mips: { data: Float32Array; width: number; height: number }[], linear: boolean,
): THREE.DataTexture {
  const t = new THREE.DataTexture(base, size, size, THREE.RGFormat, THREE.FloatType);
  t.mipmaps = mips.map(m => ({ data: m.data, width: m.width, height: m.height }));
  t.generateMipmaps = false;
  // Coarse taps read exact texels (texelFetch); full-resolution taps filter in hardware when float textures allow it,
  // else by hand, so the extension is optional.
  t.minFilter = linear ? THREE.LinearMipmapNearestFilter : THREE.NearestMipmapNearestFilter;
  t.magFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

function qualityUniforms(q: SolarShadowQuality) {
  const p = SOLAR_SHADOW_QUALITY[q];
  return { stepGrowth: { value: p.stepGrowth }, maxSteps: { value: p.maxSteps } };
}

function placeholder(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Float32Array([0, 0]), 1, 1, THREE.RGFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * GLSL for the horizon march. Declares uniforms and `float solarShadowVisibility(vec3 viewPos, out float unknown)`.
 *
 * - The fragment is placed on the clipmap's own surface (bilinear height at its direction), so receiver and
 *   occluder come from one data set and the draw LOD cannot create self-shadow or leaks.
 * - Ray points are tracked as (east, north, w) with w above the anchor sphere. Height above the sphere is
 *   `(e²+n²+w²+2·Rc·w)/(|q|+Rc)`, which never subtracts two ~Rc values (float32 would lose metres).
 * - Each tap finds the finest level containing the point and looks up its gnomonic projection. Steps are
 *   `dt = max(0.9 texel, stepGrowth × distance)` (4 % at `high`); a step longer than a texel reads the max-reduced mip whose texel is
 *   at least that long, at both ends of the step, so a ridge narrower than the step cannot be skipped
 *   (it can be dilated by up to one step: the penumbra edge may move toward the ridge by ~stepGrowth–2×stepGrowth of its distance).
 * - Result: the Sun disk's visible fraction, from the largest angle by which terrain stands above the Sun ray
 *   (linear across the disk's diameter, as `sunFraction` in TerrainSunVisibility.ts).
 */
export const solarShadowGlsl = `
uniform float uSsEnabled;
uniform float uSsDebug;
uniform float uSsJitter;
uniform float uSsGrowth;
uniform float uSsMaxSteps;
uniform mat3 uSsViewToTan;
uniform vec3 uSsOriginView;
uniform vec3 uSsSun;
uniform float uSsSunRad;
uniform float uSsRc;
uniform float uSsHMax;
uniform float uSsMaxRange;
uniform float uSsBias;
uniform vec3 uSsHalf;
uniform vec3 uSsTexel;
uniform vec3 uSsMaxLod;
uniform vec3 uSsValid;
uniform vec2 uSsOff0;
uniform vec2 uSsOff1;
uniform vec2 uSsOff2;
uniform sampler2D uSsTex0;
uniform sampler2D uSsTex1;
uniform sampler2D uSsTex2;

// Finest valid level whose box (less one texel) contains the gnomonic point g; -1 when none.
int ssLevel(vec2 g) {
  if (uSsValid.x > 0.5 && max(abs(g.x - uSsOff0.x), abs(g.y - uSsOff0.y)) < uSsHalf.x - uSsTexel.x) return 0;
  if (uSsValid.y > 0.5 && max(abs(g.x - uSsOff1.x), abs(g.y - uSsOff1.y)) < uSsHalf.y - uSsTexel.y) return 1;
  if (uSsValid.z > 0.5 && max(abs(g.x - uSsOff2.x), abs(g.y - uSsOff2.y)) < uSsHalf.z - uSsTexel.z) return 2;
  return -1;
}

float ssHalf(int l) { return l == 0 ? uSsHalf.x : (l == 1 ? uSsHalf.y : uSsHalf.z); }
float ssMaxLod(int l) { return l == 0 ? uSsMaxLod.x : (l == 1 ? uSsMaxLod.y : uSsMaxLod.z); }
float ssTexel(int l) { return l == 0 ? uSsTexel.x : (l == 1 ? uSsTexel.y : uSsTexel.z); }
vec2 ssOff(int l) { return l == 0 ? uSsOff0 : (l == 1 ? uSsOff1 : uSsOff2); }
int ssSize(int l) { return int(floor(2.0 * ssHalf(l) / ssTexel(l) + 0.5)); }
vec2 ssTexelAt(int l, ivec2 ij, int lod) {
  if (l == 0) return texelFetch(uSsTex0, ij, lod).rg;
  if (l == 1) return texelFetch(uSsTex1, ij, lod).rg;
  return texelFetch(uSsTex2, ij, lod).rg;
}
// Texel coordinates in [0, n) of the point g in level l, before flooring.
vec2 ssCoord(int l, vec2 g, int n) { return ((g - ssOff(l)) / (2.0 * ssHalf(l)) + 0.5) * float(n); }

// (height above the anchor sphere, valid) of level l at g, bilinear at full resolution. Heights are read exactly
// and blended by hand, so no float-linear texture extension is needed. valid is 1 only if all four texels are.
vec2 ssBilinear(int l, vec2 g) {
#ifdef SS_HW_LINEAR
  vec2 uv = (g - ssOff(l)) / (2.0 * ssHalf(l)) + 0.5;
  if (l == 0) return textureLod(uSsTex0, uv, 0.0).rg;
  if (l == 1) return textureLod(uSsTex1, uv, 0.0).rg;
  return textureLod(uSsTex2, uv, 0.0).rg;
#else
  int n = ssSize(l);
  vec2 x = ssCoord(l, g, n) - 0.5;
  vec2 f = x - floor(x);
  ivec2 i0 = ivec2(floor(x));
  ivec2 hi = ivec2(n - 1);
  vec2 a = ssTexelAt(l, clamp(i0, ivec2(0), hi), 0);
  vec2 b = ssTexelAt(l, clamp(i0 + ivec2(1, 0), ivec2(0), hi), 0);
  vec2 c = ssTexelAt(l, clamp(i0 + ivec2(0, 1), ivec2(0), hi), 0);
  vec2 d = ssTexelAt(l, clamp(i0 + ivec2(1, 1), ivec2(0), hi), 0);
  return vec2(mix(mix(a.x, b.x, f.x), mix(c.x, d.x, f.x), f.y), min(min(a.y, b.y), min(c.y, d.y)));
#endif
}

// Conservative footprint of the step from g to g2: the max-reduced mip texels containing both ends. A step is at most
// one mip texel long, so the two cover everything the ray passes over (bilinear filtering of a max pyramid would not).
vec2 ssFootprint(int l, vec2 g, vec2 g2, int lod) {
  int n = max(ssSize(l) >> lod, 1);
  ivec2 hi = ivec2(n - 1);
  vec2 a = ssTexelAt(l, clamp(ivec2(floor(ssCoord(l, g, n * (1 << lod)) / float(1 << lod))), ivec2(0), hi), lod);
  vec2 b = ssTexelAt(l, clamp(ivec2(floor(ssCoord(l, g2, n * (1 << lod)) / float(1 << lod))), ivec2(0), hi), lod);
  return vec2(max(a.x, b.x), min(a.y, b.y));
}

// Debug: rendered surface height minus the clipmap's at this fragment, km (0 when frames and data agree);
// NaN where the clipmap holds nothing. A frame or scale mistake shows here as a large constant offset.
float solarShadowDelta(vec3 viewPos) {
  vec3 p = uSsViewToTan * (viewPos - uSsOriginView);
  float rf = uSsRc + p.z;
  vec2 g0 = p.xy * uSsRc / rf;
  int l0 = ssLevel(g0);
  if (l0 < 0) return 0.0 / 0.0;
  vec2 s0 = ssBilinear(l0, g0);
  float r2m = dot(p.xy, p.xy) + p.z * p.z + 2.0 * uSsRc * p.z;
  float hRendered = r2m / (sqrt(uSsRc * uSsRc + r2m) + uSsRc);
  return s0.y < 0.999 ? 0.0 / 0.0 : hRendered - s0.x;
}

// Fraction of the Sun disk visible from the fragment at view-space position viewPos; unknown = 1 when
// the march met terrain the clipmap does not hold (the answer then uses only the known terrain).
float solarShadowVisibility(vec3 viewPos, out float unknown) {
  unknown = 0.0;
  vec3 p = uSsViewToTan * (viewPos - uSsOriginView);
  float rc = uSsRc;
  float rf = rc + p.z;
  vec2 g0 = p.xy * rc / rf;
  int l0 = ssLevel(g0);
  if (l0 < 0) { unknown = 1.0; return 1.0; }
  vec2 s0 = ssBilinear(l0, g0);
  if (s0.y < 0.999) { unknown = 1.0; return 1.0; }
  float h0 = s0.x;
  // Receiver on the clipmap's own surface: radius rc+h0 along the fragment's radial direction.
  float sg = sqrt(rc * rc + dot(g0, g0));
  vec2 e0 = g0 * ((rc + h0) / sg);
  float w0 = rc * (h0 - dot(g0, g0) / (sg + rc)) / sg;
  float sinEl = dot(uSsSun, normalize(vec3(e0, rc + w0)));
  if (sinEl < -0.2) return 0.0;
  vec3 sun = uSsSun;
  float t = max(0.5 * ssTexel(l0), 0.005);
  // Every fragment would otherwise sample the same distances along its ray, and a far shadow edge then bands in
  // lock-step with those rings. A per-pixel shift of the first step (interleaved gradient noise) turns bands into grain.
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  t += uSsJitter * jit * max(ssTexel(l0) * 0.9, t * uSsGrowth);
  // The same for the cross-ray position of coarse (max-mip) taps: a ray running along a texel row would otherwise read
  // one row for its whole length, and neighbouring rows differ, so a far edge bands row by row.
  float jit2 = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.00583715, 0.06711056)))) - 0.5;
  vec2 across = length(sun.xy) > 1.0e-4 ? normalize(vec2(-sun.y, sun.x)) : vec2(0.0);
  float worst = -1.0e9; // largest (terrain - ray) / distance, radians (small angle)
  for (int i = 0; i < ${SOLAR_SHADOW_MAX_STEPS}; i++) {
    if (float(i) >= uSsMaxSteps) break;
    vec2 ee = e0 + sun.xy * t;
    float w = w0 + sun.z * t;
    float r2m = dot(ee, ee) + w * w + 2.0 * rc * w;
    float qlen = sqrt(rc * rc + r2m);
    float hRay = r2m / (qlen + rc);
    if (t > uSsMaxRange || hRay > uSsHMax) break;
    vec2 g = ee * rc / (rc + w);
    int l = ssLevel(g);
    if (l < 0) { unknown = 1.0; break; }
    float texel = ssTexel(l);
    float dt = max(texel * 0.9, t * uSsGrowth);
    int lod = int(clamp(ceil(log2(dt / texel)), 0.0, ssMaxLod(l)));
    vec2 s;
    if (lod == 0) s = ssBilinear(l, g);
    else {
      vec2 e2 = e0 + sun.xy * (t + dt);
      float w2 = w0 + sun.z * (t + dt);
      vec2 shift = across * (jit2 * texel * float(1 << lod) * uSsJitter);
      s = ssFootprint(l, g + shift, e2 * rc / (rc + w2) + shift, lod);
    }
    if (s.y < 0.999) unknown = 1.0;
    else worst = max(worst, (s.x - hRay - uSsBias) / t);
    t += dt;
    // Terrain only ever adds shadow: once it covers the whole Sun disk (angle >= the Sun's radius) nothing can undo it.
    if (worst >= uSsSunRad) break;
  }
  float ang = atan(worst);
  // Sun-ray elevation is not part of ang: both the Sun centre and the terrain are measured from the same ray.
  return clamp(0.5 - ang / (2.0 * uSsSunRad), 0.0, 1.0);
}
`;

/** Wire the horizon march into a MeshStandard/Physical fragment shader: only the direct terms are attenuated. */
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
  if (shader.uniforms) {
    Object.assign(shader.uniforms, {
      uSsEnabled: u.enabled, uSsDebug: u.debug, uSsJitter: u.jitter, uSsGrowth: u.stepGrowth, uSsMaxSteps: u.maxSteps, uSsViewToTan: u.viewToTan, uSsOriginView: u.originView, uSsSun: u.sun,
      uSsSunRad: u.sunRad, uSsRc: u.rc, uSsHMax: u.hMax, uSsMaxRange: u.maxRange, uSsBias: u.bias, uSsHalf: u.half,
      uSsTexel: u.texel, uSsMaxLod: u.maxLod, uSsValid: u.valid, uSsOff0: u.off0, uSsOff1: u.off1, uSsOff2: u.off2,
      uSsTex0: u.tex0, uSsTex1: u.tex1, uSsTex2: u.tex2,
    });
  }
  const main = /void main\(\s*\)\s*\{/;
  if (!main.test(shader.fragmentShader)) throw new Error('Solar shadow: fragment shader has no main().');
  shader.fragmentShader = (u.hardwareLinear ? '#define SS_HW_LINEAR\n' : '') + solarShadowGlsl + shader.fragmentShader.replace(main, 'void main() {\n  float solarVis = 1.0; float solarUnknown = 0.0;')
    .replace(end, `${end}
#if NUM_DIR_LIGHTS > 0
if (uSsEnabled > 0.5 && dot(normal, directionalLights[0].direction) > 0.0) {
  solarVis = solarShadowVisibility(-vViewPosition, solarUnknown);
  reflectedLight.directDiffuse *= solarVis;
  reflectedLight.directSpecular *= solarVis;
}
#endif`)
    .replace(opaque, `if (uSsDebug > 0.5 && uSsEnabled > 0.5) {
  outgoingLight = vec3(solarVis);
  if (uSsDebug > 1.5 && solarUnknown > 0.5) outgoingLight = mix(outgoingLight, vec3(1.0, 0.0, 1.0), 0.6);
  if (uSsDebug > 2.5) {
    float d = solarShadowDelta(-vViewPosition);
    outgoingLight = d != d ? vec3(1.0, 0.0, 1.0) : (abs(d) < 0.01 ? vec3(0.0, 1.0, 0.0) : (d > 0.0 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0)));
  }
}
${opaque}`);
}
