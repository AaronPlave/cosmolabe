/**
 * #381: what a conversation carries from one request to the next.
 *
 * Referents survive (the event, object and result under discussion are still
 * checked); target states do not bind the next request: a new question about
 * another time, event or view supersedes what the earlier request held about
 * that domain, at the host layer, without the model remembering `release`.
 * Only what the person made enduring (`keep`) holds, and a change that
 * contradicts it is refused with an explanation. The person's own moves,
 * a replaced scene and a stopped request retire what was held.
 *
 * Every sequence asserts the viewer's actual final time, selection and camera
 * from the fake host, never from the scripted answers.
 */
import { describe, expect, it } from 'vitest';
import { FakeViewer } from './__tests__/fake-host.js';
import { createCapabilityTools } from './capabilities.js';
import { runAgent, type AgentContent, type AgentMessage, type AgentRequest, type AgentResponse } from './agent-loop.js';
import type { Predicate } from './outcome.js';
import type { ScriptEventReference, ScriptEventResultPage, ScriptEventVisualization } from './contracts.js';

const TITAN_ET = 166_950_769, FAR_ET = 146_844_527;
const use = (id: string, name: string, input: unknown): AgentContent => ({ type: 'tool_use', id, name, input });
const say = (text: string): AgentResponse => ({ content: [{ type: 'text', text }], stop: 'end' });
const call = (...uses: AgentContent[]): AgentResponse => ({ content: uses, stop: 'tool_use' });
const goal = (require: unknown[] = [], release?: string[]) => use(`goal-${Math.random().toString(36).slice(2, 6)}`, 'checkGoal', { require, ...(release ? { release } : {}) });
const op = (id: string, input: unknown) => use(`${id}-${Math.random().toString(36).slice(2, 6)}`, 'invokeCapability', { id, input });
/** The operations' usage notes, read at the start of each request (they are delivered per request), as the shipped prompt directs. */
const NOTES = call(use('notes', 'describeCapabilities', { ids: ['events.presentEventResult', 'camera.frameObject', 'time.setTime', 'time.setPlaying', 'camera.composeView'] }));
const ref = (query: string) => JSON.stringify({ scene: 5, query, id: `${query}-0`, revision: 1 });

