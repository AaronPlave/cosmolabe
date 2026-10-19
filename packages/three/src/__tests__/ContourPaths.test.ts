import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildContourPaths, stitchContourPaths, type ContourSegment } from '../ContourPaths.js';
import { automaticContourInterval, niceContourInterval } from '../ContourIntervals.js';

function segment(mesh: THREE.Mesh, a: number[], b: number[], heightKm = 0): ContourSegment {
  return { mesh, start: new THREE.Vector3(...a), end: new THREE.Vector3(...b), heightKm,
    normal: new THREE.Vector3(0, 0, 1), gradient: new THREE.Vector3(0, 1, 0) };
}

describe('connected index contours', () => {
  it('joins triangle intersections and neighbouring tile ends under body transforms', () => {
    const group = new THREE.Group(), a = new THREE.Mesh(), b = new THREE.Mesh();
    group.position.set(1e7, -2e7, 3e7); group.rotation.x = 0.7; group.scale.setScalar(0.001);
    b.position.x = 100; group.add(a, b); group.updateMatrixWorld(true);
    const paths = stitchContourPaths([
      segment(a, [0, 0, 0], [50, 0, 0], -1), segment(a, [100, 0, 0], [50, 0, 0], -1),
      segment(b, [0.2, 0, 0], [100, 0, 0], -1),
    ], group);
    expect(paths).toHaveLength(1);
    expect(paths[0].edges).toHaveLength(3);
    expect(paths[0].heightKm).toBe(-1);
  });

  it('keeps distinct closed loops at the same elevation and other elevations separate', () => {
    const mesh = new THREE.Mesh(), group = new THREE.Group(); group.add(mesh); group.updateMatrixWorld(true);
    const segments: ContourSegment[] = [];
    for (const offset of [0, 100]) {
      const p = [[offset, 0, 0], [offset + 20, 0, 0], [offset + 20, 20, 0], [offset, 20, 0]];
      for (let i = 0; i < 4; i++) segments.push(segment(mesh, p[i], p[(i + 1) % 4], -1));
    }
    segments.push(segment(mesh, [0, 0, 0], [20, 0, 0], 1));
    const paths = stitchContourPaths(segments, group);
    expect(paths.map(p => p.edges.length).sort()).toEqual([1, 4, 4]);
    expect(paths.filter(p => p.heightKm === -1)).toHaveLength(2);
  });

  it('joins subpixel mixed-LOD border gaps while retaining a neighbouring parallel line', () => {
    const mesh = new THREE.Mesh(), group = new THREE.Group(); group.add(mesh); group.updateMatrixWorld(true);
    const camera = new THREE.OrthographicCamera(-400, 400, 400, -400, 0.1, 10000); camera.position.z = 1000; camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const segments = [segment(mesh, [0, 0, 0], [100, 0, 0]), segment(mesh, [102, 0, 0], [200, 0, 0]),
      segment(mesh, [102, 2, 0], [200, 2, 0])];
    expect(stitchContourPaths(segments, group)).toHaveLength(3);
    const paths = stitchContourPaths(segments, group, camera, 800);
    expect(paths).toHaveLength(2);
    expect(paths.map(p => p.edges.length).sort()).toEqual([1, 2]);
  });

  it('chooses shared 1–2–5 automatic steps from visible relief and responds to density', () => {
    expect([0.001, 0.0011, 0.0021, 0.0051, 0.011, 100].map(niceContourInterval)).toEqual([0.001, 0.002, 0.005, 0.01, 0.02, 1]);
    const geometry = new THREE.PlaneGeometry(1000, 1000, 10, 10), p = geometry.getAttribute('position');
    geometry.setAttribute('surfaceHeightKm', new THREE.Float32BufferAttribute(Array.from({ length: p.count }, (_, i) => p.getY(i) * 0.001), 1));
    const mesh = new THREE.Mesh(geometry), camera = new THREE.OrthographicCamera(-500, 500, 500, -500, 1, 10000);
    camera.position.z = 1000; camera.lookAt(0, 0, 0);
    expect(automaticContourInterval(camera, 1000, 1000, [mesh], 1, 0.1)).toBe(0.005);
    expect(automaticContourInterval(camera, 1000, 1000, [mesh], 4, 0.1)).toBe(0.001);
    expect(automaticContourInterval(camera, 1000, 1000, [], 1, 0.05)).toBe(0.05);
    expect(automaticContourInterval(camera, 1000, 1000, [mesh], 1, 0.005)).toBe(0.005);
  });

  it('yields during topology construction without dropping any contour paths', () => {
    const mesh = new THREE.Mesh(), group = new THREE.Group(); group.add(mesh); group.updateMatrixWorld(true);
    const segments = Array.from({ length: 200 }, (_, i) => segment(mesh, [0, 0, 0], [100, 0, 0], i));
    const job = buildContourPaths(segments, group);
    let result = job.next(); expect(result.done).toBe(false);
    while (!result.done) result = job.next();
    expect(result.value).toHaveLength(200);
  });

  it('does not let tiny projected terrain patches dominate automatic spacing', () => {
    const make = (size: number, slope: number) => {
      const geometry = new THREE.PlaneGeometry(size, size, 10, 10), p = geometry.getAttribute('position');
      geometry.setAttribute('surfaceHeightKm', new THREE.Float32BufferAttribute(Array.from({ length: p.count }, (_, i) => p.getY(i) * slope), 1));
      return new THREE.Mesh(geometry);
    };
    const camera = new THREE.OrthographicCamera(-500, 500, 500, -500, 1, 10000);
    camera.position.z = 1000; camera.lookAt(0, 0, 0);
    const surface = make(1000, 0.001), tinySteepPatch = make(10, 100);
    expect(automaticContourInterval(camera, 1000, 1000, [surface, tinySteepPatch], 1, 0.1)).toBe(0.005);
  });
});
