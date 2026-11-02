import { describe, expect, it, vi } from 'vitest';
import { FakeViewer } from './__tests__/fake-host.js';
import { createCapabilityTools } from './capabilities.js';
import { execute } from './execute.js';
import { parse } from './parse.js';
import { quote } from './snapshot.js';

describe('Event Finder shared script and capability path', () => {
  const reference = { scene: 1, query: 'q', id: 'result-0', revision: 3 };
  it('stops a script before capture on a stale computed reference and reports unsupported hosts', async () => {
    const host = new FakeViewer(), capture = vi.spyOn(host, 'screenshot');
    host.focusEventResult = (ref, anchor = 'inspect') => ({ status: 'stale-result', reference: ref, anchor, observation: host.getEventVisualization() });
    const source = `focusEventResult ${quote(JSON.stringify(reference))} start\nscreenshot`;
    await expect(execute(parse(source), host)).rejects.toThrow('Event focus stale-result');
    expect(capture).not.toHaveBeenCalled();
    Object.assign(host, { focusEventResult: undefined });
    await expect(execute(parse(source), host)).rejects.toThrow('not supported');
  });
  it('discovers the native methods, records partial visualization honestly and respects host-owned effects', async () => {
    const host = new FakeViewer();
    const read = host.getEventVisualization.bind(host);
    let selected = false;
    host.focusEventResult = (ref, anchor = 'inspect') => { selected = true; return { status: 'partial', reference: ref, anchor, observation: host.getEventVisualization() }; };
    host.getEventVisualization = () => ({ ...read(), selected: selected ? reference : null });
    const tools = createCapabilityTools(host), task = tools.begin();
    expect(tools.listCapabilities({ domain: 'events', limit: 12, query: 'getEventResultPage' }).items.some(c => c.id === 'events.getEventResultPage')).toBe(true);
    await task.call('describeCapabilities', { ids: ['events.focusEventResult', 'events.getEventVisualization'] });
    const result = await task.call('focusEventResult', { reference: JSON.stringify(reference), anchor: 'inspect' });
    expect(result).toMatchObject({ ok: true, receipt: { status: 'partial', verification: 'observed', observation: { state: { events: { selected: reference, status: 'partial', renderer: null } } } } });
    expect(result.receipt?.warnings.join(' ')).toContain('partial readback');
    tools.dispose();
    selected = false;
    const owned = createCapabilityTools(host, { omitted: { 'events.focusEventResult': 'Host owns event selection/time' } });
    expect(owned.describeCapabilities(['events.focusEventResult'])[0]).toMatchObject({ available: false });
    expect((await owned.begin().call('focusEventResult', { reference: JSON.stringify(reference) })).ok).toBe(false);
    expect(selected).toBe(false); owned.dispose();
  });
  it('projects query/coverage/metric provenance without private solver text, URLs, frame names or arbitrary parameters', async () => {
    const host = new FakeViewer(), secret = 'https://private.example/token?secret=yes';
    host.getEventQueryInfo = () => ({ status: 'unavailable', definition: { id: 'q', label: secret, enabled: true, visible: true,
      query: { id: 'q', kind: 'closest-approach', bodies: { observer: 'Titan', target: 'Saturn' }, window: { start: 0, end: 100 }, step: 10, abcorr: 'NONE', params: { scope: 'local', maxRangeKm: 1000, arbitrary: secret } } },
      coverage: { status: 'unknown', exact: false, windows: [], problems: [secret], caveats: [secret] },
      error: { code: 'provider-error', message: secret }, provenance: { source: 'loaded-spice-kernels', kernelCount: 2, kernelRevision: 3, contextFrame: secret, calculationFrames: [secret], timeUnit: 'ET seconds past J2000', stepUnit: 's', abcorr: 'NONE', limitations: [secret] } });
    host.getEventResultPage = () => ({ status: 'ready', total: 1, offset: 0, nextOffset: null, query: host.getEventQueryInfo(), items: [{ reference, event: { id: reference.id, queryId: 'q', kind: 'closest-approach', label: secret, bodies: { target: 'Saturn' }, temporality: 'instant', et: 42,
      metrics: [{ key: 'range', label: secret, value: 123, unit: 'km' }, { key: secret, label: secret, value: 2, unit: secret }] } }] });
    const tools = createCapabilityTools(host), task = tools.begin();
    await task.call('describeCapabilities', { ids: ['events.getEventQueryInfo', 'events.getEventResultPage'] });
    const info = await task.call('getEventQueryInfo', { query: 'q' });
    const page = await task.call('getEventResultPage', { query: 'q', limit: 1 });
    expect(info).toMatchObject({ ok: true, data: { definition: { params: { scope: 'local', maxRangeKm: 1000 } }, provenance: { contextFrame: null, calculationFrames: [null] } } });
    expect(page).toMatchObject({ ok: true, data: { items: [{ reference, metrics: [{ key: 'range', value: 123, unit: 'km' }] }] } });
    expect(JSON.stringify([info, page])).not.toContain(secret); tools.dispose();
  });
});
