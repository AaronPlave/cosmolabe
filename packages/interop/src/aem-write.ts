// CCSDS Attitude Ephemeris Message (AEM, KVN form; CCSDS 504.0-B) writer, the inverse
// of parseAem. Serializes the metadata block and the tabulated quaternion records so a
// computed attitude history can be exported and round-tripped. Quaternions are written
// scalar-first ([w, x, y, z], QUATERNION_TYPE = FIRST), matching @bessel/spice m2q/q2m.
// This is the portable attitude-interchange path; a native CK binary write needs new
// CSPICE-WASM exports (ckopn/ckw03/ckcls) that are not yet bound, so CK-binary IO is
// deferred and the AEM round-trip closes the read/write seam meanwhile. Pure and
// headless; fails loudly. (STK_PARITY_SPEC section 4.6 ATT-7, section 4.11 INTEROP-AEM.)

import type { Aem, AemMetadata, AemRecord } from './aem.ts';
import { AemError } from './aem.ts';

const META_ORDER: readonly (readonly [string, keyof AemMetadata])[] = [
  ['OBJECT_NAME', 'objectName'],
  ['OBJECT_ID', 'objectId'],
  ['CENTER_NAME', 'centerName'],
  ['REF_FRAME_A', 'refFrameA'],
  ['REF_FRAME_B', 'refFrameB'],
  ['ATTITUDE_DIR', 'attitudeDir'],
  ['TIME_SYSTEM', 'timeSystem'],
  ['START_TIME', 'startTime'],
  ['STOP_TIME', 'stopTime'],
  ['ATTITUDE_TYPE', 'attitudeType'],
  ['QUATERNION_TYPE', 'quaternionType'],
];

function recordLine(r: AemRecord): string {
  // Scalar-first: epoch q0(w) q1(x) q2(y) q3(z).
  const q = r.quaternion.map((n) => n.toExponential(12));
  return [r.epoch, ...q].join(' ');
}

/**
 * Serialize an AEM (KVN) document. The version defaults to the current CCSDS AEM
 * revision; ATTITUDE_TYPE defaults to QUATERNION and QUATERNION_TYPE to FIRST so the
 * scalar-first convention round-trips through parseAem. Records are written in order.
 * `parseAem(writeAem(aem))` reproduces the version, metadata, and (scalar-first)
 * quaternions.
 */
export function writeAem(aem: Aem): string {
  if (aem.records.length === 0) throw new AemError('writeAem: AEM has no attitude records');
  const lines: string[] = [];
  lines.push(`CCSDS_AEM_VERS = ${aem.version || '1.0'}`);
  lines.push('META_START');
  const meta = aem.metadata;
  for (const [key, field] of META_ORDER) {
    let value = meta[field];
    if (key === 'ATTITUDE_TYPE') value = value ?? 'QUATERNION';
    // Records are stored scalar-first ([w, x, y, z]) and recordLine emits them in that
    // order, so the written type must be FIRST regardless of the source metadata.
    // Honoring a stored 'LAST' would mislabel scalar-first components and corrupt the
    // round-trip ([1,0,0,0] reads back as [0,1,0,0]).
    if (key === 'QUATERNION_TYPE') value = 'FIRST';
    if (value !== undefined) lines.push(`${key} = ${value}`);
  }
  lines.push('META_STOP');
  lines.push('DATA_START');
  for (const r of aem.records) lines.push(recordLine(r));
  lines.push('DATA_STOP');
  return lines.join('\n') + '\n';
}
