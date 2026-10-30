// The Ask prompt (#311) without a browser or a model: deployment config, the
// Anthropic request/response mapping, the session's conversation handling,
// and the shell offering the tool only where a model is configured.
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRequest, AgentResponse, AgentTransport, ScriptCancelSignal } from '@cosmolabe/control';
import { resolveAskDeployment, DEFAULT_ASK_MODEL } from '../deployment';
import { fromAnthropicMessage, toAnthropicRequest } from '../ask/anthropic-transport';
import { ask, askAvailable, askNeedsKey, clearAsk, disposeAsk, MAX_TURNS, setHostAskTransport, stopAsk, submitAsk } from '../ask/ask.svelte';
import { availableTools, enableTool, isToolAvailable, isToolOpen, openTool, closeTool } from '../shell.svelte';
import { resetStores } from '../session.svelte';
import { emit } from '../viewer-state.svelte';

describe('resolveAskDeployment', () => {
  const page = 'https://viewer.test/app/';
  it('is off unless configured', () => {
    expect(resolveAskDeployment({}, page)).toEqual({ mode: 'off' });
    expect(resolveAskDeployment({ VITE_ASK_BYOK: 'yes' }, page)).toEqual({ mode: 'off' });
  });
  it('prefers a proxy, resolving it against the page', () => {
    expect(resolveAskDeployment({ VITE_ASK_ENDPOINT: '/ask', VITE_ASK_BYOK: 'true' }, page)).toEqual({ mode: 'proxy', endpoint: 'https://viewer.test/ask', model: DEFAULT_ASK_MODEL });
  });
  it('offers BYOK only when asked for', () => {
    expect(resolveAskDeployment({ VITE_ASK_BYOK: 'true', VITE_ASK_MODEL: 'claude-sonnet-5-5' }, page)).toEqual({ mode: 'byok', model: 'claude-sonnet-5-5' });
  });
});

describe('Anthropic mapping', () => {
  it('sends tools as input_schema, results as tool_result, and provider blocks verbatim', () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig' };
    const body = toAnthropicRequest({
      system: 'sys',
      tools: [{ name: 'flyTo', description: 'd', effect: 'camera', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'provider', block: thinking }, { type: 'tool_use', id: 't1', name: 'flyTo', input: { object: 'Mars' } }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: '{"summary":"ok"}', isError: false }] },
      ],
    }, { model: 'claude-opus-5-5' });
    expect(body.tools[0]).toEqual({ name: 'flyTo', description: 'd', input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } });
    expect(body.messages[1].content).toEqual([thinking, { type: 'tool_use', id: 't1', name: 'flyTo', input: { object: 'Mars' } }]);
    expect(body.messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: '{"summary":"ok"}', is_error: false }]);
    expect(body.fallbacks).toBe('default');
    expect('api_key' in body).toBe(false);
  });

  it('keeps every reply block for replay and maps stop reasons', () => {
    const text = { type: 'text', text: 'Done.', citations: null };
    const reply = fromAnthropicMessage({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 's' }, text] as never });
    expect(reply.stop).toBe('end');
    expect(reply.content[0]).toEqual({ type: 'provider', block: { type: 'thinking', thinking: '', signature: 's' } });
    expect(reply.content[1]).toEqual({ type: 'text', text: 'Done.', raw: text });
    // The raw block goes back, not a rebuilt one.
    const back = toAnthropicRequest({ system: '', tools: [], messages: [{ role: 'assistant', content: reply.content }] }, { model: 'm' });
    expect((back.messages[0].content as unknown[])[1]).toBe(text);
    expect(fromAnthropicMessage({ stop_reason: 'refusal', content: [] }).stop).toBe('refusal');
    expect(fromAnthropicMessage({ stop_reason: 'pause_turn', content: [] }).stop).toBe('other');
  });
});

/** A scripted model; `gate` holds a reply until the test releases it. */
class MockTransport implements AgentTransport {
  readonly requests: AgentRequest[] = [];
  private gates: (() => void)[] = [];
  constructor(private readonly reply: (req: AgentRequest) => AgentResponse, private readonly hold = false) {}
  release() { this.gates.shift()?.(); }
  async send(request: AgentRequest, signal: ScriptCancelSignal): Promise<AgentResponse> {
    this.requests.push({ ...request, messages: [...request.messages] });
    if (this.hold) {
      await new Promise<void>((resolve, reject) => {
        this.gates.push(resolve);
        signal.addEventListener('abort', () => {
          this.gates = this.gates.filter((g) => g !== resolve);
          reject(new Error('stopped'));
        });
      });
    }
    return this.reply(request);
  }
}

