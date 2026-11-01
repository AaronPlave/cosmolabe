/** Standard global first-party API USD per million tokens, checked 2026-11-01.
 * https://platform.claude.com/docs/en/about-claude/pricing (5-minute writes)
 * https://developers.openai.com/api/docs/pricing (standard tier)
 * Estimates exclude taxes, regional/batch/priority rates and account discounts.
 * Unknown models deliberately have no estimate; never price a fallback as the requested model.
 */
const PRICES = {
  anthropic: {
    'claude-sonnet-5-5': [2, 0.1, 2.5, 10],
    'claude-opus-5-5': [4, 0.2, 5, 20],
  },
  openai: { 'gpt-5.1': [1.25, 0.125, 0, 10] },
};

export function estimatedCostUsd(provider, usage) {
  const prices = PRICES[provider]?.[usage.model];
  if (!prices) return null;
  return (usage.inputTokens * prices[0] + usage.cacheReadTokens * prices[1]
    + usage.cacheWriteTokens * prices[2] + usage.outputTokens * prices[3]) / 1_000_000;
}
