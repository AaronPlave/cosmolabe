import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Universe } from '@cosmolabe/core';
import { BodyMesh } from '../BodyMesh.js';
import { SurfaceTileOverlay } from '../SurfaceTileOverlay.js';
import { siteMeshPlacement, type SiteMeshConfig } from '../SiteMeshPlacement.js';

/** A second, synthetic site at +X, with source axes east/north/up in metres.
 * This intentionally differs from Dingo Gap's north/east/down convention. */
const fixture = (): SiteMeshConfig => ({
  name: 'Synthetic east-facing site', url: 'https://example.invalid/pinned-v1/tileset.json', sourceVersion: 'synthetic-v1',
  registration: { version: 'synthetic-transform-v1', bodyFixedFrame: 'TEST_BODY_FIXED', status: 'controlled',
    bodyFixedKmFromLocalMeters: [0, .001, 0, 0, 0, 0, .001, 0, .001, 0, 0, 0, 100, 0, 0, 1],
    provenance: 'Synthetic numerical fixture; no mission or physical-accuracy claim', uncertaintyKm: 0 },
  coverage: { min: [-10, -20, -1], max: [10, 20, 3] },
  physicalQueryPolicy: 'visual-only', overlapPolicy: 'composite', priority: 7,
});

describe('fixed mission-site reconstruction placement', () => {
  it('accepts declared non-SPICE body axes and rejects absent or incompatible frames', () => {
    for (const frame of [undefined, 'WRONG_FRAME', 'TEST_BODY_FIXED']) {
      const u = new Universe();
      u.loadCatalog({ items: [{ name: 'Synthetic', trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
        rotationModel: { type: 'Fixed', quaternion: [1, 0, 0, 0], inertialFrame: 'ECLIPJ2000', bodyFixedFrame: frame },
        geometry: { type: 'Globe', radius: 100 } }] });
      const bm = new BodyMesh(u.getBody('Synthetic')!);
      if (frame === 'TEST_BODY_FIXED') {
        const overlay = bm.addSurfaceTiles(fixture());
        expect(overlay.registration.bodyFixedFrame).toBe(frame);
        overlay.dispose();
      } else expect(() => bm.addSurfaceTiles(fixture())).toThrow(/matching explicit body-fixed rotation/);
      bm.dispose();
    }
  });
  it('preserves the original mission inputs and publishes the audited fixed transform', () => {
    const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
    const current = json('../../../../apps/viewer/test-catalogs/msl-dingo-gap.json');
    const localized = json('../../../../apps/viewer/test-catalogs/msl-dingo-gap-localized.json');
    expect(localized.spiceKernels.at(-1)).toContain('msl_surf_rover_loc_');
    expect(localized.items.find((i: any) => i.name === 'Mars').geometry).toEqual(current.items.find((i: any) => i.name === 'Mars').geometry);
    expect(localized.displayNote).toContain('Orbital-localized');
    const previous = json('../../../../docs/validation/curiosity-gale/previous-catalog.json');
    const audit = json('../../../../docs/validation/curiosity-gale/source-registration.json');
    expect(current.spiceKernels).toEqual(previous.spiceKernels);
    expect(current.defaultTime).toBe(previous.defaultTime);
    const rover = (catalog: any) => catalog.items.find((item: any) => item.name === 'Mars').items[0];
    expect(rover(current).trajectory).toEqual(rover(previous).trajectory);
    expect(rover(current).rotationModel).toEqual(rover(previous).rotationModel);
    expect(rover(current).trajectoryFrame).toEqual(rover(previous).trajectoryFrame);
    expect(rover(current).geometry).toEqual(rover(previous).geometry);
    const mars = current.items.find((item: any) => item.name === 'Mars');
    expect(mars.geometry.surfaceTiles[0].registration).toEqual(audit.registration);
    expect(mars.geometry.imagery.map((layer: any) => layer.id)).toEqual(['viking', 'gale-ctx', 'curiosity-hirise']);
  });

  it('recovers prepared failures without dereferencing unprocessed descendants after eviction', () => {
    const overlay = new SurfaceTileOverlay(fixture());
    const prepared = { internal: { loadingState: -1 } }, unprocessed = {};
    const stats = (overlay.tiles as unknown as { stats: { failed: number } }).stats;
    stats.failed = 1;
    const traverse = vi.spyOn(overlay.tiles, 'traverse').mockImplementation(before => {
      before?.(prepared, {}, 0); before?.(unprocessed, prepared, 1);
    });
    expect(() => overlay.retryFailed()).not.toThrow();
    expect(prepared.internal.loadingState).toBe(0);
    expect(stats.failed).toBe(0);
    expect(overlay.tiles.traverse).toBe(traverse);
    traverse.mockRestore(); overlay.dispose();
  });

  it('maps source axes, metres and body origin exactly once for a second site', () => {
    const mat = siteMeshPlacement(fixture());
    expect(new THREE.Vector3(10, 20, 3).applyMatrix4(mat).distanceTo(new THREE.Vector3(100.003, .020, -.010))).toBeLessThan(1e-12);
  });

  it('rejects implicit units, shear, reflections, invalid coverage and unimplemented physical authority', () => {
    for (const change of [
      (c: SiteMeshConfig) => { c.registration.bodyFixedKmFromLocalMeters[1] = 1; },
      (c: SiteMeshConfig) => { c.registration.bodyFixedKmFromLocalMeters[0] = .0001; },
      (c: SiteMeshConfig) => { c.registration.bodyFixedKmFromLocalMeters[1] = -.001; },
      (c: SiteMeshConfig) => { c.coverage.max[0] = -11; },
      (c: SiteMeshConfig) => { c.registration.uncertaintyKm = NaN; },
      (c: SiteMeshConfig) => { (c as unknown as { physicalQueryPolicy: string }).physicalQueryPolicy = 'authoritative'; },
    ]) {
      const c = fixture(); change(c); expect(() => siteMeshPlacement(c)).toThrow(/Site mesh/);
    }
  });

  it('keeps the source transform stationary through CRR, camera movement, recovery and LOD updates', () => {
    const config = fixture(), overlay = new SurfaceTileOverlay(config);
    const fixed = overlay.tiles.group.matrix.clone();
    const reset = vi.spyOn(overlay.tiles, 'resetFailedTiles').mockImplementation(() => {});
    const update = vi.spyOn(overlay.tiles, 'update').mockImplementation(() => {});
    vi.spyOn(overlay.tiles, 'setResolutionFromRenderer').mockImplementation(() => true);
    const body = new THREE.Vector3(100, 200, 300), rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .8);
    for (const cam of [new THREE.Vector3(100, 210, 300), new THREE.Vector3(50, 20, -30)]) {
      overlay.setCameraRelativeTransform(body, rotation, .001, cam);
      const point = new THREE.Vector3(1, 2, 3).applyMatrix4(overlay.tiles.group.matrixWorld);
      const expected = new THREE.Vector3(1, 2, 3).applyMatrix4(fixed).applyQuaternion(rotation).multiplyScalar(.001).add(body).sub(cam);
      expect(point.distanceTo(expected)).toBeLessThan(1e-12);
      const center = overlay.ecefPositionKm.clone().applyQuaternion(rotation).multiplyScalar(.001).add(body);
      expect(overlay.distanceTo(cam, body, rotation, .001)).toBeCloseTo(cam.distanceTo(center), 12);
      overlay.retryFailed();
      overlay.update(new THREE.PerspectiveCamera(), {} as THREE.WebGLRenderer);
      expect(overlay.tiles.group.matrix.equals(fixed)).toBe(true);
    }
    expect(reset).toHaveBeenCalledTimes(2); expect(update).toHaveBeenCalledTimes(2);
    expect(overlay.physicalQueryPolicy).toBe('visual-only'); expect(overlay.group.renderOrder).toBe(7);
    overlay.dispose(); overlay.retryFailed(); expect(reset).toHaveBeenCalledTimes(2);
  });

  it('restores the camera even when streaming setup throws and hides far-side composites', () => {
    const overlay = new SurfaceTileOverlay(fixture());
    const camera = new THREE.PerspectiveCamera(45, 1, .002, 1000);
    vi.spyOn(overlay.tiles, 'setResolutionFromRenderer').mockImplementation(() => { throw new Error('context unavailable'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    overlay.update(camera, {} as THREE.WebGLRenderer);
    expect(camera.near).toBe(.002); expect(camera.far).toBe(1000);
    expect(overlay.visibleFrom(new THREE.Vector3(-200, 0, 0), new THREE.Vector3(), new THREE.Quaternion(), 1)).toBe(false);
    expect(overlay.visibleFrom(new THREE.Vector3(200, 0, 0), new THREE.Vector3(), new THREE.Quaternion(), 1)).toBe(true);
    error.mockRestore(); overlay.dispose();
  });

  it('loads two independent sites with explicit uncertainty and fixed Dingo Gap NED axes', () => {
    const catalog = JSON.parse(readFileSync(new URL('../../../../apps/viewer/test-catalogs/msl-dingo-gap.json', import.meta.url), 'utf8'));
    const config = catalog.items.find((i: { name: string }) => i.name === 'Mars').geometry.surfaceTiles[0] as SiteMeshConfig;
    const a = new SurfaceTileOverlay(config), b = new SurfaceTileOverlay(fixture());
    expect(a.registration.status).toBe('estimated'); expect(a.registration.uncertaintyKm).toBeNull();
    expect(config.url).toContain(`/${config.sourceVersion}/`);
    const mat = a.tiles.group.matrix;
    const origin = new THREE.Vector3().applyMatrix4(mat);
    const down = new THREE.Vector3(0, 0, 1).applyMatrix4(mat).sub(origin);
    expect(down.dot(origin)).toBeLessThan(0);
    b.retryFailed(); expect(a.tiles.group.matrix.equals(mat)).toBe(true);
    a.dispose(); b.dispose();
  });
});
