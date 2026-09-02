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
import type { Vec3 } from '@cosmolabe/spice';
import type { Oem } from '@cosmolabe/interop';
import type { StateRecord } from './InterpolatedStates.js';
import type { InertialFrameName } from '../rotations/RotationModel.js';

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
 * Map an OEM `REF_FRAME` onto the inertial frame the states are expressed in.
 *
 * EME2000, J2000 and ICRF are the same equatorial frame for our purposes (ICRF
 * and J2000 differ by well under an arcsecond — far below anything this
 * pipeline resolves). Returns undefined for a frame we don't recognize, which
 * the caller should treat as "cannot verify" rather than "no frame".
 */
export function oemRefFrameToInertial(refFrame: string | undefined): InertialFrameName | undefined {
  if (!refFrame) return undefined;
  switch (refFrame.trim().toUpperCase()) {
    case 'EME2000':
    case 'J2000':
    case 'ICRF':
    case 'GCRF':
      return 'EquatorJ2000';
    case 'ECLIPJ2000':
    case 'ECLIPTIC':
      return 'EclipticJ2000';
    default:
      return undefined;
  }
}

/** What a catalog item's 3-bucket `trajectoryFrame` means as an inertial frame. */
function itemFrameToInertial(trajectoryFrame: string | undefined): InertialFrameName | undefined {
  switch (trajectoryFrame) {
    case undefined:
    case 'ecliptic':
    case 'EclipticJ2000':
    case 'ECLIPJ2000':
      return 'EclipticJ2000';
    case 'equatorial':
    case 'EquatorJ2000':
    case 'J2000':
      return 'EquatorJ2000';
    default:
      return undefined;
  }
}

export interface OemFrameCheck {
  /** True when the file's frame and the catalog item's frame agree, or when
   *  one of them is unrecognized and no claim can be made. */
  readonly ok: boolean;
  /** Human-readable explanation when `ok` is false. */
  readonly message?: string;
}

/**
 * Check an OEM's declared reference frame against the catalog item's
 * `trajectoryFrame`.
 *
 * This exists because the failure it catches is silent and expensive. A child
 * whose declared frame does not match the frame its states are actually in
 * still renders — it just renders in the wrong place, off by the J2000
 * obliquity (23.44 degrees) about the parent. At Psyche and Voyager distances
 * that put trajectory lines roughly 12 million km from the body they belong
 * to, and nothing in the pipeline complained. An OEM makes the mismatch
 * checkable for the first time, because the file states its own frame.
 */
export function checkOemFrame(oem: Oem, trajectoryFrame: string | undefined): OemFrameCheck {
  const fileFrame = oemRefFrameToInertial(oem.metadata.refFrame);
  const itemFrame = itemFrameToInertial(trajectoryFrame);
  if (!fileFrame || !itemFrame) return { ok: true };
  if (fileFrame === itemFrame) return { ok: true };
  return {
    ok: false,
    message:
      `OEM frame mismatch: the file declares REF_FRAME=${oem.metadata.refFrame} ` +
      `(${fileFrame}) but the catalog item declares trajectoryFrame=` +
      `${trajectoryFrame ?? '(default ecliptic)'} (${itemFrame}). The states will be ` +
      `rendered as if they were ${itemFrame}, placing them off by the J2000 obliquity ` +
      `(23.44 degrees) about the parent body. Set trajectoryFrame to match the file.`,
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
