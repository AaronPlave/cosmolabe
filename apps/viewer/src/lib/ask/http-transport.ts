/**
 * The viewer's one built-in `AgentTransport` (#311): the agent loop's own
 * request, POSTed as JSON to a model proxy (`AGENT_WIRE_VERSION`).
 *
 * Nothing here knows a provider. The proxy — `examples/ask-proxy`, or a
 * deployment's own — holds the key, picks the model and translates to its
 * provider's API, so the browser never sees a key and changing provider is a
 * server change.
 */
import {
  AGENT_WIRE_VERSION, AgentTransportError, type AgentContent, type AgentRequest, type AgentResponse, type AgentStop, type AgentTransport,
  type AgentWireRequest, type ScriptCancelSignal,
} from '@cosmolabe/control';

const STOPS: readonly AgentStop[] = ['end', 'tool_use', 'max_tokens', 'refusal', 'other'];
const KINDS = new Set(['text', 'tool_use', 'tool_result', 'provider']);

/** A proxy's reply, checked before the loop trusts it. Exported for tests. */
export function parseWireResponse(body: unknown): AgentResponse {
  const r = body as { version?: unknown; content?: unknown; stop?: unknown } | null;
  if (!r || typeof r !== 'object') throw new Error('the model proxy sent no reply');
  if (r.version !== AGENT_WIRE_VERSION) throw new Error(`the model proxy speaks wire version ${String(r.version)}, not ${AGENT_WIRE_VERSION}`);
  if (!Array.isArray(r.content) || !STOPS.includes(r.stop as AgentStop)) throw new Error('the model proxy sent a malformed reply');
  for (const c of r.content as { type?: unknown; text?: unknown; id?: unknown; name?: unknown }[]) {
    const ok = c && typeof c === 'object' && KINDS.has(c.type as string)
      && (c.type !== 'text' || typeof c.text === 'string')
      && (c.type !== 'tool_use' || (typeof c.id === 'string' && typeof c.name === 'string'));
    if (!ok) throw new Error('the model proxy sent a malformed content block');
  }
  return { content: r.content as AgentContent[], stop: r.stop as AgentStop };
}

export function createHttpTransport(endpoint: string): AgentTransport {
  return {
    async send(request: AgentRequest, signal: ScriptCancelSignal): Promise<AgentResponse> {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal.addEventListener('abort', onAbort);
      if (signal.aborted) controller.abort();
      const body: AgentWireRequest = { version: AGENT_WIRE_VERSION, ...request };
      try {
        let res: Response;
        try {
          res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (err) {
          throw new Error(controller.signal.aborted ? 'stopped' : `could not reach the model proxy (${err instanceof Error ? err.message : String(err)})`);
        }
        const payload: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const error = (payload as { error?: { message?: unknown; code?: unknown } } | null)?.error;
          const message = error?.message;
          throw new AgentTransportError(
            `the model proxy answered ${res.status}${typeof message === 'string' ? `: ${message}` : ''}`,
            typeof error?.code === 'string' ? error.code : undefined,
            res.status,
          );
        }
        return parseWireResponse(payload);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
