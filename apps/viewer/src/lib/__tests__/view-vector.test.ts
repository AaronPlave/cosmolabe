import { describe, expect, it } from 'vitest';
import { parseViewVector } from '../view-vector';

describe('view vector fields', () => {
  it('accepts numbers as a number input binds them, and strings', () => {
    expect(parseViewVector(0, 1.5, -2)).toEqual({ ok: true, vector: [0, 1.5, -2] });
    expect(parseViewVector('0', '0', '1')).toEqual({ ok: true, vector: [0, 0, 1] });
  });

  it('refuses blank, non-numeric and zero vectors with a reason', () => {
    expect(parseViewVector(null, 1, 1)).toMatchObject({ ok: false });
    expect(parseViewVector('', '1', '1')).toMatchObject({ ok: false });
    expect(parseViewVector('a', '1', '1')).toMatchObject({ ok: false });
    expect(parseViewVector(0, 0, 0)).toMatchObject({ ok: false, reason: expect.stringContaining('zero') });
  });
});
