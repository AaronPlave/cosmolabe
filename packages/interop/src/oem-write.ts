// CCSDS Orbit Ephemeris Message (OEM, KVN form; CCSDS 502.0-B) writer. The inverse
// of parseOem: serialize a metadata block and tabulated state lines so a computed
// trajectory can be exported and round-tripped. Pure and headless. (STK §4.11.)

import type { Oem, OemMetadata, OemState } from './oem.ts';

const META_ORDER: readonly (readonly [string, keyof OemMetadata])[] = [
  ['OBJECT_NAME', 'objectName'],
  ['OBJECT_ID', 'objectId'],
  ['CENTER_NAME', 'centerName'],
  ['REF_FRAME', 'refFrame'],
  ['TIME_SYSTEM', 'timeSystem'],
  ['START_TIME', 'startTime'],
  ['STOP_TIME', 'stopTime'],
];

function stateLine(s: OemState): string {
  const cols = [...s.position, ...s.velocity].map((n) => n.toExponential(12));
  return [s.epoch, ...cols].join(' ');
}

/**
 * Serialize an OEM (KVN) document. The version defaults to the current CCSDS OEM
 * revision; the header CREATION_DATE and ORIGINATOR are emitted when present (they
 * carry the file's provenance in its own terms); metadata fields are emitted in the
 * standard order, omitting absent ones. `parseOem(writeOem(oem))` reproduces the
 * version, header, metadata, and states.
 */
export function writeOem(oem: Oem): string {
  const lines: string[] = [];
  lines.push(`CCSDS_OEM_VERS = ${oem.version || '2.0'}`);
  if (oem.creationDate !== undefined) lines.push(`CREATION_DATE = ${oem.creationDate}`);
  if (oem.originator !== undefined) lines.push(`ORIGINATOR = ${oem.originator}`);
  lines.push('META_START');
  for (const [key, field] of META_ORDER) {
    const value = oem.metadata[field];
    if (value !== undefined) lines.push(`${key} = ${value}`);
  }
  lines.push('META_STOP');
  for (const s of oem.states) lines.push(stateLine(s));
  return lines.join('\n') + '\n';
}
