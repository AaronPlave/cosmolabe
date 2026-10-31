/**
 * The OpenAI Responses API, as a provider for the Ask proxy (`server.mjs`).
 *
 * Stateless (`store: false`): the whole conversation is sent every request, as
 * the viewer's history, so nothing is kept at the provider and the viewer's
 * conversation boundaries are the model's. The model's own output items (its
 * reasoning, messages and function calls) go back verbatim on its turns, as
 * `raw` and `provider` blocks, with encrypted reasoning included so a
 * reasoning model can continue a tool-using turn.
 */
import { checkWire, WIRE_VERSION } from './wire.mjs';

/** One assistant block as Responses input items, or an error string. */
function assistantItems(c) {
  if (!c || typeof c !== 'object') return 'content blocks must be objects';
  switch (c.type) {
    case 'text':
      if (typeof c.text !== 'string') return 'text blocks need text';
      return [c.raw ?? { role: 'assistant', content: c.text }];
    case 'tool_use':
      if (typeof c.id !== 'string' || typeof c.name !== 'string') return 'tool_use needs id and name';
      return [c.raw ?? { type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.input ?? {}) }];
    case 'provider':
      if (!c.block || typeof c.block !== 'object') return 'provider blocks need a block';
      return [c.block];
    default:
      return `unknown assistant content block ${JSON.stringify(c.type)}`;
  }
}

function userItems(c) {
  if (!c || typeof c !== 'object') return 'content blocks must be objects';
  switch (c.type) {
    case 'text':
      if (typeof c.text !== 'string') return 'text blocks need text';
      return [{ role: 'user', content: [{ type: 'input_text', text: c.text }] }];
    case 'tool_result':
      if (typeof c.toolUseId !== 'string' || typeof c.content !== 'string') return 'malformed tool_result';
      return [{ type: 'function_call_output', call_id: c.toolUseId, output: c.isError === true ? `Error: ${c.content}` : c.content }];
    default:
      return `unknown user content block ${JSON.stringify(c.type)}`;
  }
}

/**
 * The viewer's wire request as a Responses body, or `{ error }`. Built here:
 * a client cannot choose the model, add built-in tools (web search, code
 * interpreter, MCP) or raise the output cap.
 */
export function toOpenAIRequest(wire, { model, maxTokens, reasoningEffort }) {
  const checked = checkWire(wire);
  if (checked.error) return checked;
  const input = [];
  for (const m of checked.messages) {
    for (const c of m.content) {
      const items = m.role === 'assistant' ? assistantItems(c) : userItems(c);
      if (typeof items === 'string') return { error: items };
      input.push(...items);
    }
  }
  return {
    body: {
      model,
      instructions: checked.system,
      input,
      // Not strict: the viewer's schemas make optional fields optional, which
      // strict mode would require to be nullable.
      tools: checked.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false })),
      max_output_tokens: maxTokens,
      store: false,
      include: ['reasoning.encrypted_content'],
      parallel_tool_calls: false,
      ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    },
  };
}

/** A Responses reply in the wire format, or null when it is not one. */
export function fromOpenAIResponse(reply) {
  if (!reply || !Array.isArray(reply.output)) return null;
  const content = [];
  let calls = false;
  let refused = false;
  for (const item of reply.output) {
    if (item?.type === 'message') {
      const parts = Array.isArray(item.content) ? item.content : [];
      if (parts.some((p) => p?.type === 'refusal')) refused = true;
      const text = parts.filter((p) => p?.type === 'output_text').map((p) => p.text).join('');
      content.push(text !== '' ? { type: 'text', text, raw: item } : { type: 'provider', block: item });
    } else if (item?.type === 'function_call') {
      let input;
      try {
        input = JSON.parse(item.arguments || '{}');
      } catch {
        input = String(item.arguments); // not an object: the loop's schema check answers it with `invalid-input`
      }
      calls = true;
      content.push({ type: 'tool_use', id: item.call_id, name: item.name, input, raw: item });
    } else {
      content.push({ type: 'provider', block: item });
    }
  }
  const reason = reply.incomplete_details?.reason;
  const stop = calls ? 'tool_use'
    : refused || reason === 'content_filter' ? 'refusal'
      : reply.status === 'incomplete' && reason === 'max_output_tokens' ? 'max_tokens'
        : reply.status === 'completed' ? 'end'
          : 'other';
  return { version: WIRE_VERSION, content, stop };
}

export const openaiProvider = {
  name: 'openai',
  defaultModel: 'gpt-5.1',
  url: 'https://api.openai.com/v1/responses',
  headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  toRequest: toOpenAIRequest,
  fromResponse: fromOpenAIResponse,
  usage: (reply) => ({
    // The model the provider says answered, which is not always the one asked for.
    model: typeof reply.model === 'string' && reply.model ? reply.model : null,
    inputTokens: Number(reply.usage?.input_tokens) || 0,
    outputTokens: Number(reply.usage?.output_tokens) || 0,
    stop: reply.status ?? null,
  }),
};
