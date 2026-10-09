import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Body, FixedPointTrajectory, bodySurfaceCoordinates, surfacePositionToBodyFixed } from '@cosmolabe/core';
import { BodyMesh } from '../BodyMesh.js';
import { normalizeGridSettings } from '@cosmolabe/control';
import { chooseGridStep, GRID_STEPS, AUTO_GRID_STEPS, annotationPattern, type AdaptiveGraticule } from '../AdaptiveGraticule.js';
import { LabelManager } from '../LabelManager.js';
import { TerrainSampler } from '../TerrainSampler.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('adaptive graticule', () => {
  it('labels one fixed latitude and one fixed longitude ruler', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ scale() {}, strokeText() {}, fillText() {} }) }) });
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const body = new Body({ name: 'Regional rulers', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body); bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const lat = 55 * Math.PI / 180, lon = 2 * Math.PI / 180;
    const radial = new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
    const north = new THREE.Vector3(-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat));
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000);
    camera.position.copy(radial).multiplyScalar(110); camera.up.copy(north); camera.lookAt(radial.clone().multiplyScalar(100));
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 1 }));
    const manager = { reserveContextRect: () => true } as unknown as LabelManager;
    for (let i = 0; i < 40; i++) { now += 16; bm.updateGrid(camera, { width: 800, height: 800 }, manager); }
    const annotations = bm.gridMetrics!.annotations;
    expect(annotations.length).toBeGreaterThan(4);
    expect(new Set(annotations.map(a => a.latDeg)).size).toBeGreaterThan(1);
    expect(new Set(annotations.map(a => a.lonDeg)).size).toBeGreaterThan(1);
    expect(new Set(annotations.map(a => a.axis))).toEqual(new Set(['latitude', 'longitude']));
    expect(annotations.length).toBeLessThanOrEqual(24);
    expect(new Set(annotations.filter(a => a.axis === 'latitude').map(a => a.lonDeg)).size).toBe(1);
    expect(new Set(annotations.filter(a => a.axis === 'longitude').map(a => a.latDeg)).size).toBe(1);
    for (const a of annotations) {
      expect(a.text).not.toContain('·');
      if (a.axis === 'latitude') {
        expect(a.latDeg).toBeCloseTo(Math.round(a.latDeg));
        expect((a.lonDeg - 0.5) / 8).toBeCloseTo(Math.round((a.lonDeg - 0.5) / 8));
        expect(a.text).toMatch(/[NS]$/);
      } else {
        expect((a.latDeg - 0.5) / 8).toBeCloseTo(Math.round((a.latDeg - 0.5) / 8));
        expect(a.lonDeg).toBeCloseTo(Math.round(a.lonDeg));
        expect(a.text).toMatch(/[EW]$/);
      }
    }
    expect(annotationPattern(1, 1)).toMatchObject({ latitudeStride: 1, longitudeStride: 1 });
    expect(annotationPattern(0.1, 0.1)).toMatchObject({ latitudeStride: 0.1, longitudeStride: 0.1 });
    expect(annotationPattern(0.02, 0.02).meridianStride).toBe(0.16);
    expect(annotationPattern(0.001, 0.001).parallelStride).toBe(0.008);
    // UniverseRenderer passes every body as an occluder. A distant body must
    // not put this smooth globe on the old six-label raycast path.
    const otherBody = new Body({ name: 'Distant occluder', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [1, 1, 1], geometryType: 'Globe' });
    const other = new BodyMesh(otherBody); other.updatePosition([0, 1000, 0], 0, 1); other.applyMeshScale(1);
    const rays = vi.spyOn(THREE.Raycaster.prototype, 'intersectObjects');
    for (let i = 0; i < 40; i++) { now += 16; bm.updateGrid(camera, { width: 800, height: 800 }, manager, [bm, other]); }
    expect(bm.gridMetrics!.labels).toBeGreaterThan(4);
    expect(rays).not.toHaveBeenCalled();
    const chosen = bm.gridMetrics!.annotations[0];
    const latRad = chosen.latDeg * Math.PI / 180, lonRad = chosen.lonDeg * Math.PI / 180;
    const site = new THREE.Vector3(100 * Math.cos(latRad) * Math.cos(lonRad), 100 * Math.cos(latRad) * Math.sin(lonRad), 100 * Math.sin(latRad));
    const foreground = camera.position.clone().lerp(site, 0.5);
    other.updatePosition(foreground.toArray() as [number, number, number], 0, 1); other.updateMatrixWorld(true);
    now += 16; bm.updateGrid(camera, { width: 800, height: 800 }, manager, [bm, other]);
    expect(bm.gridMetrics!.annotations.some(a => a.id === chosen.id)).toBe(false);
    expect(rays).toHaveBeenCalled();
    bm.dispose(); other.dispose();
  });

  it('switches whole fixed ruler bands without drawing both carriers together', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ scale() {}, strokeText() {}, fillText() {} }) }) });
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const body = new Body({ name: 'Band switch', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body); bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 1 }));
    const camera = new THREE.PerspectiveCamera(35, 1, 0.001, 1000); camera.up.set(0, 0, 1);
    const manager = { reserveContextRect: () => true } as unknown as LabelManager;
    const pose = (lonDeg: number) => {
      const angle = lonDeg * Math.PI / 180;
      camera.position.set(110 * Math.cos(angle), 110 * Math.sin(angle), 0);
      camera.lookAt(100 * Math.cos(angle), 100 * Math.sin(angle), 0);
      for (let i = 0; i < 40; i++) { now += 16; bm.updateGrid(camera, { width: 800, height: 800 }, manager); }
      const labels = bm.gridMetrics!.annotations.filter(a => a.axis === 'latitude');
      expect(new Set(labels.map(a => a.lonDeg)).size).toBeLessThanOrEqual(1);
      return labels;
    };
    const first = pose(0);
    expect(first.length).toBeGreaterThan(0);
    expect(new Set(first.map(a => a.lonDeg))).toEqual(new Set([0.5]));
    const second = pose(7);
    expect(second.length).toBeGreaterThan(0);
    expect(new Set(second.map(a => a.lonDeg))).toEqual(new Set([8.5]));
    expect(second.some(a => first.some(b => a.id === b.id))).toBe(false);
    const restored = pose(0);
    expect(new Set(restored.map(a => a.lonDeg))).toEqual(new Set([0.5]));
    bm.dispose();
  });

  it('keeps fixed lattice sites under changed search bounds', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ scale() {}, strokeText() {}, fillText() {} }) }) });
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const body = new Body({ name: 'Pattern', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body); bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000); camera.up.set(0, 0, 1);
    const manager = { reserveContextRect: () => true } as unknown as LabelManager;
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 0.1 }));
    const sites = new Map<string, readonly [number, number]>();
    for (const [distance, longitude] of [[300, 0], [110, 0], [101, 0], [101, 0.2], [101, -0.2]]) {
      camera.position.set(distance * Math.cos(longitude), distance * Math.sin(longitude), 0); camera.lookAt(0, 0, 0);
      for (let i = 0; i < 40; i++) {
        now += 16; bm.updateGrid(camera, { width: 800, height: 800 }, manager);
        for (const a of bm.gridMetrics!.anchors) {
          const pattern = annotationPattern(0.1, 0.1);
          const row = a.lat / pattern.latitudeStride, column = a.lon / pattern.longitudeStride;
          if (a.axis === 'latitude') {
            expect(row).toBeCloseTo(Math.round(row), 5);
            expect((column - 0.5) / 8).toBeCloseTo(Math.round((column - 0.5) / 8), 5);
          } else {
            expect((row - 0.5) / 8).toBeCloseTo(Math.round((row - 0.5) / 8), 5);
            expect(column).toBeCloseTo(Math.round(column), 5);
          }
          if (sites.has(a.id)) expect([a.lat, a.lon]).toEqual(sites.get(a.id)); else sites.set(a.id, [a.lat, a.lon]);
        }
        const annotations = bm.gridMetrics!.annotations;
        expect(new Set(annotations.map(a => `${a.axis}:${a.latDeg}:${a.lonDeg}`)).size).toBe(annotations.length);
      }
    }
    const annotations = bm.gridMetrics!.annotations;
    expect(annotations.length).toBeGreaterThan(0);
    const values = [...new Set(annotations.map(a => a.lonDeg))].sort((a, b) => a - b);
    expect(values.length).toBeGreaterThan(1);
    for (let i = 1; i < values.length; i++) expect(values[i] - values[i - 1]).toBeGreaterThan(0.049);
    bm.dispose();
  });

  it('hides a prescribed site for UI collisions without moving it', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ scale() {}, strokeText() {}, fillText() {} }) }) });
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const body = new Body({ name: 'Sparse pattern', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body); bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000); camera.position.set(101, 0, 0); camera.up.set(0, 0, 1); camera.lookAt(100, 0, 0);
    const manager = new LabelManager({} as HTMLElement);
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 0.2 }));
    const frame = () => { now += 16; manager.beginContextAnnotations(); bm.updateGrid(camera, { width: 800, height: 800 }, manager); return bm.gridMetrics!; };
    for (let i = 0; i < 40; i++) frame();
    const original = frame(); expect(original.annotations.length).toBeGreaterThan(0);
    const anchor = original.annotations[0];
    manager.setReservedRects([{ x0: 0, x1: 800, y0: 0, y1: 800 }], 'controls');
    for (let i = 0; i < 50; i++) {
      const hidden = frame(); expect(hidden.labels).toBe(0);
      expect(hidden.anchors).toEqual(original.anchors);
    }
    manager.setReservedRects([], 'controls');
    for (let i = 0; i < 40; i++) frame();
    expect(frame().annotations[0]).toMatchObject({ id: anchor.id, latDeg: anchor.latDeg, lonDeg: anchor.lonDeg });
    camera.lookAt(102, 0, 0);
    for (let i = 0; i < 40; i++) frame();
    expect(frame().labels).toBe(0); // No coverage-filling fallback.
    bm.dispose();
  });

  it('keeps labels visible when the surface enters night', () => {
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
    const day = frame().annotations[0];
    expect(day.opacity).toBeGreaterThan(0.5);
    (bm.mesh.material as THREE.MeshStandardMaterial).color.set('#080808');
    for (let i = 0; i < 40; i++) frame();
    expect(frame().annotations.find(a => a.id === day.id)?.opacity).toBeCloseTo(day.opacity);
    sun.position.set(-5000, 0, 0);
    expect(frame().annotations.find(a => a.id === day.id)?.opacity).toBeCloseTo(day.opacity);
    expect(bm.gridMetrics!.densityBlend).toBe(1);
    ambient.intensity = 1.8;
    for (let i = 0; i < 40; i++) frame();
    expect(frame().annotations.find(a => a.id === day.id)?.opacity).toBeGreaterThan(0.5);
    bm.dispose();
  });

  it('keeps labels independent of lighting in the surface overlay scene', () => {
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
    const lit = frame().annotations[0];
    expect(lit).toBeDefined();
    expect(lit.opacity).toBeGreaterThan(0.2);
    ambient.intensity = 1.8;
    for (let i = 0; i < 40; i++) frame();
    expect(frame().annotations.find(a => a.id === lit.id)?.opacity).toBeCloseTo(lit.opacity);
    overlayAmbient.intensity = 0;
    expect(frame().annotations.find(a => a.id === lit.id)?.opacity).toBeCloseTo(lit.opacity);
    ambient.intensity = 0.015; group.visible = false; overlayAmbient.intensity = 1;
    for (let i = 0; i < 40; i++) frame();
    expect(frame().labels).toBeGreaterThan(0);
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
    expect(bm.gridMetrics!.latitudeStep).toBeLessThanOrEqual(0.1);
    expect(bm.gridMetrics!.longitudeStep).toBeLessThanOrEqual(0.1);
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
    expect(initial.annotations.every(a => !a.text.includes('·'))).toBe(true);
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

  it('introduces separate fixed tiers and retires old line stations', () => {
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
    expect(before.annotations.some(a => Math.abs(a.lonDeg) === 30)).toBe(true);
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 10 }));
    expect(frame().densityBlend).toBe(0);
    const refined = settle();
    expect(refined.annotations.every(a => a.tier === '10:10')).toBe(true);
    expect(refined.anchors.some(a => a.tier === '10:10')).toBe(true);
    for (const a of refined.annotations) {
      const row = a.latDeg / 10, column = a.lonDeg / 10;
      if (a.axis === 'latitude') { expect(row).toBeCloseTo(Math.round(row)); expect((column - 0.5) / 2).toBeCloseTo(Math.round((column - 0.5) / 2)); }
      else { expect((row - 0.5) / 2).toBeCloseTo(Math.round((row - 0.5) / 2)); expect(column).toBeCloseTo(Math.round(column)); }
    }
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 30 }));
    const coarse = settle();
    expect(coarse.annotations.length).toBeGreaterThan(0);
    for (const a of coarse.annotations) {
      expect(a.axis === 'latitude' ? a.latDeg / 30 : a.lonDeg / 30).toBeCloseTo(Math.round(a.axis === 'latitude' ? a.latDeg / 30 : a.lonDeg / 30));
    }
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
    const initial = frame(); const anchor = initial.annotations[0];
    expect(anchor).toBeDefined();
    const p = surfacePositionToBodyFixed({ latDeg: anchor.latDeg, lonDeg: anchor.lonDeg }, bodySurfaceCoordinates(body)!);
    const screen = new THREE.Vector3(p.xKm, p.yKm, p.zKm).project(camera); const x = (screen.x + 1) * 400, y = (1 - screen.y) * 400;
    manager.setReservedRects([{ x0: x - 120, x1: x + 120, y0: y - 50, y1: y + 50 }], 'controls');
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
      expect(new Set(annotations.map(a => `${a.axis}:${a.latDeg}:${a.lonDeg}`)).size).toBe(annotations.length);
      return bm.gridMetrics!.labels;
    };
    for (let i = 0; i < 20; i++) frame();
    const settled = bm.gridMetrics!.labels;
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
    const anchor = frame().annotations[0];
    expect(anchor).toBeDefined();
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial());
    const anchorPoint = surfacePositionToBodyFixed({ latDeg: anchor.latDeg, lonDeg: anchor.lonDeg }, bodySurfaceCoordinates(body)!);
    ridge.position.set(anchorPoint.xKm, anchorPoint.yKm, anchorPoint.zKm).lerp(camera.position, 0.02); terrain.add(ridge); terrain.updateMatrixWorld(true);
    expect(frame().annotations.some(a => a.id === anchor.id)).toBe(false);
    terrain.remove(ridge);
    expect(frame().annotations.some(a => a.id === anchor.id)).toBe(false);
    for (let i = 0; i < 40; i++) frame();
    expect(frame().anchors.find(a => a.id === anchor.id)).toMatchObject({ lat: anchor.latDeg, lon: anchor.lonDeg });
    bm.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); ridge.geometry.dispose(); ridge.material.dispose();
  });
  it('retires obsolete lattice sites during a manual non-nested transition', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ scale() {}, strokeText() {}, fillText() {} }) }) });
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const body = new Body({ name: 'Carriers', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body); bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000); camera.up.set(0, 0, 1); camera.position.set(0, 300, 0); camera.lookAt(0, 0, 0);
    const manager = { reserveContextRect: () => true } as unknown as LabelManager;
    const settle = () => { for (let i = 0; i < 40; i++) { now += 16; bm.updateGrid(camera, { width: 800, height: 800 }, manager); } return bm.gridMetrics!; };
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 15 }));
    const old = settle().annotations.find(a => a.latDeg % 10 !== 0 || a.lonDeg % 10 !== 0)!;
    expect(old).toBeDefined();
    bm.showGrid(true, true, normalizeGridSettings({ density: 'manual', spacingDeg: 10 }));
    expect(settle().annotations.some(a => a.id === old.id)).toBe(false);
    bm.dispose();
  });

  it('uses a nested automatic hierarchy and restores the globe lattice on zoom out', () => {
    for (let i = 1; i < AUTO_GRID_STEPS.length; i++) expect(AUTO_GRID_STEPS[i - 1] / AUTO_GRID_STEPS[i]).toBeCloseTo(Math.round(AUTO_GRID_STEPS[i - 1] / AUTO_GRID_STEPS[i]));
    expect(chooseGridStep(10, 15)).not.toBe(15); // Manual-only nice steps do not persist in Auto.
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ scale() {}, strokeText() {}, fillText() {} }) }) });
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const body = new Body({ name: 'Hierarchy', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body); bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000); camera.up.set(0, 0, 1);
    const manager = { reserveContextRect: () => true } as unknown as LabelManager;
    bm.showGrid(true, true, normalizeGridSettings());
    const pose = (distance: number) => { camera.position.set(distance, 0, 0); camera.lookAt(100, 0, 0);
      for (let i = 0; i < 40; i++) { now += 16; bm.updateGrid(camera, { width: 800, height: 800 }, manager); } return bm.gridMetrics!; };
    const globe = pose(300);
    expect([globe.latitudeStep, globe.longitudeStep]).toEqual([30, 30]);
    expect(globe.annotations.length).toBeGreaterThan(0);
    for (const a of globe.annotations) {
      expect(a.axis === 'latitude' ? a.latDeg / 30 : a.lonDeg / 30).toBeCloseTo(Math.round(a.axis === 'latitude' ? a.latDeg / 30 : a.lonDeg / 30));
    }
    expect(pose(146).latitudeStep).toBe(30);
    expect(pose(144).latitudeStep).toBeLessThan(30);
    expect(pose(130).latitudeStep).toBe(10);
    expect(pose(115).latitudeStep).toBe(5);
    const grid = (bm as unknown as { graticule: AdaptiveGraticule }).graticule;
    expect(grid.uniforms.uGridDetailStep.value.x).toBe(2.5);
    expect(pose(151).latitudeStep).toBeLessThan(30);
    expect(pose(161).latitudeStep).toBe(30);
    expect(pose(101).latitudeStep).toBeLessThan(1);
    const restored = pose(300);
    expect([restored.latitudeStep, restored.longitudeStep]).toEqual([30, 30]);
    expect(restored.annotations.map(a => [a.latDeg, a.lonDeg]).sort()).toEqual(globe.annotations.map(a => [a.latDeg, a.lonDeg]).sort());
    bm.dispose();
  });

  it('refines both axes and unlabelled detail during fixed-altitude FOV zoom, then restores the globe rulers', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ scale() {}, strokeText() {}, fillText() {} }) }) });
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const body = new Body({ name: 'Optical', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body); bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.001, 1000); camera.up.set(0, 0, 1);
    camera.position.set(300, 0, 0); camera.lookAt(100, 0, 0);
    bm.showGrid(true, true, normalizeGridSettings());
    const manager = { reserveContextRect: () => true } as unknown as LabelManager;
    const zoom = (fov: number) => { camera.fov = fov; camera.updateProjectionMatrix();
      for (let i = 0; i < 40; i++) { now += 16; bm.updateGrid(camera, { width: 800, height: 800 }, manager); } return bm.gridMetrics!; };
    const globe = zoom(60);
    const originalSites = globe.annotations.map(a => [a.latDeg, a.lonDeg]).sort();
    expect(originalSites.length).toBeGreaterThan(0);
    expect([globe.latitudeStep, globe.longitudeStep]).toEqual([30, 30]);
    const region = zoom(10);
    expect(region.latitudeStep).toBeLessThan(30); expect(region.longitudeStep).toBeLessThan(30);
    const close = zoom(1);
    expect(close.latitudeStep).toBeLessThanOrEqual(1); expect(close.longitudeStep).toBeLessThanOrEqual(1);
    const grid = (bm as unknown as { graticule: AdaptiveGraticule }).graticule;
    expect(grid.uniforms.uGridDetailStep.value.x).toBeLessThan(close.latitudeStep);
    expect(grid.uniforms.uGridDetailStep.value.y).toBeLessThan(close.longitudeStep);
    expect(grid.uniforms.uGridHierarchy.value).toBe(1);
    expect(camera.position.toArray()).toEqual([300, 0, 0]);
    // At this altitude the exit/entry diameters correspond to about 17.5°/20.6°.
    zoom(60); expect(zoom(18).latitudeStep).toBe(30);
    expect(zoom(17).latitudeStep).toBeLessThan(30);
    expect(zoom(19).latitudeStep).toBeLessThan(30);
    expect(zoom(21).latitudeStep).toBe(30);
    const restored = zoom(60);
    expect([restored.latitudeStep, restored.longitudeStep]).toEqual([30, 30]);
    expect(restored.annotations.map(a => [a.latDeg, a.lonDeg]).sort()).toEqual(originalSites);
    bm.dispose();
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
      expect(bm.gridMetrics!.candidates).toBeLessThanOrEqual(384);
      for (const a of bm.gridMetrics!.anchors) {
        expect(a.lon).toBeGreaterThanOrEqual(-180); expect(a.lon).toBeLessThan(180);
        expect(Math.abs(a.lat)).toBeLessThan(85);
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
    expect(chooseGridStep(10, 10, 100)).toBe(10);
    expect(chooseGridStep(11, 10, 100)).toBe(10);
    expect(chooseGridStep(10, 30, 100)).toBe(10);
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
    expect(bm.gridMetrics!.candidates).toBeLessThanOrEqual(384);
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
