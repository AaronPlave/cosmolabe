// The Ask prompt (#311) without a browser or a model: deployment config, the
// HTTP wire transport, the session's conversation handling, and the shell
// offering the tool only where a model is configured.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentTransportError, type AgentRequest, type AgentResponse, type AgentTransport, type ScriptCancelSignal } from '@cosmolabe/control';
import { resolveAskDeployment } from '../deployment';
import { createHttpTransport, parseWireResponse } from '../ask/http-transport';
import { actionCounts, actionsSummary, ask, askAvailable, clearAsk, disposeAsk, endingNote, MAX_TURNS, setHostAskTransport, stopAsk, submitAsk, type AskTurn } from '../ask/ask.svelte';
import { availableTools, enableTool, isToolAvailable, isToolOpen, openTool, closeTool } from '../shell.svelte';
import { resetStores } from '../session.svelte';
import { emit } from '../viewer-state.svelte';

// A load binds a renderer and bumps the scene id; the conversation only needs the id.
const scene = vi.hoisted(() => ({ id: 0 }));
vi.mock('../viewer-state.svelte', async (importOriginal) => ({ ...(await importOriginal<typeof import('../viewer-state.svelte')>()), sceneId: () => scene.id }));

describe('resolveAskDeployment', () => {
  const page = 'https://viewer.test/app/';
  it('is off unless an endpoint is configured', () => {
    expect(resolveAskDeployment({}, page)).toEqual({ mode: 'off' });
    expect(resolveAskDeployment({ VITE_ASK_ENDPOINT: '  ' }, page)).toEqual({ mode: 'off' });
  });
  it('resolves the endpoint against the page', () => {
    expect(resolveAskDeployment({ VITE_ASK_ENDPOINT: '/ask' }, page)).toEqual({ mode: 'proxy', endpoint: 'https://viewer.test/ask' });
  });
});

const never: ScriptCancelSignal = { aborted: false, addEventListener: () => {}, removeEventListener: () => {} };
const REQUEST: AgentRequest = { system: 's', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };

describe('the HTTP wire transport', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the request with its version and returns the checked reply', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ version: 1, stop: 'end', content: [{ type: 'provider', block: { type: 'thinking' } }, { type: 'text', text: 'Hi.' }] }));
    });
    const reply = await createHttpTransport('https://proxy.test/').send(REQUEST, never);
    expect(calls[0]).toEqual({ url: 'https://proxy.test/', body: { version: 1, ...REQUEST } });
    expect(reply).toEqual({ stop: 'end', content: [{ type: 'provider', block: { type: 'thinking' } }, { type: 'text', text: 'Hi.' }] });
  });

  it("says what the proxy said when it fails", async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'too many requests' } }), { status: 429 }));
    await expect(createHttpTransport('https://proxy.test/').send(REQUEST, never)).rejects.toThrow('the model proxy answered 429: too many requests');
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    await expect(createHttpTransport('https://proxy.test/').send(REQUEST, never)).rejects.toThrow('could not reach the model proxy');
  });

  it('gives a failure the proxy\'s own code, so nothing has to read the message', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'the proxy has spent its token budget', code: 'budget-exhausted' } }), { status: 429 }));
    const err = await createHttpTransport('https://proxy.test/').send(REQUEST, never).catch((e) => e);
    expect(err).toBeInstanceOf(AgentTransportError);
    expect(err).toMatchObject({ code: 'budget-exhausted', message: 'the model proxy answered 429: the proxy has spent its token budget' });
    // A proxy that sends no code and answers 429 is rate limiting.
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 429 }));
    expect(await createHttpTransport('https://proxy.test/').send(REQUEST, never).catch((e) => e)).toMatchObject({ code: 'rate-limited' });
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    expect(await createHttpTransport('https://proxy.test/').send(REQUEST, never).catch((e) => e)).toMatchObject({ code: 'unreachable' });
  });

  it('refuses replies it cannot trust', () => {
    expect(() => parseWireResponse({ version: 2, stop: 'end', content: [] })).toThrow('wire version 2');
    expect(() => parseWireResponse({ version: 1, stop: 'later', content: [] })).toThrow('malformed reply');
    expect(() => parseWireResponse({ version: 1, stop: 'end', content: [{ type: 'tool_use', name: 'x' }] })).toThrow('malformed content block');
    expect(() => parseWireResponse({ version: 1, stop: 'end', content: [{ type: 'script' }] })).toThrow('malformed content block');
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

  it('the model starts over after MAX_TURNS requests, rather than trimming history, and the panel keeps them and says so', async () => {
    const transport = new MockTransport(() => textReply('ok'));
    setHostAskTransport(transport);
    for (let i = 0; i < MAX_TURNS; i++) await submitAsk(`request ${i}`);
    expect(transport.requests.at(-1)!.messages).toHaveLength(MAX_TURNS * 2 - 1);
    expect(ask.turns.every((t) => t.fresh === null)).toBe(true);
    await submitAsk('one more');
    // Sent alone: nothing earlier is replayed, so nothing is half-trimmed.
    expect(transport.requests.at(-1)!.messages).toHaveLength(1);
    // Shown with the rest, behind a note saying why the model does not remember them.
    expect(ask.turns).toHaveLength(MAX_TURNS + 1);
    expect(ask.turns.at(-1)!.fresh).toContain(`${MAX_TURNS} requests`);
    expect(ask.turns.slice(0, -1).every((t) => t.fresh === null)).toBe(true);
    // The new conversation counts from one again.
    await submitAsk('and another');
    expect(transport.requests.at(-1)!.messages).toHaveLength(3);
    expect(ask.turns.at(-1)!.fresh).toBeNull();
  });

  it('a new scene starts a new conversation for the model and keeps what the panel showed', async () => {
    const transport = new MockTransport(() => textReply('ok'));
    setHostAskTransport(transport);
    await submitAsk('first');
    scene.id++; // a catalog load binds a new scene
    await submitAsk('second');
    expect(transport.requests.at(-1)!.messages).toHaveLength(1);
    expect(ask.turns).toHaveLength(2);
    expect(ask.turns[1].fresh).toContain('new scene');
  });

  it('keeps the model\'s narration while it works out of its answer', async () => {
    const transport = new MockTransport((req) => req.messages.length === 1
      ? { stop: 'tool_use', content: [{ type: 'text', text: 'The object Mars is clearly meant.' }, { type: 'tool_use', id: 'a', name: 'describeScene', input: {} }] }
      : textReply('Nothing is loaded.'));
    setHostAskTransport(transport);
    await submitAsk('what is loaded?');
    expect(ask.turns[0].reply).toBe('Nothing is loaded.');
    expect(ask.turns[0].notes).toEqual(['The object Mars is clearly meant.']);
  });

  it('a spent proxy budget between rounds leaves an honest, usable partial request', async () => {
    let round = 0;
    const budget = new AgentTransportError('the model proxy answered 429: the proxy has spent its token budget', 'budget-exhausted');
    const transport: AgentTransport = {
      async send(request: AgentRequest): Promise<AgentResponse> {
        if (request.messages.length === 1 && round++ === 0) {
          return { stop: 'tool_use', content: [
            { type: 'tool_use', id: 'a', name: 'describeScene', input: {} },
            { type: 'tool_use', id: 'b', name: 'flyTo', input: { object: 'Mars' } },
          ] };
        }
        throw budget;
      },
    };
    setHostAskTransport(transport);
    await submitAsk('show me flight 5');
    const [turn] = ask.turns;
    expect(turn).toMatchObject({ status: 'error', errorCode: 'budget-exhausted', reply: '' });
    // Counts come from the results: describeScene ran (no scene is bound in this test, so a write is refused).
    expect(actionCounts(turn)).toEqual({ total: 2, done: 1, refused: 1, notRun: 0 });
    expect(actionsSummary(turn)).toBe('1 action succeeded, 1 refused');
    const note = endingNote(turn)!;
    expect(note).toContain('the local model budget is spent');
    expect(note).toContain('1 action succeeded, 1 refused');
    expect(note).toContain("The final answer wasn't generated");
    expect(note).toContain('Changes already made to the view remain');
    expect(note).not.toMatch(/try again|retry/i);
    // Usable afterwards: not running, and the next request goes through.
    expect(ask.running).toBe(false);
    setHostAskTransport(new MockTransport(() => textReply('ok')));
    await submitAsk('again');
    expect(ask.turns).toHaveLength(2);
    expect(ask.turns[1].status).toBe('done');
  });

  it('clears the conversation', async () => {
    setHostAskTransport(new MockTransport(() => textReply('ok')));
    await submitAsk('hello');
    clearAsk();
    expect(ask.turns).toEqual([]);
  });
});

