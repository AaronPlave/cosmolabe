// A drone's camera a few metres above the ground lost the nearest terrain: the
// instrument camera's near plane was 1e-4 of the distance to a look target
// placed 0.001 scene units ahead (≈100 m at 1e-6 units/km). With log depth the
// near plane only clips, so it must be metric and small at every clearance.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { InstrumentView, INSTRUMENT_NEAR_KM } from '../InstrumentView.js';

const SF = 1e-6; // scene units per km

/** An InstrumentView without DOM: just the camera, pose and render path. */
function view(aperture: THREE.Vector3) {
  const iv = Object.create(InstrumentView.prototype) as InstrumentView & Record<string, unknown>;
  Object.assign(iv, {
    camera: new THREE.PerspectiveCamera(30, 4 / 3, 1e-8, 1e12),
    sensor: { position: aperture },
    _active: true,
    fovCenterOffset: [0, 0],
    fullScreen: true,
    layout: { surface: { x: 0, y: 0, w: 400, h: 300 }, fit: { x: 0, y: 0, w: 400, h: 300 }, image: { x: 0, y: 0, w: 400, h: 300 }, clip: { x: 0, y: 0, w: 400, h: 300 } },
  });
  return iv;
}

/** Row-major instrument→world rotation whose boresight (+Z column) is `bore`, up (+Y column) is `up`. */
function rotation(bore: THREE.Vector3, up: THREE.Vector3): number[] {
  const z = bore.clone().normalize(), y = up.clone().normalize(), x = y.clone().cross(z).normalize();
  return [x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z];
}

const fakeRenderer = (onRender: (c: THREE.PerspectiveCamera) => void) => ({
  domElement: { height: 300, clientWidth: 400, clientHeight: 300 },
  getPixelRatio: () => 1,
  getViewport: () => {}, getScissor: () => {}, getScissorTest: () => false, getClearColor: () => {}, getClearAlpha: () => 1,
  setScissorTest: () => {}, setClearColor: () => {}, setViewport: () => {}, setScissor: () => {}, clear: () => {},
  autoClear: true,
  render: (_s: unknown, c: THREE.PerspectiveCamera) => onRender(c),
}) as unknown as THREE.WebGLRenderer;

describe('instrument camera near plane', () => {
  for (const clearanceM of [1000, 100, 10, 2]) {
    for (const obliqueDeg of [0, 40, 70]) {
      it(`keeps the ground in the image ${clearanceM} m up, ${obliqueDeg}° off nadir`, () => {
        // Ground is the plane z = 0 (scene units); aperture straight above it.
        const aperture = new THREE.Vector3(0, 0, (clearanceM / 1000) * SF);
        const iv = view(aperture);
        const a = THREE.MathUtils.degToRad(obliqueDeg);
        const bore = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
        iv.update(0, SF, () => [0, 0, 0], undefined, rotation(bore, new THREE.Vector3(Math.cos(a), 0, Math.sin(a))), 'attitude');
        let near = NaN;
        let groundCentreVisible = false;
        let groundBelowVisible = false;
        iv.render(fakeRenderer((c) => {
          near = c.near;
          c.updateMatrixWorld();
          const inFrustum = (p: THREE.Vector3) => {
            const ndc = p.clone().project(c);
            return Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z >= -1 && ndc.z <= 1;
          };
          // Where the boresight meets the ground, and the closest ground the bottom edge of the image can see.
          const t = aperture.z / Math.cos(a);
          groundCentreVisible = inFrustum(aperture.clone().addScaledVector(bore, t));
          const lower = bore.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(14));
          groundBelowVisible = lower.z >= 0 || inFrustum(aperture.clone().addScaledVector(lower, aperture.z / -lower.z));
        }), new THREE.Scene());
        expect(near).toBeCloseTo(INSTRUMENT_NEAR_KM * SF, 20);
        expect(groundCentreVisible).toBe(true);
        expect(groundBelowVisible).toBe(true);
      });
    }
  }

  it('is far below the old ≈100 m plane and independent of where it looks', () => {
    expect(INSTRUMENT_NEAR_KM * 1000).toBeLessThanOrEqual(0.05);
  });
});
