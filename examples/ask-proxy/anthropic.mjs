/** The Anthropic Messages API, as a provider for the Ask proxy (`server.mjs`). */
import { checkWire, WIRE_VERSION } from './wire.mjs';

/** One wire content block as an Anthropic block, or an error string. */
function toBlock(c, role) {
  if (!c || typeof c !== 'object') return 'content blocks must be objects';
  switch (c.type) {
    case 'text':
      if (typeof c.text !== 'string') return 'text blocks need text';
      return role === 'assistant' && c.raw ? c.raw : { type: 'text', text: c.text };
    case 'tool_use':
      if (role !== 'assistant') return 'tool_use belongs to the assistant';
      return c.raw ?? { type: 'tool_use', id: c.id, name: c.name, input: c.input };
    case 'tool_result':
      if (role !== 'user' || typeof c.toolUseId !== 'string' || typeof c.content !== 'string') return 'malformed tool_result';
      return { type: 'tool_result', tool_use_id: c.toolUseId, content: c.content, is_error: c.isError === true };
    case 'provider':
      // The model's own blocks (its thinking, say), carried back on its turns.
      if (role !== 'assistant' || !c.block || typeof c.block !== 'object') return 'provider blocks belong to the assistant';
      return c.block;
    default:
      return `unknown content block ${JSON.stringify(c.type)}`;
  }
}

/**
 * The viewer's wire request as an Anthropic Messages body, or `{ error }`.
 * The proxy builds the body itself, so a client cannot choose the model, add
 * server tools or MCP servers, or raise the token cap. The request names one
 * model and nothing else: provider-side model fallback, which can answer on a
 * different (possibly dearer) model, is off unless `fallback` is set.
 *
 * Prompt caching (5-minute, `cache`, on by default) marks two breakpoints: the
 * system prompt, which with the tools before it is the stable prefix, and the
 * last block of the conversation, so each round of a tool-using request
 * re-reads the history the last round wrote. It lowers what repeated rounds
 * cost to process, not how many tokens they carry.
 */
export function toAnthropicRequest(wire, { model, maxTokens, fallback = false, cache = true }) {
  const checked = checkWire(wire);
  if (checked.error) return checked;
  const messages = [];
  for (const m of checked.messages) {
    const content = [];
    for (const c of m.content) {
      const block = toBlock(c, m.role);
      if (typeof block === 'string') return { error: block };
      content.push(block);
    }
    messages.push({ role: m.role, content });
  }
  if (cache) {
    // The last block of the last message, on a copy: provider blocks go back as sent.
    const last = messages.at(-1).content;
    if (last.length > 0 && last.at(-1).type !== 'thinking' && last.at(-1).type !== 'redacted_thinking') {
      last[last.length - 1] = { ...last.at(-1), cache_control: { type: 'ephemeral' } };
    }
  }
  return {
    body: {
      model,
      max_tokens: maxTokens,
      system: cache ? [{ type: 'text', text: checked.system, cache_control: { type: 'ephemeral' } }] : checked.system,
      messages,
      tools: checked.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      // Opt-in: a declined request is retried on the model the API picks for
      // that category, inside the same call (with `FALLBACK_BETA`).
      ...(fallback ? { fallbacks: 'default' } : {}),
    },
  };
}

const STOPS = { end_turn: 'end', stop_sequence: 'end', tool_use: 'tool_use', max_tokens: 'max_tokens', refusal: 'refusal' };

/** An Anthropic reply in the wire format. Every block is kept for replay. */
export function fromAnthropicMessage(message) {
  const content = (message.content ?? []).map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text, raw: block };
    if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: block.input, raw: block };
    return { type: 'provider', block };
  });
  return { version: WIRE_VERSION, content, stop: STOPS[message.stop_reason] ?? 'other' };
}

/** The beta header the `fallbacks` request field needs; sent only with it. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export const anthropicProvider = {
  name: 'anthropic',
  defaultModel: 'claude-sonnet-5-5',
  url: 'https://api.anthropic.com/v1/messages',
  headers: (apiKey, { fallback = false } = {}) => ({
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    ...(fallback ? { 'anthropic-beta': FALLBACK_BETA } : {}),
  }),
  toRequest: toAnthropicRequest,
  fromResponse: (reply) => (reply && Array.isArray(reply.content) ? fromAnthropicMessage(reply) : null),
  usage: (reply) => ({
    // The model the provider says answered, which is not always the one asked for.
    model: typeof reply.model === 'string' && reply.model ? reply.model : null,
    // Anthropic reports input in three parts that do not overlap.
    uncachedInputTokens: Number(reply.usage?.input_tokens) || 0,
    outputTokens: Number(reply.usage?.output_tokens) || 0,
    cacheReadTokens: Number(reply.usage?.cache_read_input_tokens) || 0,
    cacheWriteTokens: Number(reply.usage?.cache_creation_input_tokens) || 0,
    // Per the API's contract, a fallback shows as a `fallback_message` entry in
    // `usage.iterations`; a reply with the list and no such entry was served by
    // the requested model. Null when the reply has no list to say.
    fallback: Array.isArray(reply.usage?.iterations) ? reply.usage.iterations.some((i) => i?.type === 'fallback_message') : null,
    stop: reply.stop_reason ?? null,
  }),
};
