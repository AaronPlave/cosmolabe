import type { RotationMatrix, SpiceInstance, Vec3 } from '../spice-injection.js';
import type { Quaternion, RotationModel } from '../rotations/RotationModel.js';
import { OBLIQUITY_J2000_RAD } from '../constants.js';
import { IDENTITY3, mat3Mul, mat3Transpose, mat3Vec, quatToMat3, rotX, rotY, rotZ } from './mat3.js';
import { j2000ToEarthFixed, j2000ToMod, j2000ToTeme, j2000ToTod } from './earthOrientation.js';

/**
 * Named reference frames, and the rotations between them.
 *
 * Every frame carries one rotation: from itself to ICRF, the canonical frame,
 * at an epoch. A conversion between any two frames is composed from those on
 * demand (`rotation(from, to, et) = toICRF(to)ᵀ · toICRF(from)`), so adding a
 * frame is one definition, not one per pair.
 *
 * Kinds of frame:
 *
 *  - **Static inertial** — ICRF, EME2000 (J2000), ECLIPJ2000, B1950, FK4,
 *    ECLIPB1950, GALACTIC. Fixed matrices, identical to SPICE's built-in
 *    definitions; used on both the SPICE and SPICE-free paths, because there
 *    is nothing for SPICE to add and it keeps `pxform` off the per-frame path.
 *  - **Earth dynamic** — MOD, TOD, TEME, ITRF. Analytical IAU-76/80 theory
 *    (`earthOrientation.ts`). ITRF prefers SPICE's ITRF93 when the binary
 *    Earth PCK is furnished; TEME, MOD and TOD have no SPICE counterpart.
 *  - **Body-fixed** — `IAU_<BODY>`, resolved first through the body's own
 *    `RotationModel` (so a surface point lands on the globe that is actually
 *    drawn), then through SPICE. The `BODY_FIXED` pseudo-frame means "the
 *    body-fixed frame of whatever this position is relative to", and is
 *    resolved to an `IAU_<BODY>` name by whoever knows the center — see
 *    `Universe`.
 *  - **Any SPICE frame** — a name the registry does not define resolves
 *    through `pxform` when a SPICE instance is present (CK and TK frames,
 *    `MOON_ME`, instrument frames).
 *  - **Declared** — frames a catalog or app registers: a fixed rotation from
 *    a base frame (`defineFixedFrame`) or any `FrameDefinition`.
 *
 * State-dependent frames (LVLH, RIC, RTN, VNC …) are deliberately not frames
 * in this sense. They are built from a spacecraft's position and velocity
 * relative to a central body, so their rotation is a function of another
 * body's state, not of the epoch alone; `TwoVectorFrame` models them. The
 * registry recognizes their names only to refuse them clearly (see
 * `isStateDependentFrameName`).
 *
 * EME2000 vs ICRF: the ~23 mas frame bias between them is not applied. SPICE
 * treats `J2000` as ICRF-aligned and every JPL ephemeris is delivered in it,
 * so applying the bias would move SPICE-driven planets ~17 km at 1 AU relative
 * to everything else. The two names stay distinct so a trajectory's declared
 * frame is preserved; the rotation between them is identity, as in SPICE.
 * Data from a producer that does apply the bias (Orekit, STK, GMAT) is
 * declared `EME2000_IERS`: FK5 J2000 with the IERS 2003 bias.
 */

export type FrameKind = 'inertial' | 'body-fixed';

export interface FrameDefinition {
  /** Canonical name. */
  readonly name: string;
  /** Other spellings that resolve to this frame (matched case-insensitively). */
  readonly aliases?: readonly string[];
  readonly kind: FrameKind;
  /** The frame's name in SPICE, when SPICE knows it. */
  readonly spiceName?: string;
  /** True when `toICRF` does not depend on `et`; the registry caches it. */
  readonly isStatic?: boolean;
  /** Rotation taking vectors in this frame to ICRF at `et` (row-major), or
   *  undefined when the frame cannot be resolved at that epoch. */
  toICRF(et: number, registry: FrameRegistry): RotationMatrix | undefined;
}

