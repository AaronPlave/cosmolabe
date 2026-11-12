import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { FakeViewer } from './__tests__/fake-host.js';
import { agentDefinitions } from './agent.js';
import { createCapabilityTools, defaultAskDefinitions, CAPABILITY_LIMITS } from './capabilities.js';
import { capabilityCoverage, CONTROL_CONTRACT_GAPS, UI_CAPABILITY_GAPS } from './capability-coverage.js';
import { VERB_LIST } from './verbs.js';
import { systemPrompt, resultText, runAgent, type AgentRequest, type AgentResponse } from './agent-loop.js';
import type { AgentTask } from './agent.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const choose = (task: AgentTask, ...ids: string[]) => task.call('describeCapabilities', { ids });

describe('capability catalog contract', () => {
  it('derives every verb and classifies every ViewerControl method, including explicit gaps', () => {
    const defs = agentDefinitions();
    const coverage = capabilityCoverage();
    for (const spec of VERB_LIST) {
      expect(defs.find(d => d.name === spec.name)?.method).toBe(spec.method);
      expect(coverage.find(row => row.script === spec.name)).toMatchObject({ discovery: true, status: 'registered' });
    }
    const source = ts.createSourceFile('contracts.ts', readFileSync(new URL('./contracts.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const port = source.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'ViewerControl') as ts.InterfaceDeclaration;
    const classified = new Set([...defs.map(d => d.method), ...Object.keys(CONTROL_CONTRACT_GAPS)]);
    for (const member of port.members) expect(classified.has(member.name!.getText(source)), member.name!.getText(source)).toBe(true);
    expect(UI_CAPABILITY_GAPS.map(row => row.feature)).toEqual(expect.arrayContaining(['Event Finder', 'Geographic file import/export', 'Instruments', 'Bookmarks / view sharing', 'Surface planner']));
    expect(new Set(coverage.map(row => row.operation).filter(Boolean)).size).toBe(defs.length);
  });

  it('keeps fixed Ask compact while every registered verb has a discoverable permission classification', async () => {
    const host = new FakeViewer();
    const tools = createCapabilityTools(host, { surface: 'fixed' });
    const names = tools.list().map(t => t.name);
    expect(names).toEqual([...defaultAskDefinitions().filter(d => !d.method || typeof (host as unknown as import('./contracts.js').ViewerControl)[d.method] === 'function').map(d => d.name), 'listCapabilities', 'describeCapabilities', 'getOperationResult', 'invokeCapability']);
    expect(names).not.toContain('upsertMeasurement');
    expect(names).not.toContain('screenshot');
    const task = tools.begin();
    expect((await task.call('resolve', { query: 'Titan' })).ok).toBe(true);
    for (const verb of VERB_LIST) {
      const row = capabilityCoverage().find(r => r.script === verb.name)!;
      expect(row).toMatchObject({ defaultAsk: defaultAskDefinitions().some(d => d.name === verb.name) ? 'direct' : 'discovery', status: 'registered' });
      const described = tools.describeCapabilities([row.operation!])[0];
      expect(described.tool.name).toBe(verb.name);
      expect(described.permission).toBe(['authoring','external'].includes(described.effect) ? 'host-and-confirmation' : verb.sceneEdit ? 'host' : 'none');
    }
    await task.call('describeCapabilities', { ids: ['measurements.upsertMeasurement', 'capture.screenshot'] });
    expect(await task.call('invokeCapability', { id: 'measurements.upsertMeasurement', input: { json: '{}' } })).toMatchObject({ ok: false, code: 'refused' });
    expect(await task.call('invokeCapability', { id: 'capture.screenshot', input: {} })).toMatchObject({ ok: false, code: 'refused' });
    expect(host.calls.filter(c => c.startsWith('screenshot'))).toHaveLength(0);
    tools.dispose();
  });

  it('auto-hydrates a skipped event schema without confirmation while retaining schema validation, host permission and stale-scene guards', async () => {
    const host = new FakeViewer();
    let approvals = 0;
    const tools = createCapabilityTools(host, { allowAuthoring: true, confirmAuthoring: async () => { approvals++; return true; } });
    const task = tools.begin();
    const call = { id: 'events.upsertEventQuery', input: { definition: JSON.stringify({ id: 'q', label: 'Approach', enabled: true, visible: true,
      query: { id: 'q', kind: 'closest-approach', bodies: { observer: 'Cassini', target: 'Titan' }, window: { start: 0, end: 100 } } }) } };
    host.getEventQueryInfo = () => ({ status: 'available', definition: JSON.parse(call.input.definition), coverage: null, error: null, provenance: null });
    expect(await task.call('invokeCapability', call)).toMatchObject({ ok: true, receipt: { verification: 'observed', status: 'completed' } });
    expect(approvals).toBe(0);
    expect(await task.call('invokeCapability', { id: call.id, input: {} })).toMatchObject({ ok: false, code: 'invalid-input', error: expect.stringContaining('Expected input schema') });
    expect(approvals).toBe(0);
    host.scene = { id: 2, catalog: 'Other', ready: true };
    expect(await task.call('invokeCapability', call)).toMatchObject({ ok: false, code: 'stale' });
    expect(approvals).toBe(0);
    tools.dispose();
    const denied = createCapabilityTools(host);
    expect(await denied.call('invokeCapability', call)).toMatchObject({ ok: false, code: 'refused', error: expect.stringContaining('permission') });
    denied.dispose();
  });

  it('allows reversible local edits only with host permission and confirms destructive/external calls', async () => {
    const host = new FakeViewer();
    const confirmations: string[] = [];
    const tools = createCapabilityTools(host, { allowAuthoring: true, allowExternal: true,
      confirmAuthoring: async id => { confirmations.push(id); return false; },
      confirmExternal: async id => { confirmations.push(id); return false; } });
    const call = (id: string, input: unknown) => tools.call('invokeCapability', { id, input });
    expect((await call('measurements.restoreMeasurements', { json: JSON.stringify({ version: 1, items: [] }) })).ok).toBe(true);
    expect((await call('bookmarks.saveBookmark', { name: 'Here' })).ok).toBe(true);
    expect(confirmations).toEqual([]);
    for (const [id, input] of [
      ['measurements.restoreMeasurements', { json: JSON.stringify({ version: 1, items: [] }), mode: 'replace' }],
      ['geographic.editAnnotation', { layer: 'mine', json: JSON.stringify({ type: 'delete', featureId: 'a' }) }],
      ['bookmarks.removeBookmark', { name: 'Here' }],
      ['capture.screenshot', {}],
    ] as const) expect(await call(id, input)).toMatchObject({ ok: false, code: 'refused' });
    expect(confirmations).toEqual(['measurements.restoreMeasurements', 'geographic.editAnnotation', 'bookmarks.removeBookmark', 'capture.screenshot']);
    tools.dispose();
    const noConfirmation = createCapabilityTools(host, { allowAuthoring: true });
    expect(await noConfirmation.call('invokeCapability', { id: 'measurements.restoreMeasurements', input: { json: '{"version":1,"items":[]}', mode: 'replace' } })).toMatchObject({ ok: false, code: 'refused' });
    noConfirmation.dispose();
  });

  it('stops later changes in a failed model batch while allowing observation and a corrected next round', async () => {
    const host = new FakeViewer(), tools = createCapabilityTools(host, { surface: 'fixed' });
    let round = 0;
    const run = await runAgent({ tools, prompt: 'pause then seek', transport: { send: async () => ++round === 1
      ? { stop: 'tool_use', content: [
        { type: 'tool_use', id: 'bad-pause', name: 'invokeCapability', input: { id: 'time.setPlaying', input: { playing: false } } },
        { type: 'tool_use', id: 'seek', name: 'invokeCapability', input: { id: 'time.setTime', input: { when: 42 } } },
        { type: 'tool_use', id: 'observe', name: 'describeScene', input: {} },
      ] } : { stop: 'end', content: [{ type: 'text', text: 'Pause failed; clock left alone.' }] } } });
    expect(run.outcome.kind).toBe('done');
    expect(host.getTime()).not.toBe(42);
    const results = run.messages.flatMap(m => m.content.filter(b => b.type === 'tool_result'));
    expect(results).toHaveLength(3);
    expect(results[1].content).toContain('later changes were not run');
    expect(results[2].isError).toBe(false);
    tools.dispose();
  });

  it('has a fixed initial schema, bounded search, pagination, and atomic selection', async () => {
    const tools = createCapabilityTools(new FakeViewer());
    expect(tools.list().map(t => t.name)).toEqual(['describeScene', 'listCapabilities', 'describeCapabilities', 'getOperationResult', 'invokeCapability']);
    const page = tools.listCapabilities();
    expect(page.items).toHaveLength(CAPABILITY_LIMITS.page);
    expect(page.nextOffset).toBe(CAPABILITY_LIMITS.page);
    expect(tools.listCapabilities({ domain: 'camera', effects: ['viewer'] }).items.every(c => c.domain === 'camera' && c.effect === 'viewer')).toBe(true);
    expect(() => tools.listCapabilities({ query: 'x'.repeat(161) })).toThrow('160');
    expect(() => tools.listCapabilities({ version: 2 })).toThrow('version');
    expect(() => tools.listCapabilities({ limit: 13 })).toThrow();
    expect(() => tools.listCapabilities({ offset: 0.5 })).toThrow();
    const task = tools.begin();
    expect(await task.call('select', { object: 'Titan' })).toMatchObject({ ok: true });
    expect((await choose(task, 'scene.select')).ok).toBe(true);
    expect(tools.list()).toHaveLength(5);
    expect((await choose(task, 'scene.resolve', 'absent.id')).ok).toBe(false);
    expect(tools.list()).toHaveLength(5);
    expect((await choose(task, 'scene.resolve')).ok).toBe(true);
    expect(tools.list()).toHaveLength(5);
    expect((await choose(task, ...Array(9).fill('scene.resolve'))).ok).toBe(false);
    const descriptions = await choose(task, 'scene.resolve', 'activities.listActivities', 'surface.getImagery', 'camera.flyTo', 'time.setPlaying', 'time.setTime', 'scene.select', 'activities.getActivity');
    expect(JSON.parse(resultText(descriptions, 16000))).not.toHaveProperty('code', 'result-too-large');
    tools.dispose();
  });

  it('reports truthful host and permission differences without installing code', async () => {
    const full = new FakeViewer();
    const bare = new FakeViewer();
    Object.defineProperty(bare, 'gotoPlace', { value: undefined });
    const a = createCapabilityTools(full);
    const b = createCapabilityTools(bare, { omitted: { 'scene.select': 'Host owns selection' } });
    expect(a.describeCapabilities(['places.gotoPlace'])[0].available).toBe(true);
    expect(b.describeCapabilities(['places.gotoPlace'])[0]).toMatchObject({ available: false, reason: 'Host does not implement gotoPlace' });
    expect(b.describeCapabilities(['scene.select'])[0]).toMatchObject({ available: false, reason: 'Host owns selection' });
    expect(a.describeCapabilities(['capture.screenshot'])[0].available).toBe(false);
    expect(b.listCapabilities({ availableOnly: true }).items.every(c => c.available)).toBe(true);
    const task = b.begin();
    await choose(task, 'scene.select');
    expect((await task.call('select', { object: 'Titan' })).ok).toBe(false);
    expect(bare.selected).toBeNull();
    a.dispose(); b.dispose();
  });

  it('rejects schemas and ambiguous/missing exact IDs before mutation', async () => {
    const host = new FakeViewer();
    const tools = createCapabilityTools(host);
    const task = tools.begin();
    await choose(task, 'scene.select', 'places.gotoPlace', 'scene.resolve');
    for (const input of [{}, { object: 'Titan', extra: true }, { object: 2 }, JSON.parse('{"object":"Titan","__proto__":{}}'), { object: 'Titan', toString: 'unknown-field' }]) {
      expect(await task.call('select', input)).toMatchObject({ ok: false, code: 'invalid-input', receipt: { status: 'refused' } });
    }
    expect(host.calls).toHaveLength(0);
    expect(await task.call('select', { object: 'Tit' })).toMatchObject({ ok: false, code: 'refused' });
    expect(await task.call('gotoPlace', { place: 'Kraken Mare' })).toMatchObject({ ok: false, code: 'refused' });
    const resolved = await task.call('resolve', { query: 'mare', kinds: ['place'] });
    expect(resolved).toMatchObject({ ok: true, data: { ambiguous: true } });
    expect(host.selectedPlace).toBeNull();
    tools.dispose();
  });
});

describe('verified receipts and partial workflows', () => {
  it('reconciles two domains after failure, keeps successful changes and immutable bounded receipts', async () => {
    const host = new FakeViewer();
    const tools = createCapabilityTools(host);
    const task = tools.begin();
    await choose(task, 'scene.select', 'surface.showImagery', 'time.setTime');
    const selection = await task.call('select', { object: 'Titan' });
    expect(selection.receipt).toMatchObject({ operation: 'scene.select', status: 'completed', resolvedTarget: { object: 'Titan' }, observation: { state: { selectedObject: 'Titan' } } });
    const time = await task.call('setTime', { when: 42 });
    expect(time.receipt).toMatchObject({ status: 'completed', observation: { state: { time: { et: 42 } } } });
    const layer = await task.call('showImagery', { object: 'Titan', layer: 'absent', visible: true });
    expect(layer).toMatchObject({ ok: false, receipt: { status: 'refused', observation: { state: { selectedObject: 'Titan', time: { et: 42 } } } } });
    const read = await task.call('describeScene', {});
    expect(read).toMatchObject({ ok: true, data: { selectedObject: 'Titan', time: { et: 42 } } });
    const id = selection.receipt!.id;
    const snapshot = tools.getOperationResult(id)!;
    (snapshot.warnings as string[]).push('tampered');
    expect(tools.getOperationResult(id)?.warnings).toEqual([]);
    for (let i = 0; i < 65; i++) await task.call('describeScene', {});
    expect(tools.getOperationResult(id)).toBeNull();
    expect(host.calls.filter(call => call.startsWith('select('))).toHaveLength(1);
    tools.dispose();
  });

  it('does not verify a host that returns success without changing observable state', async () => {
    const host = new FakeViewer();
    host.select = () => true;
    const tools = createCapabilityTools(host);
    const task = tools.begin();
    await choose(task, 'scene.select');
    expect(await task.call('select', { object: 'Titan' })).toMatchObject({ ok: false, receipt: { status: 'partial', observation: { state: { selectedObject: null } } } });
    tools.dispose();
  });

  it('retains success but marks it unverified when resulting observation fails', async () => {
    const host = new FakeViewer();
    const original = host.select.bind(host);
    host.select = (object) => {
      const result = original(object);
      host.getCamera = () => { throw new Error('Camera readback unavailable'); };
      return result;
    };
    const tools = createCapabilityTools(host);
    const task = tools.begin();
    await choose(task, 'scene.select');
    const result = await task.call('select', { object: 'Titan' });
    expect(host.selected).toBe('Titan');
    expect(result).toMatchObject({ ok: true, receipt: { status: 'partial', verification: 'host-return', observation: { state: null }, warnings: expect.arrayContaining([expect.stringContaining('could not be observed')]) } });
    expect(tools.getOperationResult(result.receipt!.id)).toEqual(result.receipt);
    tools.dispose();
  });

  it('keeps feature guidance with the operations: the core prompt names no feature operation', () => {
    const core = systemPrompt([], []);
    for (const def of agentDefinitions()) if (!['checkGoal', 'describeScene'].includes(def.name)) expect(core, def.name).not.toMatch(new RegExp(`\\b${def.name}\\b`));
    const tools = createCapabilityTools(Object.assign(new FakeViewer(), { getSurfaceData: () => undefined }), { surface: 'fixed' });
    const prompt = systemPrompt(tools.list(), tools.guides!());
    // Only the directly offered tools' notes are in the prompt; the rest come from the registry on demand.
    expect(prompt).toContain('- composeView: To bring another object into a close-up');
    expect(prompt).not.toContain('- getSurfaceData:');
    expect(tools.describeCapabilities(['surface.getSurfaceData'])[0].guide).toContain('Zero getImagery layers');
    for (const name of ['listCapabilities', 'describeCapabilities', 'invokeCapability']) expect(prompt).toContain(name);
    expect(prompt).toContain('source provenance withheld');
    // Discovery offers describeScene alone directly, so only its notes are in the prompt.
    const discovery = createCapabilityTools(new FakeViewer(), { surface: 'discovery' });
    expect(discovery.guides!().map(g => g.name)).toEqual(['describeScene']);
    discovery.dispose();
    tools.dispose();
  });

  it('declares missing semantic readback instead of marking every UI feature verified', async () => {
    const tools = createCapabilityTools(new FakeViewer());
    const task = tools.begin();
    await choose(task, 'places.gotoCoordinates');
    expect(await task.call('gotoCoordinates', { object: 'Titan', latitude: 1, longitude: 2 })).toMatchObject({ ok: true, outcome: { expected: [], unobservable: 'a surface coordinate view has no projection read' },
      receipt: { status: 'partial', verification: 'host-return', warnings: ['Not observable: a surface coordinate view has no projection read.'] } });
    tools.dispose();
  });

  it('inspects running flights, observes completion, respects manual takeover, and cancels only its own flight', async () => {
    const host = new FakeViewer();
    const progress: { id: string; status: string }[] = [];
    const tools = createCapabilityTools(host, { onReceipt: receipt => progress.push(receipt) });
    const task = tools.begin();
    await choose(task, 'camera.flyTo', 'camera.jumpTo');
    const pending = task.call('flyTo', { object: 'Titan' });
    await tick();
    expect(progress.map(r => r.status)).toEqual(['accepted', 'running']);
    expect(tools.getOperationResult(progress[0].id)?.status).toBe('running');
    const flight = host.flight!;
    host.flight = null;
    host.tracked = 'Titan';
    host.emit('flightEnd', { ...flight, outcome: 'arrived' });
    const arrived = await pending;
    expect(arrived.receipt).toMatchObject({ status: 'completed', observation: { state: { tracked: 'Titan', flight: null } } });
    host.emit('cameraInput', {});
    expect(await task.call('jumpTo', { object: 'Saturn' })).toMatchObject({ ok: false, code: 'interrupted', receipt: { status: 'cancelled' } });
    const next = tools.begin();
    await choose(next, 'camera.flyTo');
    const stopped = next.call('flyTo', { object: 'Saturn' });
    await tick();
    next.cancel();
    expect(await stopped).toMatchObject({ ok: false, receipt: { status: 'cancelled' } });
    expect(host.flight).toBeNull();
    tools.dispose();
  });

  it('invalidates refs on reload even if host reuses scene IDs and drops late async completions', async () => {
    const host = new FakeViewer();
    let finish!: () => void;
    (host as unknown as { select: () => Promise<boolean> }).select = () => new Promise(resolve => { finish = () => resolve(true); });
    const tools = createCapabilityTools(host);
    const task = tools.begin();
    await choose(task, 'scene.select');
    const pending = task.call('select', { object: 'Titan' });
    host.emit('load', { objects: host.objects });
    finish();
    expect(await pending).toMatchObject({ ok: false, code: 'stale', receipt: { status: 'stale', scope: { revision: 0 }, observation: { scope: { revision: 1 } } } });
    expect(tools.list()).toHaveLength(5);
    expect(await task.call('select', { object: 'Titan' })).toMatchObject({ ok: false, code: 'stale' });
    tools.dispose();
  });

  it('binds confirmation to a trusted host and exact call; never executes after stale approval', async () => {
    const host = new FakeViewer();
    let confirm!: (yes: boolean) => void;
    const tools = createCapabilityTools(host, { allowExternal: true, confirmExternal: () => new Promise(resolve => { confirm = resolve; }) });
    const task = tools.begin();
    await choose(task, 'capture.screenshot');
    expect(await task.call('screenshot', { confirmed: true })).toMatchObject({ ok: false, code: 'invalid-input' });
    const declined = task.call('screenshot', { label: 'review' });
    confirm(false);
    expect(await declined).toMatchObject({ ok: false, receipt: { status: 'refused' } });
    const late = task.call('screenshot', { label: 'review' });
    host.emit('load', { objects: host.objects });
    confirm(true);
    expect(await late).toMatchObject({ ok: false, code: 'stale' });
    expect(host.calls.some(call => call.startsWith('screenshot('))).toBe(false);
    const current = tools.begin();
    await choose(current, 'capture.screenshot');
    const accepted = current.call('screenshot', {});
    confirm(true);
    expect((await accepted).ok).toBe(true);
    tools.dispose();
  });

  it('refuses reentrant host writes during accepted progress and disables disposed handles', async () => {
    const host = new FakeViewer();
    let competing: Promise<unknown> | undefined;
    const tools = createCapabilityTools(host, { onReceipt: receipt => {
      if (receipt.status === 'accepted') competing = task.call('select', { object: 'Saturn' });
    } });
    const task = tools.begin();
    await choose(task, 'scene.select');
    expect((await task.call('invokeCapability', { id: 'scene.select', input: { object: 'Titan' } })).ok).toBe(true);
    expect(await competing).toMatchObject({ ok: false, code: 'refused' });
    expect(host.calls.filter(call => call.startsWith('select('))).toHaveLength(1);
    expect(host.selected).toBe('Titan');
    tools.dispose();
    expect(() => tools.inspect!()).toThrow('disposed');
    expect(await task.call('select', { object: 'Saturn' })).toMatchObject({ ok: false, code: 'cancelled' });
  });

  it('isolates two viewers and reports no-scene writes as unavailable', async () => {
    const a = new FakeViewer(), b = new FakeViewer();
    const one = createCapabilityTools(a), two = createCapabilityTools(b);
    const task = one.begin();
    await choose(task, 'scene.select');
    const result = await task.call('select', { object: 'Titan' });
    expect(two.getOperationResult(result.receipt!.id)).toBeNull();
    expect(b.selected).toBeNull();
    expect(two.list()).toHaveLength(5);
    b.scene = null;
    expect(two.describeCapabilities(['scene.select'])[0]).toMatchObject({ available: false, reason: expect.stringContaining('identity') });
    one.dispose(); two.dispose();
  });

  it('keeps provider schemas fixed while invoking selected operations with typed validation', async () => {
    const host = new FakeViewer();
    const tools = createCapabilityTools(host);
    const offered = tools.list();
    const requests: AgentRequest[] = [];
    let round = 0;
    const uses = (name: string, input: unknown): AgentResponse => ({ stop: 'tool_use', content: [{ type: 'tool_use', id: String(round), name, input }] });
    const run = await runAgent({ tools, prompt: 'Select Titan then try missing imagery', transport: { send: async request => {
      requests.push(request);
      round++;
      if (round === 1) return uses('describeCapabilities', { ids: ['scene.select', 'surface.showImagery'] });
      if (round === 2) return { stop: 'tool_use', content: [{ type: 'tool_use', id: 'g', name: 'checkGoal', input: { require: [] } }, ...uses('invokeCapability', { id: 'scene.select', version: 1, input: { object: 'Titan' } }).content] };
      if (round === 3) return uses('invokeCapability', { id: 'surface.showImagery', version: 1, input: { object: 'Titan', layer: 'absent', visible: true } });
      if (round === 4) return uses('describeScene', {});
      return { stop: 'end', content: [{ type: 'text', text: 'Titan selected; imagery refused.' }] };
    } } });
    expect(run.outcome.kind).toBe('done');
    expect(host.selected).toBe('Titan');
    for (const request of requests) expect(request.tools).toEqual(offered);
    const task = tools.begin();
    await choose(task, 'scene.select');
    const before = host.calls.length;
    expect(await task.call('invokeCapability', { id: 'scene.select', version: 2, input: { object: 'Saturn' } })).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(await task.call('invokeCapability', { id: 'scene.select', input: { object: 'Saturn', extra: true } })).toMatchObject({ ok: false, code: 'invalid-input', receipt: { status: 'refused' } });
    expect(await task.call('invokeCapability', { id: 'surface.getImagery', input: { object: 'Titan' } })).toMatchObject({ ok: true });
    expect(host.calls).toHaveLength(before);
    tools.dispose();
  });

  it('drops a stale provider response without extra writes', async () => {
    const host = new FakeViewer();
    const tools = createCapabilityTools(host);
    let respond!: (response: AgentResponse) => void;
    const requests: AgentRequest[] = [];
    const run = runAgent({ tools, prompt: 'Select Titan', transport: { send: request => { requests.push(request); return new Promise(resolve => { respond = resolve; }); } } });
    host.emit('load', { objects: host.objects });
    respond({ stop: 'tool_use', content: [{ type: 'tool_use', id: 'late', name: 'select', input: { object: 'Titan' } }] });
    expect((await run).outcome.kind).toBe('stale');
    expect(requests).toHaveLength(1);
    expect(host.calls).toHaveLength(0);
    tools.dispose();
  });
});
