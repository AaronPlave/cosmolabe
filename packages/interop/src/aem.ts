// CCSDS Attitude Ephemeris Message (AEM, KVN form; CCSDS 504.0-B) parser. Reads the
// metadata block and the tabulated attitude records, normalizing quaternions to the
// scalar-first [w, x, y, z] convention (matching @bessel/spice m2q/q2m). This closes
// the attitude-interchange seam with MONTE and other AMMOS/CCSDS producers. Pure and
// headless; fails loudly. Only the QUATERNION attitude type is supported today.
// (STK_PARITY_SPEC §4.11.)

export interface AemMetadata {
  readonly objectName?: string;
  readonly objectId?: string;
  readonly centerName?: string;
  /** Frame A and frame B; the rotation is between them per attitudeDir. */
  readonly refFrameA?: string;
  readonly refFrameB?: string;
  /** "A2B" or "B2A": the direction of the quaternion rotation. */
  readonly attitudeDir?: string;
  readonly timeSystem?: string;
  readonly startTime?: string;
  readonly stopTime?: string;
  /** Attitude representation; only "QUATERNION" is parsed. */
  readonly attitudeType?: string;
  /** "FIRST" or "LAST": whether the scalar component is first or last in the file. */
  readonly quaternionType?: string;
}

export interface AemRecord {
  /** Epoch as written (UTC ISO unless the time system says otherwise). */
  readonly epoch: string;
  /** Quaternion normalized to scalar-first [w, x, y, z]. */
  readonly quaternion: readonly [number, number, number, number];
}

export interface Aem {
  readonly version: string;
  readonly metadata: AemMetadata;
  readonly records: readonly AemRecord[];
}

export class AemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AemError';
  }
}

const META_KEYS: Record<string, keyof AemMetadata> = {
  OBJECT_NAME: 'objectName',
  OBJECT_ID: 'objectId',
  CENTER_NAME: 'centerName',
  REF_FRAME_A: 'refFrameA',
  REF_FRAME_B: 'refFrameB',
  ATTITUDE_DIR: 'attitudeDir',
  TIME_SYSTEM: 'timeSystem',
  START_TIME: 'startTime',
  STOP_TIME: 'stopTime',
  ATTITUDE_TYPE: 'attitudeType',
  QUATERNION_TYPE: 'quaternionType',
};

/** Parse a CCSDS AEM (KVN) document. */
export function parseAem(text: string): Aem {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('COMMENT'));
  let version = '';
  const metadata: Record<string, string> = {};
  const records: AemRecord[] = [];
  let inMeta = false;
  // The scalar position defaults to FIRST (scalar first) until a QUATERNION_TYPE says
  // otherwise.
  let scalarLast = false;

  for (const line of lines) {
    if (line.startsWith('CCSDS_AEM_VERS')) {
      version = line.split('=')[1]!.trim();
      continue;
    }
    if (line === 'META_START') {
      inMeta = true;
      continue;
    }
    if (line === 'META_STOP') {
      inMeta = false;
      scalarLast = (metadata.QUATERNION_TYPE ?? 'FIRST').toUpperCase() === 'LAST';
      continue;
    }
    if (line === 'DATA_START' || line === 'DATA_STOP') continue;
    if (line.includes('=')) {
      const [k, v] = line.split('=');
      metadata[k!.trim()] = v!.trim();
      continue;
    }
    if (inMeta) continue;

    // An attitude data line: epoch followed by the quaternion components.
    const attitudeType = (metadata.ATTITUDE_TYPE ?? 'QUATERNION').toUpperCase();
    if (attitudeType !== 'QUATERNION') {
      throw new AemError(`AEM attitude type ${attitudeType} is not supported (QUATERNION only)`);
    }
    const parts = line.split(/\s+/);
    if (parts.length < 5) throw new AemError(`AEM data line has too few fields: "${line}"`);
    const q = parts.slice(1, 5).map((s) => {
      const n = Number(s);
      if (!Number.isFinite(n)) throw new AemError(`AEM data line has a non-numeric field: "${line}"`);
      return n;
    });
    // Normalize to scalar-first [w, x, y, z].
    const quaternion: [number, number, number, number] = scalarLast
      ? [q[3]!, q[0]!, q[1]!, q[2]!]
      : [q[0]!, q[1]!, q[2]!, q[3]!];
    records.push({ epoch: parts[0]!, quaternion });
  }

  if (version === '') throw new AemError('not a CCSDS AEM (missing CCSDS_AEM_VERS)');
  if (records.length === 0) throw new AemError('AEM has no attitude records');

  const meta: AemMetadata = {};
  for (const [key, field] of Object.entries(META_KEYS)) {
    if (metadata[key] !== undefined) (meta as Record<string, string>)[field] = metadata[key]!;
  }
  return { version, metadata: meta, records };
}
