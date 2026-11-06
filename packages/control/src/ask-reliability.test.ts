/**
 * #345 regression: the five-turn Psyche/Mars close-up conversation, offline.
 *
 * A scripted model plays the turns the way the shipped prompt asks it to; the
 * assertions are about everything around the model: the tools fixed Ask
 * offers, what each round replays, how long the conversation stays cheap, and
 * the end state judged by the viewer's own reads, not by the answers.
 */
import { describe, expect, it } from 'vitest';
import { FakeViewer } from './__tests__/fake-host.js';
import { CURATED_AGENT_VERBS } from './agent.js';
import { createCapabilityTools } from './capabilities.js';
import { evaluate, type Predicate } from './outcome.js';
import { compactHistory, runAgent, AgentTransportError, HOST_CHECK_PREFIX, type AgentContent, type AgentMessage, type AgentRequest, type AgentResponse } from './agent-loop.js';
import { VERBS } from './verbs.js';

const ENCOUNTER = 832_000_000;

class PsycheScene extends FakeViewer {
  constructor() {
    super();
    this.objects = ['Psyche', 'Mars', 'Sun'];
    this.bodies = { Psyche: { position: [0, 0, 0], radiusKm: 0.0125 }, Mars: { position: [-6000, 1500, 7800], radiusKm: 3389.5 } };
    this.camera = { position: [20_000, 0, 0], target: [0, 0, 0], up: [0, 1, 0], fov: 45 };
    this.scene = { id: 7, catalog: 'Psyche', ready: true };
  }
  // Mars terrain coloured by elevation in an earlier conversation turn.
  override getSurfaceAppearance(body: string) { return body === 'Mars' ? { settings: { hillshade: true, baseColor: 'elevation' } as never, unavailable: null } : undefined; }
  // A close-up: what the viewer's frameObject does for a spacecraft.
  override frameObject(name?: string): boolean {
    const ok = super.frameObject(name);
    if (ok && name === 'Psyche') this.camera = { ...this.camera, position: [0, 0, 0.06], target: [0, 0, 0], up: [0, 1, 0] };
    return ok;
  }
}

const use = (id: string, name: string, input: unknown): AgentContent => ({ type: 'tool_use', id, name, input });
const say = (text: string): AgentResponse => ({ content: [{ type: 'text', text }], stop: 'end', usage: { inputTokens: 300, cacheReadTokens: 9000, cacheWriteTokens: 0, outputTokens: 60 } });
const call = (...uses: AgentContent[]): AgentResponse => ({ content: uses, stop: 'tool_use', usage: { inputTokens: 300, cacheReadTokens: 9000, cacheWriteTokens: 0, outputTokens: 80 } });

/**
 * The turns, as the shipped prompt directs: state what the person asked for
 * with checkGoal before the first change, in the same reply, then act. Every
 * write also holds itself to its own result.
 */
const goal = (id: string, require: unknown[] = [], release?: string[]) => use(id, 'checkGoal', { require, ...(release ? { release } : {}) });
const SCRIPT: Record<string, AgentResponse[]> = {
  'show me when psyche is within 10000km of mars': [
    call(goal('a0'), use('a1', 'invokeCapability', { id: 'time.setPlaying', input: { on: false } }), use('a2', 'invokeCapability', { id: 'time.setTime', input: { when: ENCOUNTER } })),
    say('Psyche is within 10,000 km of Mars for about 40 minutes; paused at the start.'),
  ],
  'zoom into psyche': [
    call(goal('b0', [{ p: 'range', object: 'Psyche', maxKm: 0.1 }]), use('b1', 'invokeCapability', { id: 'camera.frameObject', input: { object: 'Psyche' } })),
    say('Zoomed in on Psyche.'),
  ],
  'frame the scene so psyche and mars are both in view': [
    call(goal('c0', [{ p: 'inView', object: 'Mars' }, { p: 'legible', object: 'Mars' }]), use('c1', 'composeView', { anchor: 'Psyche', target: 'Mars' })),
    say('Rotated around Psyche; Mars is now in frame.'),
  ],
  'but keep psyche up close': [
    call(goal('d1', [{ p: 'range', object: 'Psyche', maxKm: 0.1 }])),
    say('Psyche is still close (60 m) and Mars stays in frame.'),
  ],
  'pull way back': [
    call(goal('f0'), use('f1', 'invokeCapability', { id: 'camera.dolly', input: { km: 5000 } })),
    say('Pulled back.'),
    say('Pulled back 5,000 km; Psyche is no longer up close, so that earlier request no longer holds.'),
  ],
  'not true just need to rotate the camera around psyche to see mars': [
    // States only Mars: the close-up limit from turn 2 is held anyway.
    call(goal('e0', [{ p: 'inView', object: 'Mars' }]), use('e1', 'composeView', { anchor: 'Psyche', target: 'Mars' })),
    say('Rotated around Psyche while staying close; Mars is in frame.'),
  ],
  // A new subject: the person dropped the Psyche close-up, so the model releases it; the Mars terrain colouring still holds.
  'now just show mars': [
    call(goal('g0', [{ p: 'inView', object: 'Mars' }], ['range:Psyche', 'view:Psyche']), use('g1', 'invokeCapability', { id: 'camera.frameObject', input: { object: 'Mars' } })),
    say('Framed Mars.'),
  ],
  // A change on another subject that breaks an earlier goal the model did not think of.
  'hide mars': [
    call(goal('h0'), use('h1', 'invokeCapability', { id: 'display.setObjectVisible', input: { object: 'Mars', visible: false } })),
    say('Mars is hidden.'),
    say('Mars is hidden, so it is no longer in view beside Psyche.'),
  ],
};

