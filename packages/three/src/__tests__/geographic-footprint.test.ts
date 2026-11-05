import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { geodeticToBodyFixed, type GeographicLayer } from '@cosmolabe/core';
import { geographicFootprint, footprintScreenRect, meshHeightRange } from '../geographic/GeographicFootprint.js';

const datum = { referenceShape: { kind: 'sphere', radiusKm: 1000 } } as GeographicLayer['datum'];
const p = (lonDeg: number, latDeg: number) => ({ lonDeg, latDeg });

describe('geographicFootprint', () => {
  it('boxes nearby positions, and goes the short way across the 180° seam', () => {
    expect(geographicFootprint([p(10, 1), p(12, -2), p(11, 3)])).toEqual({ kind: 'box', west: 10, east: 12, south: -2, north: 3 });
    expect(geographicFootprint([p(179, 0), p(-179, 1)])).toEqual({ kind: 'box', west: 179, east: -179, south: 0, north: 1 });
  });
  it('gives up (global) for wide spans and near the poles, and null for nothing', () => {
    expect(geographicFootprint([p(0, 0), p(90, 0)])).toEqual({ kind: 'global' });
    expect(geographicFootprint([p(0, 0), p(1, 89.5)])).toEqual({ kind: 'global' });
    expect(geographicFootprint([])).toBeNull();
  });
});

describe('footprintScreenRect', () => {
  // A camera 500 km above (lon 0, lat 0), looking straight down, with a 1000×800 viewport.
  const camera = new THREE.PerspectiveCamera(60, 1000 / 800, 1, 1e5);
  camera.position.set(1500, 0, 0); camera.up.set(0, 0, 1); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const viewport = new THREE.Vector4(0, 0, 1000, 800);
  const identity = new THREE.Matrix4();
  const project = (lon: number, lat: number) => {
    const q = geodeticToBodyFixed({ lonDeg: lon, latDeg: lat, heightKm: 0 }, datum);
    const v = new THREE.Vector3(q.xKm, q.yKm, q.zKm).project(camera);
    return [(v.x + 1) / 2 * 1000, (v.y + 1) / 2 * 800];
  };

  it('contains every point of the box and stays small for a small box', () => {
    const box = { kind: 'box', west: -1, east: 1, south: -1, north: 1 } as const;
    const rect = footprintScreenRect(box, -1, 1, datum, identity, camera, viewport, 4);
    expect(rect).toBeInstanceOf(THREE.Vector4);
    const r = rect as THREE.Vector4;
    for (const [lon, lat] of [[-1, -1], [1, 1], [0, 0], [0.5, -0.7]]) {
      const [x, y] = project(lon, lat);
      expect(x).toBeGreaterThanOrEqual(r.x); expect(x).toBeLessThanOrEqual(r.x + r.z);
      expect(y).toBeGreaterThanOrEqual(r.y); expect(y).toBeLessThanOrEqual(r.y + r.w);
    }
    expect(r.z * r.w).toBeLessThan(0.2 * 1000 * 800);
  });

  it('is empty outside the view, and unbounded behind the camera or for a global footprint', () => {
    expect(footprintScreenRect({ kind: 'box', west: 60, east: 62, south: 0, north: 1 }, 0, 0, datum, identity, camera, viewport, 4)).toBe('empty');
    // Projection knows nothing of occlusion: the far side lands mid-screen, which is conservative.
    expect(footprintScreenRect({ kind: 'box', west: 170, east: 172, south: 0, north: 1 }, 0, 0, datum, identity, camera, viewport, 4)).toBeInstanceOf(THREE.Vector4);
    expect(footprintScreenRect({ kind: 'box', west: -1, east: 1, south: -1, north: 1 }, 0, 600, datum, identity, camera, viewport, 4)).toBeNull();
    const away = camera.clone(); away.lookAt(3000, 0, 0); away.updateMatrixWorld(true);
    expect(footprintScreenRect({ kind: 'box', west: -1, east: 1, south: -1, north: 1 }, 0, 0, datum, identity, away, viewport, 4)).toBe('empty');
    expect(footprintScreenRect({ kind: 'global' }, 0, 0, datum, identity, camera, viewport, 4)).toBeNull();
  });

  it('is offset into a sub-viewport', () => {
    const box = { kind: 'box', west: -1, east: 1, south: -1, north: 1 } as const;
    const a = footprintScreenRect(box, 0, 0, datum, identity, camera, viewport, 0) as THREE.Vector4;
    const b = footprintScreenRect(box, 0, 0, datum, identity, camera, new THREE.Vector4(200, 100, 1000, 800), 0) as THREE.Vector4;
    expect([b.x - a.x, b.y - a.y, b.z, b.w]).toEqual([200, 100, a.z, a.w]);
  });
});

describe('meshHeightRange', () => {
  it('bounds a tile patch, and says whether it can touch the footprint', () => {
    const geometry = new THREE.BufferGeometry();
    const corners = [p(10, 10), p(11, 10), p(11, 11), p(10, 11)].map(({ lonDeg, latDeg }) => geodeticToBodyFixed({ lonDeg, latDeg, heightKm: 2 }, datum));
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners.flatMap((c) => [c.xKm, c.yKm, c.zKm]), 3));
    const near = meshHeightRange(geometry, new THREE.Matrix4(), datum, { kind: 'box', west: 10.5, east: 10.6, south: 10.5, north: 10.6 })!;
    expect(near.touches).toBe(true);
    expect(near.low).toBeLessThanOrEqual(2);
    expect(near.high).toBeGreaterThanOrEqual(2);
    expect(meshHeightRange(geometry, new THREE.Matrix4(), datum, { kind: 'box', west: 40, east: 41, south: 10, north: 11 })!.touches).toBe(false);
  });
  it('cannot bound a whole globe from its box', () => {
    expect(meshHeightRange(new THREE.SphereGeometry(1000, 32, 16), new THREE.Matrix4(), datum, { kind: 'global' })).toBeNull();
  });
});
