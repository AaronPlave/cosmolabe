import { expect, it } from 'vitest';
import { estimatedCostUsd } from './cost.mjs';
it('prices cached reads and 5-minute writes separately from uncached input and output', () => {
  expect(estimatedCostUsd('anthropic', { model: 'claude-sonnet-5-5', inputTokens: 12, cacheReadTokens: 43231, cacheWriteTokens: 17898, outputTokens: 916 })).toBeCloseTo(0.0582521, 8);
  expect(estimatedCostUsd('openai', { model: 'gpt-5.1', inputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 10 })).toBeCloseTo(0.00035, 8);
  expect(estimatedCostUsd('anthropic', { model: 'unknown' })).toBeNull();
});
