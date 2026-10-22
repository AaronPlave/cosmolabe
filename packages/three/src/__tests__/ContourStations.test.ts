import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { contourStations } from '../ContourStations.js';
import { SurfaceAppearance, DEFAULT_SURFACE_APPEARANCE as defaults } from '../SurfaceAppearance.js';

const normal = new THREE.Vector3(0, 0, 1);
const stations = (a: THREE.Vector3, b: THREE.Vector3, exponent = 4) => [...contourStations(a, b, normal, 1, exponent)]
  .map(s => a.clone().lerp(b, s.t).toArray().map(v => Math.round(v * 1e8) / 1e8).join(',')).sort();

describe('terrain-fixed contour stations', () => {
  it('preserves positions after subdivision and reversal, and nests stations as zoom reveals finer levels', () => {
    const a = new THREE.Vector3(-109, 13, 0), b = new THREE.Vector3(103, 13, 0), mid = a.clone().lerp(b, 0.37);
    const coarse = stations(a, b);
    expect(stations(b, a)).toEqual(coarse);
    expect([...stations(a, mid), ...stations(mid, b)].sort()).toEqual(coarse);
    const fine = stations(a, b, 3);
    expect(coarse.every(point => fine.includes(point))).toBe(true);
    expect(fine.length).toBeGreaterThan(coarse.length);
    expect(stations(new THREE.Vector3(-109, 27, 0), new THREE.Vector3(103, 27, 0)).map(s => s.split(',')[0]))
      .toEqual(coarse.map(s => s.split(',')[0]));
  });

  it('keeps automatic intervals invariant under look direction and tile changes, while responding to travel and zoom', () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const geometry = new THREE.PlaneGeometry(800, 800, 16, 16), p = geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) p.setZ(i, p.getY(i) * 0.5);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()); mesh.position.z = 1000;
    const style = new SurfaceAppearance({ referenceShape: { kind: 'sphere', radiusKm: 1 }, heightConvention: 'radial', verticalDatum: 'reference-sphere' });
    style.attach(mesh, new THREE.Matrix4().makeTranslation(0, 0, 1000));
    style.set({ ...defaults, contours: true, contourDensity: 0.5 }); style.update(Infinity);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1e6); camera.position.z = 2000; camera.lookAt(0, 10000, 2000);
    try {
      style.updateContourInterval(camera, 1000, 1000, [mesh]); const initial = style.contourIntervalKm;
      for (const target of [[0, 10000, 2000], [0, 0, 10000], [0, 0, 0]]) {
        camera.lookAt(new THREE.Vector3(...target)); now += 500;
        style.updateContourInterval(camera, 1000, 1000, [mesh]); expect(style.contourIntervalKm).toBe(initial);
      }
      const replacement = new THREE.Mesh(geometry.clone(), mesh.material); replacement.position.copy(mesh.position);
      style.attach(replacement, new THREE.Matrix4().makeTranslation(0, 0, 1000)); style.update(Infinity); now += 500;
      style.updateContourInterval(camera, 1000, 1000, [replacement]); expect(style.contourIntervalKm).toBe(initial);
      style.set({ ...defaults, contours: true, contourDensity: 2 }); now += 500;
      style.updateContourInterval(camera, 1000, 1000, [replacement]); expect(style.contourIntervalKm).toBeLessThan(initial);
      style.set({ ...defaults, contours: true }); camera.position.z = 20000; camera.lookAt(0, 0, 0); now += 500;
      style.updateContourInterval(camera, 1000, 1000, [replacement]); expect(style.contourIntervalKm).toBeGreaterThan(initial);
      camera.fov = 5; camera.updateProjectionMatrix(); now += 500;
      style.updateContourInterval(camera, 1000, 1000, [replacement]); expect(style.contourIntervalKm).toBeLessThanOrEqual(initial);
    } finally { clock.mockRestore(); }
  });
});
