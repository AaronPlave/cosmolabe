/**
 * The Ask engine (#345), offline: goals held from contracts, answers shown only
 * after the viewer's check, answers grounded in published facts, intent that
 * stops a wrong action before it runs, the person's takeover, and an operation
 * added or removed with no Ask code or prompt change.
 */
import { describe, expect, it } from 'vitest';
import { FakeViewer } from './__tests__/fake-host.js';
import { createCapabilityTools } from './capabilities.js';
import { runAgent, systemPrompt, type AgentContent, type AgentEvent, type AgentRequest, type AgentResponse } from './agent-loop.js';
import { checkAnswer, statedDistancesKm, statedDates } from './answer-check.js';
import { registerVerb, type VerbSpec } from './verbs.js';
import type { ScriptEventReference, ScriptEventResultPage, ScriptEventVisualization, ViewerControl } from './contracts.js';
import type { ResultFact } from './agent.js';

const use = (id: string, name: string, input: unknown): AgentContent => ({ type: 'tool_use', id, name, input });
const say = (text: string): AgentResponse => ({ content: [{ type: 'text', text }], stop: 'end' });
const call = (...uses: AgentContent[]): AgentResponse => ({ content: uses, stop: 'tool_use' });

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
      call(use('1', 'invokeCapability', { id: 'scene.select', input: { object: 'Mars' } })),
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
      facts: [{ kind: 'event-result', target: 'Neptune', rangeKm: 3.48e9, encounter: false }, { kind: 'event-window' }] });
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
      call(use('1', 'checkGoal', { require: [{ p: 'eventSelected', query: 'v1-neptune', encounter: true }] })),
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
      call(use('1', 'checkGoal', { require: [{ p: 'eventSelected', query: 'psyche-mars', pick: 'closest', encounter: true }] })),
      call(use('2', 'invokeCapability', { id: 'events.presentEventResult', input: { reference: ref('psyche-mars') } })),
      say('Showing the Psyche–Mars flyby at 4,500 km.'),
    ]);
    const run = await runAgent({ transport: model.transport, tools, prompt: 'show the psyche mars flyby' });
    expect(host.presented).toEqual(['psyche-mars-0']);
    expect(run.goals).toContainEqual({ p: 'eventSelected', query: 'psyche-mars', pick: 'closest', encounter: true, id: 'psyche-mars-0' });
    expect(run.result).toMatchObject({ status: 'verified', report: { status: 'met' } });
  });

  it('checks distances, dates and flyby claims against the facts, and passes prose with nothing to check', () => {
    const facts: ResultFact[] = [{ kind: 'event-result', query: 'q', id: 'e', observer: 'Psyche', target: 'Earth', utc: '2026-05-15T12:00:00.000Z', rangeKm: 1.8e8, altitudeKm: null, encounter: false, criterion: 'sphere-of-influence', thresholdKm: 9.25e5 },
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
      call(use('1', 'invokeCapability', { id: 'camera.frameObject', input: { object: 'Mars' } }), use('2', 'invokeCapability', { id: 'time.setPlaying', input: { on: false } })),
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
    const model = scripted([call(use('1', 'invokeCapability', { id: 'scene.select', input: { object: 'Mars' } })), call(use('2', 'invokeCapability', { id: 'scene.select', input: { object: 'Psyche' } })), say('done')]);
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
      expect(now.index).toContain('display.setWidgetColor(color:string=grey|teal)');
      expect(now.prompt).toContain('- setWidgetColor: Teal means the widget is armed.');
      expect(tools.describeCapabilities(['display.setWidgetColor'])[0]).toMatchObject({ available: true, behaviour: { writes: ['display'], unobservable: null, idempotent: true } });
      const model = scripted([call(use('1', 'invokeCapability', { id: 'display.setWidgetColor', input: { color: 'teal' } })), say('The widget is teal.')]);
      const run = await runAgent({ transport: model.transport, tools, prompt: 'arm the widget' });
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
