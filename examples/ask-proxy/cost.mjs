/** Standard global first-party API USD per million tokens, checked 2026-11-02 (Haiku prompt-length tiers included).
 * https://platform.claude.com/docs/en/about-claude/pricing (5-minute writes)
 * https://developers.openai.com/api/docs/pricing (standard tier)
 * Estimates exclude taxes, regional/batch/priority rates and account discounts.
 * Unknown models deliberately have no estimate; never price a fallback as the requested model.
 */
const PRICES = {
  anthropic: {
    'claude-sonnet-5-5': [2, 0.1, 2.5, 10],
    'claude-opus-5-5': [4, 0.2, 5, 20],
    'claude-haiku-5-5': [0.1, 0.01, 0.125, 0.5],
  },
  openai: { 'gpt-5.1': [1.25, 0.125, 0, 10] },
};

export function estimatedCostUsd(provider, usage) {
  // Long-context rates depend on ALL prompt tokens, including cache reads/writes.
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const prices = provider === 'anthropic' && usage.model === 'claude-haiku-5-5'
    ? (promptTokens > 100_000 ? [0.5, 0.05, 0.625, 2.5] : [0.1, 0.01, 0.125, 0.5])
    : PRICES[provider]?.[usage.model];
  if (!prices) return null;
  return (usage.inputTokens * prices[0] + usage.cacheReadTokens * prices[1]
    + usage.cacheWriteTokens * prices[2] + usage.outputTokens * prices[3]) / 1_000_000;
}