function scriptedModel(budget = Infinity) {
  const requests: AgentRequest[] = [];
  let spent = 0;
  const transport = {
    async send(request: AgentRequest): Promise<AgentResponse> {
      if (spent >= budget) throw new AgentTransportError('the proxy has reached its raw-token safety cap', 'budget_exhausted', 429);
      requests.push({ ...request, messages: [...request.messages] });
      const prompt = [...request.messages].reverse().find(m => m.role === 'user' && m.content.some(c => c.type === 'text' && !c.text.startsWith(HOST_CHECK_PREFIX)))!;
      const turn = SCRIPT[(prompt.content.find(c => c.type === 'text') as { text: string }).text];
      const round = request.messages.length - request.messages.indexOf(prompt) - 1;
      const reply = turn[round / 2];
      spent += Object.values(reply.usage!).reduce((a, b) => a + b, 0);
      return reply;
    },
  };
  return { transport, requests };
}

const FIVE = ['show me when psyche is within 10000km of mars', 'zoom into psyche', 'frame the scene so psyche and mars are both in view',
  'but keep psyche up close', 'not true just need to rotate the camera around psyche to see mars'];

const SURFACE: Predicate = { p: 'state', read: 'getSurfaceAppearance', args: ['Mars'], path: 'settings.baseColor', equals: 'elevation' };
const CLOSE_UP: Predicate[] = [{ p: 'inView', object: 'Psyche' }, { p: 'inView', object: 'Mars' }, { p: 'legible', object: 'Mars' }, { p: 'range', object: 'Psyche', maxKm: 0.1 },
  { p: 'paused', value: true }, { p: 'epoch', et: ENCOUNTER }];

async function converse(budget?: number, prompts: readonly string[] = FIVE, initialGoals: readonly Predicate[] = []) {
  const host = new PsycheScene();
  const tools = createCapabilityTools(host, { surface: 'fixed' });
  const model = scriptedModel(budget);
  let history: readonly AgentMessage[] = [];
  let goals: readonly Predicate[] = initialGoals;
  const turns = [];
  for (const prompt of prompts) {
    const run = await runAgent({ transport: model.transport, tools, history, goals, prompt });
    history = run.messages;
    goals = run.goals;
    turns.push(run);
  }
  return { host, tools, model, turns };
}

