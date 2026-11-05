/**
 * The Ask engine (#345), offline: goals held from contracts, answers shown only
 * after the viewer's check, answers grounded in published facts, intent that
 * stops a wrong action before it runs, the person's takeover, and an operation
 * added or removed with no Ask code or prompt change.
 */
import { describe, expect, it } from 'vitest';
import { FakeViewer } from './__tests__/fake-host.js';
import { CAPABILITY_LIMITS, createCapabilityTools } from './capabilities.js';
import { runAgent, systemPrompt, type AgentContent, type AgentEvent, type AgentRequest, type AgentResponse } from './agent-loop.js';
import { checkAnswer, statedDistancesKm, statedDates } from './answer-check.js';
import { registerVerb, type VerbSpec } from './verbs.js';
import type { ScriptEventReference, ScriptEventResultPage, ScriptEventVisualization, ViewerControl } from './contracts.js';
import type { ResultFact } from './agent.js';

const use = (id: string, name: string, input: unknown): AgentContent => ({ type: 'tool_use', id, name, input });
const say = (text: string): AgentResponse => ({ content: [{ type: 'text', text }], stop: 'end' });
const call = (...uses: AgentContent[]): AgentResponse => ({ content: uses, stop: 'tool_use' });
const goal = (require: unknown[] = []) => use('goal', 'checkGoal', { require });
const describe_ = (...ids: string[]) => use('describe', 'describeCapabilities', { ids });

/** A model that plays its replies in order, whatever it is told. */
function scripted(replies: AgentResponse[]) {
  const requests: AgentRequest[] = [];
  return { requests, transport: { async send(request: AgentRequest) { requests.push({ ...request, messages: [...request.messages] }); return replies[requests.length - 1]; } } };
}

/** One computed closest approach per search: Voyager 1–Neptune (3.48e9 km) and Psyche–Mars (4,500 km). */
class EventScene extends FakeViewer {
  readonly searches: Record<string, { observer: string; target: string; et: number; km: number }> = {
    'v1-neptune': { observer: 'Voyager 1', target: 'Neptune', et: 400_000_000, km: 3.48e9 },
    'psyche-mars': { observer: 'Psyche', target: 'Mars', et: 832_000_000, km: 4500 },
  };
  presented: string[] = [];
  selectedRef: ScriptEventReference | null = null;
  constructor() {
    super();
    this.objects = ['Voyager 1', 'Neptune', 'Psyche', 'Mars', 'Sun'];
    this.scene = { id: 3, catalog: 'events', ready: true };
  }
  private event(q: string) {
    const s = this.searches[q];
    return { id: `${q}-0`, queryId: q, kind: 'closest-approach', temporality: 'instant' as const, et: s.et, bodies: { observer: s.observer, target: s.target },
      metrics: [{ key: 'range', label: 'Range', value: s.km, unit: 'km' }] };
  }
  override getEventQueryInfo(q?: string) {
    const s = q ? this.searches[q] : undefined;
    return { status: 'available', coverage: null, error: null, provenance: null,
      definition: s ? { id: q!, label: q!, enabled: true, visible: true, query: { id: q!, kind: 'closest-approach', bodies: { observer: s.observer, target: s.target }, window: { start: 0, end: 1e9 }, step: 3600, abcorr: 'NONE', params: { scope: 'local' } } } : null } as never;
  }
  override getEventResultPage(q?: string): ScriptEventResultPage {
    return { status: 'ready', total: 1, offset: 0, nextOffset: null, ranking: { order: 'range-ascending', compared: 1 },
      items: [{ reference: { scene: 3, query: q!, id: `${q}-0`, revision: 1 }, event: this.event(q!) as never }], query: this.getEventQueryInfo(q) };
  }
  listEventResults(q: string) { return { total: 1, items: [this.event(q) as never] }; }
  override async presentEventResult(reference: ScriptEventReference) {
    this.presented.push(reference.id);
    this.selectedRef = reference; this.time = this.searches[reference.query].et; this.playing = false; this.tracked = this.searches[reference.query].target;
    return { status: 'observed', reference, anchor: 'middle', observation: this.getEventVisualization() } as never;
  }
  override getEventVisualization(): ScriptEventVisualization {
    const s = this.selectedRef ? this.searches[this.selectedRef.query] : null;
    return { ...super.getEventVisualization(), selected: this.selectedRef, status: 'observed',
      renderer: this.selectedRef ? { observedEt: this.time, selected: { query: this.selectedRef.query, id: this.selectedRef.id }, markerGroups: 1, visibleGlyphs: 1, visibleSpans: 0, occultationVisible: false } : null,
      presentation: s ? { tracked: s.target, reference: null, participants: [s.observer, s.target].map(object => ({ object, ndc: [0, 0, 0.5], inView: true, drawEnabled: true })) } : undefined };
  }
}
const ref = (q: string) => JSON.stringify({ scene: 3, query: q, id: `${q}-0`, revision: 1 });

