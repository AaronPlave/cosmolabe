import { describe, expect, it, vi } from 'vitest';
import { FakeViewer } from './__tests__/fake-host.js';
import { createCapabilityTools } from './capabilities.js';
import { resultText } from './agent-loop.js';
import type { ScriptGroundProjection, ScriptSpatialContext } from './contracts.js';
import type { SurfacePoint } from '@cosmolabe/core';
const datum = { referenceShape: { kind: 'sphere' as const, radiusKm: 2 }, verticalDatum: 'reference-sphere' as const, heightConvention: 'radial' as const, origin: 'body-shape' as const };
const point: SurfacePoint = { bodyName: 'Mars', frame: 'PRIVATE_FRAME', source: 'ellipsoid', bodyFixedPositionKm: [2,0,0], latDeg: 0, lonDeg: 0, latitudeKind: 'planetocentric',
  resolution: { surfaceKm: 0, latDeg: 0, lonDeg: 0 }, hit: { heightKm: 0, datum }, altitude: { km: 0, datum, from: 'rendered-hit' } };
const context: ScriptSpatialContext = { status: 'available', scene: 1, et: 42, object: 'Vehicle', parent: 'Mars', coordinates: null,
  parentCoordinates: { frame: 'PRIVATE_FRAME', latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '-180..180', referenceShape: datum.referenceShape },
  state: { et: 42, frame: 'PRIVATE_FRAME', center: 'Mars', position: [3,0,0], attitude: null, positionAvailability: { available: true, sourceId: '/private/ephemeris?key=secret', message: 'private fault', classification: 'estimated' } },
  editableLayers: [], selectedFeature: null, drawing: [] };
const projection: ScriptGroundProjection = { scene: 1, et: 42, object: 'Vehicle', body: 'Mars', frame: 'PRIVATE_FRAME', policy: 'reference', status: 'available', reason: null, referenceOnly: true, point, annotation: null, limitations: [] };
describe('shared spatial capability boundary', () => {
  it('uses transient display permission for a native pin, and keeps persistent annotation approval separate', async () => {
    const host = Object.assign(new FakeViewer(), { getSpatialContext: () => context,
      projectGroundPoint: () => projection, getProbePoint: () => ({ scene: 1, placedEt: 42, observedEt: 42, drawn: true, point, annotation: null }) });
    host.pinGroundPoint = vi.fn(() => projection);
    const tools = createCapabilityTools(host, { surface: 'fixed' });
    const task = tools.begin();
    const pin = await task.call('invokeCapability', { id: 'spatial.pinGroundPoint', input: { object: 'Vehicle', policy: 'reference' } });
    expect(pin.ok).toBe(true); expect(host.pinGroundPoint).toHaveBeenCalledOnce();
    expect(await task.call('invokeCapability', { id: 'geographic.createAnnotationLayer', input: { body: 'Mars', name: 'test', json: '{}' } })).toMatchObject({ ok: false, code: 'refused', error: expect.stringContaining('permission') });
    tools.dispose();
  });
  it('bounds targeted reads and withholds private frames/source errors/provenance on the next model payload', async () => {
    const host = Object.assign(new FakeViewer(), { getSpatialContext: () => context, projectGroundPoint: () => projection,
      getObjectState: () => context.state!, getProbePoint: () => ({ scene: 1, placedEt: 42, observedEt: 42, drawn: true, point, annotation: null }) });
    const tools = createCapabilityTools(host, { surface: 'fixed' }), task = tools.begin();
    for (const name of ['getSpatialContext','getObjectState','projectGroundPoint','getProbePoint']) {
      const result = await task.call(name, name === 'getProbePoint' ? {} : { object: 'Vehicle' });
      expect(result.ok).toBe(true);
      const wire = resultText(result,6000);
      expect(wire).not.toMatch(/PRIVATE_FRAME|private|secret|result-too-large/);
      if (name === 'projectGroundPoint') expect(result).toMatchObject({ data: { referenceOnly: true, point: { frame: null, source: 'ellipsoid' } } });
    }
    tools.dispose();
  });
});