describe('Psyche/Mars five-turn close-up (#345)', () => {
  it('ends close to Psyche, Mars in frame, at the paused encounter epoch', async () => {
    const { host, turns } = await converse();
    expect(turns.map(t => t.outcome.kind)).toEqual(['done', 'done', 'done', 'done', 'done']);
    const report = evaluate(host, CLOSE_UP);
    expect(report.status, JSON.stringify(report.checks)).toBe('met');
    // And the viewer's own verdict on every turn agrees.
    expect(turns.map(t => t.result.status)).toEqual(['verified', 'verified', 'verified', 'no-change', 'verified']);
    expect([host.tracked, host.time, host.playing]).toEqual(['Psyche', ENCOUNTER, false]);
    // Only the swings composeView makes: no frameObject/pair-framing flip-flop after the close-up.
    expect(host.calls.filter(c => /frameObject|dolly/.test(c))).toEqual(['frameObject("Psyche")']);
  });

  it('offers the camera tools directly in fixed Ask and verifies camera writes', async () => {
    const { turns, tools } = await converse();
    expect(tools.list().map(t => t.name)).toEqual(expect.arrayContaining(['composeView', 'checkGoal']));
    const results = turns.flatMap(t => t.messages).flatMap(m => m.content).filter(c => c.type === 'tool_result');
    expect(results.every(r => r.type === 'tool_result' && !r.isError)).toBe(true);
    // A camera write with a shared composition read is completed, not "unverified".
    const composed = results.map(r => JSON.parse((r as { content: string }).content)).filter(r => r.receipt?.operation === 'camera.composeView');
    expect(composed.length).toBeGreaterThan(0);
    expect(composed.every(r => r.receipt.status === 'completed')).toBe(true);
  });

  it('stays cheap: earlier turns are condensed, not replayed tool by tool', async () => {
    const { model, turns } = await converse();
    const stats = turns.map(t => t.stats);
    expect(stats.map(s => s.rounds)).toEqual([2, 2, 2, 2, 2]);
    expect(stats.every(s => s.rawTokens !== null && s.rawTokens <= 3 * 9440)).toBe(true);
    const lastTurnFirstRequest = model.requests.at(-2)!;
    const priorResults = lastTurnFirstRequest.messages.slice(0, -1).flatMap(m => m.content).filter(c => c.type !== 'text');
    expect(priorResults).toEqual([]);
    // Four earlier turns condense to eight short messages, not dozens of tool exchanges.
    expect(lastTurnFirstRequest.messages.length).toBe(9);
    expect(JSON.stringify(lastTurnFirstRequest.messages).length).toBeLessThan(2500);
    // Against replaying every earlier tool exchange verbatim.
    const raw = turns.slice(0, -1).flatMap((t, i) => t.messages.slice(i === 0 ? 0 : 2 * i));
    expect(JSON.stringify(lastTurnFirstRequest.messages).length * 3).toBeLessThan(JSON.stringify(raw).length);
    // The condensed history still says what the viewer did.
    expect(lastTurnFirstRequest.messages.map(m => (m.content[0] as { text: string }).text).join('\n')).toMatch(/composeView\{"anchor":"Psyche","target":"Mars"\} ok/);
  });

  it('on a hard budget stop, keeps every applied change and a valid, condensable history', async () => {
    // Enough for the first three turns and one round of the fourth.
    const { host, turns } = await converse(70_000);
    expect(turns.slice(0, 3).every(t => t.outcome.kind === 'done')).toBe(true);
    expect(turns.at(-1)!.outcome).toMatchObject({ kind: 'error', code: 'budget_exhausted' });
    // The composition made before the stop holds.
    expect(evaluate(host, [{ p: 'inView', object: 'Psyche' }, { p: 'inView', object: 'Mars' }]).status).toBe('met');
    const condensed = compactHistory(turns.at(-1)!.messages);
    expect(condensed.map(m => m.role)).toEqual(Array.from({ length: condensed.length }, (_, i) => (i % 2 ? 'assistant' : 'user')));
  });
});

