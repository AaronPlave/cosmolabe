/**
 * CCSDS OEM ingest: a parsed Orbit Ephemeris Message becomes state records the
 * existing Hermite interpolator can drive.
 *
 * This is the astrolabe wire. Astrolabe emits OEM, and until now a catalog
 * could only carry `InterpolatedStates` samples that somebody had already
 * converted by hand. With this, a catalog points at the file.
 *
 * Deliberately not a new Trajectory class. An OEM is a tabulation of position
 * and velocity at epochs, which is exactly what `InterpolatedStatesTrajectory`
 * consumes, so the conversion is a data adapter and the interpolation stays in
 * the one tested place.
 *
 * Two fidelity statements, both of which matter more than they look:
 *
 * 1. Interpolation order. The MGS reference file — and most real OEMs — carry
 *    `INTERPOLATION = HERMITE` with `INTERPOLATION_DEGREE = 7`. We interpolate
 *    with cubic Hermite (degree 3) from the tabulated position and velocity.
 *    Between closely spaced samples the difference is far below anything
 *    visible, but this is a lower-order reconstruction than the file asks for,
 *    so an OEM ingested here is a faithful rendering of its samples rather
 *    than a bit-exact reproduction of the producer's own interpolant. Do not
 *    treat a value read back out of this path as authoritative for analysis.
 *
 * 2. Epoch conversion is not arithmetic. OEM epochs are calendar strings in a
 *    declared time system, and getting from there to ET needs leap seconds.
 *    We route every epoch through SPICE rather than subtracting a J2000
 *    constant, and refuse a time system we cannot convert exactly instead of
 *    guessing — a silent UTC-as-TDB read is a ~69 second error, which at LEO
 *    velocities puts a spacecraft roughly 500 km from where it belongs while
 *    looking entirely plausible.
 */
import type { Vec3 } from '../spice-injection.js';
import type { Oem } from '@cosmolabe/interop';
import type { StateRecord } from './InterpolatedStates.js';
import type { InertialFrameName } from '../rotations/RotationModel.js';
import { DEFAULT_FRAMES, type FrameRegistry } from '../frames/FrameRegistry.js';

/** Time systems we can hand to SPICE and get an exact answer for. CSPICE's
 *  str2et reads a trailing system token, so the conversion is the file's own
 *  declaration made explicit rather than assumed. */
const SUPPORTED_TIME_SYSTEMS: Record<string, string> = {
  UTC: 'UTC',
  TDB: 'TDB',
  TT: 'TDT', // CSPICE spells Terrestrial Time TDT
  TDT: 'TDT',
};

/**
 * The frame name for an OEM `REF_FRAME` (CCSDS 502.0 names: `EME2000`, `ICRF`,
 * `GCRF`, `TEME`, `TOD`, `ITRF-93`, `ITRF2000`, `TDR`, …). A name the registry
 * defines comes back canonical (`ITRF-93` → `ITRF`); any other non-empty name
 * (`MCI`, a mission or FK-defined frame) is kept as written, for the universe's
 * registry to resolve through SPICE or a catalog-declared frame. The file's
 * frame is authoritative either way; the loader reports one nothing resolves.
 * Undefined only when the file declares no frame.
 */
export function oemFrameName(
  refFrame: string | undefined,
  frames: FrameRegistry = DEFAULT_FRAMES,
): string | undefined {
  if (!refFrame || !refFrame.trim()) return undefined;
  return frames.canonicalName(refFrame);
}

/** EME2000, ICRF and EME2000_IERS: one label family whose meaning depends on
 *  the file's producer (see `FrameRegistry` on the frame bias). */
function isJ2000EquatorFamily(frame: string): boolean {
  return frame === 'EME2000' || frame === 'ICRF' || frame === 'EME2000_IERS';
}

/**
 * The frame an OEM's states are taken to be in: the file's `REF_FRAME`, unless
 * the catalog names another member of the J2000-equator family. "EME2000" means
 * SPICE's J2000 from a JPL producer and FK5 J2000 from Orekit or STK, and only
 * the catalog author knows which, so `trajectoryFrame: "EME2000_IERS"` on a
 * bias-aware producer's file is honoured. Any other disagreement leaves the
 * file's frame in charge (and `checkOemFrame` reports it).
 */
export function refineOemFrame(
  fileFrame: string | undefined,
  trajectoryFrame: string | undefined,
  frames: FrameRegistry = DEFAULT_FRAMES,
): string | undefined {
  if (!fileFrame || trajectoryFrame === undefined) return fileFrame;
  const item = frames.canonicalName(trajectoryFrame);
  if (isJ2000EquatorFamily(fileFrame) && isJ2000EquatorFamily(item)) return item;
  return fileFrame;
}

/**
 * Map an OEM `REF_FRAME` onto the two J2000 inertial frames of the old
 * three-bucket model.
 *
 * @deprecated Use `oemFrameName`, which keeps TEME, ICRF, EME2000 and ITRF
 * apart instead of collapsing them. Returns undefined for anything that is
 * neither J2000-equatorial nor J2000-ecliptic.
 */
