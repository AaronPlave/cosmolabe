// CCSDS Orbit Ephemeris Message (OEM, KVN form; CCSDS 502.0-B) parser. Pure and
// headless: reads the metadata block and the tabulated state lines. Fails loudly
// with a located error. The caller turns epochs into ET and may build an SPK.
// (STK_PARITY_SPEC §4.11, INTEROP-OEM.)

export interface OemMetadata {
  readonly objectName?: string;
  readonly objectId?: string;
  readonly centerName?: string;
  readonly refFrame?: string;
  readonly timeSystem?: string;
  readonly startTime?: string;
  readonly stopTime?: string;
}

export interface OemState {
  /** Epoch as written in the file (UTC ISO unless the time system says otherwise). */
  readonly epoch: string;
  readonly position: readonly [number, number, number]; // km
  readonly velocity: readonly [number, number, number]; // km/s
}

export interface Oem {
  readonly version: string;
  readonly metadata: OemMetadata;
  readonly states: readonly OemState[];
}

export class OemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OemError';
  }
}

const META_KEYS: Record<string, keyof OemMetadata> = {
  OBJECT_NAME: 'objectName',
  OBJECT_ID: 'objectId',
  CENTER_NAME: 'centerName',
  REF_FRAME: 'refFrame',
  TIME_SYSTEM: 'timeSystem',
  START_TIME: 'startTime',
  STOP_TIME: 'stopTime',
};

/** Parse a CCSDS OEM (KVN) document. */
export function parseOem(text: string): Oem {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('COMMENT'));
  let version = '';
  const metadata: Record<string, string> = {};
  const states: OemState[] = [];
  let inMeta = false;

  for (const line of lines) {
    if (line.startsWith('CCSDS_OEM_VERS')) {
      version = line.split('=')[1]!.trim();
      continue;
    }
    if (line === 'META_START') {
      inMeta = true;
      continue;
    }
    if (line === 'META_STOP') {
      inMeta = false;
      continue;
    }
    if (line.includes('=')) {
      // A '=' line is metadata only inside a META block. Outside META it is a header
      // line (CREATION_DATE, ORIGINATOR) or a data-region label (a COVARIANCE_START
      // section key, USER_DEFINED_x, ...): skip it so it neither overwrites a segment's
      // metadata (a second META would clobber the first) nor reaches the data parser.
      if (inMeta) {
        const [k, v] = line.split('=');
        metadata[k!.trim()] = v!.trim();
      }
      continue;
    }
    if (inMeta) continue;
    // An ephemeris data line: epoch followed by 6 (or 9 with acceleration) numbers.
    const parts = line.split(/\s+/);
    if (parts.length < 7) throw new OemError(`OEM data line has too few fields: "${line}"`);
    const nums = parts.slice(1, 7).map((s) => {
      const n = Number(s);
      if (!Number.isFinite(n)) throw new OemError(`OEM data line has a non-numeric field: "${line}"`);
      return n;
    });
    states.push({
      epoch: parts[0]!,
      position: [nums[0]!, nums[1]!, nums[2]!],
      velocity: [nums[3]!, nums[4]!, nums[5]!],
    });
  }

  if (version === '') throw new OemError('not a CCSDS OEM (missing CCSDS_OEM_VERS)');
  if (states.length === 0) throw new OemError('OEM has no ephemeris data lines');

  const meta: OemMetadata = {};
  for (const [key, field] of Object.entries(META_KEYS)) {
    if (metadata[key] !== undefined) (meta as Record<string, string>)[field] = metadata[key]!;
  }
  return { version, metadata: meta, states };
}
