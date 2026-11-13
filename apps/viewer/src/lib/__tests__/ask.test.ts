// The Ask prompt (#311) without a browser or a model: deployment config, the
// HTTP wire transport, the session's conversation handling, and the shell
// offering the tool only where a model is configured.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentTransportError, type AgentRequest, type AgentResponse, type AgentTransport, type ViewerControl, type ScriptCancelSignal } from '@cosmolabe/control';
import { resolveAskDeployment, resolveDevAskToolMode } from '../deployment';
import { createHttpTransport, parseWireResponse } from '../ask/http-transport';
import { ask, askApproval, answerAskApproval, askAvailable, checkNote, clearAsk, disposeAsk, endNote, type AskTurn, MAX_TURNS, setHostAskTransport, stopAsk, submitAsk, tally } from '../ask/ask.svelte';
import { availableTools, enableTool, isToolAvailable, isToolOpen, openTool, closeTool } from '../shell.svelte';
import { resetStores } from '../session.svelte';
import * as loader from '../loader';
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

describe('development Ask mode', () => {
  it('requires both development and the exact opt-in; production always stays fixed', () => {
    for (const search of ['', '?askMode=fixed', '?askMode=Discovery', '?askMode=', '?askMode=discovery']) {
      expect(resolveDevAskToolMode(false, search)).toBe('fixed');
    }
    expect(resolveDevAskToolMode(true, '?askMode=discovery')).toBe('discovery');
    expect(resolveDevAskToolMode(true, '?catalog=moonfall-shackleton&askMode=discovery')).toBe('discovery');
    expect(resolveDevAskToolMode(true, '')).toBe('fixed');
    expect(resolveDevAskToolMode(true, '?askMode=other')).toBe('fixed');
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

  it('carries the proxy\'s reason code, so a local budget is not mistaken for a provider limit', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'the proxy has spent its token budget', code: 'budget_exhausted' } }), { status: 429 }));
    const err = await createHttpTransport('https://proxy.test/').send(REQUEST, never).catch((e) => e);
    expect(err).toBeInstanceOf(AgentTransportError);
    expect(err).toMatchObject({ code: 'budget_exhausted', status: 429 });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'model service 429: slow down', code: 'upstream_error' } }), { status: 429 }));
    expect(await createHttpTransport('https://proxy.test/').send(REQUEST, never).catch((e) => e)).toMatchObject({ code: 'upstream_error' });
    // A proxy that sends no code is still an error, with none.
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'x' } }), { status: 500 }));
    expect((await createHttpTransport('https://proxy.test/').send(REQUEST, never).catch((e) => e)).code).toBeUndefined();
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
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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
    expect(transport.requests[0].tools.map((t) => t.name)).toContain('listCapabilities');
  });

  it.each([['fixed', 10], ['discovery', 20]] as const)('bounds %s requests independently of the shared discovery bridge', async (mode, rounds) => {
    let sequence = 0;
    const transport = new MockTransport(() => ({ stop: 'tool_use', content: [{ type: 'tool_use', id: String(++sequence), name: 'describeScene', input: {} }] }));
    setHostAskTransport(transport, {}, mode);
    await submitAsk('inspect forever');
    expect(transport.requests[0].tools.some(t => t.name === 'listCapabilities')).toBe(true);
    expect(transport.requests).toHaveLength(rounds);
    expect(ask.turns.at(-1)?.status).toBe('step-limit');
    expect(ask.turns.at(-1)?.reply).toBe('');
    expect(endNote(ask.turns.at(-1)!)?.text).toContain('Stopped after too many steps');
  });

  it('applies the embedding host capability omissions to Ask discovery and execution', async () => {
    let round = 0;
    const transport = new MockTransport(() => ++round === 1
      ? { stop: 'tool_use', content: [{ type: 'tool_use', id: 'describe', name: 'describeCapabilities', input: { ids: ['scene.resolve'] } }] }
      : round === 2 ? { stop: 'tool_use', content: [{ type: 'tool_use', id: 'resolve', name: 'resolve', input: { query: 'Earth' } }] }
        : textReply('The host omitted name resolution.'));
    setHostAskTransport(transport, { omitted: { 'scene.resolve': 'Host omitted name resolution' } }, 'discovery');
    await submitAsk('Find Earth');
    expect(ask.turns[0].steps[0].result).toMatchObject({ ok: true, data: { selected: [{ id: 'scene.resolve', available: false, reason: 'Host omitted name resolution' }] } });
    expect(ask.turns[0].steps[1].result).toMatchObject({ ok: false, code: 'refused' });
    expect(transport.requests[1].tools.map(t => t.name)).not.toContain('resolve');
  });

  it('enforces host omissions with fixed tools and avoids capability lookup rounds', async () => {
    const transport = new MockTransport(req => req.messages.length === 1
      ? { stop: 'tool_use', content: [{ type: 'tool_use', id: 'resolve', name: 'resolve', input: { query: 'Earth' } }] }
      : textReply('Resolution is unavailable.'));
    setHostAskTransport(transport, { omitted: { 'scene.resolve': 'Host owns resolution' } });
    await submitAsk('Find Earth');
    expect(transport.requests[0].tools.map(t => t.name)).not.toContain('resolve');
    expect(ask.turns[0].steps[0].result).toMatchObject({ ok: false, code: 'refused', error: 'Host owns resolution' });
    expect(transport.requests).toHaveLength(2);
  });

  it.each(['fixed', 'discovery'] as const)('requires exact UI approval through the ordinary %s Ask session and cancels pending approval', async mode => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_ASK_ENDPOINT', '/ask');
    vi.stubGlobal('location', { href: 'http://localhost/', search: mode === 'discovery' ? '?askMode=discovery' : '' });
    const host = { getScene: () => ({ id: 1, catalog: 'test', ready: true }), on: () => () => {}, removeBookmark: vi.fn(() => true) } as unknown as ViewerControl;
    vi.spyOn(loader, 'getCosmo').mockReturnValue(host);
    const saved = vi.spyOn(host, 'removeBookmark');
    // Replies by what the request holds: a deletion is first proposed unescalated, dropped, and proposed again escalated (#345).
    const escalations: boolean[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as AgentRequest;
      const last = JSON.stringify(request.messages.at(-1));
      const reply: AgentResponse = last.includes('"toolUseId":"write"') ? textReply('Finished.')
        : last.includes('"toolUseId":"desc"')
          ? (escalations.push(request.escalated === true), { stop: 'tool_use', content: [{ type: 'tool_use', id: 'goal', name: 'checkGoal', input: { require: [] } }, { type: 'tool_use', id: 'write', name: 'invokeCapability', input: { id: 'bookmarks.removeBookmark', input: { name: 'approved-view' } } }] })
          : { stop: 'tool_use', content: [{ type: 'tool_use', id: 'desc', name: 'describeCapabilities', input: { ids: ['bookmarks.removeBookmark'] } }] };
      return new Response(JSON.stringify({ version: 1, ...reply }));
    });
    const denied = submitAsk('Delete this view');
    await until(() => !!askApproval.pending);
    expect(escalations).toEqual([false, true]);
    expect(saved).not.toHaveBeenCalled();
    expect(askApproval.pending).toMatchObject({ kind: 'authoring', operation: 'bookmarks.removeBookmark' });
    answerAskApproval(false);
    await denied;
    expect(saved).not.toHaveBeenCalled();
    const approved = submitAsk('Delete it');
    await until(() => !!askApproval.pending);
    answerAskApproval(true);
    await approved;
    expect(saved).toHaveBeenCalledExactlyOnceWith('approved-view');
    const cancelled = submitAsk('Delete again');
    await until(() => !!askApproval.pending);
    stopAsk();
    await cancelled;
    expect(askApproval.pending).toBeNull();
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it('replaces a host policy in the same mode without retaining old authoring permission or history', async () => {
    const host = { getScene: () => ({ id: 1, catalog: 'test', ready: true }), on: () => () => {}, saveBookmark: vi.fn(() => true) } as unknown as ViewerControl;
    vi.spyOn(loader, 'getCosmo').mockReturnValue(host);
    let round = 0;
    const transport = new MockTransport(() => ++round % 3 === 1
      ? { stop: 'tool_use', content: [{ type: 'tool_use', id: 'desc', name: 'describeCapabilities', input: { ids: ['bookmarks.saveBookmark'] } }] }
      : round % 3 === 2
        ? { stop: 'tool_use', content: [{ type: 'tool_use', id: 'goal', name: 'checkGoal', input: { require: [] } }, { type: 'tool_use', id: 'write', name: 'invokeCapability', input: { id: 'bookmarks.saveBookmark', input: { name: 'once' } } }] }
        : textReply('Finished.'));
    setHostAskTransport(transport, { allowAuthoring: true, confirmAuthoring: async () => true });
    await submitAsk('Save');
    expect(host.saveBookmark).toHaveBeenCalledTimes(1);
    setHostAskTransport(transport); // revokes the earlier permission, same mode
    await submitAsk('Save');
    expect(host.saveBookmark).toHaveBeenCalledTimes(1);
    expect(ask.turns.at(-1)?.steps.at(-1)?.result).toMatchObject({ ok: false, code: 'refused' });
    expect(transport.requests[3].messages).toHaveLength(1);
  });

  it.each(['budget_exhausted', 'rate_limited'] as const)('stops futile retries after %s without another provider call or repeated write', async code => {
    vi.useFakeTimers();
    const transport: AgentTransport = { send: vi.fn(async () => { throw new AgentTransportError('Service limit', code, 429); }) };
    setHostAskTransport(transport);
    await submitAsk('go');
    expect(ask.serviceBlocked).not.toBeNull();
    await submitAsk('retry');
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(ask.turns).toHaveLength(1);
    if (code === 'rate_limited') {
      await vi.advanceTimersByTimeAsync(60000);
      expect(ask.serviceBlocked).toBeNull();
    } else {
      expect(endNote(ask.turns[0])?.text).not.toMatch(/TOKEN_BUDGET|restart the proxy/i);
      clearAsk();
      expect(ask.serviceBlocked).toBeNull();
    }
    vi.useRealTimers();
  });

  it('on a budget stop, names exactly what is already applied, once, in the action list\'s words (#345)', () => {
    const outcome = { writes: ['camera' as const], expected: [], report: null, unobservable: null };
    const ok = (name: string, input: unknown = {}, write = false) => ({ id: name, name, input, result: { ok: true as const, summary: 'Done', ...(write ? { outcome } : {}) } });
    // Writes are known by their contract's outcome, not by their names.
    const steps = [ok('describeScene'), ok('invokeCapability', { id: 'camera.composeView', input: { anchor: 'Psyche', target: 'Mars' } }, true), ok('checkGoal'), { id: 'x', name: 'dolly', input: {}, result: { ok: false as const, code: 'refused' as const, error: 'no' } }];
    const note = endNote({ id: 1, prompt: '', fresh: null, steps, reply: '', notes: [], status: 'error', error: 'cap', errorCode: 'budget_exhausted', stats: { rounds: 3, rawTokens: 30000 }, result: null }, s => s.name === 'invokeCapability' ? 'Rotated around Psyche to show Mars' : s.name)!;
    expect(note.text).toContain('Already applied: Rotated around Psyche to show Mars. 1 step refused.');
    expect(note.text).not.toMatch(/receipt|readback|unverified/i);
  });

  it('puts the viewer\'s own verdict beside a finished answer (#345)', () => {
    const turn = (result: Partial<NonNullable<AskTurn['result']>> & Pick<NonNullable<AskTurn['result']>, 'status'>): AskTurn => ({ id: 1, prompt: '', fresh: null, steps: [], reply: 'Mars is in view.', notes: [], status: 'done', error: null, errorCode: null, stats: null,
      result: { report: null, unobservable: [], changes: [], facts: [], answerIssues: [], intentStated: true, escalated: null, ...result } });
    const unmet = { status: 'unmet' as const, checks: [{ slot: 'view:Mars', ok: false, detail: 'Mars out of frame', soft: false }] };
    expect(checkNote(turn({ status: 'failed', report: unmet }))).toEqual({ tone: 'warning', text: 'Viewer check: Mars out of frame.' });
    expect(checkNote(turn({ status: 'verified', report: { status: 'met', checks: [] } }))).toEqual({ tone: 'muted', text: 'Checked in the viewer.' });
    // Without a stated goal, verified covers each change's own result, never the whole request.
    expect(checkNote(turn({ status: 'verified', intentStated: false, report: { status: 'met', checks: [] } }))?.text).toBe('Each change checked in the viewer; the request as a whole was not stated, so not checked.');
    expect(checkNote(turn({ status: 'verified', escalated: 'removeBookmark destroys saved state', report: { status: 'met', checks: [] } }))?.text).toBe('Checked in the viewer. Answered by the escalation model: removeBookmark destroys saved state.');
    expect(checkNote(turn({ status: 'partial', report: { status: 'partial', checks: [{ slot: 'ready:terrain:Mars:', ok: false, detail: 'terrain on Mars partial', soft: true }] } })))
      .toEqual({ tone: 'muted', text: 'Holds; not yet observed: terrain on Mars partial.' });
    expect(checkNote(turn({ status: 'unverified', unobservable: ['showTrajectory: trajectory visibility has no read'] }))).toEqual({ tone: 'muted', text: 'Not checked against the viewer: trajectory visibility has no read.' });
    expect(checkNote({...turn({status:'partial',answerSource:'host-facts'}),status:'max-tokens'})?.text).toContain('viewer’s own measured account');
    expect(checkNote(turn({ status: 'no-change' }))).toBeNull();
    expect(checkNote(turn({ status: 'no-change', answerIssues: ['flyby'] }))).toEqual({ tone: 'warning', text: 'The model\'s answer contradicted the viewer\'s results, so the viewer\'s own account is shown.' });
  });

  it('passes a proxy\'s per-round usage through, and ignores a malformed one', () => {
    const usage = { inputTokens: 10, cacheReadTokens: 9000, cacheWriteTokens: 0, outputTokens: 50 };
    expect(parseWireResponse({ version: 1, stop: 'end', content: [], usage }).usage).toEqual(usage);
    expect(parseWireResponse({ version: 1, stop: 'end', content: [], usage: { inputTokens: 'lots' } }).usage).toBeUndefined();
  });

  it('counts capability lookups separately from completed viewer steps', () => {
    const steps = ['listCapabilities', 'describeCapabilities', 'getOperationResult', 'describeScene'].map(name => ({ id: name, name, input: {}, result: { ok: true as const, summary: 'Read' } }));
    expect(tally({ steps })).toMatchObject({ inspected: 3, done: 1, partial: 0 });
    const note = endNote({ id: 1, prompt: '', fresh: null, steps: steps.slice(0, 3), reply: '', notes: [], status: 'cancelled', error: null, errorCode: null, stats: null, result: null });
    // Lookups change nothing, so they are not reported as applied.
    expect(note?.text).toBe('Stopped.');
  });

  it('uses the normal proxy with the dev URL mode and resets history when it changes', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_ASK_ENDPOINT', '/ask');
    const page = { href: 'http://localhost/?askMode=discovery', search: '?askMode=discovery' };
    vi.stubGlobal('location', page);
    const requests: AgentRequest[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ version: 1, ...textReply('Observed.') }));
    });
    await submitAsk('Inspect this scene');
    await submitAsk('Again');
    expect(requests[0].tools.map(t => t.name)).toEqual(['describeScene', 'listCapabilities', 'describeCapabilities', 'getOperationResult', 'invokeCapability']);
    expect(requests[1].messages.length).toBeGreaterThan(1);
    page.search = '?askMode=fixed';
    await submitAsk('Find Earth');
    expect(requests[2].tools.map(t => t.name)).toContain('resolve');
    expect(requests[2].messages).toHaveLength(1);
    expect(ask.toolMode).toBe('fixed');
    page.search = '?askMode=discovery';
    await submitAsk('Inspect');
    expect(requests[3].messages).toHaveLength(1);
    expect(ask.toolMode).toBe('discovery');
  });

  it('cancels a running task on mode change and drops its late tool response', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_ASK_ENDPOINT', '/ask');
    const page = { href: 'http://localhost/', search: '' };
    vi.stubGlobal('location', page);
    let release!: (response: Response) => void;
    let firstSignal!: AbortSignal;
    const requests: AgentRequest[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      if (requests.length === 1) {
        firstSignal = init.signal as AbortSignal;
        return new Promise<Response>(resolve => { release = resolve; });
      }
      return new Response(JSON.stringify({ version: 1, ...textReply('New mode.') }));
    });
    const first = submitAsk('Move camera');
    await until(() => requests.length === 1);
    page.search = '?askMode=discovery';
    const second = submitAsk('Inspect');
    expect(firstSignal.aborted).toBe(true);
    release(new Response(JSON.stringify({ version: 1, stop: 'tool_use', content: [{ type: 'tool_use', id: 'late', name: 'select', input: { object: 'Earth' } }] })));
    await Promise.all([first, second]);
    expect(ask.turns.at(-2)?.steps).toHaveLength(0);
    expect(ask.turns.at(-2)?.status).toBe('cancelled');
    expect(ask.turns.at(-1)?.reply).toBe('New mode.');
    expect(requests[1].messages).toHaveLength(1);
    expect(requests[1].tools.map(t => t.name)).toContain('listCapabilities');
  });

  it('ignores a discovery URL in production when offering tools to the proxy', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_ASK_ENDPOINT', '/ask');
    vi.stubGlobal('location', { href: 'http://viewer.test/?askMode=discovery', search: '?askMode=discovery' });
    let request!: AgentRequest;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      request = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ version: 1, ...textReply('Observed.') }));
    });
    await submitAsk('Inspect');
    expect(request.tools.map(t => t.name)).toContain('resolve');
    expect(request.tools.map(t => t.name)).toContain('listCapabilities');
    expect(ask.toolMode).toBe('fixed');
  });

  it('shows only the last round\'s words as the reply, not planning between tool calls', async () => {
    const transport = new MockTransport((req) => req.messages.length === 1
      ? { stop: 'tool_use', content: [{ type: 'text', text: 'The object Mars is clearly meant.' }, { type: 'tool_use', id: 'a', name: 'describeScene', input: {} }] }
      : textReply('Two candidates match Mars: the planet and a place.'));
    setHostAskTransport(transport);
    await submitAsk('go to mars');
    expect(ask.turns[0].reply).toBe('Two candidates match Mars: the planet and a place.');
  });

  describe('when the model proxy stops partway', () => {
    const budget = () => new AgentTransportError('the model proxy answered 429: the proxy has spent its token budget', 'budget_exhausted', 429);
    /** Rounds of tools, then the budget error; the viewer has no scene here, so a write is refused. */
    const capAfter = (rounds: number) => {
      let n = 0;
      return {
        requests: [] as AgentRequest[],
        async send(request: AgentRequest): Promise<AgentResponse> {
          this.requests.push(request);
          if (n++ >= rounds) throw budget();
          return { stop: 'tool_use', content: [
            { type: 'text', text: 'Looking.' },
            { type: 'tool_use', id: `r${n}a`, name: 'describeScene', input: {} },
            { type: 'tool_use', id: `r${n}b`, name: 'select', input: { object: 'Titan' } },
          ] };
        },
      };
    };

    it('before any action: says so, with no account of actions and no reply', async () => {
      setHostAskTransport(capAfter(0));
      await submitAsk('go');
      const [turn] = ask.turns;
      expect(turn).toMatchObject({ status: 'error', errorCode: 'budget_exhausted', reply: '' });
      expect(turn.steps).toHaveLength(0);
      const note = endNote(turn)!;
      expect(note.text).toContain('raw-token safety cap (cached tokens included) is used up');
      expect(note.text).not.toContain('actions ran');
      expect(note.tone).toBe('warning');
    });

    it('after actions: counts what ran from the step results, a refusal not as done, and keeps the trace', async () => {
      const transport = capAfter(2);
      setHostAskTransport(transport);
      await submitAsk('tour');
      const [turn] = ask.turns;
      // Two rounds of (a read that worked, a write the viewer refused for want of a scene).
      expect(turn.steps.map((s) => [s.name, s.result?.ok])).toEqual([['describeScene', true], ['select', false], ['describeScene', true], ['select', false]]);
      expect(turn.reply).toBe(''); // the planning remark of a round that never got its answer
      const note = endNote(turn)!;
      // Reads are not changes; the refused writes are counted, not claimed.
      expect(note.text).toContain('Nothing changed; 2 steps refused.');
      // No retry is offered, and nothing ran after the failure.
      expect(note.text).not.toMatch(/try again|retry/i);
      expect(transport.requests).toHaveLength(3);
    });

    it('is a different note from a rate limit and from any other failure', async () => {
      const failing = (code?: string): AgentTransport => ({ send: async () => { throw new AgentTransportError('the model proxy answered 4xx', code, 429); } });
      setHostAskTransport(failing('rate_limited'));
      await submitAsk('a');
      expect(endNote(ask.turns[0])!.text).toContain('rate limit');
      setHostAskTransport(failing('upstream_error'));
      await submitAsk('b');
      expect(endNote(ask.turns[1])).toMatchObject({ tone: 'error', text: 'the model proxy answered 4xx' });
    });

    it('leaves the next request clean: it continues a valid conversation and runs normally', async () => {
      setHostAskTransport(capAfter(1));
      await submitAsk('tour');
      const ok = new MockTransport(() => textReply('Done.'));
      setHostAskTransport(ok);
      await submitAsk('again');
      expect(ask.turns.map((t) => t.status)).toEqual(['error', 'done']);
      // The failed request's tool results are in what the model is sent, each use answered.
      const sent = ok.requests[0].messages;
      const uses = sent.flatMap((m) => m.content.filter((c) => c.type === 'tool_use'));
      const results = sent.flatMap((m) => m.content.filter((c) => c.type === 'tool_result'));
      expect(results).toHaveLength(uses.length);
      expect(ask.turns[1].reply).toBe('Done.');
    });
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

  it('keeps the model\'s narration while it works out of its answer, and in its notes', async () => {
    const transport = new MockTransport((req) => req.messages.length === 1
      ? { stop: 'tool_use', content: [{ type: 'text', text: 'The object Mars is clearly meant.' }, { type: 'tool_use', id: 'a', name: 'describeScene', input: {} }] }
      : textReply('Nothing is loaded.'));
    setHostAskTransport(transport);
    await submitAsk('what is loaded?');
    expect(ask.turns[0].reply).toBe('Nothing is loaded.');
    expect(ask.turns[0].notes).toEqual(['The object Mars is clearly meant.']);
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
