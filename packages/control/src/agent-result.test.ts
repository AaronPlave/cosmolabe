import { describe, expect, it } from 'vitest';
import { resultText } from './agent-loop.js';

describe('model-visible result budgets', () => {
  it('shrinks an oversized page as complete records with a resumable nextOffset', () => {
    const activities = Array.from({ length: 75 }, (_, i) => ({ id: `flight-${i}`, name: 'name'.repeat(20) }));
    const text = resultText({ ok: true, summary: '75 matching', data: { total: 75, offset: 0, returned: 75, nextOffset: null, complete: true, activities } }, 800);
    expect(text.length).toBeLessThanOrEqual(800);
    const parsed = JSON.parse(text);
    expect(parsed.data).toMatchObject({ total: 75, complete: false, partial: true });
    expect(parsed.data.activities.length).toBeGreaterThan(0);
    expect(parsed.data.nextOffset).toBe(parsed.data.activities.length);
    expect(parsed.data.returned).toBe(parsed.data.activities.length);
  });
  it('explicitly omits a huge single record rather than returning broken JSON', () => {
    const parsed = JSON.parse(resultText({ ok: true, summary: 'details', data: { secret: 'x'.repeat(10000) } }, 500));
    expect(parsed).toMatchObject({ partial: true, code: 'result-too-large' });
    expect(parsed.data).toBeUndefined();
  });
});
