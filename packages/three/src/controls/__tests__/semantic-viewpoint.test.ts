/**
 * Applying a semantic catalog viewpoint (#114): the pose is resolved where the
 * view is shown — at the viewpoint's epoch, else at the current time — and the
 * viewpoint establishes the whole view: tracked body, look-at body, FOV.
 *
 * Runs against a synthetic universe and a recording stand-in for the
 * renderer, so no WebGL context is needed. The resolver's math is covered in
 * core's viewpoint-resolve suite; this covers what the applier does with it.
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { Universe, resolveViewpoint, type CatalogJson, type ViewpointDefinition } from '@cosmolabe/core';
import { applyNamedViewpoint, type ViewpointHost } from '../applyNamedViewpoint.js';
import { cameraViewpointFromDefinition, resolveCameraViewpoint } from '../catalogViewpoint.js';
import type { CameraViewpoint } from '../CameraController.js';
import type { BodyMesh } from '../../BodyMesh.js';

const SCALE = 1e-6;
const ET0 = 1.0e8;

function universe(viewpoints: object[]): Universe {
  const u = new Universe();
  u.loadCatalog({
    name: 'semantic-viewpoints',
    items: [
      { name: 'Sun', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
      {
        name: 'Mars', center: 'Sun',
        trajectory: { type: 'FixedPoint', position: [2.2e8, 0, 0] },
        rotationModel: { type: 'Uniform', period: 1, meridianAngle: 0, ascension: 317, declination: 53 },
      },
      {
        name: 'Probe', center: 'Mars',
        trajectory: { type: 'Keplerian', semiMajorAxis: 9000, eccentricity: 0, inclination: 25, ascendingNode: 0, argOfPeriapsis: 0, meanAnomaly: 0 },
      },
      ...viewpoints.map((v) => ({ type: 'Viewpoint', ...v })),
    ],
  } as CatalogJson);
  u.setTime(ET0);
  return u;
}

/** A renderer stand-in over a universe's catalog viewpoints. */
function host(u: Universe) {
  const vps = new Map<string, CameraViewpoint>(
    u.viewpoints.map((d) => [d.name, cameraViewpointFromDefinition(u, d, SCALE, u.time)]),
  );
  const meshes = new Map<string, BodyMesh>(u.getAllBodies().map((b) => [b.name, { body: b } as unknown as BodyMesh]));
  const state = {
    et: u.time,
    tracked: null as string | null,
    lookAt: 'stale' as string | null,
    applied: null as CameraViewpoint | null,
    fov: 50,
    calls: [] as string[],
  };
  const h: ViewpointHost = {
    cameraController: {
      getViewpoint: (n) => vps.get(n),
      applyViewpoint: (vp) => { state.applied = vp; state.calls.push('apply'); },
      flyToViewpoint: (vp) => { state.applied = vp; state.calls.push('fly'); },
      track: (bm) => { state.tracked = bm?.body.name ?? null; },
      lookAt: (bm) => { state.lookAt = bm?.body.name ?? null; },
    },
    timeController: {
      get et() { return state.et; },
      setTime: (t) => { state.et = t; state.calls.push(`setTime:${t}`); },
    },
    camera: { get fov() { return state.fov; }, set fov(v) { state.fov = v; }, updateProjectionMatrix: () => {} },
    getBodyMesh: (n) => meshes.get(n),
  };
  return { h, state, vps };
}

const scenePose = (u: Universe, def: ViewpointDefinition, et: number) => {
  const r = resolveViewpoint(u, def, et);
  return { eye: new THREE.Vector3(...r.eye).multiplyScalar(SCALE), target: new THREE.Vector3(...r.target).multiplyScalar(SCALE) };
};

describe('applyNamedViewpoint with semantic catalog viewpoints', () => {
  it('resolves a timeless viewpoint at the current time, not at load', () => {
    const u = universe([{ name: 'Over Jezero', center: 'Mars', distance: 4000, latitude: 18.4, longitude: 77.5 }]);
    const { h, state } = host(u);
    state.et = ET0 + 6 * 3600; // a quarter turn later
    expect(applyNamedViewpoint(h, 'Over Jezero')).toBe(true);
    const def = u.viewpoints[0];
    const now = scenePose(u, def, state.et);
    expect(state.applied!.position.distanceTo(now.eye)).toBeLessThan(1e-12);
    expect(state.applied!.position.distanceTo(scenePose(u, def, ET0).eye)).toBeGreaterThan(1e-3);
    // No time named, so the clock is left alone.
    expect(state.calls.some((c) => c.startsWith('setTime'))).toBe(false);
  });

  it('resolves an epoch-bearing viewpoint at its epoch, and seeks there first', () => {
    const epoch = ET0 + 12345;
    const u = universe([{ name: 'At epoch', center: 'Probe', distance: 1, from: { kind: 'velocity', negate: true }, epoch }]);
    const { h, state } = host(u);
    applyNamedViewpoint(h, 'At epoch');
    expect(state.calls).toEqual([`setTime:${epoch}`, 'apply']);
    expect(state.applied!.position.distanceTo(scenePose(u, u.viewpoints[0], epoch).eye)).toBeLessThan(1e-15);
  });

  it('tracks the center and keeps facing the look-at body', () => {
    const u = universe([{ name: 'Mars beyond the probe', center: 'Probe', lookAt: 'Mars', distance: 0.02, from: { kind: 'toward', body: 'Mars', negate: true }, fov: 35 }]);
    const { h, state } = host(u);
    applyNamedViewpoint(h, 'Mars beyond the probe');
    expect(state.tracked).toBe('Probe');
    expect(state.lookAt).toBe('Mars');
    expect(state.fov).toBe(35);
    expect(state.applied!.target.distanceTo(scenePose(u, u.viewpoints[0], ET0).target)).toBeLessThan(1e-12);
  });

  it('clears a look-at left from earlier navigation', () => {
    const u = universe([{ name: 'Plain', center: 'Mars', distance: 9000, latitude: 0, longitude: 0 }]);
    const { h, state } = host(u);
    expect(state.lookAt).toBe('stale');
    applyNamedViewpoint(h, 'Plain');
    expect(state.lookAt).toBeNull();
    expect(state.tracked).toBe('Mars');
  });

  it('refuses, changing nothing, when a reference cannot be resolved', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const u = universe([{ name: 'Ghost', center: 'Probe', lookAt: 'Philae', distance: 1, from: { kind: 'toward', body: 'Mars' }, epoch: ET0 + 1 }]);
      // Reported at registration, before anyone picks it.
      const { h, state } = host(u);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('unknown body "Philae"'))).toBe(true);
      expect(applyNamedViewpoint(h, 'Ghost')).toBe(false);
      expect(state.calls).toEqual([]);
      expect(state.lookAt).toBe('stale');
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves a session-saved viewpoint (no resolver) as stored', () => {
    const saved: CameraViewpoint = { name: 'Saved', position: new THREE.Vector3(1, 2, 3), target: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) };
    expect(resolveCameraViewpoint(saved, 42)).toBe(saved);
  });
});
