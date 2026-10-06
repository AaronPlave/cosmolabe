import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Body, FixedPointTrajectory, bodySurfaceCoordinates, surfacePositionToBodyFixed } from '@cosmolabe/core';
import { BodyMesh } from '../BodyMesh.js';
import { normalizeGridSettings } from '@cosmolabe/control';
import { chooseGridStep, GRID_STEPS } from '../AdaptiveGraticule.js';
import { LabelManager } from '../LabelManager.js';
import { TerrainSampler } from '../TerrainSampler.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('adaptive graticule', () => {
  it('plans the nearby resident depression while the camera is inside the reference sphere', () => {
    const body = new Body({ name: 'Depression', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe' });
    const bm = new BodyMesh(body);
    bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const sampler = new TerrainSampler(bodySurfaceCoordinates(body)!.datum, { id: 'resident', kind: 'height-grid' });
    sampler.addTile({ id: 'depression', westDeg: -180, eastDeg: 180, southDeg: -90, northDeg: 90,
      width: 2, height: 2, elevationsKm: new Float32Array(4).fill(-1) });
    vi.spyOn(bm, 'sampleTerrain').mockImplementation((lat, lon) => sampler.sample(lat, lon));
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000);
    camera.position.set(99.5, 0, 0); camera.up.set(0, 0, 1); camera.lookAt(99, 0, 0);
    bm.showGrid(true, false, normalizeGridSettings());
    const rays = vi.spyOn(THREE.Raycaster.prototype, 'intersectObjects');
    bm.updateGrid(camera, { width: 800, height: 800 }, null);
    expect(bm.gridMetrics!.candidates).toBeGreaterThan(0);
    expect(bm.gridMetrics!.latitudeStep).toBeLessThan(0.1);
    expect(bm.gridMetrics!.longitudeStep).toBeLessThan(0.1);
    expect(bm.gridMetrics!.layout).toBe('regional');
    expect(rays).not.toHaveBeenCalled();
    bm.dispose();
  });

  it('uses common globe bands, regional edges, distinct zero labels and pose-dependent placements', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ scale() {}, strokeText() {}, fillText() {} }) }) });
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const body = new Body({ name: 'Layout', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body); bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000);
    const manager = { reserveContextRect: () => true } as unknown as LabelManager;
    const pose = (eye: [number, number, number], up: [number, number, number] = [0, 0, 1]) => {
      camera.position.set(...eye); camera.up.set(...up); camera.lookAt(0, 0, 0); now += 200;
      for (let i = 0; i < 20; i++) { now += 16; bm.updateGrid(camera, { width: 800, height: 800 }, manager); }
      return bm.gridMetrics!;
    };
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 20 }));
    const first = pose([300, 0, 0]);
    expect(first.annotations.map(a => a.text)).toContain('Equator 0°');
    expect(first.annotations.map(a => a.text)).toContain('Prime 0°');
    for (const eye of [[200, 150, 220], [0, 0, 300]] as [number, number, number][]) {
      const m = pose(eye, eye[0] === 0 ? [1, 0, 0] : [0, 0, 1]);
      expect(m.layout).toBe('globe');
      expect(new Set(m.annotations.filter(a => a.axis === 'latitude').map(a => a.lonDeg)).size).toBe(1);
      expect(new Set(m.annotations.filter(a => a.axis === 'longitude').map(a => a.latDeg)).size).toBe(1);
      expect(m.annotations.filter(a => a.axis === 'longitude').every(a => Math.abs(a.latDeg) <= 60)).toBe(true);
    }
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 0.1 }));
    const regional = pose([100.5, 0, 0]);
    expect(regional.layout).toBe('regional');
    expect(regional.annotations.length).toBeGreaterThan(0);
    expect(regional.annotations.filter(a => a.axis === 'latitude').every(a => a.edge === 'left')).toBe(true);
    expect(regional.annotations.filter(a => a.axis === 'longitude').every(a => a.edge === 'bottom')).toBe(true);
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 20 }));
    const final = pose([300, 0, 0]);
    const ordered = (m: typeof first) => m.annotations.slice().sort((a, b) => a.text.localeCompare(b.text));
    expect(ordered(final)).toEqual(ordered(first));
    bm.dispose();
  });
  it('updates regional line intersections between density plans and keeps clipped globe bands fixed', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ scale() {}, strokeText() {}, fillText() {} }) }) });
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const body = new Body({ name: 'Motion', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body); bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000); camera.up.set(0, 0, 1);
    const manager = { reserveContextRect: () => true } as unknown as LabelManager;
    const frame = (x: number, y: number) => {
      now += 16; camera.position.set(x, y, 0); camera.lookAt(100, y, 0);
      bm.updateGrid(camera, { width: 800, height: 800 }, manager); return bm.gridMetrics!;
    };
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 0.1 }));
    const a = frame(100.5, 0), b = frame(100.5, 0.005), c = frame(100.5, 0.01);
    const zero = (m: typeof a) => m.annotations.find(a => a.axis === 'latitude' && a.latDeg === 0)!;
    expect(zero(a)).toBeDefined(); expect(zero(b).lonDeg).not.toBe(zero(a).lonDeg);
    expect(zero(c).lonDeg).not.toBe(zero(b).lonDeg);
    expect(a.latitudeStep).toBe(c.latitudeStep);
    expect(a.densityBlend).toBe(0);
    expect(b.densityBlend).toBeGreaterThan(0); expect(b.densityBlend).toBeLessThan(1);
    const roll = (degrees: number, frames = 1) => {
      const angle = degrees * Math.PI / 180;
      camera.position.set(100.5, 0, 0); camera.up.set(0, Math.sin(angle), Math.cos(angle)); camera.lookAt(100, 0, 0);
      for (let i = 0; i < frames; i++) { now += 16; bm.updateGrid(camera, { width: 800, height: 800 }, manager); }
      return bm.gridMetrics!;
    };
    roll(0, 40);
    expect(roll(50).annotations.filter(a => a.axis === 'latitude').every(a => a.edge === 'left')).toBe(true);
    const settledA = roll(50, 40);
    expect(settledA.annotations.filter(a => a.axis === 'latitude').every(a => a.edge === 'bottom')).toBe(true);
    roll(90, 40);
    const settledB = roll(50, 40);
    const sorted = (m: typeof a) => m.annotations.slice().sort((a, b) => a.text.localeCompare(b.text));
    expect(sorted(settledB)).toEqual(sorted(settledA));
    camera.up.set(0, 0, 1);
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 15 }));
    camera.position.set(180, 0, 0); camera.lookAt(0, 0, 0); now += 400;
    for (let i = 0; i < 20; i++) { now += 16; bm.updateGrid(camera, { width: 800, height: 800 }, manager); }
    expect(bm.gridMetrics!.layout).toBe('globe'); // projected disc clips the viewport
    const fixed = bm.gridMetrics!.annotations;
    camera.position.y = 0.01; camera.lookAt(0, 0, 0); now += 16;
    bm.updateGrid(camera, { width: 800, height: 800 }, manager);
    expect(bm.gridMetrics!.annotations).toEqual(fixed);
    bm.dispose();
  });
  it('reserves measured controls and moves regional anchors into the usable viewport', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ scale() {}, strokeText() {}, fillText() {} }) }) });
    const manager = new LabelManager({} as HTMLElement);
    manager.setReservedRects([{ x0: 8, x1: 56, y0: 80, y1: 550 }, { x0: 80, x1: 1016, y0: 686, y1: 760 }], 'controls');
    expect(manager.getContextViewport(1024, 768)).toEqual({ x0: 104, x1: 960, y0: 36, y1: 662 });
    const body = new Body({ name: 'Controls', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body); bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const camera = new THREE.PerspectiveCamera(45, 1024 / 768, 0.001, 1000);
    camera.position.set(100.5, 0, 0); camera.up.set(0, 0, 1); camera.lookAt(100, 0, 0);
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 0.1 }));
    manager.beginContextAnnotations(); bm.updateGrid(camera, { width: 1024, height: 768 }, manager);
    const annotations = bm.gridMetrics!.annotations;
    expect(annotations.filter(a => a.axis === 'latitude').length).toBeGreaterThan(0);
    expect(annotations.filter(a => a.axis === 'longitude').length).toBeGreaterThan(0);
    for (const a of annotations) {
      const p = surfacePositionToBodyFixed({ latDeg: a.latDeg, lonDeg: a.lonDeg }, bodySurfaceCoordinates(body)!);
      const screen = new THREE.Vector3(p.xKm, p.yKm, p.zKm).project(camera);
      if (a.edge === 'left') expect((screen.x + 1) * 512).toBeCloseTo(104, 0);
      if (a.edge === 'bottom') expect((1 - screen.y) * 384).toBeCloseTo(662, 0);
    }
    bm.dispose();
  });
  it('retains terrain annotations during continuous small camera moves within the ray budget', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({
      scale() {}, strokeText() {}, fillText() {},
    }) }) });
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const body = new Body({ name: 'Moon', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe' });
    const bm = new BodyMesh(body);
    bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    bm.mesh.visible = false;
    const terrain = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(100, 128, 64).rotateX(0.137).rotateZ(0.213), new THREE.MeshStandardMaterial());
    terrain.add(mesh); terrain.updateMatrixWorld(true);
    vi.spyOn(bm, 'terrainTileGroup', 'get').mockReturnValue(terrain);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.set(300, 0, 0); camera.up.set(0, 0, 1); camera.lookAt(0, 0, 0);
    const labels = { reserveContextRect: () => true } as unknown as LabelManager;
    const rays = vi.spyOn(THREE.Raycaster.prototype, 'intersectObjects');
    bm.showGrid(true, true, normalizeGridSettings());
    const frame = () => {
      now += 16; rays.mockClear();
      bm.updateGrid(camera, { width: 800, height: 800 }, labels);
      expect(rays.mock.calls.length).toBeLessThanOrEqual(8);
      return bm.gridMetrics!.labels;
    };
    for (let i = 0; i < 20; i++) frame();
    const settled = bm.gridMetrics!.labels;
    expect(settled).toBeGreaterThan(8);
    let stationaryQueries = 0;
    for (let i = 0; i < 20; i++) {
      expect(frame()).toBe(settled);
      stationaryQueries += rays.mock.calls.length;
    }
    // Do not spend each frame's budget rechecking alternative anchors on
    // lines that already have a visible annotation.
    expect(stationaryQueries).toBeLessThan(60);
    for (let i = 0; i < 40; i++) {
      camera.position.y += 0.001;
      expect(frame(), 'motion frame ' + i).toBe(settled);
    }
    // A large view change must not reuse old visibility results outside the
    // controlled screen-space grace period, even if their time has not expired.
    camera.position.y += 50;
    expect(frame()).toBeLessThanOrEqual(8);
    // Cached visible hits expire when the rendered terrain disappears.
    terrain.remove(mesh); now += 151;
    expect(frame()).toBe(0);
    bm.dispose(); mesh.geometry.dispose(); mesh.material.dispose();
  });
  it('keeps zoom noise inside hysteresis and bounds extreme regional density', () => {
    expect(chooseGridStep(10, 10)).toBe(10);
    expect(chooseGridStep(11, 10)).toBe(10);
    expect(chooseGridStep(10, 30)).toBe(10);
    expect(chooseGridStep(0.001)).toBe(30);
    expect(chooseGridStep(1e9)).toBe(0.001);
    for (let p = 0.1; p < 1e6; p *= 1.2) expect(GRID_STEPS).toContain(chooseGridStep(p));
  });
  it('refines a screen-filling regional view without a global geometry lattice', () => {
    const body = new Body({ name: 'Region', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body);
    bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000);
    camera.position.set(100.1, 0, 0); camera.up.set(0, 0, 1); camera.lookAt(100, 0, 0); camera.updateMatrixWorld(true);
    bm.showGrid(true, false, normalizeGridSettings());
    bm.updateGrid(camera, { width: 800, height: 800 }, null);
    expect(bm.gridMetrics!.latitudeStep).toBeLessThan(1);
    expect(bm.gridMetrics!.longitudeStep).toBeLessThan(1);
    expect(bm.gridMetrics!.candidates).toBeLessThanOrEqual(96);
    expect(bm.gridMetrics!.labels).toBe(0);
    // No Line objects or tessellated grid buffers: surface material carries the lattice.
    expect(bm.children.some(child => child instanceof THREE.Line)).toBe(false);
    bm.dispose();
  });
  it('round-trips body coordinates with or without a rotation model and ignores model pre-rotation', () => {
    for (const rotation of [undefined, { sourceFrame: 'ECLIPJ2000', rotationAt: () => [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as [number, number, number, number] }]) {
      const body = new Body({ name: 'Fixture', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [2, 2, 1], geometryType: 'Globe', rotation });
      const bm = new BodyMesh(body);
      bm.updatePosition([0, 0, 0], 0, 1);
      const c = bodySurfaceCoordinates(body)!;
      const fixed = surfacePositionToBodyFixed({ latDeg: 45, lonDeg: 90 }, c);
      const p = new THREE.Vector3(fixed.xKm, fixed.yKm, fixed.zKm);
      const q = bm.bodyToWorldQuaternion(new THREE.Quaternion());
      expect(p.clone().applyQuaternion(q).applyQuaternion(q.clone().invert()).distanceTo(p)).toBeLessThan(1e-12);
      if (rotation) {
        const before = q.clone();
        bm.meshRotationQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
        bm.updatePosition([0, 0, 0], 0, 1);
        expect(before.angleTo(bm.bodyToWorldQuaternion(q))).toBeLessThan(1e-7);
      }
      bm.dispose();
    }
  });
});