describe('answers are shown only after the viewer has checked them', () => {
  it('a candidate answer the check sends back is never displayed', async () => {
    const host = new EventScene();
    const tools = createCapabilityTools(host, { surface: 'fixed' });
    const model = scripted([
      call(goal(), use('1', 'invokeCapability', { id: 'scene.select', input: { object: 'Mars' } })),
      call(use('2', 'invokeCapability', { id: 'display.setObjectVisible', input: { object: 'Mars', visible: false } })),
      say('Mars is selected and in view.'),
      say('Mars is selected, but it is hidden.'),
    ]);
    // An earlier request held Mars in view.
    const events: AgentEvent[] = [];
    const run = await runAgent({ transport: model.transport, tools, prompt: 'select mars and hide it', goals: [{ p: 'inView', object: 'Mars' }], onEvent: e => events.push(e) });
    expect(events.filter(e => e.type === 'text').map(e => (e as { text: string }).text)).toEqual(['Mars is selected, but it is hidden.']);
    expect(run.answer).toBe('Mars is selected, but it is hidden.');
    expect(run.result.status).toBe('failed');
  });
});

describe('scientific answers are grounded in published facts', () => {
  const neptune = [
    call(use('1', 'getEventResultPage', { query: 'v1-neptune', order: 'range-ascending' })),
    say('Voyager 1 flew past Neptune at 3.5 billion km.'),
  ];

  it('a result page says whether each range minimum is an encounter, and by which criterion', async () => {
    const tools = createCapabilityTools(new EventScene(), { surface: 'fixed' });
    const r = await tools.call('getEventResultPage', { query: 'v1-neptune' });
    expect(r).toMatchObject({ ok: true, summary: expect.stringContaining("0 of 1 on this page are encounters by Neptune's sphere of influence (8.66e+7 km)"),
      data: { items: [{ encounter: { criterion: 'sphere-of-influence', encounter: false, thresholdKm: 8.66e7 } }] },
      facts: [{ kind: 'event-result', target: 'Neptune', criterionBody: 'Neptune', rangeKm: 3.48e9, encounter: false }, { kind: 'event-window' }] });
    const mars = await tools.call('getEventResultPage', { query: 'psyche-mars' });
    expect(mars).toMatchObject({ facts: [{ encounter: true, rangeKm: 4500 }, { kind: 'event-window' }] });
  });

  it('an answer that calls a distant minimum a flyby gets one correction; if it persists, the host states the facts instead', async () => {
    const tools = createCapabilityTools(new EventScene(), { surface: 'fixed' });
    const model = scripted([...neptune, say('Voyager 1 flew past Neptune at 3.5 billion km.')]);
    const run = await runAgent({ transport: model.transport, tools, prompt: 'show me when voyager 1 flew past neptune' });
    expect(JSON.stringify(model.requests[2].messages.at(-1))).toMatch(/contradicts what the viewer published: .*presents a flyby, but every result is outside the Neptune's sphere of influence/);
    expect(run.result.answerIssues.length).toBe(1);
    expect(run.answer).toMatch(/^The viewer's closest Voyager 1–Neptune result is 3\.48e\+9 km on .*: a distant range minimum, not a flyby \(Neptune's sphere of influence is 8\.66e\+7 km\)\.$/);
  });

  it('a corrected answer stands', async () => {
    const tools = createCapabilityTools(new EventScene(), { surface: 'fixed' });
    const model = scripted([...neptune, say('Voyager 1 never flew past Neptune: its closest approach in the searched window is 3.48 billion km, far outside Neptune\'s sphere of influence.')]);
    const run = await runAgent({ transport: model.transport, tools, prompt: 'show me when voyager 1 flew past neptune' });
    expect(run.result.answerIssues).toEqual([]);
    expect(run.answer).toMatch(/^Voyager 1 never flew past Neptune/);
    expect(run.result.status).toBe('no-change');
  });

  it('a stated encounter stops presenting a result that is not one, before it runs', async () => {
    const host = new EventScene();
    const tools = createCapabilityTools(host, { surface: 'fixed' });
    const model = scripted([
      call(describe_('events.presentEventResult'), use('1', 'checkGoal', { require: [{ p: 'eventSelected', query: 'v1-neptune', encounter: true }] })),
      call(use('2', 'invokeCapability', { id: 'events.presentEventResult', input: { reference: ref('v1-neptune') } })),
      say('Voyager 1 never flew past Neptune; I did not show the distant closest approach.'),
    ]);
    const run = await runAgent({ transport: model.transport, tools, prompt: 'show me when voyager 1 flew past neptune' });
    const refused = run.messages.flatMap(m => m.content).find(c => c.type === 'tool_result' && c.toolUseId === '2') as { content: string; isError: boolean };
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content).error).toMatch(/^Not run: the person asked for an encounter, and result v1-neptune-0 is not one: .*not a flyby/);
    expect(host.presented).toEqual([]);
  });

  it('a real encounter presents and verifies, with the closest and encounter intent carried onto the selected result', async () => {
    const host = new EventScene();
    const tools = createCapabilityTools(host, { surface: 'fixed' });
    const model = scripted([
      call(describe_('events.presentEventResult'), use('1', 'checkGoal', { require: [{ p: 'eventSelected', query: 'psyche-mars', pick: 'closest', encounter: true }] })),
      call(use('2', 'invokeCapability', { id: 'events.presentEventResult', input: { reference: ref('psyche-mars') } })),
      say('Showing the Psyche–Mars flyby at 4,500 km.'),
    ]);
    const run = await runAgent({ transport: model.transport, tools, prompt: 'show the psyche mars flyby' });
    expect(host.presented).toEqual(['psyche-mars-0']);
    expect(run.goals).toContainEqual({ p: 'eventSelected', query: 'psyche-mars', pick: 'closest', encounter: true, id: 'psyche-mars-0', stated: true });
    expect(run.result).toMatchObject({ status: 'verified', report: { status: 'met' } });
  });

  it('checks distances, dates and flyby claims against the facts, and passes prose with nothing to check', () => {
    const facts: ResultFact[] = [{ kind: 'event-result', query: 'q', id: 'e', observer: 'Psyche', target: 'Earth', utc: '2026-05-15T12:00:00.000Z', rangeKm: 1.8e8, altitudeKm: null, encounter: false, criterion: 'sphere-of-influence', criterionBody: 'Earth', thresholdKm: 9.25e5 },
      { kind: 'event-window', query: 'q', startUtc: '2023-10-13T00:00:00Z', endUtc: '2031-11-01T00:00:00Z', maxRangeKm: null }];
    expect(statedDistancesKm('about 1.2 AU, or 180 million km; 4,500 km; 1.8e8 km').map(d => Math.round(d.km))).toEqual([179517445, 180000000, 4500, 180000000]);
    expect(statedDates('on May 15, 2026 and 2031-11-01 and 3 March 2030').map(d => d.day)).toEqual(['2026-05-15', '2031-11-01', '2030-03-03']);
    expect(checkAnswer('None of these is a flyby: the closest is 180 million km on 2026-05-15, searched from 2023-10-13 to 2031-11-01; none comes within 1 AU.', facts)).toEqual([]);
    expect(checkAnswer('Psyche flew past Earth at 4,500 km on 2026-05-16.', facts)).toEqual([expect.stringMatching(/"4,500 km" matches no distance/), expect.stringMatching(/presents a flyby/)]);
    expect(checkAnswer('Psyche passes Earth on 2027-01-01.', facts)).toEqual([expect.stringMatching(/"2027-01-01" matches no date/)]);
    expect(checkAnswer('Selected Mars.', [])).toEqual([]);
  });
});

