import { describe, it, expect } from 'vitest';
import { parseOem } from './oem.ts';
import { writeOem } from './oem-write.ts';

describe('writeOem', () => {
  const oem = {
    version: '2.0',
    metadata: {
      objectName: 'CASSINI',
      objectId: '1997-061A',
      centerName: 'SATURN',
      refFrame: 'ICRF',
      timeSystem: 'UTC',
      startTime: '2004-001T00:00:00.000',
      stopTime: '2004-001T01:00:00.000',
    },
    states: [
      { epoch: '2004-001T00:00:00.000', position: [1, 2, 3] as const, velocity: [4, 5, 6] as const },
      { epoch: '2004-001T00:30:00.000', position: [7, 8, 9] as const, velocity: [10, 11, 12] as const },
    ],
  };

  it('round-trips through parseOem', () => {
    const round = parseOem(writeOem(oem));
    expect(round.version).toBe('2.0');
    expect(round.metadata).toEqual(oem.metadata);
    expect(round.states.length).toBe(2);
    // Numeric columns survive the exponential formatting exactly for small integers.
    expect(round.states[0]!.position).toEqual([1, 2, 3]);
    expect(round.states[1]!.velocity).toEqual([10, 11, 12]);
    expect(round.states[0]!.epoch).toBe('2004-001T00:00:00.000');
  });

  it('omits absent metadata fields and defaults the version', () => {
    const text = writeOem({ version: '', metadata: { objectName: 'X' }, states: oem.states });
    expect(text).toContain('CCSDS_OEM_VERS = 2.0');
    expect(text).toContain('OBJECT_NAME = X');
    expect(text).not.toContain('CENTER_NAME');
  });
});
