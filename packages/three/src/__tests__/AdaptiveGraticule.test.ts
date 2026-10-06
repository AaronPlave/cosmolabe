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
  it('deduplicates coordinate lines across anchors and retained tiers, while showing both axes', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ scale() {}, strokeText() {}, fillText() {} }) }) });
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const body = new Body({ name: 'Selection', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body); bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000); camera.up.set(0, 0, 1); camera.position.set(300, 0, 0); camera.lookAt(0, 0, 0);
    const manager = { reserveContextRect: () => true } as unknown as LabelManager;
    const frame = () => {
      now += 16; bm.updateGrid(camera, { width: 800, height: 800 }, manager);
      const annotations = bm.gridMetrics!.annotations;
      expect(new Set(annotations.map(a => `${a.axis}:${a.angle}`)).size).toBe(annotations.length);
      return annotations;
    };
    const settle = () => { for (let i = 0; i < 60; i++) frame(); return frame(); };
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 15 }));
    const original = settle();
    expect(original.filter(a => a.angle === 0)).toHaveLength(2);
    expect(new Set(original.map(a => a.axis)).size).toBe(2);
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 10 }));
    const refined = settle();
    for (const a of original.filter(a => a.angle === 0)) expect(refined.find(b => b.axis === a.axis && b.angle === 0)?.id).toBe(a.id);
    camera.position.set(101, 0, 0); camera.lookAt(100, 0, 0);
    bm.showGrid(true, true, normalizeGridSettings());
    const regional = settle();
    expect(regional.length).toBeGreaterThan(0);
    expect(new Set(regional.map(a => a.axis)).size).toBe(2);
    bm.dispose();
  });

  it('retires an unsuitable incumbent before admitting another fixed anchor on the same line', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ scale() {}, strokeText() {}, fillText() {} }) }) });
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const body = new Body({ name: 'Replacement', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body); bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000); camera.position.set(300, 0, 0); camera.up.set(0, 0, 1); camera.lookAt(0, 0, 0);
    const manager = new LabelManager({} as HTMLElement);
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 10 }));
    const frame = () => { now += 16; manager.beginContextAnnotations(); bm.updateGrid(camera, { width: 800, height: 800 }, manager); return bm.gridMetrics!; };
    for (let i = 0; i < 40; i++) frame();
    const original = frame().annotations.find(a => a.axis === 'latitude' && a.angle === 0)!;
    expect(original).toBeDefined();
    const fixed = surfacePositionToBodyFixed({ latDeg: original.latDeg, lonDeg: original.lonDeg }, bodySurfaceCoordinates(body)!);
    const screen = new THREE.Vector3(fixed.xKm, fixed.yKm, fixed.zKm).project(camera);
    const x = (screen.x + 1) * 400 + 8, y = (1 - screen.y) * 400;
    manager.setReservedRects([{ x0: x - 45, x1: x + 45, y0: y - 14, y1: y + 14 }], 'controls');
    expect(frame().annotations.some(a => a.axis === 'latitude' && a.angle === 0)).toBe(false);
    for (let i = 0; i < 6; i++) expect(frame().annotations.some(a => a.axis === 'latitude' && a.angle === 0)).toBe(false);
    for (let i = 0; i < 40; i++) frame();
    const replacement = frame().annotations.find(a => a.axis === 'latitude' && a.angle === 0)!;
    expect(replacement).toBeDefined(); expect(replacement.id).not.toBe(original.id);
    manager.setReservedRects([], 'controls');
    for (let i = 0; i < 30; i++) expect(frame().annotations.find(a => a.axis === 'latitude' && a.angle === 0)?.id).toBe(replacement.id);
    expect(frame().anchors.find(a => a.id === original.id)).toMatchObject({ lat: original.latDeg, lon: original.lonDeg });
    bm.dispose();
  });

  it('dims night-side labels with the lit grid without penalizing dark daytime albedo', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ scale() {}, strokeText() {}, fillText() {} }) }) });
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const body = new Body({ name: 'Lighting', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body); bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const scene = new THREE.Scene(); const ambient = new THREE.AmbientLight(0xffffff, 0.015);
    const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(5000, 0, 0); scene.add(bm, ambient, sun);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000); camera.position.set(300, 0, 0); camera.up.set(0, 0, 1); camera.lookAt(0, 0, 0);
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 15 }));
    const manager = { reserveContextRect: () => true } as unknown as LabelManager;
    const frame = () => { now += 16; bm.updateGrid(camera, { width: 800, height: 800 }, manager); return bm.gridMetrics!; };
    for (let i = 0; i < 40; i++) frame();
    const day = frame().annotations.find(a => a.axis === 'latitude' && a.angle === 0)!;
    expect(day.opacity).toBeGreaterThan(0.5);
    (bm.mesh.material as THREE.MeshStandardMaterial).color.set('#080808');
    for (let i = 0; i < 40; i++) frame();
    expect(frame().annotations.find(a => a.id === day.id)?.opacity).toBeCloseTo(day.opacity);
    sun.position.set(-5000, 0, 0);
    expect(frame().labels).toBe(0); expect(bm.gridMetrics!.densityBlend).toBe(1);
    ambient.intensity = 1.8;
    for (let i = 0; i < 40; i++) frame();
    expect(frame().annotations.find(a => a.id === day.id)?.opacity).toBeGreaterThan(0.5);
    bm.dispose();
  });

  it('uses the hit overlay scene lighting without brightening uncovered night terrain', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ scale() {}, strokeText() {}, fillText() {} }) }) });
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const body = new Body({ name: 'Overlay lighting', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body); bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const scene = new THREE.Scene(); const ambient = new THREE.AmbientLight(0xffffff, 0.015); scene.add(bm, ambient);
    const overlayScene = new THREE.Scene(), group = new THREE.Group();
    const overlay = new THREE.Mesh(new THREE.SphereGeometry(100, 128, 64), new THREE.MeshStandardMaterial()); group.add(overlay);
    const overlayAmbient = new THREE.AmbientLight(0xffffff, 1); overlayScene.add(group, overlayAmbient); overlayScene.updateMatrixWorld(true);
    vi.spyOn(bm, 'getSurfaceOverlays').mockReturnValue([{ group, tiles: { addEventListener() {} } }] as unknown as ReturnType<BodyMesh['getSurfaceOverlays']>);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000); camera.position.set(300, 0, 0); camera.up.set(0, 0, 1); camera.lookAt(0, 0, 0);
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 15 }));
    const manager = { reserveContextRect: () => true } as unknown as LabelManager;
    const frame = () => { now += 16; bm.updateGrid(camera, { width: 800, height: 800 }, manager); return bm.gridMetrics!; };
    for (let i = 0; i < 40; i++) frame();
    const lit = frame().annotations.find(a => a.axis === 'latitude' && a.angle === 0)!;
    expect(lit.opacity).toBeGreaterThan(0.2);
    ambient.intensity = 1.8;
    for (let i = 0; i < 40; i++) frame();
    expect(frame().annotations.find(a => a.id === lit.id)?.opacity).toBeCloseTo(lit.opacity);
    overlayAmbient.intensity = 0;
    expect(frame().labels).toBe(0); // Main-scene flood lighting does not light this overlay.
    ambient.intensity = 0.015; group.visible = false; overlayAmbient.intensity = 1;
    for (let i = 0; i < 40; i++) frame();
    expect(frame().labels).toBe(0); // The bright overlay scene does not light uncovered terrain.
    bm.dispose(); overlay.geometry.dispose(); overlay.material.dispose();
  });

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
    expect(bm.gridMetrics!.layout).toBe('geographic');
    expect(rays).not.toHaveBeenCalled();
    bm.dispose();
  });

  it('keeps geographic identities and locations through orbit, pan, roll and nearly stationary motion', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ scale() {}, strokeText() {}, fillText() {} }) }) });
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const body = new Body({ name: 'Attachment', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body); bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000); camera.up.set(0, 0, 1);
    const manager = { reserveContextRect: () => true } as unknown as LabelManager;
    const identities = new Map<string, readonly [number, number]>();
    const frame = () => {
      now += 16; bm.updateGrid(camera, { width: 800, height: 800 }, manager);
      const metric = bm.gridMetrics!;
      for (const a of metric.anchors) {
        const original = identities.get(a.id); if (original) expect([a.lat, a.lon]).toEqual(original);
        else identities.set(a.id, [a.lat, a.lon]);
      }
      for (const a of metric.annotations) expect([a.latDeg, a.lonDeg]).toEqual(identities.get(a.id));
      return metric;
    };
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 15 }));
    camera.position.set(300, 0, 0); camera.lookAt(0, 0, 0);
    for (let i = 0; i < 30; i++) frame();
    const initial = frame(); expect(initial.annotations.length).toBeGreaterThan(0);
    expect(initial.annotations.map(a => a.text)).toContain('Equator 0°');
    expect(initial.annotations.map(a => a.text)).toContain('Prime 0°');
    for (let i = 0; i < 80; i++) {
      const angle = i * 0.0005; camera.position.set(300 * Math.cos(angle), 300 * Math.sin(angle), i * 0.002);
      camera.up.set(0, Math.sin(angle), Math.cos(angle)); camera.lookAt(0, 0, 0); frame();
    }
    expect(frame().annotations.some(a => initial.annotations.some(b => b.id === a.id))).toBe(true);
    const stable = frame().annotations.map(a => a.id).sort();
    for (let i = 0; i < 60; i++) {
      camera.position.y += i % 2 ? 1e-7 : -1e-7; camera.lookAt(0, 0, 0);
      expect(frame().annotations.map(a => a.id).sort()).toEqual(stable);
    }
    bm.dispose();
  });

  it('introduces separate fixed tiers, retains matching coarse anchors and retires non-nested/finer lines', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ scale() {}, strokeText() {}, fillText() {} }) }) });
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const body = new Body({ name: 'Tiers', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body); bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000); camera.up.set(0, 0, 1); camera.position.set(300, 0, 0); camera.lookAt(0, 0, 0);
    const manager = { reserveContextRect: () => true } as unknown as LabelManager;
    const frame = () => { now += 16; bm.updateGrid(camera, { width: 800, height: 800 }, manager); return bm.gridMetrics!; };
    const settle = () => { for (let i = 0; i < 40; i++) frame(); return frame(); };
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 15 }));
    const before = settle();
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 10 }));
    expect(frame().densityBlend).toBe(0);
    const refined = settle();
    const survivors = refined.annotations.filter(a => before.annotations.some(b => b.id === a.id));
    expect(survivors.length).toBeGreaterThan(0);
    for (const a of survivors) expect(a).toMatchObject(before.annotations.find(b => b.id === a.id)!);
    expect(refined.anchors.some(a => a.tier === '10:10')).toBe(true);
    for (const a of refined.annotations) expect(Math.abs(a.angle / 10 - Math.round(a.angle / 10))).toBeLessThan(1e-5);
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 30 }));
    const coarse = settle();
    expect(coarse.annotations.length).toBeGreaterThan(0);
    expect(coarse.annotations.every(a => a.step >= 30)).toBe(true);
    bm.dispose();
  });

  it('yields to measured controls by hiding labels without changing their geographic pattern', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ scale() {}, strokeText() {}, fillText() {} }) }) });
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const manager = new LabelManager({} as HTMLElement);
    const body = new Body({ name: 'Controls', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body); bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000); camera.position.set(300, 0, 0); camera.up.set(0, 0, 1); camera.lookAt(0, 0, 0);
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 15 }));
    const frame = () => { now += 16; manager.beginContextAnnotations(); bm.updateGrid(camera, { width: 800, height: 800 }, manager); return bm.gridMetrics!; };
    for (let i = 0; i < 40; i++) frame();
    const initial = frame(); const anchor = initial.annotations.find(a => a.text === 'Equator 0°')!;
    expect(anchor).toBeDefined();
    const p = surfacePositionToBodyFixed({ latDeg: anchor.latDeg, lonDeg: anchor.lonDeg }, bodySurfaceCoordinates(body)!);
    const screen = new THREE.Vector3(p.xKm, p.yKm, p.zKm).project(camera); const x = (screen.x + 1) * 400, y = (1 - screen.y) * 400;
    manager.setReservedRects([{ x0: x - 60, x1: x + 60, y0: y - 15, y1: y + 15 }], 'controls');
    const hidden = frame(); expect(hidden.annotations.some(a => a.id === anchor.id)).toBe(false);
    expect(hidden.anchors.find(a => a.id === anchor.id)).toMatchObject({ lat: anchor.latDeg, lon: anchor.lonDeg });
    manager.setReservedRects([], 'controls');
    expect(frame().annotations.some(a => a.id === anchor.id)).toBe(false); // entry dwell
    for (let i = 0; i < 40; i++) frame();
    expect(frame().annotations.find(a => a.id === anchor.id)).toMatchObject({ latDeg: anchor.latDeg, lonDeg: anchor.lonDeg });
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
      const annotations = bm.gridMetrics!.annotations;
      expect(new Set(annotations.map(a => `${a.axis}:${a.angle}`)).size).toBe(annotations.length);
      return bm.gridMetrics!.labels;
    };
    for (let i = 0; i < 20; i++) frame();
    const settled = bm.gridMetrics!.labels;
    expect(new Set(bm.gridMetrics!.annotations.map(a => a.axis)).size).toBe(2);
    expect(settled).toBeGreaterThan(0);
    expect(settled).toBeLessThanOrEqual(6);
    let stationaryQueries = 0;
    for (let i = 0; i < 20; i++) {
      expect(frame()).toBe(settled);
      stationaryQueries += rays.mock.calls.length;
    }
    // Current-frame geometry validates every displayed label, within the
    // existing eight-query budget; two queries remain available for discovery.
    expect(stationaryQueries).toBeLessThanOrEqual(160);
    for (let i = 0; i < 40; i++) {
      camera.position.y += 0.001;
      expect(frame(), 'motion frame ' + i).toBe(settled);
    }
    // A large view change must not reuse old visibility results outside the
    // controlled screen-space grace period, even if their time has not expired.
    camera.position.y += 50;
    expect(frame()).toBeLessThanOrEqual(8);
    // A positive from the previous frame cannot survive removed terrain.
    terrain.remove(mesh);
    expect(frame()).toBe(0);
    bm.dispose(); mesh.geometry.dispose(); mesh.material.dispose();
  });
  it('rejects a newly occluding ridge on the same latitude without reusing a cached positive', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ scale() {}, strokeText() {}, fillText() {} }) }) });
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const body = new Body({ name: 'Ridge', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body); bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1); bm.mesh.visible = false;
    const terrain = new THREE.Group(); const mesh = new THREE.Mesh(new THREE.SphereGeometry(100, 128, 64), new THREE.MeshStandardMaterial());
    terrain.add(mesh); terrain.updateMatrixWorld(true); vi.spyOn(bm, 'terrainTileGroup', 'get').mockReturnValue(terrain);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000); camera.position.set(300, 100, 0); camera.up.set(0, 0, 1); camera.lookAt(0, 0, 0);
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 15 }));
    const manager = { reserveContextRect: () => true } as unknown as LabelManager;
    const rays = vi.spyOn(THREE.Raycaster.prototype, 'intersectObjects');
    const frame = () => { now += 16; rays.mockClear(); bm.updateGrid(camera, { width: 800, height: 800 }, manager);
      expect(rays.mock.calls.length).toBeLessThanOrEqual(8); return bm.gridMetrics!; };
    for (let i = 0; i < 60; i++) frame();
    const equator = frame().annotations.find(a => a.axis === 'latitude' && a.latDeg === 0 && a.lonDeg === 0)!;
    expect(equator).toBeDefined();
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial());
    ridge.position.set(104, 2, 0); terrain.add(ridge); terrain.updateMatrixWorld(true);
    expect(frame().annotations.some(a => a.id === equator.id)).toBe(false);
    terrain.remove(ridge);
    expect(frame().annotations.some(a => a.id === equator.id)).toBe(false);
    for (let i = 0; i < 40; i++) frame();
    expect(frame().anchors.find(a => a.id === equator.id)).toMatchObject({ lat: equator.latDeg, lon: equator.lonDeg });
    bm.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); ridge.geometry.dispose(); ridge.material.dispose();
  });
  it('uses canonical fixed anchors through seam crossings and bounds polar/tiny-step enumeration', () => {
    const body = new Body({ name: 'Seam', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body); bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000); camera.up.set(0, 0, 1);
    bm.showGrid(true, false, normalizeGridSettings({ density: 'manual', spacingDeg: 0.001 }));
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const anchors = new Map<string, readonly [number, number]>();
    for (const eye of [[-300, -1, 0], [-300, 1, 0], [0, 0, 300], [-300, -1, 0]]) {
      camera.position.set(...eye as [number, number, number]); camera.lookAt(0, 0, 0); now += 200;
      bm.updateGrid(camera, { width: 800, height: 800 }, null);
      expect(bm.gridMetrics!.candidates).toBeLessThanOrEqual(96);
      for (const a of bm.gridMetrics!.anchors) {
        expect(a.lon).toBeGreaterThanOrEqual(-180); expect(a.lon).toBeLessThan(180);
        if (a.axis === 'longitude') expect(Math.abs(a.lat)).toBeLessThanOrEqual(70);
        if (anchors.has(a.id)) expect([a.lat, a.lon]).toEqual(anchors.get(a.id)); else anchors.set(a.id, [a.lat, a.lon]);
      }
    }
    bm.dispose();
  });
  it('does not validate GPU-only displaced labels against undisplaced reference triangles', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ scale() {}, strokeText() {}, fillText() {} }) }) });
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const body = new Body({ name: 'GPU displacement', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body); bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000); camera.position.set(300, 0, 0); camera.up.set(0, 0, 1); camera.lookAt(0, 0, 0);
    const material = bm.mesh.material as THREE.MeshStandardMaterial; const texture = new THREE.Texture();
    material.displacementMap = texture; material.displacementScale = 1;
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 15 }));
    const manager = { reserveContextRect: () => true } as unknown as LabelManager;
    const frame = () => { now += 16; bm.updateGrid(camera, { width: 800, height: 800 }, manager); return bm.gridMetrics!; };
    for (let i = 0; i < 30; i++) frame();
    expect(frame().candidates).toBeGreaterThan(0); expect(frame().labels).toBe(0);
    material.displacementMap = null;
    for (let i = 0; i < 30; i++) frame();
    expect(frame().labels).toBeGreaterThan(0);
    bm.dispose(); texture.dispose();
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