describe('the person keeps what they take', () => {
  it('camera and clock goals are given up when the person moves the camera or the clock during the request', async () => {
    const host = new EventScene();
    const tools = createCapabilityTools(host, { surface: 'fixed' });
    const model = scripted([
      call(goal(), use('1', 'invokeCapability', { id: 'camera.frameObject', input: { object: 'Mars' } }), use('2', 'invokeCapability', { id: 'time.setPlaying', input: { on: false } })),
      say('Framed Mars, paused.'),
    ]);
    const send = model.transport.send;
    model.transport.send = async (req: AgentRequest) => {
      // Between rounds the person drags the view and scrubs the clock.
      if (model.requests.length === 1) { host.emit('cameraInput', {}); host.camera = { ...host.camera, position: [9, 9, 9] }; host.emit('time', { et: 5, cause: 'viewer' }); }
      return send(req);
    };
    const run = await runAgent({ transport: model.transport, tools, prompt: 'frame mars and pause' });
    expect(run.result.changes).toEqual(['The person moved the camera; camera goals are theirs now.', 'The person moved the clock; time goals are theirs now.']);
    expect(run.goals).toEqual([]);
  });

  it('a scene reload ends the request: nothing later runs against the new scene', async () => {
    const host = new EventScene();
    const tools = createCapabilityTools(host, { surface: 'fixed' });
    const model = scripted([call(goal(), use('1', 'invokeCapability', { id: 'scene.select', input: { object: 'Mars' } })), call(use('2', 'invokeCapability', { id: 'scene.select', input: { object: 'Psyche' } })), say('done')]);
    const send = model.transport.send;
    model.transport.send = async (req: AgentRequest) => { if (model.requests.length === 1) { host.scene = { id: 4, catalog: 'other', ready: true }; host.emit('load', { objects: [] }); } return send(req); };
    const run = await runAgent({ transport: model.transport, tools, prompt: 'select mars then psyche' });
    expect(run.outcome.kind).toBe('stale');
    expect(host.selected).toBe('Mars');
  });
});

