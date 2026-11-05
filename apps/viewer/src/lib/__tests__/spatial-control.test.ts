import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spatialControl } from '../spatial-control';
import { probePoint } from './surface-point-fixture';
const test = vi.hoisted(() => ({ scene: 7, et: 123, universe: null as any, renderer: null as any, shape: true, pin: null as any }));
vi.mock('../loader', () => ({ getUniverse: () => test.universe }));
vi.mock('../viewer-state.svelte', () => ({ sceneId: () => test.scene, vs: { get et() { return test.et; }, get probePin() { return test.pin; } }, getSceneUniverse: () => test.universe, getRenderer: () => test.renderer }));
vi.mock('../geographic-editing.svelte', () => ({ annotationTarget: () => null, editLayer: () => null, pointPositionInCoordinates: () => [0,45], inferredCoordinates: () => test.shape ? { frame: 'IAU_MARS', latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '-180..180', referenceShape: { kind: 'sphere', radiusKm: 3390 } } : null }));
vi.mock('../geographic-layers.svelte', () => ({ geographicLayer: () => undefined, geo: { selected: null } }));
beforeEach(() => {
  test.scene = 7; test.et = 123; test.shape = true; test.pin = null;
  test.universe = { getBody: (name: string) => name === 'missing' ? null : { activeParentAt: () => 'Mars' }, frames: { bodyFixedFrameFor: () => 'IAU_MARS', sameFrame: (a: string,b: string) => a === b },
    stateIn: vi.fn(() => ({ position: [1,0,1], attitude: null, availability: { position: { available: true, classification: 'estimated' } } })) };
  test.renderer = { timeController: { et: 123, playing: true }, getBodyMesh: () => ({ bodyFixedFrame: 'IAU_MARS' }),
    projectSurfacePoint: vi.fn(() => probePoint('Mars', [1,0,1], 'ellipsoid')),
    setProbePin: vi.fn((point: unknown) => { test.pin = point; }),
    getProbeVisualization: () => ({ observedEt: 123, placedEt: 123, drawn: true }) };
});
describe('semantic body-fixed ground projection', () => {
  it.each(['rover','helicopter','hopper','orbiter','flyby','stationary'])('uses the same state/frame/surface path for %s without changing time or camera', name => {
    const r = spatialControl.pinGroundPoint(name, 'rendered', { scene: 7 });
    expect(r).toMatchObject({ status: 'available', et: 123, body: 'Mars', frame: 'IAU_MARS', referenceOnly: true });
    expect(test.universe.stateIn).toHaveBeenCalledWith(name, 123, { frame: 'IAU_MARS', center: 'Mars' });
    expect(test.renderer.projectSurfacePoint).toHaveBeenCalledWith('Mars', expect.closeTo(45,12), 0, 'rendered');
    expect(test.renderer.setProbePin).toHaveBeenCalledOnce();
    expect(test.renderer.timeController).toEqual({ et: 123, playing: true });
  });
  it('does not re-seat an explicitly requested reference pin onto later terrain', () => {
    spatialControl.pinGroundPoint('vehicle', 'reference');
    expect(test.renderer.setProbePin).toHaveBeenCalledWith(expect.anything(), { refine: false });
  });
  it.each(['before-coverage','gap','dependency','unbound'])('refuses unavailable %s state and preserves the existing pin', reason => {
    const old = probePoint(); test.pin = old;
    test.universe.stateIn.mockReturnValue({ position: null, attitude: null, availability: { position: { available: false, reason } } });
    expect(spatialControl.pinGroundPoint('vehicle')).toMatchObject({ status: 'unavailable', reason: `position-${reason}`, point: null });
    expect(test.renderer.projectSurfacePoint).not.toHaveBeenCalled(); expect(test.pin).toBe(old);
  });
  it('refuses missing entity/shape/frame, zero vectors, wrong scene and unsupported physical terrain', () => {
    expect(spatialControl.pinGroundPoint('missing').reason).toBe('missing-entity');
    expect(spatialControl.pinGroundPoint('vehicle', 'rendered', { scene: 6 }).status).toBe('stale');
    test.shape = false; expect(spatialControl.pinGroundPoint('vehicle').reason).toBe('unsupported-reference-shape'); test.shape = true;
    test.renderer.getBodyMesh = () => ({ bodyFixedFrame: 'WRONG_FRAME' });
    expect(spatialControl.pinGroundPoint('vehicle').reason).toBe('body-fixed-frame-unavailable');
    test.renderer.getBodyMesh = () => ({ bodyFixedFrame: 'IAU_MARS' });
    test.universe.stateIn.mockReturnValueOnce({ position: [0,0,0], attitude: null, availability: { position: { available: true } } });
    expect(spatialControl.pinGroundPoint('vehicle').reason).toBe('invalid-body-fixed-position');
    test.renderer.projectSurfacePoint.mockReturnValue(null);
    expect(spatialControl.pinGroundPoint('vehicle','terrain')).toMatchObject({ status: 'unavailable', point: null, reason: expect.stringContaining('physical-terrain-unavailable') });
    expect(test.renderer.setProbePin).not.toHaveBeenCalled();
  });
  it('reads UI-originated pins and clears through the native owner with scene refusal', () => {
    const point = probePoint('Mars'); test.pin = point;
    expect(spatialControl.getProbePoint()).toMatchObject({ scene: 7, placedEt: 123, observedEt: 123, drawn: true, point });
    expect(() => spatialControl.clearProbePoint({ scene: 6 })).toThrow('scene changed');
    expect(test.pin).toBe(point);
    spatialControl.clearProbePoint({ scene: 7 }); expect(test.pin).toBeNull();
  });
});
