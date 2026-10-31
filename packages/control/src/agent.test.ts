import { describe, expect, it } from 'vitest';
import { createAgentTools, type AgentToolResult } from './agent.js';
import { AgentTransportError, runAgent, type AgentRequest, type AgentResponse, type AgentTransport } from './agent-loop.js';
import { FakeViewer } from './__tests__/fake-host.js';
import type { ScriptActivity, ViewerControl } from './contracts.js';

const fail = (r: AgentToolResult) => {
  if (r.ok) throw new Error(`expected a failure, got ${r.summary}`);
  return r;
};

/** A microtask boundary, so a flight wait has subscribed before the test lands it. */
const tick = () => new Promise((r) => setTimeout(r, 0));

function land(host: FakeViewer, outcome: 'arrived' | 'stopped' | 'interrupted') {
  const flight = host.flight!;
  host.flight = null;
  if (outcome === 'arrived') host.tracked = flight.target;
  host.emit('flightEnd', { id: flight.id, target: flight.target, path: flight.path, outcome });
}

const FLIGHT_5: ScriptActivity = {
  id: 'ingenuity-flight-5', name: 'Flight 5', kind: 'flight', vehicle: 'Ingenuity', body: 'Mars', start: 100, end: 208,
  temporality: 'interval',
  provenance: { source: 'catalog', version: '1', authority: 'JPL', timing: 'reconstructed', limitations: 'none' },
};

describe('agent tools: discovery', () => {
  it('lists only tools whose capability the host has', () => {
    const full = createAgentTools(new FakeViewer()).list().map((t) => t.name);
    expect(full).toEqual(expect.arrayContaining(['describeScene', 'resolve', 'searchPlaces', 'flyTo', 'gotoPlace', 'showImagery']));
    // Out of the curated set: files, raw poses, sequencing.
    expect(full).not.toEqual(expect.arrayContaining(['screenshot']));
    for (const name of ['record', 'setCamera', 'wait', 'runTo']) expect(full).not.toContain(name);

    const host = new FakeViewer() as Partial<FakeViewer>;
    delete (host as { searchPlaces?: unknown }).searchPlaces;
    Object.defineProperty(host, 'searchPlaces', { value: undefined });
    Object.defineProperty(host, 'gotoPlace', { value: undefined });
    const bare = createAgentTools(host as ViewerControl).list().map((t) => t.name);
    expect(bare).not.toContain('searchPlaces');
    expect(bare).not.toContain('gotoPlace');
  });

  it('describes every input as a closed schema', () => {
    for (const tool of createAgentTools(new FakeViewer()).list()) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(10);
    }
    const flyTo = createAgentTools(new FakeViewer()).list().find((t) => t.name === 'flyTo')!;
    expect(flyTo.inputSchema.required).toEqual(['object']);
    expect(flyTo.inputSchema.properties!.path).toEqual({ type: 'string', enum: ['direct', 'overview'] });
  });
});

describe('agent tools: validation', () => {
  const tools = createAgentTools(new FakeViewer());

  it('rejects unknown fields, missing fields, wrong types and bad enums before anything runs', async () => {
    expect(fail(await tools.call('select', { object: 'Titan', extra: 1 }))).toMatchObject({ code: 'invalid-input', error: expect.stringContaining('unknown field "extra"') });
    expect(fail(await tools.call('select', {}))).toMatchObject({ code: 'invalid-input', error: expect.stringContaining('missing "object"') });
    expect(fail(await tools.call('setTimeRate', { rate: '10' }))).toMatchObject({ code: 'invalid-input', error: 'rate must be a number' });
    expect(fail(await tools.call('flyTo', { object: 'Titan', path: 'scenic' }))).toMatchObject({ code: 'invalid-input' });
    expect(fail(await tools.call('select', 'Titan'))).toMatchObject({ code: 'invalid-input' });
  });

  it('names a near miss for an unknown tool', async () => {
    expect(fail(await tools.call('flyto', { object: 'Titan' }))).toMatchObject({ code: 'unknown-tool', error: expect.stringContaining('"flyTo"') });
  });

  it('refuses unknown names with the scene\'s real ones, like a script line', async () => {
    const r = fail(await tools.call('select', { object: 'Titn' }));
    expect(r.code).toBe('refused');
    expect(r.error).toContain('did you mean "Titan"');
  });

  it('reports what the viewer threw', async () => {
    const host = new FakeViewer();
    const r = fail(await createAgentTools(host).call('gotoPlace', { place: '["titan-names","43"]' }));
    expect(r).toMatchObject({ code: 'failed', error: expect.stringContaining('frame mismatch') });
  });

  it('takes a time as a calendar string or seconds past J2000', async () => {
    const host = new FakeViewer();
    const calls: unknown[] = [];
    host.setTime = (when) => { calls.push(when); return true; };
    const t = createAgentTools(host);
    expect((await t.call('setTime', { when: '2021-04-30T19:00:00' })).ok).toBe(true);
    expect((await t.call('setTime', { when: 1000 })).ok).toBe(true);
    expect(calls).toEqual([{ kind: 'calendar', text: '2021-04-30T19:00:00' }, { kind: 'et', et: 1000 }]);
  });
});

