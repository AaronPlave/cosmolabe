import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { UniverseRenderer } from './UniverseRenderer.js';
function fixture() {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(2,64,32)); mesh.scale.set(1,.5,1); mesh.updateMatrixWorld(true);
  const bm = Object.assign(new THREE.Group(), { body: { name: 'Body', radii: [2,2,1] }, mesh, visible: true, displayRadius: 2, bodyFixedFrame: 'IAU_BODY',
    getWorldPosition: (out: THREE.Vector3) => out.set(0,0,0), getDskMeshes: () => [], getSurfaceOverlays: () => [], terrainTileGroup: null,
    surfaceCoordinates: null, terrainDatum: null, terrainReferenceRadiusAt: () => 1, sampleTerrainBodyFixed: () => null });
  bm.add(mesh); bm.updateMatrixWorld(true);
  const r = Object.create(UniverseRenderer.prototype) as any;
  let point: unknown = null;
  Object.assign(r, { bodyMeshes: new Map([['Body',bm]]), scaleFactor: 1, camera: new THREE.PerspectiveCamera(),
    renderer: { domElement: { clientWidth: 640, clientHeight: 480 } }, timeController: { et: 123 },
    events: { emit: vi.fn() }, _probe: { get pinned() { return point; }, pinnedVisible: true, setPin: (p: unknown) => { point = p; } } });
  return { r, bm };
}
describe('native semantic surface placement', () => {
  it('uses the declared oblate reference shape and fixed frame without camera pixels or terrain authority', () => {
    const { r } = fixture();
    const north = r.projectSurfacePoint('Body',90,0,'reference');
    expect(north).toMatchObject({ bodyName: 'Body', frame: 'IAU_BODY', source: 'ellipsoid', placement: 'semantic',
      hit: { heightKm: 0, datum: { referenceShape: { kind: 'ellipsoid', radiiKm: [2,2,1] }, origin: 'body-shape' } } });
    expect(north.bodyFixedPositionKm[2]).toBeCloseTo(1,12);
    expect(Math.hypot(...r.projectSurfacePoint('Body',0,0,'reference').bodyFixedPositionKm)).toBeCloseTo(2,12);
    expect(north.terrainSample).toBeUndefined();
    r.camera.position.set(100,200,300);
    expect(r.projectSurfacePoint('Body',90,0,'reference').bodyFixedPositionKm).toEqual(north.bodyFixedPositionKm);
  });
  it('reuses native surface rays for rendered points and refuses to call a globe physical terrain', () => {
    const { r } = fixture();
    expect(r.projectSurfacePoint('Body',90,0,'rendered')).toMatchObject({ source: 'ellipsoid', placement: 'semantic' });
    expect(r.projectSurfacePoint('Body',90,0,'terrain')).toBeNull();
  });
  it('refuses unknown or invalid shapes/policies and keeps reference pins fixed while native observation expires with camera changes', () => {
    const { r, bm } = fixture();
    expect(r.projectSurfacePoint('missing',0,0,'reference')).toBeNull();
    expect(r.projectSurfacePoint('Body',91,0,'reference')).toBeNull();
    expect(r.projectSurfacePoint('Body',0,0,'invented')).toBeNull();
    const point = r.projectSurfacePoint('Body',0,0,'reference');
    r.setProbePin(point,{ refine: false });
    r._castSurfaces = vi.fn(); r._refinePin(); expect(r._castSurfaces).not.toHaveBeenCalled();
    expect(r.getProbeVisualization()).toMatchObject({ observedEt: null, drawn: false, placedEt: 123 });
    r._probeObservedEt = 123; r._probeObservedView = r.viewObservationSignature();
    expect(r.getProbeVisualization().drawn).toBe(true);
    r.timeController.et = 124;
    expect(r.getProbeVisualization()).toMatchObject({ observedEt: 123, drawn: true });
    r.camera.position.x = 2;
    expect(r.getProbeVisualization()).toMatchObject({ observedEt: null, drawn: false, placedEt: 123 });
    bm.body.radii = [2,1,1]; expect(r.projectSurfacePoint('Body',0,0,'reference')).toBeNull();
  });
});