/** Cassini at Saturn: a saved Titan closest approach and a Saturn farthest-point search, each with one result. */
class SaturnScene extends FakeViewer {
  readonly searches: Record<string, { observer: string; target: string; et: number; km: number; extremum: 'minimum' | 'maximum' }> = {
    titan: { observer: 'Cassini', target: 'Titan', et: TITAN_ET, km: 3601.5, extremum: 'minimum' },
    far: { observer: 'Cassini', target: 'Saturn', et: FAR_ET, km: 9.1e6, extremum: 'maximum' },
  };
  selectedRef: ScriptEventReference | null = null;
  constructor() {
    super();
    this.objects = ['Cassini', 'Titan', 'Saturn', 'Sun'];
    this.scene = { id: 5, catalog: 'Cassini at Saturn', ready: true };
    // Camera at the origin looking +z: Titan ahead, Saturn behind.
    this.bodies = { Titan: { position: [0, 0, 20_000], radiusKm: 2575 }, Saturn: { position: [0, 0, -1e6], radiusKm: 60_268 }, Cassini: { position: [100, 0, 15_000], radiusKm: null } };
    this.camera = { position: [0, 0, 0], target: [0, 0, 1], up: [0, 1, 0], fov: 45 };
  }
  /** Framing aims the camera at the body, so whatever was ahead may leave the frame. */
  override frameObject(name?: string): boolean {
    const ok = super.frameObject(name);
    const b = name ? this.bodies[name] : undefined;
    if (ok && b) this.camera = { ...this.camera, target: b.position };
    return ok;
  }
  private event(q: string) {
    const s = this.searches[q];
    return { id: `${q}-0`, queryId: q, kind: 'closest-approach', temporality: 'instant' as const, et: s.et, bodies: { observer: s.observer, target: s.target }, metrics: [{ key: 'range', label: 'Range', value: s.km, unit: 'km' }] };
  }
  override getEventQueryInfo(q?: string) {
    const s = q ? this.searches[q] : undefined;
    return { status: s ? 'available' : 'missing-query', coverage: null, error: null, provenance: null,
      definition: s ? { id: q!, label: q!, enabled: true, visible: true, query: { id: q!, kind: 'closest-approach', bodies: { observer: s.observer, target: s.target }, window: { start: 1.4e8, end: 1.7e8 }, step: 3600, abcorr: 'NONE', params: { scope: 'local', ...(s.extremum === 'maximum' ? { extremum: 'maximum' } : {}) } } } : null } as never;
  }
  override getEventResultPage(q?: string): ScriptEventResultPage {
    if (!q || !this.searches[q]) return super.getEventResultPage();
    return { status: 'ready', total: 1, offset: 0, nextOffset: null, ranking: { order: 'range-ascending', compared: 1 },
      items: [{ reference: { scene: 5, query: q, id: `${q}-0`, revision: 1 }, event: this.event(q) as never }], query: this.getEventQueryInfo(q) };
  }
  listEventResults(q: string) { return { total: 1, items: [this.event(q) as never] }; }
  override async presentEventResult(reference: ScriptEventReference) {
    const s = this.searches[reference.query];
    if (!s) return { status: 'missing-query', reference, anchor: 'middle', observation: this.getEventVisualization() } as never;
    this.selectedRef = reference; this.time = s.et; this.playing = false; this.frameObject(s.target);
    return { status: 'observed', reference, anchor: 'middle', observation: this.getEventVisualization() } as never;
  }
  override getEventVisualization(): ScriptEventVisualization {
    const s = this.selectedRef ? this.searches[this.selectedRef.query] : null;
    return { ...super.getEventVisualization(), selected: this.selectedRef, status: 'observed',
      renderer: this.selectedRef ? { observedEt: this.time, selected: { query: this.selectedRef.query, id: this.selectedRef.id }, markerGroups: 1, visibleGlyphs: 1, visibleSpans: 0, occultationVisible: false } : null,
      presentation: s ? { tracked: s.target, reference: null, participants: [s.observer, s.target].map(object => ({ object, ndc: [0, 0, 0.5], inView: true, drawEnabled: true })) } : undefined };
  }
}

/** A model that plays its replies in order, one request's replies after another. */
function scripted(turns: AgentResponse[][]) {
  const requests: AgentRequest[] = [];
  let turn = -1, round = 0;
  return { requests, next() { turn++; round = 0; }, transport: { async send(request: AgentRequest) { requests.push({ ...request, messages: [...request.messages] }); return turns[turn][round++]; } } };
}

async function converse(host: SaturnScene, script: AgentResponse[][], between?: (turn: number, host: SaturnScene, tools: ReturnType<typeof createCapabilityTools>) => void | Promise<void>) {
  const tools = createCapabilityTools(host, { surface: 'fixed' });
  const model = scripted(script);
  let history: readonly AgentMessage[] = [], goals: readonly Predicate[] = [];
  const turns = [];
  for (let i = 0; i < script.length; i++) {
    await between?.(i, host, tools);
    script[i] = [NOTES, ...script[i]];
    model.next();
    const run = await runAgent({ transport: model.transport, tools, history, goals, prompt: `turn ${i + 1}` });
    history = run.messages; goals = run.goals; turns.push(run);
  }
  tools.dispose();
  return { turns, model, tools };
}

const slots = (goals: readonly Predicate[]) => goals.map(p => `${p.p}${p.object ? `:${p.object}` : ''}${p.query ? `:${p.query}` : ''}${p.keep ? '!' : ''}${p.prior ? '~' : ''}`).sort();
const showTitan = [call(goal([{ p: 'eventSelected', query: 'titan', pick: 'closest' }]), op('events.presentEventResult', { reference: ref('titan') })), say('Showing the Titan closest approach: 3,601.5 km.')];