describe('agent tools: scene context', () => {
  it('describes the scene, bounded, with explicit gaps', async () => {
    const host = new FakeViewer();
    host.objects = Array.from({ length: 100 }, (_, i) => `Object ${i}`);
    host.selected = 'Object 3';
    const r = await createAgentTools(host, { formatTime: () => '2000-01-01T12:00:00' }).call('describeScene', {});
    if (!r.ok) throw new Error(r.error);
    const data = r.data as Record<string, any>;
    expect(data.scene).toEqual({ id: 1, catalog: 'Cassini', ready: true });
    expect(data.time.utc).toBe('2000-01-01T12:00:00');
    expect(data.objects.total).toBe(100);
    expect(data.objects.names).toHaveLength(40);
    expect(data.selected).toBe('Object 3');
    expect(data.unsupported).toEqual([]);
  });

  it('reports the imagery of the body in focus', async () => {
    const host = new FakeViewer();
    host.tracked = 'Titan';
    const r = await createAgentTools(host).call('describeScene', {});
    const imagery = (r as { data: Record<string, any> }).data.focusImagery;
    expect(imagery.layers.map((l: { id: string }) => l.id)).toEqual(['iss', 'radar']);
    expect(imagery.imageryOnly).toBe(true);
  });

  it('resolves across kinds and flags ambiguity', async () => {
    const host = new FakeViewer();
    (host as ViewerControl).listActivities = () => [FLIGHT_5, { ...FLIGHT_5, id: 'ingenuity-flight-6', name: 'Flight 6' }];
    const tools = createAgentTools(host);
    const one = await tools.call('resolve', { query: 'flight 5' });
    expect((one as { data: any }).data).toEqual({ candidates: [{ kind: 'activity', id: 'ingenuity-flight-5', label: 'Flight 5', detail: 'flight, Ingenuity' }], ambiguous: false });
    const many = await tools.call('resolve', { query: 'mare', kinds: ['place'] });
    expect((many as { data: any }).data.ambiguous).toBe(true);
    const typo = await tools.call('resolve', { query: 'Enceladas', kinds: ['object'] });
    expect((typo as { data: any }).data.candidates[0].id).toBe('Enceladus');
    const none = await tools.call('resolve', { query: 'Ingenuity', kinds: ['object'] });
    expect((none as { summary: string }).summary).toContain('Nothing in this scene');
  });

  it('carries place provenance and availability', async () => {
    const r = await createAgentTools(new FakeViewer()).call('searchPlaces', { query: 'ligeia' });
    expect((r as { data: any }).data[0]).toMatchObject({ name: 'Ligeia Mare', unavailable: 'frame mismatch', source: expect.stringContaining('titan-names.geojson') });
  });

  it('says plainly when a body has no imagery', async () => {
    const tools = createAgentTools(new FakeViewer());
    expect(await tools.call('getImagery', { object: 'Saturn' })).toMatchObject({ ok: true, summary: 'Saturn has no streamed imagery.' });
    expect(fail(await tools.call('getImagery', { object: 'Satrun' })).error).toContain('did you mean "Saturn"');
  });
});