export function oemRefFrameToInertial(refFrame: string | undefined): InertialFrameName | undefined {
  const name = oemFrameName(refFrame);
  if (name === 'EME2000' || name === 'ICRF') return 'EquatorJ2000';
  if (name === 'ECLIPJ2000') return 'EclipticJ2000';
  return undefined;
}

export interface OemFrameCheck {
  /** True when the catalog item declares no frame, or one that agrees with
   *  the file's, or when either is unrecognized and no claim can be made. */
  readonly ok: boolean;
  /** Human-readable explanation when `ok` is false. */
  readonly message?: string;
}

/**
 * Check an OEM's declared reference frame against the catalog item's
 * `trajectoryFrame`.
 *
 * The file's `REF_FRAME` is the frame of record — the loader tags the
 * trajectory with it and the frame registry rotates from it — so a catalog
 * that declares nothing is fine. A catalog that declares a *different* frame
 * is reported: it used to decide where the states were drawn, and it is how
 * Psyche and Voyager ended up ~12 million km off their bodies (the J2000
 * obliquity, 23.44°, about the parent), so an author relying on it should
 * hear that it no longer applies.
 */
export function checkOemFrame(
  oem: Oem,
  trajectoryFrame: string | undefined,
  frames: FrameRegistry = DEFAULT_FRAMES,
): OemFrameCheck {
  if (trajectoryFrame === undefined) return { ok: true };
  const fileFrame = oemFrameName(oem.metadata.refFrame, frames);
  const itemFrame = frames.canonicalName(trajectoryFrame);
  // A file frame the registry cannot see at all (no definition, no SPICE)
  // cannot be compared; the loader reports it as unresolvable instead.
  if (!fileFrame || !frames.get(fileFrame)) return { ok: true };
  if (frames.sameFrame(fileFrame, itemFrame)) return { ok: true };
  // Within the J2000-equator family a catalog declaration refines the file's
  // label rather than contradicting it (see `refineOemFrame`).
  if (isJ2000EquatorFamily(fileFrame) && isJ2000EquatorFamily(itemFrame)) return { ok: true };
  return {
    ok: false,
    message:
      `OEM frame mismatch: the file declares REF_FRAME=${oem.metadata.refFrame} ` +
      `(${fileFrame}) but the catalog item declares trajectoryFrame=${trajectoryFrame} ` +
      `(${itemFrame}). The file's frame is used; remove trajectoryFrame or set it to match.`,
  };
}

/** Convert an OEM epoch to ET via SPICE, honouring the file's time system. */
export function oemEpochToEt(
  epoch: string,
  timeSystem: string | undefined,
  str2et: (s: string) => number,
): number {
  const declared = (timeSystem ?? 'UTC').trim().toUpperCase();
  const token = SUPPORTED_TIME_SYSTEMS[declared];
  if (!token) {
    throw new Error(
      `OEM TIME_SYSTEM=${timeSystem} is not a system this ingest can convert exactly. ` +
        `Supported: ${Object.keys(SUPPORTED_TIME_SYSTEMS).join(', ')}. Refusing rather than ` +
        `guessing, since misreading the time system shifts every state by tens of seconds.`,
    );
  }
  // State the system explicitly rather than relying on CSPICE's default, so a
  // TDB file is never read as UTC. Two quirks make this fiddlier than it looks,
  // both confirmed against the engine rather than assumed:
  //
  //   - str2et REFUSES a system token appended to an ISO "T" string:
  //     "1996-12-18T12:00:00.331 TDB" is rejected outright ("uses the ISO
  //     \"T\" date/time delimiter but does not match any of the accepted ISO
  //     formats"). Swapping the T for a space gives the calendar form, which
  //     does take a token: "1996-12-18 12:00:00.331 TDB" parses.
  //   - a trailing Z is accepted on the ISO form but is redundant with an
  //     explicit token, so it comes off first.
  //
  // Only the first T is replaced; a fractional-second field never contains
  // one, and touching more would corrupt an otherwise valid string.
  const bare = epoch.trim().replace(/Z$/i, '').replace('T', ' ');
  return str2et(`${bare} ${token}`);
}

/**
 * Turn a parsed OEM into state records in ET.
 *
 * `str2et` is injected rather than reached for, so this stays a pure function
 * over the file plus a time authority — the same discipline the frames tier
 * applies, and what makes it testable without standing up an engine.
 */
export function oemToStateRecords(oem: Oem, str2et: (s: string) => number): StateRecord[] {
  const timeSystem = oem.metadata.timeSystem;
  const records: StateRecord[] = [];
  for (const state of oem.states) {
    records.push({
      et: oemEpochToEt(state.epoch, timeSystem, str2et),
      position: [...state.position] as Vec3,
      velocity: [...state.velocity] as Vec3,
    });
  }
  records.sort((a, b) => a.et - b.et);
  return records;
}