async function until(ok: () => boolean) {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 0));
  if (!ok()) throw new Error('condition never held');
}

const textReply = (text: string): AgentResponse => ({ stop: 'end', content: [{ type: 'text', text }] });

describe('the Ask session', () => {
  afterEach(() => {
    disposeAsk();
    resetStores();
  });

  it('is unavailable with no deployment or host transport', () => {
    expect(askAvailable()).toBe(false);
    expect(askNeedsKey()).toBe(false);
  });

  it('runs a request through a host transport, showing steps and the reply', async () => {
    const transport = new MockTransport((req) => req.messages.length === 1
      ? { stop: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'describeScene', input: {} }] }
      : textReply('No scene is loaded.'));
    setHostAskTransport(transport);
    expect(askAvailable()).toBe(true);
    await submitAsk('what is loaded?');
    expect(ask.turns).toHaveLength(1);
    const [turn] = ask.turns;
    expect(turn.status).toBe('done');
    expect(turn.steps.map((s) => [s.name, s.result?.ok])).toEqual([['describeScene', true]]);
    expect(turn.reply).toBe('No scene is loaded.');
    expect(ask.running).toBe(false);
    // The tools offered are the adapter's.
    expect(transport.requests[0].tools.map((t) => t.name)).toContain('resolve');
  });

  it('a second request supersedes the first, and continues its conversation', async () => {
    const transport = new MockTransport(() => textReply('ok'), true);
    setHostAskTransport(transport);
    const first = submitAsk('fly somewhere');
    await until(() => transport.requests.length === 1);
    const second = submitAsk('no, somewhere else');
    await first;
    await until(() => transport.requests.length === 2);
    transport.release();
    await second;
    expect(ask.turns.map((t) => t.status)).toEqual(['superseded', 'done']);
    // The superseded prompt stays in the history the model sees next.
    const last = transport.requests.at(-1)!;
    expect(last.messages.filter((m) => m.role === 'user').length).toBe(2);
  });

  it('stops a running request', async () => {
    const transport = new MockTransport(() => textReply('late'), true);
    setHostAskTransport(transport);
    const pending = submitAsk('go');
    await until(() => transport.requests.length === 1);
    stopAsk();
    await pending;
    expect(ask.turns[0].status).toBe('cancelled');
    expect(ask.turns[0].reply).toBe('');
  });

  it('a scene load stops a running request', async () => {
    const transport = new MockTransport(() => textReply('late'), true);
    setHostAskTransport(transport);
    const pending = submitAsk('go');
    await until(() => transport.requests.length === 1);
    emit('load', []);
    await pending;
    expect(ask.turns[0].status).toBe('cancelled');
  });

  it('starts over after MAX_TURNS requests rather than trimming history', async () => {
    const transport = new MockTransport(() => textReply('ok'));
    setHostAskTransport(transport);
    for (let i = 0; i < MAX_TURNS; i++) await submitAsk(`request ${i}`);
    expect(transport.requests.at(-1)!.messages).toHaveLength(MAX_TURNS * 2 - 1);
    await submitAsk('one more');
    expect(ask.turns).toHaveLength(1);
    expect(ask.notice).toContain('started over');
    expect(transport.requests.at(-1)!.messages).toHaveLength(1);
  });

  it('clears the conversation', async () => {
    setHostAskTransport(new MockTransport(() => textReply('ok')));
    await submitAsk('hello');
    clearAsk();
    expect(ask.turns).toEqual([]);
  });
});

describe('the shell offers Ask only when enabled', () => {
  afterEach(() => resetStores());

  it('hides and refuses to open the tool until enabled', () => {
    expect(isToolAvailable('ask')).toBe(false);
    expect(availableTools().map((t) => t.id)).not.toContain('ask');
    openTool('ask');
    expect(isToolOpen('ask')).toBe(false);
    enableTool('ask');
    expect(availableTools().map((t) => t.id)).toContain('ask');
    openTool('ask');
    expect(isToolOpen('ask')).toBe(true);
    closeTool('ask');
  });
});