describe('agent tools: completion, supersession, takeover, stale scenes', () => {
  it('returns from a flight when it arrives', async () => {
    const host = new FakeViewer();
    const pending = createAgentTools(host).call('flyTo', { object: 'Titan' });
    await tick();
    land(host, 'arrived');
    expect(await pending).toEqual({ ok: true, summary: 'flyTo Titan: arrived at Titan.' });
  });

  it('leaves the camera to a person who takes it, for the rest of the task', async () => {
    const host = new FakeViewer();
    const task = createAgentTools(host).begin();
    const pending = task.call('flyTo', { object: 'Titan' });
    await tick();
    land(host, 'interrupted');
    expect(fail(await pending)).toMatchObject({ code: 'interrupted' });
    const before = host.calls.length;
    expect(fail(await task.call('jumpTo', { object: 'Saturn' }))).toMatchObject({ code: 'interrupted' });
    expect(host.calls.length).toBe(before);
    // Non-camera work still runs.
    expect((await task.call('select', { object: 'Saturn' })).ok).toBe(true);
  });

  it('a newer task supersedes the one running', async () => {
    const host = new FakeViewer();
    const tools = createAgentTools(host);
    const first = tools.begin();
    const pending = first.call('flyTo', { object: 'Titan' });
    await tick();
    const second = tools.begin();
    expect(fail(await pending)).toMatchObject({ code: 'superseded' });
    expect(fail(await first.call('select', { object: 'Titan' }))).toMatchObject({ code: 'superseded' });
    expect((await second.call('select', { object: 'Titan' })).ok).toBe(true);
  });

  it('cancelling stops the flight it waits on', async () => {
    const host = new FakeViewer();
    const tools = createAgentTools(host);
    const task = tools.begin();
    const pending = task.call('flyTo', { object: 'Titan' });
    await tick();
    tools.cancel();
    expect(fail(await pending)).toMatchObject({ code: 'cancelled' });
    expect(host.calls).toContain('stopFlight()');
  });

  it('waits for its own flight, not for another command\'s end', async () => {
    const host = new FakeViewer();
    const task = createAgentTools(host).begin();
    const pending = task.call('flyTo', { object: 'Titan' });
    await tick();
    const own = host.flight!.id;
    // A host's flight ends (a different id): it is not this wait's end.
    host.emit('flightEnd', { id: own + 100, target: 'Saturn', path: 'direct', outcome: 'arrived' });
    await tick();
    let settled = false;
    void pending.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    land(host, 'arrived');
    expect(await pending).toEqual({ ok: true, summary: 'flyTo Titan: arrived at Titan.' });
  });

  it('reports its flight stopped when another command replaces it, and does not wait on the replacement', async () => {
    const host = new FakeViewer();
    const tools = createAgentTools(host);
    const task = tools.begin();
    const pending = task.call('flyTo', { object: 'Titan' });
    await tick();
    const own = host.flight!;
    // A host starts its own flight; the agent's ends as stopped.
    host.flyTo('Saturn');
    host.emit('flightEnd', { id: own.id, target: own.target, path: own.path, outcome: 'stopped' });
    expect(fail(await pending)).toMatchObject({ code: 'failed', error: expect.stringContaining('stopped by another camera command') });
  });

  it('does not wait on a flight it did not start', async () => {
    const host = new FakeViewer();
    host.flyTo('Saturn'); // the host's own flight, already playing
    const task = createAgentTools(host).begin();
    // jumpTo starts no flight; the one playing is not this call's.
    expect(await task.call('jumpTo', { object: 'Titan' })).toMatchObject({ ok: true, summary: 'jumpTo Titan: done.' });
  });

  it('Stop ends the request only when no flight is its own', async () => {
    const host = new FakeViewer();
    const tools = createAgentTools(host);
    const task = tools.begin();
    // The model is still thinking when the host starts a flight.
    host.flyTo('Saturn');
    const flight = host.flight!.id;
    tools.cancel();
    expect(host.calls).not.toContain('stopFlight()');
    expect(host.flight?.id).toBe(flight);
    expect(fail(await task.call('select', { object: 'Titan' }))).toMatchObject({ code: 'cancelled' });
  });

  it('Stop does not stop a flight a host started after the task\'s own had ended', async () => {
    const host = new FakeViewer();
    const tools = createAgentTools(host);
    const task = tools.begin();
    const pending = task.call('flyTo', { object: 'Titan' });
    await tick();
    land(host, 'arrived');
    await pending;
    host.flyTo('Saturn');
    tools.cancel();
    expect(host.calls).not.toContain('stopFlight()');
    expect(host.flight?.target).toBe('Saturn');
  });

  it('refuses a place ref in a scene that replaced the one it was read from, even when the new scene reuses the ref', async () => {
    const host = new FakeViewer();
    const task = createAgentTools(host).begin();
    const place = host.places[0];
    host.scene = { id: 2, catalog: 'Other', ready: true }; // same layer and feature ids, a different catalog
    expect(fail(await task.call('gotoPlace', { place: place.ref }))).toMatchObject({ code: 'stale' });
    expect(host.calls.filter((c) => c.startsWith('gotoPlace'))).toEqual([]);
  });

  it('refuses to act on a scene loaded after the task began', async () => {
    const host = new FakeViewer();
    const task = createAgentTools(host).begin();
    host.scene = { id: 2, catalog: 'Cassini', ready: true };
    expect(fail(await task.call('select', { object: 'Titan' }))).toMatchObject({ code: 'stale' });
    expect(host.calls).toEqual([]);
  });

  it('ends a flight wait when the scene is replaced', async () => {
    const host = new FakeViewer();
    const task = createAgentTools(host).begin();
    const pending = task.call('flyTo', { object: 'Titan' });
    await tick();
    host.scene = { id: 2, catalog: 'Other', ready: false };
    host.emit('load', { objects: [] });
    expect(fail(await pending)).toMatchObject({ code: 'stale' });
  });

  it('refuses writes with no scene loaded', async () => {
    const host = new FakeViewer();
    host.scene = null;
    const tools = createAgentTools(host);
    expect(fail(await tools.call('select', { object: 'Titan' }))).toMatchObject({ code: 'no-scene' });
    expect(await tools.call('describeScene', {})).toMatchObject({ ok: true, summary: 'No scene is loaded.' });
  });
});