/** A frame fixed relative to a base frame (a SPICE TK frame, in effect). */
export interface FixedFrameSpec {
  name: string;
  aliases?: string[];
  /** The frame this one is defined against. Any registry name. */
  base: string;
  /** Rotation taking vectors in the new frame to `base`, row-major. */
  matrix?: number[];
  /** The same rotation as a unit quaternion `[w, x, y, z]` (v_base = q v q*). */
  quaternion?: number[];
  /** Defaults to the base frame's kind. */
  kind?: FrameKind;
}

export interface FrameRegistryOptions {
  spice?: SpiceInstance;
  /** Rotation model of a body, by the name part of an `IAU_<BODY>` frame
   *  (upper-case, spaces as underscores). `Universe` supplies this. */
  bodyRotation?: (normalizedBodyName: string) => RotationModel | undefined;
}

/** Name of the pseudo-frame for "fixed to the body this position is relative to". */
export const BODY_FIXED = 'BODY_FIXED';

/** cosmolabe's scene frame: what `Universe.absolutePositionOf` returns. */
export const WORLD_FRAME = 'ECLIPJ2000';

/** Upper-case, whitespace and hyphens as underscores: the lookup key for names. */
export function normalizeFrameKey(name: string): string {
  return name.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

/** Name of a body's body-fixed frame (`Io` → `IAU_IO`, `Ingenuity Heli` → `IAU_INGENUITY_HELI`). */
export function bodyFixedFrameName(bodyName: string): string {
  return `IAU_${normalizeFrameKey(bodyName)}`;
}

const STATE_DEPENDENT = new Set([
  'LVLH', 'VVLH', 'RIC', 'RSW', 'RTN', 'NTW', 'TNW', 'VNC', 'VNB', 'QSW', 'LOF', 'TNB',
]);

/** True for names of spacecraft-state-dependent frames (LVLH, RIC, …), which
 *  are not registry frames. See the module comment. */
export function isStateDependentFrameName(name: string): boolean {
  return STATE_DEPENDENT.has(normalizeFrameKey(name));
}

const cosE = Math.cos(OBLIQUITY_J2000_RAD);
const sinE = Math.sin(OBLIQUITY_J2000_RAD);

// Static matrices, frame → J2000, exactly as SPICE's built-in inertial frames
// define them (pxform(frame, 'J2000', et) — they have no et dependence). The
// frame tests assert these against SPICE to 1e-12.
const ECLIPJ2000_TO_J2000: RotationMatrix = [1, 0, 0, 0, cosE, -sinE, 0, sinE, cosE];
const B1950_TO_J2000: RotationMatrix = [
  0.9999257079523629, -0.011178938137770135, -0.00485900381535927,
  0.01117893812642769, 0.9999375133499887, -0.00002716259471424704,
  0.0048590038414544285, -0.000027157926258510777, 0.9999881946023742,
];
const FK4_TO_J2000: RotationMatrix = [
  0.9999256794956877, -0.01118148322046629, -0.00485900381535927,
  0.011181483239171792, 0.9999374848933135, -0.00002716259471424704,
  0.004859003772314385, -0.000027170293744002025, 0.9999881946023742,
];
const ECLIPB1950_TO_J2000: RotationMatrix = [
  0.9999257079523629, -0.012189277138214924, -0.000009940500920351154,
  0.01117893812642769, 0.9173688178789828, -0.3978812427417045,
  0.0048590038414544285, 0.3978515722052201, 0.9174369278459982,
];
const GALACTIC_TO_J2000: RotationMatrix = [
  -0.054875539395742516, 0.49410945362774383, -0.8676661356833737,
  -0.8734371047275961, -0.44482959429757496, -0.19807638961301985,
  -0.4838349917700252, 0.7469822486998919, 0.4559837945214199,
];

// IERS 2003 frame bias (Conventions 2003 §5.5.1), in SOFA's exact form
// (iauBi00 / iauBp00): Δψ and Δε of the FK5 J2000 pole from the ICRS pole,
// and the equinox offset; ξ0 = Δψ·sin ε0, η0 = Δε.
const MAS = Math.PI / (180 * 3600 * 1000);
const XI0 = -41.775 * MAS * Math.sin(OBLIQUITY_J2000_RAD);
const ETA0 = -6.8192 * MAS;
const DA0 = -14.6 * MAS;
/** B takes ICRS vectors to FK5 J2000: R1(−η0)·R2(ξ0)·R3(dα0); its transpose goes back. */
const EME2000_IERS_TO_ICRF: RotationMatrix = mat3Transpose(mat3Mul(rotX(-ETA0), mat3Mul(rotY(XI0), rotZ(DA0))));

function staticFrame(
  name: string,
  toICRF: RotationMatrix,
  aliases: string[],
  spiceName: string | undefined = name,
): FrameDefinition {
  return { name, aliases, kind: 'inertial', spiceName, isStatic: true, toICRF: () => toICRF };
}

function earthFrame(
  name: string,
  kind: FrameKind,
  j2000To: (et: number) => RotationMatrix,
  aliases: string[],
  spiceName?: string,
): FrameDefinition {
  return {
    name,
    aliases,
    kind,
    spiceName,
    toICRF(et, registry) {
      if (spiceName) {
        const m = registry.spiceToJ2000(spiceName, et);
        if (m) return m;
      }
      return mat3Transpose(j2000To(et));
    },
  };
}

/** The frames every registry starts with. */
export const BUILTIN_FRAMES: readonly FrameDefinition[] = [
  staticFrame('ICRF', IDENTITY3, ['GCRF', 'ICRF2', 'ICRF3'], 'J2000'),
  staticFrame('EME2000', IDENTITY3, ['J2000', 'EquatorJ2000', 'EMEJ2000', 'EME_J2000', 'equatorial'], 'J2000'),
  // No spiceName: SPICE has no frame-bias rotation, so SPICE queries for this
  // frame go out in J2000 and are labelled as such.
  { ...staticFrame('EME2000_IERS', EME2000_IERS_TO_ICRF, ['FK5_J2000_BIASED']), spiceName: undefined },
  staticFrame('ECLIPJ2000', ECLIPJ2000_TO_J2000, ['EclipticJ2000', 'ecliptic', 'ECLIPTIC_J2000']),
  staticFrame('B1950', B1950_TO_J2000, ['EquatorB1950', 'EME1950']),
  staticFrame('FK4', FK4_TO_J2000, []),
  staticFrame('ECLIPB1950', ECLIPB1950_TO_J2000, ['EclipticB1950']),
  staticFrame('GALACTIC', GALACTIC_TO_J2000, ['Galactic_II']),
  earthFrame('MOD', 'inertial', j2000ToMod, ['MeanOfDate', 'MEAN_OF_DATE', 'MEME_OF_DATE']),
  earthFrame('TOD', 'inertial', j2000ToTod, ['TrueOfDate', 'TRUE_OF_DATE', 'TETE']),
  earthFrame('TEME', 'inertial', j2000ToTeme, ['TEMEOfDate', 'TEME_OF_DATE']),
  earthFrame(
    'ITRF',
    'body-fixed',
    j2000ToEarthFixed,
    ['ITRF93', 'ITRF-93', 'ITRF97', 'ITRF-97', 'ITRF2000', 'ITRF2005', 'ITRF2008', 'ITRF2014', 'ITRF2020', 'ECEF', 'PEF', 'TDR'],
    'ITRF93',
  ),
];

const IAU_PREFIX = 'IAU_';

export class FrameRegistry {
  private readonly byKey = new Map<string, FrameDefinition>();
  /** `IAU_*` and SPICE-frame definitions, synthesized on first request. */
  private readonly synthesized = new Map<string, FrameDefinition>();
  /** Raw name → canonical name. Frame names repeat on every leg of every
   *  parent-chain walk, so normalizing each time would be the hot path. */
  private readonly canonicalCache = new Map<string, string>();
  private readonly staticCache = new Map<string, RotationMatrix>();
  /** SPICE names SPICE reported it does not know; not retried until invalidate(). */
  private readonly spiceUnknown = new Set<string>();
  private readonly spice?: SpiceInstance;
  private readonly bodyRotation?: (normalizedBodyName: string) => RotationModel | undefined;
  /** Recursion guard: body-fixed frames whose rotation is stated in another
   *  body-fixed frame resolve recursively, and a cycle must not hang. */
  private depth = 0;

  constructor(options: FrameRegistryOptions = {}) {
    this.spice = options.spice;
    this.bodyRotation = options.bodyRotation;
    for (const def of BUILTIN_FRAMES) this.register(def);
  }

  /** Add (or replace) a frame. Its name and aliases become resolvable. */
  register(def: FrameDefinition): void {
    this.byKey.set(normalizeFrameKey(def.name), def);
    for (const a of def.aliases ?? []) this.byKey.set(normalizeFrameKey(a), def);
    this.staticCache.clear();
    this.canonicalCache.clear();
    this.synthesized.clear();
  }

  /** Declare a frame fixed relative to a base frame. */
  defineFixedFrame(spec: FixedFrameSpec): FrameDefinition {
    let offset: RotationMatrix;
    if (spec.matrix && spec.matrix.length === 9) {
      offset = spec.matrix.slice(0, 9) as RotationMatrix;
    } else if (spec.quaternion && spec.quaternion.length === 4) {
      const [w, x, y, z] = spec.quaternion;
      const n = Math.hypot(w, x, y, z);
      offset = quatToMat3([w / n, x / n, y / n, z / n] as Quaternion);
    } else {
      throw new Error(`Frame "${spec.name}": a declared frame needs a 9-element "matrix" or a 4-element "quaternion".`);
    }
    if (normalizeFrameKey(spec.base) === normalizeFrameKey(spec.name)) {
      throw new Error(`Frame "${spec.name}" cannot be defined against itself.`);
    }
    const base = spec.base;
    const baseDef = this.get(base);
    const def: FrameDefinition = {
      name: spec.name,
      aliases: spec.aliases,
      kind: spec.kind ?? baseDef?.kind ?? 'inertial',
      isStatic: baseDef?.isStatic,
      toICRF: (et, registry) => {
        const b = registry.toICRF(base, et);
        return b ? mat3Mul(b, offset) : undefined;
      },
    };
    this.register(def);
    return def;
  }

  /** Forget cached SPICE failures (call after furnishing kernels). */
  invalidate(): void {
    this.spiceUnknown.clear();
    this.staticCache.clear();
  }

  /** The canonical spelling of a frame name: an alias resolves to its frame's
   *  name, `IAU_*` is upper-cased, and a name the registry does not define is
   *  returned trimmed (it may still be a SPICE frame). */
  canonicalName(name: string): string {
    const cached = this.canonicalCache.get(name);
    if (cached !== undefined) return cached;
    const key = normalizeFrameKey(name);
    const def = this.byKey.get(key);
    let canonical: string;
    if (def) canonical = def.name;
    else if (key === BODY_FIXED || key === 'BODYFIXED') canonical = BODY_FIXED;
    else if (key.startsWith(IAU_PREFIX)) canonical = key;
    else canonical = name.trim();
    this.canonicalCache.set(name, canonical);
    return canonical;
  }

  /** The frame's SPICE name, when it has one: the registry's mapping for a
   *  defined frame (`EclipticJ2000` → `ECLIPJ2000`, `EME2000` → `J2000`),
   *  otherwise the name itself, on the assumption that it is a SPICE frame.
   *  Undefined for frames SPICE cannot know (TEME, MOD, TOD, declared frames). */
  spiceName(name: string): string | undefined {
    const def = this.byKey.get(normalizeFrameKey(name));
    if (def) return def.spiceName;
    const canonical = this.canonicalName(name);
    return canonical === BODY_FIXED ? undefined : canonical;
  }

  /** The registry's definition of a frame. `IAU_*` frames and SPICE frames are
   *  synthesized on first request; returns undefined for a name nothing can
   *  resolve (no definition, no body, no SPICE). */
  get(name: string): FrameDefinition | undefined {
    const key = normalizeFrameKey(name);
    const def = this.byKey.get(key) ?? this.synthesized.get(key);
    if (def) return def;
    let made: FrameDefinition | undefined;
    if (key.startsWith(IAU_PREFIX)) made = this.bodyFixedDefinition(key);
    else if (this.spice && key !== BODY_FIXED && key !== 'BODYFIXED' && !isStateDependentFrameName(key)) {
      made = this.spiceDefinition(name.trim());
    }
    if (made) this.synthesized.set(key, made);
    return made;
  }

  /** Whether `frame` resolves to a rotation at `et` — the check to run once at
   *  load time, since `transform` passes unresolvable frames through silently. */
  isResolvable(frame: string, et: number): boolean {
    return this.toICRF(frame, et) !== undefined;
  }

  /** Rotation taking vectors in `frame` to ICRF at `et`. */
  toICRF(frame: string, et: number): RotationMatrix | undefined {
    const def = this.get(frame);
    if (!def) return undefined;
    if (def.isStatic) {
      const cached = this.staticCache.get(def.name);
      if (cached) return cached;
    }
    if (this.depth > 16) return undefined;
    this.depth++;
    let m: RotationMatrix | undefined;
    try {
      m = def.toICRF(et, this);
    } finally {
      this.depth--;
    }
    if (m && def.isStatic) this.staticCache.set(def.name, m);
    return m;
  }

  /** Rotation taking vectors in `from` to `to` at `et`, or undefined when either
   *  frame cannot be resolved. */
  rotation(from: string, to: string, et: number): RotationMatrix | undefined {
    if (this.sameFrame(from, to)) return IDENTITY3;
    const a = this.toICRF(from, et);
    if (!a) return undefined;
    const b = this.toICRF(to, et);
    if (!b) return undefined;
    return mat3Mul(mat3Transpose(b), a);
  }

  /** Re-express `v` from `from` into `to` at `et`. Passes `v` through unchanged
   *  when either frame cannot be resolved — callers thread this unconditionally,
   *  and an unresolvable frame is reported once at catalog load, not per frame. */
  transform(v: Vec3, from: string, to: string, et: number): Vec3 {
    if (this.sameFrame(from, to)) return v;
    const m = this.rotation(from, to, et);
    return m ? mat3Vec(m, v) : v;
  }

  /** True when two names denote the same frame (aliases included). */
  sameFrame(a: string, b: string): boolean {
    if (a === b) return true;
    return this.canonicalName(a) === this.canonicalName(b);
  }

  /** True when SPICE has been asked for `spiceName` and said it does not know
   *  the frame (as opposed to lacking coverage at an epoch). */
  spiceRejects(spiceName: string): boolean {
    return this.spiceUnknown.has(spiceName);
  }

  /** SPICE `pxform(name, 'J2000', et)`, or undefined when there is no SPICE
   *  instance or SPICE cannot produce it. A frame SPICE does not know is
   *  remembered and not retried; a coverage gap (CK, binary PCK) is retried. */
  spiceToJ2000(spiceName: string, et: number): RotationMatrix | undefined {
    if (!this.spice || this.spiceUnknown.has(spiceName)) return undefined;
    try {
      return this.spice.pxform(spiceName, 'J2000', et);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not recognized|UNKNOWNFRAME|NOFRAME|not a known reference frame/i.test(msg)) {
        this.spiceUnknown.add(spiceName);
      }
      return undefined;
    }
  }

  private bodyFixedDefinition(key: string): FrameDefinition {
    const bodyKey = key.slice(IAU_PREFIX.length);
    return {
      name: key,
      kind: 'body-fixed',
      spiceName: key,
      toICRF: (et, registry) => {
        const rotation = this.bodyRotation?.(bodyKey);
        if (rotation) {
          // rotationAt is source → body-fixed; its transpose is body-fixed → source.
          const srcToIcrf = registry.toICRF(rotation.sourceFrame, et);
          if (srcToIcrf) {
            return mat3Mul(srcToIcrf, mat3Transpose(quatToMat3(rotation.rotationAt(et))));
          }
        }
        return registry.spiceToJ2000(key, et);
      },
    };
  }

  private spiceDefinition(name: string): FrameDefinition {
    return {
      name,
      kind: 'inertial',
      spiceName: name,
      toICRF: (et, registry) => registry.spiceToJ2000(name, et),
    };
  }
}

/** A registry with the built-in frames only: no SPICE, no bodies. Backs the
 *  stateless helpers in `kinematics.ts`. */
export const DEFAULT_FRAMES = new FrameRegistry();
