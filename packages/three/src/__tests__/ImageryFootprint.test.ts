import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { BodyMesh } from '../BodyMesh.js';
import { geodeticToBodyFixed, type TerrainDatum } from '../TerrainSampler.js';

const datum: TerrainDatum = { referenceShape: { kind: 'ellipsoid', radiiKm: [10, 10, 8] }, verticalDatum: 'ellipsoid', heightConvention: 'geodetic-normal' };

function fixture(cube = true) {
  const mesh = new THREE.Mesh();
  mesh.scale.set(2, 1.6, 2);
  const terrain = new THREE.Group();
  terrain.scale.setScalar(2);
  const sampler = { datum, sample: vi.fn(), sampleBodyFixed: vi.fn() };
  const body = Object.assign(new THREE.Group(), {
    mesh, displayRadius: 10, ellipsoidRatios: [1, .8, 1], imageryFootprint: null,
    terrainManager: { sampler, cubeStats: cube ? {} : null, group: terrain },
  });
  Object.setPrototypeOf(body, BodyMesh.prototype);
  body.add(mesh, terrain);
  body.updateMatrixWorld(true);
  return { body: body as unknown as BodyMesh, terrain, sampler };
}

function centre(body: BodyMesh) {
  const footprint = body.children.at(-1)!;
  const dot = footprint.children[1] as THREE.Points;
  const camera = new THREE.PerspectiveCamera(); camera.position.set(30, 30, 0);
  dot.onBeforeRender(null!, null!, camera, dot.geometry, dot.material as THREE.Material, null!);
  return new THREE.Vector3().fromBufferAttribute(dot.geometry.getAttribute('position'), 0).applyMatrix4(dot.matrixWorld);
}

describe('imagery region highlight and navigation', () => {
  it('preserves planetocentric cube latitude on an oblate reference shape', () => {
    const { body } = fixture();
    body.showImageryFootprint([-.1, 29.9, .1, 30.1]);
    const point = centre(body);
    expect(Math.atan2(point.y, point.x) * 180 / Math.PI).toBeCloseTo(30, 5);
  });

  it('frames the short interval across the antimeridian', () => {
    const { body } = fixture();
    const view = body.imageryRegionView([179, -.1, -179, .1], .5, 45)!;
    expect(view.target.x).toBeCloseTo(-10, 8);
    expect(Math.abs(view.target.z)).toBeLessThan(1e-8);
    expect(view.position.distanceTo(view.target)).toBeCloseTo(1.2 * 2 * Math.PI / 180 * 10 / .5 / (2 * Math.tan(Math.PI / 8)), 8);
  });

  it('retains geodetic coordinates for non-cube imagery', () => {
    const { body } = fixture(false);
    body.showImageryFootprint([-.1, 29.9, .1, 30.1]);
    const point = centre(body);
    const expected = geodeticToBodyFixed({ latDeg: 30, lonDeg: 0 }, datum);
    expect(point.x).toBeCloseTo(expected.xKm * 2, 5);
    expect(point.y).toBeCloseTo(expected.zKm * 2, 5);
    expect(body.imageryRegionView([-.1, 29.9, .1, 30.1], 1, 45)!.target.distanceTo(point.multiplyScalar(.5))).toBeLessThan(1e-5);
  });

  it('follows visible rendered terrain and LOD changes without querying CPU data', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    try {
      const { body, terrain, sampler } = fixture();
      const direction = new THREE.Vector3(Math.cos(Math.PI / 6), .5, 0);
      const tile = (radius: number) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
        m.position.copy(direction).multiplyScalar(radius);
        m.lookAt(direction.clone().multiplyScalar(radius + 1));
        return m;
      };
      const active = tile(8), cached = tile(9);
      const hidden = new THREE.Group(); hidden.visible = false; hidden.add(cached);
      terrain.add(active, hidden); body.updateMatrixWorld(true);
      body.showImageryFootprint([-.1, 29.9, .1, 30.1]);
      expect(centre(body).distanceTo(direction.clone().multiplyScalar(16))).toBeLessThan(1e-5);
      const view = body.imageryRegionView([-.1, 29.9, .1, 30.1], 1, 45)!;
      expect(view.target.distanceTo(centre(body).multiplyScalar(.5))).toBeLessThan(1e-5);
      expect(view.position.clone().sub(view.target).normalize().distanceTo(direction)).toBeLessThan(1e-5);
      expect(view.up.dot(direction)).toBeCloseTo(0, 8);
      expect(view.position.distanceTo(view.target)).toBeCloseTo(1.2 * .2 * Math.PI / 180 * 10 / (2 * Math.tan(Math.PI / 8)), 8);
      active.visible = false; hidden.visible = true;
      clock.mockReturnValue(1300);
      expect(centre(body).distanceTo(direction.clone().multiplyScalar(18))).toBeLessThan(1e-5);
      expect(sampler.sample).not.toHaveBeenCalled();
      expect(sampler.sampleBodyFixed).not.toHaveBeenCalled();
      body.showImageryFootprint(null);
      expect(body.children).toHaveLength(2);
    } finally { clock.mockRestore(); }
  });
});
