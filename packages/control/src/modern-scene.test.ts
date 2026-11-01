import { describe, expect, it, vi } from 'vitest';
import { FakeViewer } from './__tests__/fake-host.js';
import { parse } from './parse.js';
import { execute } from './execute.js';
import { snapshotScript, quote } from './snapshot.js';
import { createCapabilityTools } from './capabilities.js';
import { completionsAt, cursorContext } from './complete.js';
const definition = { id: 'earth-moon', kind: 'distance' as const, source: { kind: 'entity' as const, bodyName: 'Earth' }, target: { kind: 'entity' as const, bodyName: 'Moon' }, vertex: null, visible: true };

describe('modern scene automation', () => {
  it('round-trips definition JSON through snapshot, parse and execute while preserving unrelated work', async () => {
    const from = new FakeViewer(); from.upsertMeasurement(definition); from.selectedMeasurement = definition.id;
    const to = new FakeViewer(); to.upsertMeasurement({ ...definition, id: 'other' });
    const report = await execute(parse(snapshotScript(from.snapshotState())), to);
    expect(report.ran).toBeGreaterThan(1);
    expect(to.listMeasurements()).toEqual([{ ...definition, id: 'other' }, definition]);
    expect(to.selectedMeasurement).toBe(definition.id);
    await execute(parse(`restoreMeasurements ${quote(JSON.stringify({ version: 1, items: [] }))} replace`), to);
    expect(to.listMeasurements()).toEqual([]);
  });
  it('fails located on unsupported methods and readiness timeout instead of running capture', async () => {
    const host = new FakeViewer();
    host.waitUntilReady = async request => ({ ...host.getReadiness(request), status: 'timed-out', missing: ['No coverage'] });
    const capture = vi.spyOn(host, 'screenshot');
    await expect(execute(parse(`waitUntilReady ${quote('{"kind":"assets"}')} 0\nscreenshot`), host)).rejects.toThrow('timed-out');
    expect(capture).not.toHaveBeenCalled();
    Object.assign(host, { upsertMeasurement: undefined });
    await expect(execute(parse(`upsertMeasurement ${quote(JSON.stringify(definition))}`), host)).rejects.toThrow('not supported');
  });
  it('forwards cancellation to the readiness operation', async () => {
    const host = new FakeViewer(); const controller = new AbortController();
    host.waitUntilReady = vi.fn((_request, opts) => new Promise<import('./contracts.js').ScriptReadiness>(resolve => { opts?.signal?.addEventListener('abort', () => resolve({ ...host.getReadiness({ kind: 'assets' }), status: 'cancelled' })); }));
    const pending = execute(parse(`waitUntilReady ${quote('{"kind":"assets"}')}`), host, { signal: controller.signal });
    controller.abort(); await expect(pending).rejects.toThrow('cancelled');
    expect(host.waitUntilReady).toHaveBeenCalledWith({ kind: 'assets' }, expect.objectContaining({ signal: controller.signal }));
  });
  it('discovers authoring but requires trusted host permission and exact-call confirmation', async () => {
    const host = new FakeViewer(); const blocked = createCapabilityTools(host);
    expect(blocked.describeCapabilities(['measurements.upsertMeasurement'])[0]).toMatchObject({ effect: 'authoring', available: false, permission: 'host-and-confirmation' });
    const confirm = vi.fn(async () => true);
    const allowed = createCapabilityTools(host, { allowAuthoring: true, confirmAuthoring: confirm });
    const task = allowed.begin(); await task.call('describeCapabilities', { ids: ['measurements.upsertMeasurement'] });
    const result = await task.call('invokeCapability', { id: 'measurements.upsertMeasurement', input: { json: JSON.stringify(definition) } });
    expect(result.ok).toBe(true); expect(confirm).toHaveBeenCalledOnce(); expect(host.listMeasurements()).toEqual([definition]);
    blocked.dispose(); allowed.dispose();
  });
  it('stops before a command can use an ID from a replaced catalog', async () => {
    const host = new FakeViewer();
    host.upsertMeasurement = item => { host.measurements = [item]; host.scene = { id: 2, catalog: 'Other', ready: true }; return true; };
    await expect(execute(parse(`upsertMeasurement ${quote(JSON.stringify(definition))}\nshowMeasurement earth-moon off`), host)).rejects.toThrow('scene was replaced');
    expect(host.measurements[0].visible).toBe(true);
  });
  it('completes stable measurement, layer and feature IDs', () => {
    expect(completionsAt(cursorContext('showMeasurement ', 16), { measurements: ['earth-moon'] }).map(c => c.insert)).toEqual(['earth-moon']);
    expect(completionsAt(cursorContext('selectGeographicFeature sites ', 30), { geographicFeatures: id => id === 'sites' ? ['string:site'] : [] }).map(c => c.insert)).toEqual(['string:site']);
  });
});
