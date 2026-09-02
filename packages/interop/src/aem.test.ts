import { describe, it, expect } from 'vitest';
import { parseAem, AemError } from './aem.ts';

const HEADER = `CCSDS_AEM_VERS = 1.0
CREATION_DATE = 2004-001T00:00:00
ORIGINATOR = JPL

META_START
OBJECT_NAME = CASSINI
OBJECT_ID = 1997-061A
CENTER_NAME = SATURN
REF_FRAME_A = J2000
REF_FRAME_B = SC_BODY
ATTITUDE_DIR = A2B
TIME_SYSTEM = UTC
START_TIME = 2004-001T00:00:00.000
STOP_TIME = 2004-001T00:02:00.000
ATTITUDE_TYPE = QUATERNION`;

describe('parseAem', () => {
  it('parses metadata and normalizes a scalar-first quaternion to [w,x,y,z]', () => {
    const aem = parseAem(`${HEADER}
QUATERNION_TYPE = FIRST
META_STOP

DATA_START
2004-001T00:00:00.000 1.0 0.0 0.0 0.0
2004-001T00:01:00.000 0.7071 0.7071 0.0 0.0
DATA_STOP
`);
    expect(aem.version).toBe('1.0');
    expect(aem.metadata.objectName).toBe('CASSINI');
    expect(aem.metadata.refFrameA).toBe('J2000');
    expect(aem.metadata.refFrameB).toBe('SC_BODY');
    expect(aem.records).toHaveLength(2);
    // Scalar first: file [QC,Q1,Q2,Q3] -> [w,x,y,z] directly.
    expect(aem.records[0]!.quaternion).toEqual([1, 0, 0, 0]);
    expect(aem.records[1]!.quaternion[0]).toBeCloseTo(0.7071, 4); // w
    expect(aem.records[1]!.quaternion[1]).toBeCloseTo(0.7071, 4); // x
    expect(aem.records[0]!.epoch).toBe('2004-001T00:00:00.000');
  });

  it('reorders a scalar-last quaternion to scalar-first', () => {
    const aem = parseAem(`${HEADER}
QUATERNION_TYPE = LAST
META_STOP
2004-001T00:00:00.000 0.0 0.0 0.0 1.0
`);
    // Scalar last: file [Q1,Q2,Q3,QC] -> [w=QC, x=Q1, y=Q2, z=Q3].
    expect(aem.records[0]!.quaternion).toEqual([1, 0, 0, 0]);
  });

  it('rejects a non-AEM document and an unsupported attitude type', () => {
    expect(() => parseAem('FOO = 1')).toThrow(AemError);
    const euler = `CCSDS_AEM_VERS = 1.0
META_START
ATTITUDE_TYPE = EULER_ANGLE
META_STOP
2004-001T00:00:00.000 10 20 30
`;
    expect(() => parseAem(euler)).toThrow(/EULER_ANGLE/);
  });
});