describe('a new request supersedes earlier turn-local goals (#381)', () => {
  it('Titan closest approach → Saturn farthest: the clock and event move on with no failed goal and no release', async () => {
    const host = new SaturnScene();
    const { turns } = await converse(host, [showTitan,
      // The model states only the new question; it does not release anything from the earlier request.
      [call(goal([{ p: 'eventSelected', query: 'far', pick: 'farthest' }]), op('events.presentEventResult', { reference: ref('far') })), say('Showing the farthest Cassini–Saturn point: 9.1 million km.')],
      [say('At the Titan encounter Cassini was 3,601.5 km from Titan; at the farthest point it was 9.1 million km from Saturn.')]]);
    expect(turns[0].result).toMatchObject({ status: 'verified', report: { status: 'met' } });
    expect(turns[1].result).toMatchObject({ status: 'verified', report: { status: 'met' } });
    expect(turns[1].result.changes).toEqual([expect.stringMatching(/^Replaced earlier eventSelected titan titan-0 closest → eventSelected far farthest/), expect.stringMatching(/^Replaced earlier eventEpoch titan → eventEpoch far/)]);
    expect(turns[1].result.report!.checks.map(c => c.slot)).not.toContain('eventEpoch:titan');
    expect(host.time).toBe(FAR_ET);
    expect(host.selectedRef?.query).toBe('far');
    expect(host.tracked).toBe('Saturn');
    // The comparison changes nothing and is not judged against either earlier target state.
    expect(turns[2].result.status).toBe('no-change');
    expect(host.time).toBe(FAR_ET);
  });

  it('"show the same point but rotate around it": a camera-only request keeps the clock and the selected result', async () => {
    const host = new SaturnScene();
    const { turns } = await converse(host, [showTitan,
      [call(goal([{ p: 'inView', object: 'Cassini' }]), use('rot', 'composeView', { anchor: 'Titan', target: 'Cassini' })), say('Rotated around Titan to show Cassini.')]]);
    expect(turns[1].result.status).not.toBe('failed');
    expect(host.time).toBe(TITAN_ET);
    expect(host.playing).toBe(false);
    expect(host.selectedRef?.query).toBe('titan');
    expect(slots(turns[1].goals)).toEqual(expect.arrayContaining(['eventSelected:titan~', 'eventEpoch:titan~', 'paused~', 'inView:Cassini']));
  });

  it('running another search retires the earlier search\'s epoch, framing and drawing goals instead of leaving them inconclusive', async () => {
    const host = new SaturnScene();
    const { turns } = await converse(host, [showTitan, [call(goal(), op('events.runEventQuery', { id: 'far' })), say('Ran the farthest-point search.')]]);
    expect(slots(turns[1].goals).filter(s => s.includes(':titan'))).toEqual([]);
    expect(turns[1].result.report!.checks.every(c => c.ok !== null)).toBe(true);
    expect(turns[1].result.changes.join(' ')).toMatch(/Earlier event, clock, eventFramed, eventDrawn superseded/);
  });

  it('a partial second result does not resurrect the earlier obligation as a failure', async () => {
    const host = new SaturnScene();
    const { turns } = await converse(host, [showTitan,
      [call(goal([{ p: 'eventSelected', query: 'none', pick: 'farthest' }]), op('events.presentEventResult', { reference: ref('none') })), say('There is no computed farthest-point result in this scene.')]]);
    // The failed change ran nothing; the earlier Titan presentation still holds and is not reported as unmet.
    expect(turns[1].result.status).toBe('no-change');
    expect(host.time).toBe(TITAN_ET);
  });
});