describe('what a stopped request says', () => {
  const step = (name: string, result: AskTurn['steps'][number]['result']) => ({ id: name, name, input: {}, result });
  const ok = { ok: true as const, summary: 'done' };
  const refused = { ok: false as const, code: 'refused' as const, error: 'no such layer' };
  const turn = (over: Partial<AskTurn>): AskTurn => ({
    id: 1, prompt: 'p', fresh: null, steps: [], reply: '', notes: [], status: 'error', error: 'x', errorCode: null, ...over,
  });

  it('counts from the results: refused and not-run are not successes', () => {
    const t = turn({
      steps: [step('select', ok), step('flyTo', ok), step('showImagery', refused), step('setTime', { ok: false, code: 'superseded', error: 'replaced' }), step('dolly', null)],
    });
    expect(actionCounts(t)).toEqual({ total: 5, done: 2, refused: 1, notRun: 2 });
    expect(actionsSummary(t)).toBe('2 actions succeeded, 1 refused, 2 not run');
  });

  it('says why it stopped, what ran, and that the view keeps its changes', () => {
    const five = Array.from({ length: 5 }, (_, i) => step(`a${i}`, ok));
    expect(endingNote(turn({ steps: five, errorCode: 'budget-exhausted' })))
      .toBe("Request stopped: the local model budget is spent. 5 actions succeeded. The final answer wasn't generated. Changes already made to the view remain.");
    expect(endingNote(turn({ steps: [], errorCode: 'budget-exhausted' }))).toBe("Request stopped: the local model budget is spent. No actions had run. The final answer wasn't generated.");
    expect(endingNote(turn({ steps: five, errorCode: 'rate-limited' }))).toContain('Wait a moment');
    expect(endingNote(turn({ steps: [step('a', ok)], error: 'could not reach the model proxy (down)', errorCode: 'unreachable' })))
      .toContain('Request stopped: could not reach the model proxy (down).');
    expect(endingNote(turn({ status: 'cancelled', steps: [step('a', ok)] }))).toBe('Stopped. 1 action succeeded. Changes already made to the view remain.');
    expect(endingNote(turn({ status: 'done', steps: five }))).toBeNull();
    expect(endingNote(turn({ status: 'running' }))).toBeNull();
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
