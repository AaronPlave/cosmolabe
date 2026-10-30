/**
 * The one real provider path for the Ask prompt (#311): an `AgentTransport`
 * over the Anthropic Messages API, through the official SDK.
 *
 * Two ways in, and neither puts a permanent key in the page:
 *
 * - **proxy** — `baseURL` is a deployment's own server (`examples/ask-proxy`),
 *   which holds the key and forwards the request. The SDK still wants a key
 *   to send; it gets a placeholder the proxy discards.
 * - **byok** — development only: a key the person pasted, held in memory by
 *   the caller and sent from the browser.
 *
 * The SDK is imported when the first request goes out, so a viewer that never
 * opens the prompt never downloads it.
 */
import type { AgentContent, AgentRequest, AgentResponse, AgentStop, AgentTransport, ScriptCancelSignal } from '@cosmolabe/control';
import type Anthropic from '@anthropic-ai/sdk';

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam;

export interface AnthropicTransportOptions {
  model: string;
  /** A proxy's base URL (the SDK appends `/v1/messages`); omit for the provider itself. */
  baseURL?: string;
  /** BYOK only. A proxy supplies its own. */
  apiKey?: string;
  maxTokens?: number;
}

const PROXY_PLACEHOLDER_KEY = 'held-by-proxy';

/** The request body the transport sends; exported for tests. */
export function toAnthropicRequest(request: AgentRequest, opts: AnthropicTransportOptions) {
  return {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 16000,
    system: request.system,
    messages: request.messages.map((m): BetaMessageParam => ({ role: m.role, content: m.content.map(toBlock) })),
    tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema })),
    // A declined request is retried on the model the API picks for that
    // category, inside the same call, rather than simply stopping.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default' as const,
  };
}

function toBlock(c: AgentContent): BetaContentBlockParam {
  switch (c.type) {
    case 'text': return (c.raw as BetaContentBlockParam | undefined) ?? { type: 'text', text: c.text };
    case 'tool_use': return (c.raw as BetaContentBlockParam | undefined) ?? { type: 'tool_use', id: c.id, name: c.name, input: c.input };
    case 'tool_result': return { type: 'tool_result', tool_use_id: c.toolUseId, content: c.content, is_error: c.isError };
    case 'provider': return c.block as BetaContentBlockParam;
  }
}

const STOPS: Record<string, AgentStop> = { end_turn: 'end', stop_sequence: 'end', tool_use: 'tool_use', max_tokens: 'max_tokens', refusal: 'refusal' };

/** The model's reply in the loop's terms; every block kept for replay. Exported for tests. */
export function fromAnthropicMessage(message: Pick<BetaMessage, 'content' | 'stop_reason'>): AgentResponse {
  const content = message.content.map((block): AgentContent => {
    if (block.type === 'text') return { type: 'text', text: block.text, raw: block };
    if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: block.input, raw: block };
    return { type: 'provider', block };
  });
  return { content, stop: STOPS[message.stop_reason ?? ''] ?? 'other' };
}

export function createAnthropicTransport(opts: AnthropicTransportOptions): AgentTransport {
  let client: Promise<Anthropic> | null = null;
  const sdk = () => (client ??= import('@anthropic-ai/sdk').then(({ default: Anthropic }) => new Anthropic({
    apiKey: opts.apiKey ?? PROXY_PLACEHOLDER_KEY,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    // Safe here by construction: a proxy's placeholder is no secret, and a
    // BYOK key is the person's own, in their own tab, for development.
    dangerouslyAllowBrowser: true,
    maxRetries: 1,
  })));

  return {
    async send(request: AgentRequest, signal: ScriptCancelSignal): Promise<AgentResponse> {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal.addEventListener('abort', onAbort);
      if (signal.aborted) controller.abort();
      try {
        const anthropic = await sdk();
        const message = await anthropic.beta.messages.create(toAnthropicRequest(request, opts), { signal: controller.signal });
        return fromAnthropicMessage(message);
      } catch (err) {
        throw new Error(await describeError(err));
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

async function describeError(err: unknown): Promise<string> {
  const { AuthenticationError, PermissionDeniedError, RateLimitError, APIUserAbortError, APIConnectionError, APIError } = await import('@anthropic-ai/sdk');
  if (err instanceof APIUserAbortError) return 'stopped';
  if (err instanceof AuthenticationError) return 'the model service rejected the credentials';
  if (err instanceof PermissionDeniedError) return 'the model service refused this request';
  if (err instanceof RateLimitError) return 'the model service is rate limiting; try again shortly';
  if (err instanceof APIConnectionError) return 'could not reach the model service';
  if (err instanceof APIError) return `the model service answered ${err.status ?? 'with an error'}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
