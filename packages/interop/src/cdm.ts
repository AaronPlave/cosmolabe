// CCSDS Conjunction Data Message (CDM, KVN form; CCSDS 508.0-B) parser. Extracts the
// relative-state summary (time of closest approach, miss distance, relative speed) and
// the two objects' designators, the inputs a conjunction screen / Pc computation
// needs. Pure and headless; fails loudly. (STK_PARITY_SPEC §4.8/§4.11.)

export interface CdmObject {
  readonly designator?: string;
  readonly name?: string;
}

export interface Cdm {
  /** Time of closest approach as written (UTC ISO unless the time system says otherwise). */
  readonly tca: string;
  /** Miss distance at TCA (m). */
  readonly missDistanceM: number;
  /** Relative speed at TCA (m/s), when present. */
  readonly relativeSpeedMS?: number;
  readonly object1: CdmObject;
  readonly object2: CdmObject;
}

export class CdmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CdmError';
  }
}

/** Strip a trailing "[unit]" annotation and parse the leading number. */
function numericValue(raw: string): number {
  const v = raw.replace(/\[.*\]\s*$/, '').trim();
  const n = Number(v);
  if (!Number.isFinite(n)) throw new CdmError(`CDM value is not numeric: "${raw}"`);
  return n;
}

/** Parse a CCSDS CDM (KVN) document. */
export function parseCdm(text: string): Cdm {
  let version = '';
  let tca: string | undefined;
  let missDistanceM: number | undefined;
  let relativeSpeedMS: number | undefined;
  const objects: CdmObject[] = [];
  // Header/relative fields appear before the OBJECT blocks; per-object designators
  // attach to the current object once an "OBJECT = OBJECT1/2" line is seen.
  let current: { designator?: string; name?: string } | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('COMMENT')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    switch (key) {
      case 'CCSDS_CDM_VERS':
        version = value;
        break;
      case 'TCA':
        tca = value;
        break;
      case 'MISS_DISTANCE':
        missDistanceM = numericValue(value);
        break;
      case 'RELATIVE_SPEED':
        relativeSpeedMS = numericValue(value);
        break;
      case 'OBJECT':
        current = {};
        objects.push(current);
        break;
      case 'OBJECT_DESIGNATOR':
        if (current) current.designator = value;
        break;
      case 'OBJECT_NAME':
        if (current) current.name = value;
        break;
      default:
        break;
    }
  }

  if (version === '') throw new CdmError('not a CCSDS CDM (missing CCSDS_CDM_VERS)');
  if (tca === undefined) throw new CdmError('CDM missing TCA');
  if (missDistanceM === undefined) throw new CdmError('CDM missing MISS_DISTANCE');
  return {
    tca,
    missDistanceM,
    ...(relativeSpeedMS !== undefined ? { relativeSpeedMS } : {}),
    object1: objects[0] ?? {},
    object2: objects[1] ?? {},
  };
}