describe('operations come and go without an Ask change', () => {
  /** A feature a later release adds: a widget with a colour, its read and its write. */
  class WidgetViewer extends EventScene {
    color = 'grey';
    getWidget() { return { color: this.color }; }
    setWidgetColor(color: string) { this.color = color; return true; }
  }
  const spec: VerbSpec = {
    name: 'setWidgetColor', params: [{ name: 'color', type: 'enum', values: ['grey', 'teal'] }], category: 'Display', method: 'setWidgetColor' as keyof ViewerControl,
    help: 'Colour the widget.', invoke: (h, a) => (h as unknown as WidgetViewer).setWidgetColor(a[0] as string),
    contract: { namespace: 'display', writes: ['display'], idempotent: true, observes: ['getWidget' as keyof ViewerControl],
      expect: a => [{ p: 'state', read: 'getWidget', path: 'color', equals: a.color }], guide: 'Teal means the widget is armed.' },
  };
  const offered = (tools: ReturnType<typeof createCapabilityTools>) => ({
    index: tools.list().find(t => t.name === 'invokeCapability')!.description, prompt: systemPrompt(tools.list(), tools.guides!()),
  });

  it('a newly registered operation is offered, guided, held to its own result and verified', async () => {
    const before = offered(createCapabilityTools(new WidgetViewer(), { surface: 'fixed' }));
    expect(before.index).not.toContain('display.setWidgetColor');
    const unregister = registerVerb(spec);
    try {
      const host = new WidgetViewer();
      const tools = createCapabilityTools(host, { surface: 'fixed' });
      const now = offered(tools);
      // Indexed and marked as having notes; the notes stay out of the prompt and come from the registry.
      expect(now.index).toContain('display.setWidgetColor*(color:string=grey|teal)');
      expect(now.prompt).not.toContain('Teal means');
      expect(tools.describeCapabilities(['display.setWidgetColor'])[0]).toMatchObject({ available: true, guide: 'Teal means the widget is armed.', behaviour: { writes: ['display'], unobservable: null, idempotent: true } });
      const invoke = (id: string) => use(id, 'invokeCapability', { id: 'display.setWidgetColor', input: { color: 'teal' } });
      const model = scripted([call(goal(), invoke('1')), call(invoke('2')), say('The widget is teal.')]);
      const run = await runAgent({ transport: model.transport, tools, prompt: 'arm the widget' });
      // Its first use returns the notes instead of running; the second runs.
      expect(JSON.stringify(model.requests[1].messages.at(-1))).toMatch(/Not run: this operation's usage notes apply before its first use.*Teal means the widget is armed/);
      expect(run.result).toMatchObject({ status: 'verified', report: { status: 'met' } });
      expect(run.goals).toEqual([{ p: 'state', read: 'getWidget', path: 'color', equals: 'teal' }]);
      // A host that says yes and changes nothing is caught by the same contract.
      host.setWidgetColor = () => true; host.color = 'grey';
      expect(await tools.call('invokeCapability', { id: 'display.setWidgetColor', input: { color: 'teal' } })).toMatchObject({ ok: false, code: 'failed' });
      // A host without the feature does not offer it, and its guidance does not reach the prompt.
      const plain = createCapabilityTools(new EventScene(), { surface: 'fixed' });
      expect(plain.listCapabilities({ query: 'setWidgetColor' }).items[0]).toMatchObject({ id: 'display.setWidgetColor', available: false, reason: 'Host does not implement setWidgetColor' });
      expect(offered(plain).prompt).not.toContain('setWidgetColor');
      expect(await plain.call('invokeCapability', { id: 'display.setWidgetColor', input: { color: 'teal' } })).toMatchObject({ ok: false, code: 'refused' });
    } finally { unregister(); }
    // Removed: gone from the index and the prompt, and refused by name.
    const after = createCapabilityTools(new WidgetViewer(), { surface: 'fixed' });
    expect(offered(after).index).not.toContain('setWidgetColor');
    expect(offered(after).prompt).not.toContain('setWidgetColor');
    expect(await after.call('invokeCapability', { id: 'display.setWidgetColor', input: { color: 'teal' } })).toMatchObject({ ok: false, code: 'unknown-tool' });
  });

  it('a built-in operation the host withholds loses its direct tool and its guidance', () => {
    const tools = createCapabilityTools(new EventScene(), { surface: 'fixed', omitted: { 'camera.composeView': 'The host owns the camera' } });
    expect(tools.list().map(t => t.name)).not.toContain('composeView');
    expect(offered(tools).prompt).not.toContain('- composeView:');
  });
});

describe('reading stated numbers', () => {
  it('reads decimals with thousands separators and spaced scientific notation whole', () => {
    expect(statedDistancesKm('76,685.77 km; 1.997 × 10^8 km; 2.0e9 km').map(d => d.km)).toEqual([76685.77, 1.997e8, 2e9]);
  });
});

describe('stated goals are held only over real reads', () => {
  it('a state predicate over an invented read is refused, not held as uncheckable', async () => {
    const tools = createCapabilityTools(new EventScene(), { surface: 'fixed' });
    const model = scripted([call(use('1', 'checkGoal', { require: [{ p: 'state', read: 'display.layer', args: ['trajectories'], equals: false }] })), say('ok')]);
    const run = await runAgent({ transport: model.transport, tools, prompt: 'hide trajectories' });
    const r = run.messages.flatMap(m => m.content).find(c => c.type === 'tool_result') as { content: string };
    expect(JSON.parse(r.content).error).toMatch(/display.layer is not a read on this viewer/);
    expect(run.goals).toEqual([]);
  });
});

/** Two local minima of Psyche–Mars range: the 2026 flyby and a distant 2030 minimum, with the pair's coverage. */
class TwoMinima extends EventScene {
  readonly results = [{ id: 'pm-0', et: 832_000_000, km: 4500 }, { id: 'pm-1', et: 950_000_000, km: 1.719e8 }];
  private item(r: { id: string; et: number; km: number }) {
    return { reference: { scene: 3, query: 'pm', id: r.id, revision: 1 }, event: { id: r.id, queryId: 'pm', kind: 'closest-approach', temporality: 'instant', et: r.et,
      bodies: { observer: 'Psyche', target: 'Mars' }, metrics: [{ key: 'range', label: 'Range', value: r.km, unit: 'km' }] } as never };
  }
  override getEventQueryInfo(q?: string) {
    if (q !== undefined && q !== 'pm') return { status: 'missing-query', definition: null, coverage: null, error: null, provenance: null } as never;
    return { status: 'available', error: null, provenance: null, coverage: { status: 'available', windows: [{ start: 0, end: 2e9 }], exact: true, problems: [] },
      definition: { id: 'pm', label: 'pm', enabled: true, visible: true, query: { id: 'pm', kind: 'closest-approach', bodies: { observer: 'Psyche', target: 'Mars' }, window: { start: 0, end: 1e9 }, step: 3600, abcorr: 'NONE', params: {} } } } as never;
  }
  override getEventResultPage(_q?: string, opts: { order?: string; limit?: number } = {}): ScriptEventResultPage {
    const items = [...this.results].sort((a, b) => opts.order === 'range-ascending' ? a.km - b.km : a.et - b.et).slice(0, opts.limit ?? 5).map(r => this.item(r));
    return { status: 'ready', total: 2, offset: 0, nextOffset: null, items, query: this.getEventQueryInfo() };
  }
  override listEventResults() { return { total: 2, items: this.results.map(r => this.item(r).event) }; }
  override async presentEventResult(reference: ScriptEventReference) {
    this.presented.push(reference.id); this.selectedRef = reference; this.playing = false;
    this.time = this.results.find(r => r.id === reference.id)!.et;
    return { status: 'observed', reference, anchor: 'middle', observation: this.getEventVisualization() } as never;
  }
  override getEventVisualization(): ScriptEventVisualization {
    return { ...super.getEventVisualization(), presentation: this.selectedRef ? { tracked: 'Mars', reference: null, participants: ['Psyche', 'Mars'].map(object => ({ object, ndc: [0, 0, 0.5], inView: true, drawEnabled: true })) } : undefined };
  }
}
const present = (id: string, result: string) => use(id, 'invokeCapability', { id: 'events.presentEventResult', input: { reference: JSON.stringify({ scene: 3, query: 'pm', id: result, revision: 1 }) } });
const errorOf = (run: Awaited<ReturnType<typeof runAgent>>, id: string) =>
  JSON.parse((run.messages.flatMap(m => m.content).find(c => c.type === 'tool_result' && c.toolUseId === id) as { content: string }).content).error as string | undefined;

describe('the Haiku misses of the final gate, replayed offline', () => {
  it('"the closest": a distant minimum is refused before it is shown, and the closest then verifies', async () => {
    const host = new TwoMinima();
    const tools = createCapabilityTools(host, { surface: 'fixed' });
    const model = scripted([
      // Stated before the search is named: it binds to the result this request presents.
      call(describe_('events.presentEventResult'), goal([{ p: 'eventSelected', pick: 'closest' }]), present('1', 'pm-1')),
      call(present('2', 'pm-0')),
      say('The closest approach is the 2026 flyby at 4,500 km.'),
    ]);
    const run = await runAgent({ transport: model.transport, tools, prompt: 'show me the one where psyche is closest to mars' });
    expect(errorOf(run, '1')).toMatch(/^Not run: the person asked for the closest result, which is pm-0, not pm-1/);
    expect(host.presented).toEqual(['pm-0']);
    expect(run.result.status).toBe('verified');
    expect(run.goals).toContainEqual({ p: 'eventSelected', pick: 'closest', query: 'pm', id: 'pm-0', stated: true });
  });

  it('a search named by its label instead of its ID is refused, not held where it can never be met', async () => {
    const tools = createCapabilityTools(new TwoMinima(), { surface: 'fixed' });
    const model = scripted([call(goal([{ p: 'eventRun', query: 'Psyche within 10000 km of Mars', whole: true }])), say('ok')]);
    const run = await runAgent({ transport: model.transport, tools, prompt: 'show me when psyche is within 10000km of mars' });
    expect(errorOf(run, 'goal')).toMatch(/no search with ID "Psyche within 10000 km of Mars".*omit query/);
    expect(run.goals).toEqual([]);
  });

  it('"all": a search that misses part of the coverage fails the stated goal, and the answer must say so', async () => {
    const host = new TwoMinima();
    const tools = createCapabilityTools(host, { surface: 'fixed' });
    const model = scripted([
      call(describe_('events.presentEventResult'), goal([{ p: 'eventRun', query: 'pm', whole: true }]), present('1', 'pm-0')),
      say('These are all of Psyche\'s approaches to Mars.'),
      say('The search covered only part of the loaded data, so these may not be all of them.'),
    ]);
    const run = await runAgent({ transport: model.transport, tools, prompt: 'show me all psyche flybys of mars' });
    expect(JSON.stringify(model.requests[2].messages.at(-1))).toMatch(/eventRun:pm unmet \(search pm misses 1 of 1 coverage windows\)/);
    expect(run.result.status).toBe('failed');
    expect(run.answer).toMatch(/only part/);
  });

  it('"on the ground": a pin on the reference ellipsoid is refused before it is placed', async () => {
    const host = new EventScene();
    let pinned = 0;
    host.pinGroundPoint = ((object: string, policy: never) => { pinned++; return FakeViewer.prototype.pinGroundPoint.call(host, object, policy); }) as never;
    const tools = createCapabilityTools(host, { surface: 'fixed' });
    const pin = (id: string, policy?: string) => use(id, 'invokeCapability', { id: 'spatial.pinGroundPoint', input: { object: 'Mars', ...(policy ? { policy } : {}) } });
    const model = scripted([call(describe_('spatial.pinGroundPoint'), goal([{ p: 'probeUnder', object: 'Mars' }]), pin('1', 'reference')), say('I could not pin it.')]);
    const run = await runAgent({ transport: model.transport, tools, prompt: 'place a pick marker on the ground where mars currently is' });
    expect(errorOf(run, '1')).toMatch(/^Not run: the person asked for probeUnder Mars, and this would leave probeUnder Mars reference\./);
    expect(pinned).toBe(0);
  });

  it('"keep it close": a stated distance survives a change of camera subject, so a later view that loses it is not verified', async () => {
    const host = new EventScene();
    host.objects = ['Psyche', 'Mars'];
    host.bodies = { Psyche: { position: [0, 0, 0], radiusKm: 0.0125 }, Mars: { position: [-6000, 1500, 7800], radiusKm: 3389.5 } } as never;
    host.camera = { position: [0, 0, 0.06], target: [0, 0, 0], up: [0, 1, 0], fov: 45 };
    // Framing Mars moves the camera to Mars, far from Psyche.
    host.frameObject = (name?: string) => { host.tracked = name ?? null; host.camera = { position: [-6000, 1500, 20_000], target: [-6000, 1500, 7800], up: [0, 1, 0], fov: 45 }; return true; };
    const tools = createCapabilityTools(host, { surface: 'fixed' });
    const model = scripted([call(goal(), use('1', 'invokeCapability', { id: 'camera.frameObject', input: { object: 'Mars' } })), say('Framed Mars.'), say('Framed Mars; Psyche is no longer close.')]);
    const run = await runAgent({ transport: model.transport, tools, prompt: 'show mars', goals: [{ p: 'range', object: 'Psyche', maxKm: 0.1, stated: true }] });
    expect(run.goals).toContainEqual({ p: 'range', object: 'Psyche', maxKm: 0.1, stated: true });
    expect(JSON.stringify(model.requests[2].messages.at(-1))).toMatch(/range:Psyche unmet/);
    expect(run.result.status).toBe('failed');
  });
});

describe('intent comes before any change', () => {
  it('a change before the goal is stated does not run', async () => {
    const host = new EventScene();
    const tools = createCapabilityTools(host, { surface: 'fixed' });
    const model = scripted([call(use('1', 'invokeCapability', { id: 'scene.select', input: { object: 'Mars' } })), say('Could not select Mars.')]);
    const run = await runAgent({ transport: model.transport, tools, prompt: 'select mars' });
    expect(errorOf(run, '1')).toMatch(/^Not run: state what the person asked for with checkGoal first/);
    expect(host.selected).toBeNull();
    expect(run.result.status).toBe('no-change');
  });

  it('an action cannot overwrite what the person stated; the person restating it can', async () => {
    const host = new EventScene();
    const tools = createCapabilityTools(host, { surface: 'fixed' });
    const select = (id: string, object: string) => use(id, 'invokeCapability', { id: 'scene.select', input: { object } });
    const held = [{ p: 'selected' as const, object: 'Mars', stated: true }];
    const blocked = await runAgent({ transport: scripted([call(goal(), select('1', 'Psyche')), say('Mars stays selected.')]).transport, tools, prompt: 'select psyche', goals: held });
    expect(errorOf(blocked, '1')).toMatch(/the person asked for selected Mars, and this would leave selected Psyche\. If they changed their mind, restate it/);
    expect(host.selected).toBeNull();
    const restated = await runAgent({ transport: scripted([call(goal([{ p: 'selected', object: 'Psyche' }]), select('1', 'Psyche')), say('Psyche is selected.')]).transport, tools, prompt: 'no, select psyche instead', goals: held });
    expect(host.selected).toBe('Psyche');
    expect(restated.goals).toEqual([{ p: 'selected', object: 'Psyche', stated: true }]);
    expect(restated.result.status).toBe('verified');
  });
});

describe('the model-facing context stays bounded as operations are added', () => {
  it('300 more operations leave the prompt unchanged and the index within its budget, and a new one is still found and run', async () => {
    const measure = () => {
      const tools = createCapabilityTools(new EventScene(), { surface: 'fixed' });
      return { tools, prompt: systemPrompt(tools.list(), tools.guides!()), index: tools.list().find(t => t.name === 'invokeCapability')!.description };
    };
    const before = measure();
    const unregister = Array.from({ length: 300 }, (_, i) => registerVerb({
      name: `synthetic${i}`, params: [{ name: 'level', type: 'number' }], category: 'Display', method: 'getScene', help: `Synthetic feature ${i}.`, invoke: () => true,
      contract: { namespace: 'display', writes: ['display'], unobservable: 'synthetic', guide: `Notes for synthetic feature ${i}, which only matter when it is used.` },
    }));
    try {
      const after = measure();
      expect(after.prompt).toBe(before.prompt);
      expect(after.index.length).toBeLessThan(CAPABILITY_LIMITS.index + 600);
      expect(after.index).toMatch(/and \d+ more: find them with listCapabilities\.$/);
      const found = after.tools.listCapabilities({ query: 'synthetic299' }).items[0];
      expect(found).toMatchObject({ id: 'display.synthetic299', available: true });
      expect(after.tools.describeCapabilities(['display.synthetic299'])[0].guide).toMatch(/synthetic feature 299/);
      expect(await after.tools.call('invokeCapability', { id: 'display.synthetic299', input: { level: 1 } })).toMatchObject({ ok: true });
    } finally { unregister.forEach(u => u()); }
  });
});