/** A scripted model: each reply in turn, recording what it was sent. */
class MockTransport implements AgentTransport {
  readonly requests: AgentRequest[] = [];
  constructor(private readonly replies: (AgentResponse | ((req: AgentRequest) => AgentResponse | Promise<AgentResponse>))[]) {}
  async send(request: AgentRequest): Promise<AgentResponse> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const next = this.replies.shift();
    if (!next) throw new Error('mock transport: no reply left');
    return typeof next === 'function' ? next(request) : next;
  }
}

const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use' as const, id, name, input });

describe('runAgent: the transport gives out partway', () => {
  const budget = () => new AgentTransportError('the model proxy answered 429: the proxy has spent its token budget', 'budget_exhausted', 429);
  const round = (n: number): AgentResponse => ({ stop: 'tool_use', content: [use(`s${n}`, 'select', { object: n % 2 ? 'Titan' : 'Saturn' })] });

  // A cap hit before any action, after one round, and after five.
  for (const rounds of [0, 1, 5]) {
    it(`after ${rounds} round${rounds === 1 ? '' : 's'}: an error with its code, a valid history, and no late calls`, async () => {
      const host = new FakeViewer();
      const replies: (AgentResponse | (() => never))[] = Array.from({ length: rounds }, (_, i) => round(i + 1));
      replies.push(() => { throw budget(); });
      const transport = new MockTransport(replies as never);
      const seen: string[] = [];
      const run = await runAgent({ transport, tools: createAgentTools(host), prompt: 'tour', onEvent: (e) => { if (e.type === 'tool-result') seen.push(`${e.name}:${e.result.ok}`); } });
      expect(run.outcome).toEqual({ kind: 'error', message: expect.stringContaining('token budget'), code: 'budget_exhausted' });
      // Only the rounds that ran acted, once each, and nothing ran after the failure.
      expect(seen).toHaveLength(rounds);
      expect(host.calls.filter((c) => c.startsWith('select'))).toHaveLength(rounds);
      expect(transport.requests).toHaveLength(rounds + 1);
      // Ends on the last results (or the prompt), so the next request continues a valid conversation.
      expect(run.messages.at(-1)!.role).toBe('user');
      const toolUses = run.messages.flatMap((m) => m.content.filter((c) => c.type === 'tool_use'));
      const results = run.messages.flatMap((m) => m.content.filter((c) => c.type === 'tool_result'));
      expect(results).toHaveLength(toolUses.length);
    });
  }

  it('leaves a transport failure without a code as a plain error', async () => {
    const transport = new MockTransport([() => { throw new Error('boom'); }] as never);
    const run = await runAgent({ transport, tools: createAgentTools(new FakeViewer()), prompt: 'x' });
    expect(run.outcome).toEqual({ kind: 'error', message: 'boom' });
  });
});

