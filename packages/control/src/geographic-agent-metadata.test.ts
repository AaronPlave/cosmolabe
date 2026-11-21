import { describe, expect, it } from 'vitest';
import { createAgentTools } from './agent.js';
import { FakeViewer } from './__tests__/fake-host.js';
import type { ScriptGeographicLayer, ViewerControl } from './contracts.js';

describe('model-visible geographic projection', () => {
  const secret = '/private/imports/confidential.geojson?token=private';
  const layer: ScriptGeographicLayer & { provenance: string } = { id: 'local-layer-1', name: 'Private layer name', body: 'Titan', frame: 'PRIVATE_FRAME',
    status: 'ready', features: 75, visible: true, editable: true, navigationUnavailable: null, style: { version: 1 },
    diagnostics: Array.from({ length: 30 }, () => ({ code: secret, severity: 'warning' })), provenance: secret };
  const feature = { id: 'string:feature-1', sourceId: 'source-private-name', name: 'Private landing site', type: 'Point',
    properties: { privateNotes: secret }, provenance: { source: secret }, geometry: { coordinates: [1, 2] } };
  const host = (): ViewerControl => Object.assign(new FakeViewer(), {
    listGeographicLayers: () => [layer],
    listGeographicFeatures: () => ({ total: 75, features: Array(75).fill(feature), provenance: secret }),
  });

  it('withholds free-form local/catalog metadata, bounds pages/diagnostics and preserves full trusted reads', async () => {
    const local = host(), tools = createAgentTools(local), task = tools.begin();
    const layers = await task.call('listGeographicLayers', {});
    const features = await task.call('listGeographicFeatures', { layer: layer.id, limit: 2 });
    if (!layers.ok || !features.ok) throw new Error('Expected successful projected reads');
    expect(layers).toMatchObject({ ok: true, data: { layers: [{ id: layer.id, name: null, frame: null, features: 75, diagnosticsTotal: 30 }] } });
    expect((layers.data as { layers: { diagnostics: unknown[] }[] }).layers[0].diagnostics).toHaveLength(16);
    expect((layers.data as { layers: { diagnostics: unknown[] }[] }).layers[0].diagnostics[0]).toEqual({ code: null, severity: 'warning' });
    expect(features).toMatchObject({ ok: true, data: { total: 75 } });
    expect(features.summary).toContain('a null name does not establish that an authored label failed to save');
    expect((features.data as { features: unknown[] }).features[0]).toEqual({ id: feature.id, name: null, sourceId: null, type: 'Point' });
    expect((features.data as { features: unknown[] }).features).toHaveLength(2);
    const serialized = JSON.stringify([layers, features]);
    for (const value of [secret, feature.name, feature.sourceId, 'privateNotes', 'provenance', '"geometry"']) expect(serialized).not.toContain(value);
    expect(local.listGeographicLayers!()[0]).toBe(layer);
    expect(local.listGeographicFeatures!(layer.id)!.features[0]).toBe(feature);
    expect(await task.call('listGeographicFeatures', { layer: layer.id, offset: 0.5 })).toMatchObject({ ok: false, code: 'invalid-input' });
    task.finish();
  });

  it('permits only exact host-approved metadata fields and never spreads arbitrary properties', async () => {
    const allowed = new Set([layer.name, feature.name, feature.sourceId, 'PRIVATE_FRAME']);
    const task = createAgentTools(host(), { metadata: { publicValue: value => allowed.has(value) } }).begin();
    const layers = await task.call('listGeographicLayers', {});
    const features = await task.call('listGeographicFeatures', { layer: layer.id, limit: 1 });
    expect(layers).toMatchObject({ data: { layers: [{ name: layer.name, frame: 'PRIVATE_FRAME' }] } });
    expect(features).toMatchObject({ data: { features: [{ name: feature.name, sourceId: feature.sourceId }] } });
    expect(JSON.stringify([layers, features])).not.toContain(secret);
    task.finish();
  });

  it('keeps host diagnostics in thrown errors local too', async () => {
    const local = host(); local.listGeographicFeatures = () => { throw new Error(secret); };
    const result = await createAgentTools(local).begin().call('listGeographicFeatures', { layer: layer.id });
    expect(result).toMatchObject({ ok: false, code: 'failed' });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