describe('what the person made enduring holds across requests', () => {
  it('"keep Titan in view" survives a time change, and a later view that loses Titan is a failed goal in user terms', async () => {
    const host = new SaturnScene();
    const { turns } = await converse(host, [
      [call(goal([{ p: 'inView', object: 'Titan', keep: true }]), op('camera.frameObject', { object: 'Titan' })), say('Titan is framed; I will keep it in view.')],
      [call(goal(), op('time.setTime', { when: FAR_ET })), say('Moved to 2004-08-27; Titan is still in view.')],
      [call(goal(), op('camera.frameObject', { object: 'Saturn' })), say('Framed Saturn.'), say('Framed Saturn; Titan is no longer in view, which you asked me to keep.')]]);
    expect(turns[1].result).toMatchObject({ status: 'verified' });
    expect(turns[1].result.report!.checks.find(c => c.slot === 'view:Titan')).toMatchObject({ ok: true });
    expect(slots(turns[1].goals)).toContain('inView:Titan!');
    expect(host.time).toBe(FAR_ET);
    expect(turns[2].result.status).toBe('failed');
    expect(turns[2].result.report!.checks.find(c => c.slot === 'view:Titan')).toMatchObject({ ok: false, detail: 'Titan out of frame' });
    expect(turns[2].answer).toMatch(/no longer in view/);
  });

  it('a change that contradicts an enduring constraint is refused before it runs, with the conflict explained', async () => {
    const host = new SaturnScene();
    const { turns } = await converse(host, [
      [call(goal([{ p: 'paused', value: true, keep: true }]), op('time.setPlaying', { on: false })), say('Paused; I will leave it paused.')],
      [call(goal(), op('time.setPlaying', { on: true })), say('You asked me to leave the clock paused; say so if you want it running again.')]]);
    const refused = turns[1].messages.flatMap(m => m.content).find(c => c.type === 'tool_result' && c.isError) as { content: string } | undefined;
    expect(refused?.content).toMatch(/the person asked for paused true, and this would leave paused false/);
    expect(host.playing).toBe(false);
    expect(turns[1].result.status).toBe('no-change');
  });
});

describe('manual control, scene reload and interruption retire what was held', () => {
  it('the person moving the clock between requests retires time goals before the next request', async () => {
    const host = new SaturnScene();
    const { turns } = await converse(host, [showTitan, [say('Nothing to change.')]],
      (turn, h) => { if (turn === 1) { h.time = 1; h.emit('time', { et: 1, cause: 'viewer' } as never); } });
    expect(turns[1].result.changes).toContain('The person moved the clock; time goals are theirs now.');
    expect(slots(turns[1].goals)).not.toContain('epoch~');
    expect(host.time).toBe(1);
  });

  it('a stopped request leaves nothing behind but what the person made enduring', async () => {
    const host = new SaturnScene();
    const tools = createCapabilityTools(host, { surface: 'fixed' });
    const task = tools.begin();
    const model = { async send() { task.cancel(); return say('…'); } };
    const run = await runAgent({ transport: model, tools, task, prompt: 'go to titan', goals: [{ p: 'inView', object: 'Titan', stated: true, keep: true }, { p: 'epoch', et: TITAN_ET, stated: true }] });
    expect(run.outcome.kind).toBe('cancelled');
    expect(run.goals).toEqual([{ p: 'inView', object: 'Titan', stated: true, keep: true }]);
    tools.dispose();
  });

  it('a scene replaced under a request ends it as stale with no carried goals', async () => {
    const host = new SaturnScene();
    const tools = createCapabilityTools(host, { surface: 'fixed' });
    const task = tools.begin();
    const model = { async send() { host.emit('load', { scene: 6 } as never); return say('…'); } };
    const run = await runAgent({ transport: model, tools, task, prompt: 'go to titan', goals: [{ p: 'epoch', et: TITAN_ET, stated: true }] });
    expect(run.outcome.kind).toBe('stale');
    expect(run.goals).toEqual([]);
    tools.dispose();
  });
});