describe('runAgent', () => {
  it('runs a multi-step request, reporting partial failure, with a valid history', async () => {
    const host = new FakeViewer();
    const transport = new MockTransport([
      { stop: 'tool_use', content: [{ type: 'provider', block: { type: 'thinking', thinking: '', signature: 's' } }, use('a', 'select', { object: 'Titan' }), use('b', 'showImagery', { object: 'Titan', layer: 'ctx', visible: true })] },
      { stop: 'end', content: [{ type: 'text', text: 'Selected Titan; it has no "ctx" layer.' }] },
    ]);
    const events: string[] = [];
    const run = await runAgent({
      transport, tools: createAgentTools(host), prompt: 'select titan and show ctx',
      onEvent: (e) => events.push(e.type === 'tool-result' ? `${e.name}:${e.result.ok}` : e.type),
    });
    expect(run.outcome).toEqual({ kind: 'done' });
    expect(events).toEqual(['thinking', 'tool', 'select:true', 'tool', 'showImagery:false', 'thinking', 'text']);
    expect(run.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    // The provider block went back untouched, and both calls got results.
    const second = transport.requests[1];
    expect(second.messages[1].content[0]).toEqual({ type: 'provider', block: { type: 'thinking', thinking: '', signature: 's' } });
    const results = second.messages[2].content;
    expect(results.map((r) => r.type === 'tool_result' && [r.toolUseId, r.isError])).toEqual([['a', false], ['b', true]]);
    expect(JSON.stringify(results[1])).toContain('layers: iss, radar');
  });

  it('stops at the step limit', async () => {
    const replies = Array.from({ length: 3 }, (_, i) => ({ stop: 'tool_use' as const, content: [use(`t${i}`, 'describeScene', {})] }));
    const run = await runAgent({ transport: new MockTransport(replies), tools: createAgentTools(new FakeViewer()), prompt: 'loop', maxSteps: 3 });
    expect(run.outcome).toEqual({ kind: 'step-limit' });
  });

  it('turns a transport failure into an outcome', async () => {
    const run = await runAgent({ transport: { send: async () => { throw new Error('502 from proxy'); } }, tools: createAgentTools(new FakeViewer()), prompt: 'hi' });
    expect(run.outcome).toEqual({ kind: 'error', message: '502 from proxy' });
    expect(run.messages).toHaveLength(1);
  });

  it('drops a reply that arrives after a newer request', async () => {
    const host = new FakeViewer();
    const tools = createAgentTools(host);
    const task = tools.begin();
    const transport = new MockTransport([() => {
      tools.begin(); // the person asked something else meanwhile
      return { stop: 'tool_use', content: [use('a', 'select', { object: 'Titan' })] };
    }]);
    const run = await runAgent({ transport, tools, task, prompt: 'select titan' });
    expect(run.outcome).toEqual({ kind: 'superseded' });
    expect(host.calls).toEqual([]);
    expect(run.messages.at(-1)!.role).toBe('user');
  });

  it('continues a conversation from its history', async () => {
    const tools = createAgentTools(new FakeViewer());
    const first = await runAgent({ transport: new MockTransport([{ stop: 'end', content: [{ type: 'text', text: 'Hi.' }] }]), tools, prompt: 'hello' });
    const transport = new MockTransport([{ stop: 'end', content: [{ type: 'text', text: 'Again.' }] }]);
    const second = await runAgent({ transport, tools, history: first.messages, prompt: 'again' });
    expect(transport.requests[0].messages).toHaveLength(3);
    expect(second.messages).toHaveLength(4);
  });
});

describe('runAgent: acceptance scenarios', () => {

  it('marks narration beside tool calls apart from the answer, and reports only what ran', async () => {
    const host = new FakeViewer();
    const transport = new MockTransport([
      { stop: 'tool_use', content: [{ type: 'text', text: 'The object Mars is clearly meant.' }, use('a', 'describeScene', {})] },
      { stop: 'tool_use', content: [use('b', 'resolve', { query: 'Titan' }), use('c', 'select', { object: 'Titan' })] },
      { stop: 'end', content: [{ type: 'text', text: 'Selected Titan.' }] },
    ]);
    const texts: { text: string; final: boolean }[] = [];
    const results: string[] = [];
    const run = await runAgent({
      transport, tools: createAgentTools(host), prompt: 'select titan',
      onEvent: (e) => {
        if (e.type === 'text') texts.push({ text: e.text, final: e.final });
        if (e.type === 'tool-result') results.push(`${e.name}:${e.result.ok}`);
      },
    });
    expect(run.outcome).toEqual({ kind: 'done' });
    expect(texts).toEqual([{ text: 'The object Mars is clearly meant.', final: false }, { text: 'Selected Titan.', final: true }]);
    expect(results).toEqual(['describeScene:true', 'resolve:true', 'select:true']);
    expect(host.calls.filter((c) => c.startsWith('select'))).toHaveLength(1);
  });

  it('does not run a round\'s calls after the scene is replaced between rounds, and never touches the new scene', async () => {
    const host = new FakeViewer();
    const tools = createAgentTools(host);
    const transport = new MockTransport([
      () => ({ stop: 'tool_use', content: [use('a', 'select', { object: 'Titan' })] }),
      () => {
        host.scene = { id: 2, catalog: 'Other', ready: true }; // a catalog loaded while the model was thinking
        return { stop: 'tool_use', content: [use('b', 'gotoPlace', { place: host.places[0].ref }), use('c', 'select', { object: 'Saturn' })] };
      },
      { stop: 'end', content: [{ type: 'text', text: 'unused' }] },
    ]);
    const results: [string, boolean, string | undefined][] = [];
    const run = await runAgent({
      transport, tools, prompt: 'go',
      onEvent: (e) => { if (e.type === 'tool-result') results.push([e.name, e.result.ok, e.result.ok ? undefined : e.result.code]); },
    });
    expect(results).toEqual([['select', true, undefined], ['gotoPlace', false, 'stale'], ['select', false, 'stale']]);
    expect(host.calls.filter((c) => c.startsWith('gotoPlace'))).toEqual([]);
    expect(host.calls.filter((c) => c.startsWith('select'))).toHaveLength(1);
    expect(run.outcome).toEqual({ kind: 'stale' });
  });

  it('reports ambiguity as candidates, with their kinds, and missing data as missing', async () => {
    const host = new FakeViewer();
    host.places.push({ ...host.places[0], ref: '["names","7"]', name: 'Titan', feature: '7' });
    const tools = createAgentTools(host);
    const two = await tools.call('resolve', { query: 'Titan' });
    expect(two).toMatchObject({ ok: true, summary: expect.stringContaining('2 candidates'), data: { ambiguous: true } });
    expect((two as { data: { candidates: { kind: string }[] } }).data.candidates.map((c) => c.kind).sort()).toEqual(['object', 'place']);
    // Nothing invented for a landing site the scene does not have.
    expect(await tools.call('resolve', { query: 'Atlantis landing' })).toMatchObject({ ok: true, summary: expect.stringContaining('Nothing in this scene matches'), data: { ambiguous: false, candidates: [] } });
    expect(await tools.call('searchPlaces', { query: 'Atlantis' })).toMatchObject({ ok: true, summary: '0 places found.' });
    // A place the viewer cannot reach is refused with its reason, not flown to.
    const refused = await tools.call('gotoPlace', { place: host.places[1].ref });
    expect(refused).toMatchObject({ ok: false });
    expect(host.calls.filter((c) => c.startsWith('gotoPlace')).length).toBeLessThanOrEqual(1);
  });

  it('keeps a scripted multi-step flight request honest: only a completed flight is reported arrived', async () => {
    const host = new FakeViewer();
    const tools = createAgentTools(host);
    const transport = new MockTransport([
      { stop: 'tool_use', content: [use('a', 'describeScene', {}), use('b', 'flyTo', { object: 'Titan' })] },
      (req) => ({ stop: 'end', content: [{ type: 'text', text: JSON.stringify(req.messages.at(-1)!.content.map((c) => c.type === 'tool_result' && c.isError)) }] }),
    ]);
    const pending = runAgent({ transport, tools, prompt: 'fly to titan' });
    await tick();
    await tick();
    // The person takes the camera before it lands: the flight is reported interrupted, not arrived.
    land(host, 'interrupted');
    const run = await pending;
    expect(run.outcome).toEqual({ kind: 'done' });
    const toolResults = transport.requests[1].messages.at(-1)!.content;
    const fly = toolResults.find((c) => c.type === 'tool_result' && c.toolUseId === 'b');
    expect(JSON.stringify(fly)).toContain('interrupted');
    expect(JSON.stringify(fly)).not.toContain('arrived');
  });
});

// The Ingenuity at Jezero case: the activity says its site by name, the place layer has a place by that
// name with the source's own attributes, and nothing links them but the name.
class MissionViewer extends FakeViewer {
  readonly activities: ScriptActivity[] = [
    {
      ...FLIGHT_5, id: 'ingenuity:flight:5', name: 'Flight 5', start: 673687471, end: 673687579.2, site: 'Airfield B', mission: 'Mars 2020',
      references: { trajectory: 'Ingenuity', sourceSegment: 'data/ingenuity/flight_05.xyzv' },
      provenance: { source: 'https://mars.nasa.gov/maps/location/?mission=M20', version: 'pinned', authority: 'estimated', timing: 'estimated', limitations: 'Observed horizontal path with estimated 3D playback, not precise flight telemetry.' },
    },
    { ...FLIGHT_5, id: 'ingenuity:flight:6', name: 'Flight 6', site: 'Airfield C', start: 675019097.7, end: 675019200 },
    { ...FLIGHT_5, id: 'ingenuity:flight:7', name: 'Flight 7', site: 'Airfield D', references: { location: '["ingenuity-sites","airfield-7"]' }, start: 676000000, end: 676000100 },
  ];
  selectedActivityId: string | null = null;
  /** A selection something else changes behind the caller's back. */
  loseSelection = false;
  constructor() {
    super();
    const site = (name: string, feature: string, fields: Record<string, string | number>) => ({
      ref: `["ingenuity-sites","${feature}"]`, name, body: 'Mars', layer: { id: 'ingenuity-sites', name: 'Ingenuity sites' }, feature, kind: 'mission-site',
      origin: 'mission/user' as const, latitude: 18.44266513, longitude: 77.4513883, fields,
      source: { kind: 'catalog' as const, identity: 'places/ingenuity-sites.geojson' }, unavailable: null,
    });
    this.places = [site('Airfield B', 'airfield-5', { Flight: 5, Earth_Date: 'May 7, 2021' }), site('Airfield D', 'airfield-7', { Flight: 7 })];
  }
  listActivities() { return this.activities; }
  getActivity(id: string) { return this.activities.find((a) => a.id === id); }
  getSelectedActivity() { return this.activities.find((a) => a.id === this.selectedActivityId); }
  selectActivity(id: string, _opts?: { scene?: number }) {
    if (!this.getActivity(id)) return false;
    this.selectedActivityId = this.loseSelection ? null : id;
    return true;
  }
  seekActivity(id: string, edge: 'start' | 'end' = 'start', _opts?: { scene?: number }) {
    const a = this.getActivity(id);
    if (!a) return false;
    this.time = a[edge];
    return true;
  }
}

describe('agent tools: where an activity happened', () => {
  const fmt = (et: number) => `ET ${et}`;
  const data = (r: AgentToolResult) => (r as { data: any }).data;

  it('lists an activity\'s site and references, and the places its name matches, saying it is a name match', async () => {
    const tools = createAgentTools(new MissionViewer(), { formatTime: fmt });
    const { activities } = data(await tools.call('listActivities', { vehicle: 'Ingenuity' }));
    const [five, six, seven] = activities;
    expect(five).toMatchObject({
      id: 'ingenuity:flight:5', mission: 'Mars 2020', startUtc: 'ET 673687471',
      references: { trajectory: 'Ingenuity', sourceSegment: 'data/ingenuity/flight_05.xyzv' },
      provenance: { timing: 'estimated', limitations: expect.stringContaining('not precise flight telemetry') },
      site: { name: 'Airfield B', link: 'name match', basis: expect.stringContaining('no direct place reference') },
    });
    // The place carries the source's own attributes, so the evidence is quotable, not inferred from a ref.
    expect(five.site.places).toEqual([expect.objectContaining({ ref: '["ingenuity-sites","airfield-5"]', name: 'Airfield B', fields: { Flight: 5, Earth_Date: 'May 7, 2021' } })]);
    // A site no place is named after is reported as having no place.
    expect(six.site).toMatchObject({ name: 'Airfield C', link: 'none', places: [], basis: expect.stringContaining('no place in this scene has the site\'s name') });
    // A record that points at a place says so.
    expect(seven.site).toMatchObject({ name: 'Airfield D', locationRef: '["ingenuity-sites","airfield-7"]', link: 'direct reference', places: [expect.objectContaining({ name: 'Airfield D' })] });
  });

  it('puts the same evidence in the scene description of the selected activity', async () => {
    const host = new MissionViewer();
    host.selectedActivityId = 'ingenuity:flight:5';
    const r = await createAgentTools(host, { formatTime: fmt }).call('describeScene', {});
    expect(data(r).selectedActivity).toMatchObject({ id: 'ingenuity:flight:5', startUtc: 'ET 673687471', site: { link: 'name match', places: [expect.objectContaining({ name: 'Airfield B' })] } });
  });

  it('resolves an activity with its site in the candidate detail', async () => {
    const r = await createAgentTools(new MissionViewer()).call('resolve', { query: 'flight 5', kinds: ['activity'] });
    expect(data(r).candidates[0]).toMatchObject({ detail: 'flight, Ingenuity, site Airfield B' });
  });
});

describe('agent tools: what a write leaves in place', () => {
  const fmt = (et: number) => `ET ${et}`;

  it('reads the selection back, so "selected" is what the viewer reports', async () => {
    const host = new MissionViewer();
    const tools = createAgentTools(host, { formatTime: fmt });
    expect(await tools.call('selectActivity', { activity: 'ingenuity:flight:5' })).toMatchObject({
      ok: true, summary: expect.stringContaining('The viewer now reports Flight 5 (ingenuity:flight:5) as the selected activity.'),
    });
    expect(await tools.call('seekActivity', { activity: 'ingenuity:flight:5' })).toMatchObject({ ok: true, summary: expect.stringContaining('The clock now reads ET 673687471.') });
  });

  it('refuses to report a selection the viewer does not hold', async () => {
    const host = new MissionViewer();
    host.loseSelection = true; // something clears it between the write and the read
    const r = await createAgentTools(host).call('selectActivity', { activity: 'ingenuity:flight:5' });
    expect(r).toMatchObject({ ok: false, code: 'failed', error: expect.stringContaining('the viewer reports none as selected') });
  });

  it('reads a place selection back after navigating', async () => {
    const host = new MissionViewer();
    const place = host.places[0];
    const r = await createAgentTools(host).call('gotoPlace', { place: place.ref });
    // The host's fake flight starts no animation, so this returns at once.
    expect(r).toMatchObject({ ok: true, summary: expect.stringContaining('The viewer now reports Airfield B as the selected place.') });
  });

  it('Flight 5: select, seek, go to its site, then a final read agrees with every step', async () => {
    const host = new MissionViewer();
    const tools = createAgentTools(host, { formatTime: fmt });
    const transport = new MockTransport([
      { stop: 'tool_use', content: [use('a', 'listActivities', { vehicle: 'Ingenuity' })] },
      (req) => {
        const listed = JSON.parse((req.messages.at(-1)!.content[0] as { content: string }).content).data.activities[0];
        return { stop: 'tool_use', content: [
          use('b', 'selectActivity', { activity: listed.id }),
          use('c', 'seekActivity', { activity: listed.id }),
          use('d', 'gotoPlace', { place: listed.site.places[0].ref }),
        ] };
      },
      { stop: 'tool_use', content: [use('e', 'describeScene', {})] },
      (req) => {
        const scene = JSON.parse((req.messages.at(-1)!.content[0] as { content: string }).content).data;
        // The model's answer is built from the final read.
        return { stop: 'end', content: [{ type: 'text', text: `${scene.selectedActivity.name} selected; ${scene.selectedPlace.name}; ${scene.time.utc}; link ${scene.selectedActivity.site.link}.` }] };
      },
    ]);
    let answer = '';
    const results: [string, boolean][] = [];
    const run = await runAgent({
      transport, tools, prompt: 'Show me Flight 5, go to its landing site and tell me what is there',
      onEvent: (e) => { if (e.type === 'text' && e.final) answer = e.text; if (e.type === 'tool-result') results.push([e.name, e.result.ok]); },
    });
    expect(run.outcome).toEqual({ kind: 'done' });
    expect(results).toEqual([['listActivities', true], ['selectActivity', true], ['seekActivity', true], ['gotoPlace', true], ['describeScene', true]]);
    expect(answer).toBe('Flight 5 selected; Airfield B; ET 673687471; link name match.');
    // And the viewer itself agrees.
    expect(host.getSelectedActivity()?.id).toBe('ingenuity:flight:5');
    expect(host.getSelectedPlace()?.name).toBe('Airfield B');
    expect(host.getTime()).toBe(673687471);
  });

  it('a flight with no place of that name gives the model nothing to navigate to', async () => {
    const tools = createAgentTools(new MissionViewer());
    const { data } = (await tools.call('listActivities', { vehicle: 'Ingenuity' })) as { data: { activities: { id: string; site: { link: string; places: unknown[] } }[] } };
    const six = data.activities.find((a) => a.id === 'ingenuity:flight:6')!;
    expect(six.site).toMatchObject({ link: 'none', places: [] });
    expect((await tools.call('resolve', { query: 'Airfield C', kinds: ['place'] })) as { summary: string }).toMatchObject({ summary: expect.stringContaining('Nothing in this scene matches') });
  });
});

