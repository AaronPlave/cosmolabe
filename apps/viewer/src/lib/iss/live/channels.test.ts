import { describe, it, expect } from 'vitest';
import { CoherentAssembler } from './assembler.js';
import { CANDIDATE_JOINT_ITEMS, issLiveTransportConfig, parseIssLiveTimestamp } from './channels.js';
import { ARRAY_JOINTS, TRUSS_JOINTS } from '../joints.js';

describe('ISS Live channel mapping', () => {
  it('parses TimeStamp as hours since 31 Dec of the previous year (1 Jan 00:00 = 24.0)', () => {
    expect(parseIssLiveTimestamp('24', 2026)).toBe(Date.UTC(2026, 0, 1));
    expect(parseIssLiveTimestamp('48.5', 2026)).toBe(Date.UTC(2026, 0, 2, 0, 30));
    expect(parseIssLiveTimestamp('junk', 2026)).toBeNaN();
    expect(parseIssLiveTimestamp('0', 2026)).toBeNaN();
  });

  it('maps every rig joint to a distinct item', () => {
    const keys = Object.keys(CANDIDATE_JOINT_ITEMS).sort();
    expect(keys).toEqual([...TRUSS_JOINTS.map((j) => `truss:${j}`), ...ARRAY_JOINTS.map((j) => `array:${j}`)].sort());
    expect(new Set(Object.values(CANDIDATE_JOINT_ITEMS)).size).toBe(keys.length);
  });

  it('asks for the status field and the transport config carries the good class', () => {
    const c = issLiveTransportConfig(() => Date.UTC(2026, 10, 9));
    expect(c.fields).toContain('Status.Class');
    expect(c.goodStatus).toBe('24');
    expect(c.parseSourceTime('24')).toBe(Date.UTC(2026, 0, 1));
  });
});

describe('provider status flag', () => {
  it('refuses values the provider marked not good', () => {
    const now = 1_800_000_000_000;
    const a = new CoherentAssembler(['q'], { now: () => now });
    expect(a.accept({ item: 'q', value: 1, sourceTimeMs: now - 100, valid: false })).toEqual({ kind: 'rejected', reason: 'invalid-status' });
    expect(a.accept({ item: 'q', value: 1, sourceTimeMs: now - 100, valid: true }).kind).toBe('sample');
  });
});
