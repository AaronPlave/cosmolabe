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
import { checkGoal } from './outcome.js';
import { compactHistory, runAgent, AgentTransportError, type AgentContent, type AgentMessage, type AgentRequest, type AgentResponse } from './agent-loop.js';
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

/** The turns, as the shipped prompt directs: compose around the anchor, then check the whole goal once. */
const SCRIPT: Record<string, AgentResponse[]> = {
  'show me when psyche is within 10000km of mars': [
    call(use('a1', 'invokeCapability', { id: 'time.setPlaying', input: { on: false } }), use('a2', 'invokeCapability', { id: 'time.setTime', input: { when: ENCOUNTER } })),
    say('Psyche is within 10,000 km of Mars for about 40 minutes; paused at the start.'),
  ],
  'zoom into psyche': [
    call(use('b1', 'invokeCapability', { id: 'camera.frameObject', input: { object: 'Psyche' } })),
    say('Zoomed in on Psyche.'),
  ],
  'frame the scene so psyche and mars are both in view': [
    call(use('c1', 'composeView', { anchor: 'Psyche', target: 'Mars' })),
    call(use('c2', 'checkGoal', { kind: 'camera-composition', anchor: 'Psyche', include: ['Mars'] })),
    say('Rotated around Psyche; Mars is now in frame.'),
  ],
  'but keep psyche up close': [
    call(use('d1', 'checkGoal', { kind: 'camera-composition', anchor: 'Psyche', include: ['Mars'], maxAnchorRangeKm: 0.1, paused: true })),
    say('Psyche is still close (60 m) and Mars stays in frame.'),
  ],
  'not true just need to rotate the camera around psyche to see mars': [
    call(use('e1', 'composeView', { anchor: 'Psyche', target: 'Mars' })),
    call(use('e2', 'checkGoal', { kind: 'camera-composition', anchor: 'Psyche', include: ['Mars'], maxAnchorRangeKm: 0.1, paused: true, et: ENCOUNTER })),
    say('Rotated around Psyche while staying close; Mars is in frame.'),
  ],
};

function scriptedModel(budget = Infinity) {
  const requests: AgentRequest[] = [];
  let spent = 0;
  const transport = {
    async send(request: AgentRequest): Promise<AgentResponse> {
      if (spent >= budget) throw new AgentTransportError('the proxy has reached its raw-token safety cap', 'budget_exhausted', 429);
      requests.push({ ...request, messages: [...request.messages] });
      const prompt = [...request.messages].reverse().find(m => m.role === 'user' && m.content.some(c => c.type === 'text'))!;
      const turn = SCRIPT[(prompt.content.find(c => c.type === 'text') as { text: string }).text];
      const round = request.messages.length - request.messages.indexOf(prompt) - 1;
      const reply = turn[round / 2];
      spent += Object.values(reply.usage!).reduce((a, b) => a + b, 0);
      return reply;
    },
  };
  return { transport, requests };
}

async function converse(budget?: number) {
  const host = new PsycheScene();
  const tools = createCapabilityTools(host, { surface: 'fixed' });
  const model = scriptedModel(budget);
  let history: readonly AgentMessage[] = [];
  const turns = [];
  for (const prompt of Object.keys(SCRIPT)) {
    const run = await runAgent({ transport: model.transport, tools, history, prompt });
    history = run.messages;
    turns.push(run);
  }
  return { host, tools, model, turns };
}

describe('Psyche/Mars five-turn close-up (#345)', () => {
  it('ends close to Psyche, Mars in frame, at the paused encounter epoch', async () => {
    const { host, turns } = await converse();
    expect(turns.map(t => t.outcome.kind)).toEqual(['done', 'done', 'done', 'done', 'done']);
    const report = checkGoal(host, { kind: 'camera-composition', anchor: 'Psyche', include: ['Mars'], maxAnchorRangeKm: 0.1, paused: true, et: ENCOUNTER });
    expect(report.status, JSON.stringify(report.checks)).toBe('met');
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
    expect(stats.map(s => s.rounds)).toEqual([2, 2, 3, 2, 3]);
    expect(stats.every(s => s.rawTokens !== null && s.rawTokens <= 3 * 9440)).toBe(true);
    const lastTurnFirstRequest = model.requests.at(-3)!;
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
    expect(checkGoal(host, { kind: 'camera-composition', anchor: 'Psyche', include: ['Mars'] }).status).toBe('met');
    const condensed = compactHistory(turns.at(-1)!.messages);
    expect(condensed.map(m => m.role)).toEqual(Array.from({ length: condensed.length }, (_, i) => (i % 2 ? 'assistant' : 'user')));
  });
});

describe('history condensing', () => {
  it('is idempotent, alternates roles and drops reads but keeps writes', async () => {
    const { turns } = await converse();
    const once = compactHistory(turns.at(-1)!.messages);
    expect(compactHistory(once)).toEqual(once);
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
    for (const d of ['Right', 'Left', 'Up', 'Down']) expect(index).toContain(`camera.circleCenter${d}(`);
    expect(index).not.toMatch(/camera\.circleCenter\(/);
    expect(index).toContain('camera.composeView(');
  });
});
