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
 * server tools or MCP servers, or raise the token cap.
 */
export function toAnthropicRequest(wire, { model, maxTokens }) {
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
  return {
    body: {
      model,
      max_tokens: maxTokens,
      system: checked.system,
      messages,
      tools: checked.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      // A declined request is retried on the model the API picks for that
      // category, inside the same call (with the beta header below).
      fallbacks: 'default',
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

export const anthropicProvider = {
  name: 'anthropic',
  defaultModel: 'claude-sonnet-5-5',
  url: 'https://api.anthropic.com/v1/messages',
  headers: (apiKey) => ({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' }),
  toRequest: toAnthropicRequest,
  fromResponse: (reply) => (reply && Array.isArray(reply.content) ? fromAnthropicMessage(reply) : null),
  usage: (reply) => ({ inputTokens: Number(reply.usage?.input_tokens) || 0, outputTokens: Number(reply.usage?.output_tokens) || 0, stop: reply.stop_reason ?? null }),
};