describe('the loop holds the conversation to its goals (#345 review)', () => {
  it('a check that omits an earlier constraint is still judged by it', async () => {
    const { turns } = await converse();
    const last = turns.at(-1)!;
    expect(last.goals).toEqual(expect.arrayContaining([{ p: 'range', object: 'Psyche', maxKm: 0.1, stated: true }, { p: 'paused', value: true }, { p: 'epoch', et: ENCOUNTER }, { p: 'inView', object: 'Mars', stated: true }]));
    const summaries = last.messages.flatMap(m => m.content).filter(c => c.type === 'tool_result').map(c => JSON.parse((c as { content: string }).content).summary);
    // Stated before the change, it is held, not yet judged.
    expect(summaries[0]).toMatch(/^Held: .*range:Psyche/);
    expect(last.result).toMatchObject({ status: 'verified', report: { status: 'met' } });
    expect(last.result.report!.checks.map(c => c.slot)).toEqual(expect.arrayContaining(['range:Psyche', 'clock', 'playing', 'view:Mars']));
  });

  it('re-checks a change the model did not check, and makes it answer to an unmet goal', async () => {
    const { turns, model } = await converse(undefined, [...FIVE, 'pull way back']);
    const run = turns.at(-1)!;
    expect(run.outcome.kind).toBe('done');
    const nudge = model.requests.at(-1)!.messages.at(-1)!;
    expect(nudge.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/^\[Viewer check\] The viewer reports: range:Psyche unmet \(Psyche at 5000.06 km \(limit 0.1\)\)/) });
    expect(run.stats.rounds).toBe(3);
    // The candidate "Pulled back." was never shown: only the answer given after the check.
    expect(run.answer).toBe('Pulled back 5,000 km; Psyche is no longer up close, so that earlier request no longer holds.');
    // A relative move has no end state of its own, and the held close-up fails: not verified.
    expect(run.result).toMatchObject({ status: 'failed', unobservable: [expect.stringMatching(/^dolly: a relative camera move/)] });
    // The nudge is part of the same request when history is condensed.
    expect(compactHistory(run.messages)).toHaveLength(12);
  });

  it('every write holds itself to its own result: an empty goal statement is enough to verify a clock change', async () => {
    const { turns } = await converse();
    expect(turns[0].stats.rounds).toBe(2);
    expect(turns[0].result).toMatchObject({ status: 'verified', report: { status: 'met' } });
    expect(turns[0].goals).toEqual([{ p: 'paused', value: true }, { p: 'epoch', et: ENCOUNTER }]);
  });

  it('a person who drops a subject releases its goals; independent ones stay', async () => {
    const { turns } = await converse(undefined, [...FIVE, 'now just show mars'], [SURFACE]);
    const run = turns.at(-1)!;
    expect(run.goals.map(p => p.p === 'state' ? 'surface' : `${p.p}${p.object ? `:${p.object}` : ''}`).sort())
      .toEqual(['epoch', 'inView:Mars', 'legible:Mars', 'paused', 'surface', 'tracked:Mars']);
    expect(run.result.changes.join(' ')).toMatch(/Released range Psyche <= 0.1 km/);
    // The stale close-up is not held against the new request.
    expect(run.result.status).toBe('verified');
    expect(run.stats.rounds).toBe(2);
  });

  it('re-checks earlier goals a change on another subject broke', async () => {
    const { turns, model } = await converse(undefined, [...FIVE, 'hide mars'], [SURFACE]);
    const run = turns.at(-1)!;
    const nudge = JSON.stringify(model.requests.at(-1)!.messages.at(-1));
    expect(nudge).toMatch(/\[Viewer check\] The viewer reports: view:Mars unmet \(Mars is hidden\)/);
    expect(nudge).not.toMatch(/getSurfaceAppearance/);
    expect(run.stats.rounds).toBe(3);
    expect(run.result.status).toBe('failed');
  });
});

describe('history condensing', () => {
  it('is idempotent, alternates roles and drops reads but keeps writes', async () => {
    const { turns } = await converse();
    const once = compactHistory(turns.at(-1)!.messages);
    expect(compactHistory(once)).toEqual(once);
    // Reads are known by their contracts, not their names.
    expect(once).toHaveLength(10);
    const text = once.map(m => (m.content[0] as { text: string }).text).join('\n');
    expect(text).not.toMatch(/checkGoal/);
    expect(text).toMatch(/setTime\{"when":832000000\} ok/);
  });
});

describe('fixed Ask vocabulary parity', () => {
  it('names only registered verbs; the directional orbit verbs exist and "circleCenter" does not', () => {
    for (const verb of CURATED_AGENT_VERBS) expect(VERBS.has(verb), verb).toBe(true);
    expect(VERBS.has('circleCenter')).toBe(false);
    const tools = createCapabilityTools(new PsycheScene(), { surface: 'fixed' });
    const index = tools.list().find(t => t.name === 'invokeCapability')!.description;
    for (const d of ['Right', 'Left', 'Up', 'Down']) expect(index).toMatch(new RegExp(`camera\\.circleCenter${d}\\*?\\(`));
    expect(index).not.toMatch(/camera\.circleCenter\*?\(/);
    expect(index).toContain('camera.composeView*(');
  });
});
