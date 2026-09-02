// Real-data fixture: the canonical CCSDS 502.0-B OEM example (Mars Global Surveyor)
// is parsed and round-tripped, so the ingest path is exercised against an operational
// message, not only hand-built strings. (STK_PARITY_SPEC §4.11.)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseOem } from './oem.ts';
import { writeOem } from './oem-write.ts';

const text = readFileSync(fileURLToPath(new URL('../test-fixtures/mgs.oem', import.meta.url)), 'utf8');

describe('OEM real-data fixture (MGS)', () => {
  it('parses the metadata and ephemeris of the CCSDS example', () => {
    const oem = parseOem(text);
    expect(oem.version).toBe('2.0');
    expect(oem.metadata.objectName).toBe('MARS GLOBAL SURVEYOR');
    expect(oem.metadata.objectId).toBe('1996-062A');
    expect(oem.metadata.centerName).toBe('MARS BARYCENTER');
    expect(oem.metadata.refFrame).toBe('EME2000');
    expect(oem.states).toHaveLength(3);
    expect(oem.states[0]!.position).toEqual([2789.6, -280.0, -1746.8]);
    expect(oem.states[0]!.velocity).toEqual([4.73, -2.5, -1.04]);
    expect(oem.states[2]!.epoch).toBe('1996-12-18T12:02:00.331');
  });

  it('round-trips the fixture through writeOem', () => {
    const round = parseOem(writeOem(parseOem(text)));
    expect(round.metadata.objectName).toBe('MARS GLOBAL SURVEYOR');
    expect(round.states).toHaveLength(3);
    expect(round.states[1]!.position).toEqual([2783.4, -308.1, -1877.1]);
  });
});
