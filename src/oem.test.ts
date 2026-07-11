// CCSDS OEM parser validated against a reference sample (CCSDS 502.0-B style), plus
// loud failures on malformed input. (STK_PARITY_SPEC §4.11.)

import { describe, it, expect } from 'vitest';
import { parseOem, OemError } from './index.ts';

const SAMPLE = `CCSDS_OEM_VERS = 2.0
CREATION_DATE = 2020-001T00:00:00
ORIGINATOR = BESSEL
META_START
OBJECT_NAME = PROBE
OBJECT_ID = 2020-001A
CENTER_NAME = EARTH
REF_FRAME = ICRF
TIME_SYSTEM = UTC
START_TIME = 2020-01-01T00:00:00.000
STOP_TIME = 2020-01-01T00:02:00.000
META_STOP
2020-01-01T00:00:00.000  6678.0 0.0 0.0  0.0 7.726 0.0
2020-01-01T00:01:00.000  6660.0 463.0 0.0  -0.535 7.707 0.0
2020-01-01T00:02:00.000  6606.0 925.0 0.0  -1.070 7.650 0.0
`;

describe('parseOem', () => {
  it('parses the metadata block', () => {
    const oem = parseOem(SAMPLE);
    expect(oem.version).toBe('2.0');
    expect(oem.metadata.objectName).toBe('PROBE');
    expect(oem.metadata.centerName).toBe('EARTH');
    expect(oem.metadata.refFrame).toBe('ICRF');
    expect(oem.metadata.timeSystem).toBe('UTC');
  });

  it('parses the ephemeris state lines', () => {
    const oem = parseOem(SAMPLE);
    expect(oem.states).toHaveLength(3);
    expect(oem.states[0]!.epoch).toBe('2020-01-01T00:00:00.000');
    expect(oem.states[0]!.position).toEqual([6678.0, 0.0, 0.0]);
    expect(oem.states[0]!.velocity).toEqual([0.0, 7.726, 0.0]);
    expect(oem.states[2]!.position[1]).toBe(925.0);
  });

  it('fails loudly on a non-OEM document', () => {
    expect(() => parseOem('hello world')).toThrow(OemError);
  });

  it('fails loudly on a malformed data line', () => {
    const bad = SAMPLE.replace('-0.535 7.707 0.0', '-0.535 oops 0.0');
    expect(() => parseOem(bad)).toThrow(OemError);
  });

  it('does not capture a "=" line outside META as metadata', () => {
    // A covariance/USER_DEFINED key after META_STOP must not overwrite the segment's
    // metadata: REF_FRAME stays ICRF rather than being clobbered by a stray label.
    const withTrailing = SAMPLE.replace(
      'META_STOP\n',
      'META_STOP\nREF_FRAME = HIJACKED\nUSER_DEFINED_X = 1\n',
    );
    const oem = parseOem(withTrailing);
    expect(oem.metadata.refFrame).toBe('ICRF');
    expect(oem.states).toHaveLength(3);
  });
});
