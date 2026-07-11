// AEM writer round-trip: a constructed attitude profile (a quaternion history) written
// with writeAem and re-read with parseAem must recover the metadata and the scalar-
// first quaternions within tolerance. This is the portable attitude read/write path
// standing in for native CK-binary IO (deferred until ck* CSPICE-WASM exports land).
// (STK_PARITY_SPEC section 4.6 ATT-7, section 4.11 INTEROP-AEM.)

import { describe, it, expect } from 'vitest';
import { parseAem } from './aem.ts';
import { writeAem } from './aem-write.ts';
import { AemError, type Aem } from './aem.ts';

const PROFILE: Aem = {
  version: '1.0',
  metadata: {
    objectName: 'TESTSAT',
    objectId: '2026-001A',
    centerName: 'EARTH',
    refFrameA: 'J2000',
    refFrameB: 'SC_BODY',
    attitudeDir: 'A2B',
    timeSystem: 'UTC',
    startTime: '2026-001T00:00:00.000',
    stopTime: '2026-001T00:02:00.000',
    attitudeType: 'QUATERNION',
    quaternionType: 'FIRST',
  },
  records: [
    { epoch: '2026-001T00:00:00.000', quaternion: [1, 0, 0, 0] },
    { epoch: '2026-001T00:01:00.000', quaternion: [0.707106781187, 0.707106781187, 0, 0] },
    { epoch: '2026-001T00:02:00.000', quaternion: [0, 0, 1, 0] },
  ],
};

describe('writeAem', () => {
  it('round-trips a profile through parse->write->parse', () => {
    const round = parseAem(writeAem(PROFILE));
    expect(round.version).toBe('1.0');
    expect(round.metadata.objectName).toBe('TESTSAT');
    expect(round.metadata.refFrameA).toBe('J2000');
    expect(round.metadata.refFrameB).toBe('SC_BODY');
    expect(round.records).toHaveLength(3);
    for (let i = 0; i < PROFILE.records.length; i++) {
      const a = PROFILE.records[i]!.quaternion;
      const b = round.records[i]!.quaternion;
      expect(round.records[i]!.epoch).toBe(PROFILE.records[i]!.epoch);
      for (let k = 0; k < 4; k++) expect(b[k]!).toBeCloseTo(a[k]!, 9);
    }
  });

  it('defaults ATTITUDE_TYPE and QUATERNION_TYPE so the scalar-first convention survives', () => {
    const minimal: Aem = {
      version: '',
      metadata: { objectName: 'X' },
      records: [{ epoch: '2026-001T00:00:00', quaternion: [0.5, 0.5, 0.5, 0.5] }],
    };
    const text = writeAem(minimal);
    expect(text).toContain('ATTITUDE_TYPE = QUATERNION');
    expect(text).toContain('QUATERNION_TYPE = FIRST');
    const round = parseAem(text);
    expect(round.records[0]!.quaternion).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it('preserves a stored quaternion even when metadata says QUATERNION_TYPE = LAST', () => {
    // Records are always stored and emitted scalar-first, so the writer must label the
    // file FIRST regardless of the source metadata. A stored 'LAST' must not flip the
    // round-trip ([1,0,0,0] must not read back as [0,1,0,0]).
    const lastLabeled: Aem = {
      version: '1.0',
      metadata: { objectName: 'X', quaternionType: 'LAST' },
      records: [{ epoch: '2026-001T00:00:00', quaternion: [1, 0, 0, 0] }],
    };
    const text = writeAem(lastLabeled);
    expect(text).toContain('QUATERNION_TYPE = FIRST');
    expect(text).not.toContain('QUATERNION_TYPE = LAST');
    const round = parseAem(text);
    expect(round.records[0]!.quaternion).toEqual([1, 0, 0, 0]);
  });

  it('fails loudly on an empty profile', () => {
    expect(() => writeAem({ version: '1.0', metadata: {}, records: [] })).toThrow(AemError);
  });
});
