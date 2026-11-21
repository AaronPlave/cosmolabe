import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Universe } from '@cosmolabe/core';
import { BodyMesh } from '../BodyMesh.js';
import { UniverseRenderer } from '../UniverseRenderer.js';

/**
 * The renderer's side of the physical-Sun contract (#204), exercised on a
 * prototype stub as UniverseRenderer.backing-store.test does: no GL context.
 */
const SCALE = 1e-6;
const body = (x: number, y: number, z: number, radiusKm: number, terrain = true, geometryData: Record<string, unknown> = {}) => ({
  body: { geometryData },
  position: new THREE.Vector3(x, y, z), displayRadius: radiusKm, hasTerrain: terrain, hasSurfaceTiles: false,
  present: true, visible: true, bodyToWorld: new THREE.Quaternion(),
  bodyToWorldQuaternion(out: THREE.Quaternion) { return out.copy(this.bodyToWorld); },
  lightingMode: 'natural' as string,
  setSurfaceLightingMode(mode: string) { this.lightingMode = mode; },
});

function harness(bodies: Record<string, ReturnType<typeof body>>, cameraPos: THREE.Vector3) {
  const light = new THREE.DirectionalLight(0xffffff, 2);
  const ambient = new THREE.AmbientLight(0x080808);
  const state = Object.assign(Object.create(UniverseRenderer.prototype), {
    bodyMeshes: new Map(Object.entries(bodies)),
    camera: { position: cameraPos },
    scaleFactor: SCALE,
    sunLight: light,
    ambientLight: ambient,
    _lightingMode: 'natural',
    _illumCandidates: [],
  }) as unknown as {
    updateSunLightAndShadow(sun: unknown): void;
    setLightingMode(mode: 'natural' | 'shadow' | 'flood'): void;
    solarGeometryAt(name: string, lat: number, lon: number): { elevationDeg: number } | null;
    directSolarTermAt(name: string, lat: number, lon: number, normal?: { east: number; north: number; up: number }):
      { directTerm: number; mode: string; physical: boolean; cosIncidence: number } | null;
  };
  return { state, light, ambient, bodies };
}

const travelDirection = (light: THREE.DirectionalLight) =>
  light.target.position.clone().sub(light.position).normalize();

describe('UniverseRenderer physical Sun illumination (#204)', () => {
  const AU = 1.496e8 * SCALE;
  const sun = body(0, 0, 0, 695700, false);

  it('aims the shared Sun light at the streamed surface being viewed, not the scene origin', () => {
    // Scene origin is the Earth (0,0,0 — the camera's origin body); the camera is at a
    // Mars-like body 1.5 AU away that has streamed terrain.
    const sunB = body(0, AU, 0, 695700, false);
    const earth = body(0, 0, 0, 6371, false);
    const mars = body(1.5 * AU, 0, 0, 3389.5, true);
    const { state, light } = harness({ Sun: sunB, Earth: earth, Mars: mars }, new THREE.Vector3(1.5 * AU, 0, 3600 * SCALE));
    state.updateSunLightAndShadow(sunB);
    const toSunFromMars = sunB.position.clone().sub(mars.position).normalize();
    expect(travelDirection(light).dot(toSunFromMars)).toBeCloseTo(-1, 10);
    // The Sun direction from the origin differs by tens of degrees: that was the bug.
    expect(toSunFromMars.angleTo(new THREE.Vector3(0, 1, 0))).toBeGreaterThan(0.5);
  });

  it('keeps the origin aim when no streamed surface is near the camera', () => {
    const sunB = body(AU, 0, 0, 695700, false);
    const earth = body(0, 0, 0, 6371, false);
    const { state, light } = harness({ Sun: sunB, Earth: earth }, new THREE.Vector3(0, 0, 100));
    state.updateSunLightAndShadow(sunB);
    expect(light.target.position.toArray()).toEqual([0, 0, 0]);
    expect(light.position.toArray()).toEqual(sunB.position.toArray());
  });

  it('keeps the legacy origin aim for a streamed body far from the camera', () => {
    const sunB = body(AU, 0, 0, 695700, false);
    const moon = body(300, 0, 0, 1737.4, true);
    const { state, light } = harness({ Sun: sunB, Moon: moon }, new THREE.Vector3(0, 0, 1e4));
    state.updateSunLightAndShadow(sunB);
    expect(light.target.position.toArray()).toEqual([0, 0, 0]);
  });

  it('follows a moving Sun and the time seek on the next update, with no stale direction', () => {
    const moon = body(0, 0, 0, 1737.4, true);
    const { state, light } = harness({ Sun: sun, Moon: moon }, new THREE.Vector3(0, 0, 2000 * SCALE));
    const dirs: THREE.Vector3[] = [];
    for (const angle of [0, 40, 100, 40]) {
      sun.position.set(AU * Math.cos(angle * Math.PI / 180), AU * Math.sin(angle * Math.PI / 180), 0);
      state.updateSunLightAndShadow(sun);
      dirs.push(travelDirection(light).negate());
    }
    expect(dirs[1].angleTo(dirs[0])).toBeCloseTo(40 * Math.PI / 180, 8);
    expect(dirs[2].angleTo(dirs[0])).toBeCloseTo(100 * Math.PI / 180, 8);
    expect(dirs[3].distanceTo(dirs[1])).toBeLessThan(1e-12); // seek back: identical
  });

  it('still aims at a shadow caster when one is flagged, as before', () => {
    const sunB = body(AU, 0, 0, 695700, false);
    const moon = body(0, 0, 0, 1737.4, true);
    const lander = body(0, 0, 1737.4 * SCALE, 0.001, false, { castShadow: true });
    const { state, light } = harness({ Sun: sunB, Moon: moon, Lander: lander }, new THREE.Vector3(0, 0, 2000 * SCALE));
    state.updateSunLightAndShadow(sunB);
    expect(light.castShadow).toBe(true);
    expect(light.target.position.toArray()).toEqual(lander.position.toArray());
  });

  it('reports Sun elevation at a surface point on a rotating body', () => {
    const moon = body(0, 0, 0, 1737.4, true);
    const sunB = body(AU, 0, 0, 695700, false);
    const { state } = harness({ Sun: sunB, Moon: moon }, new THREE.Vector3(0, 0, 2000 * SCALE));
    expect(state.solarGeometryAt('Moon', 0, 0)!.elevationDeg).toBeCloseTo(90, 5);
    moon.bodyToWorld.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    expect(state.solarGeometryAt('Moon', 0, 0)!.elevationDeg).toBeCloseTo(0, 2);
    expect(state.solarGeometryAt('Nowhere', 0, 0)).toBeNull();
  });

  it('reports the unshadowed direct term at ridge-facing and ridge-away receivers, independent of the camera', () => {
    // Moon-like body; observer at lat 0 lon 0 (up=+X, east=+Y).
    const moon = body(0, 0, 0, 1737.4, true);
    const el = 15 * Math.PI / 180;
    const sunB = body(0, 0, 0, 695700, false);
    // Observer at lat 0 lon 0 has up=+X: put the Sun at elevation 15° toward east (+Y).
    sunB.position.set(AU * Math.sin(el), AU * Math.cos(el), 0);
    const { state } = harness({ Sun: sunB, Moon: moon }, new THREE.Vector3(0, 0, 2000 * SCALE));
    const facing = state.directSolarTermAt('Moon', 0, 0, { east: Math.sin(25 * Math.PI / 180), north: 0, up: Math.cos(25 * Math.PI / 180) })!;
    const away = state.directSolarTermAt('Moon', 0, 0, { east: -Math.sin(25 * Math.PI / 180), north: 0, up: Math.cos(25 * Math.PI / 180) })!;
    expect(facing.mode).toBe('natural');
    expect(facing.physical).toBe(true);
    expect(facing.directTerm).toBeCloseTo(2 * Math.cos((90 - 15 - 25) * Math.PI / 180), 4);
    // The Sun is up globally (elevation +15°) but the receiver's own incidence is negative.
    expect(state.solarGeometryAt('Moon', 0, 0)!.elevationDeg).toBeGreaterThan(14);
    expect(away.directTerm).toBe(0);
    // Camera position is irrelevant to the receiver term.
    const other = harness({ Sun: sunB, Moon: moon }, new THREE.Vector3(5, 5, 5)).state;
    expect(other.directSolarTermAt('Moon', 0, 0)!.directTerm).toBeCloseTo(state.directSolarTermAt('Moon', 0, 0)!.directTerm, 12);
  });

  it('has no direct term in flood and a nonphysical shadow mode', () => {
    const moon = body(0, 0, 0, 1737.4, true);
    const sunB = body(AU, 0, 0, 695700, false);
    const { state } = harness({ Sun: sunB, Moon: moon }, new THREE.Vector3(0, 0, 2000 * SCALE));
    state.setLightingMode('flood');
    const flood = state.directSolarTermAt('Moon', 0, 0)!;
    expect(flood.directTerm).toBe(0);
    expect(flood.physical).toBe(false);
    expect(moon.lightingMode).toBe('flood'); // streamed terrain learns the mode for baked imagery's night floor
    state.setLightingMode('shadow');
    expect(state.directSolarTermAt('Moon', 0, 0)!.physical).toBe(false);
    expect(moon.lightingMode).toBe('shadow');
  });

  describe('on a real Globe BodyMesh (mesh.quaternion is not the body-fixed frame)', () => {
    const globe = () => {
      const u = new Universe();
      u.loadCatalog({ items: [{ name: 'Rock', trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
        geometry: { type: 'Globe', radius: 1737.4 } }] });
      return new BodyMesh(u.getBody('Rock')!);
    };
    const withSun = (bm: BodyMesh, sunPos: THREE.Vector3) => harness(
      { Sun: Object.assign(body(0, 0, 0, 695700, false), { position: sunPos }), Rock: bm as never },
      new THREE.Vector3(0, 0, 2000 * SCALE)).state;

    it('keeps the globe\'s own pole (world +Y) for a body with no rotation model', () => {
      const bm = globe();
      const state = withSun(bm, new THREE.Vector3(0, AU, 0));
      // The pole points at the Sun: elevation 90° there, and the equator is on the terminator.
      expect(state.solarGeometryAt('Rock', 90, 0)!.elevationDeg).toBeCloseTo(90, 4);
      expect(state.solarGeometryAt('Rock', 0, 0)!.elevationDeg).toBeCloseTo(0, 2);
      // Contrast: the mesh quaternion carries the geometry's X-90° rotation, so using it
      // (the earlier behaviour) put the pole on world +Z instead.
      expect(bm.mesh.quaternion.angleTo(bm.bodyToWorldQuaternion(new THREE.Quaternion()))).toBeGreaterThan(1);
      bm.dispose();
    });

    it('follows a rotation applied to the mesh the way BodyMesh.update composes it', () => {
      const bm = globe();
      // update(): mesh.quaternion = bodyToWorld × meshRotationQ. Rotate body-fixed Z (the pole) to world +X.
      const bodyToWorld = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
      bm.mesh.quaternion.multiplyQuaternions(bodyToWorld, bm.meshRotationQ);
      const state = withSun(bm, new THREE.Vector3(AU, 0, 0));
      expect(state.solarGeometryAt('Rock', 90, 0)!.elevationDeg).toBeCloseTo(90, 4);
      expect(state.directSolarTermAt('Rock', 90, 0)!.directTerm).toBeCloseTo(2, 4);
      // Spinning about the pole moves the Sun across the equator: lon 0 now faces world +Y.
      const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
      bm.mesh.quaternion.multiplyQuaternions(spin.multiply(bodyToWorld), bm.meshRotationQ);
      expect(state.solarGeometryAt('Rock', 0, 0)!.elevationDeg).toBeCloseTo(0, 2);
      bm.dispose();
    });
  });

  it('applies one lighting-mode definition: flood switches the Sun off, natural restores it', () => {
    const { state, light, ambient } = harness({}, new THREE.Vector3());
    state.setLightingMode('flood');
    expect(light.intensity).toBe(0);
    expect(ambient.color.getHex()).toBe(0xffffff);
    state.setLightingMode('shadow');
    expect(light.intensity).toBe(1.5);
    state.setLightingMode('natural');
    expect(light.intensity).toBe(2);
    expect(ambient.color.getHex()).toBe(0x080808);
  });
});

describe('UniverseRenderer terrain-shadow summary for the viewer (#205)', () => {
  const status = (state: string, unknown: number[], coarse = 0) => ({ state, levels: unknown.map(u => ({ unknownFraction: u, coarseFraction: coarse })) });
  const shadowBody = (support: { supported: boolean; mode: string; bakedOnly?: boolean } | null, s: ReturnType<typeof status> | null = null) =>
    ({ ...body(0, 0, 0, 1737.4), solarShadowSupport: support && { bakedOnly: false, ...support }, solarShadowStatus: s });
  const summarize = (bodies: Record<string, ReturnType<typeof shadowBody>>) => {
    const state = Object.assign(Object.create(UniverseRenderer.prototype), { bodyMeshes: new Map(Object.entries(bodies)) }) as unknown as {
      terrainShadowSummary(): { mode: string; state: string | null; unknownFraction: number; coarseFraction: number; bakedOnly: boolean } | null;
    };
    return state.terrainShadowSummary();
  };

  it('is null (no viewer control) when no body has terrain a shadow can be built from', () => {
    expect(summarize({ Moon: shadowBody(null), Earth: shadowBody({ supported: false, mode: 'off' }) })).toBeNull();
  });

  it('offers the control on supported terrain even when the catalog configured nothing (mode off, no clipmap)', () => {
    expect(summarize({ Moon: shadowBody({ supported: true, mode: 'off' }) })).toEqual({ mode: 'off', state: null, unknownFraction: 0, coarseFraction: 0, bakedOnly: false });
  });

  it('reports the highest mode, the least-finished clipmap state and the largest unknown fraction', () => {
    expect(summarize({
      Moon: shadowBody({ supported: true, mode: 'medium' }, status('ready', [0, 0, 0])),
      Mars: shadowBody({ supported: true, mode: 'high' }, status('partial', [0, 0.1, 0.25], 0.4)),
    })).toEqual({ mode: 'high', state: 'partial', unknownFraction: 0.25, coarseFraction: 0.4, bakedOnly: false });
    expect(summarize({
      Moon: shadowBody({ supported: true, mode: 'low' }, status('building', [1, 1, 1])),
      Mars: shadowBody({ supported: true, mode: 'low' }, status('ready', [0, 0, 0])),
    })?.state).toBe('building');
  });

  it('says when every supported surface is drawn from baked imagery', () => {
    expect(summarize({ Moon: shadowBody({ supported: true, mode: 'high', bakedOnly: true }), Mars: shadowBody({ supported: true, mode: 'high', bakedOnly: true }) })?.bakedOnly).toBe(true);
    expect(summarize({ Moon: shadowBody({ supported: true, mode: 'high', bakedOnly: true }), Mars: shadowBody({ supported: true, mode: 'high', bakedOnly: false }) })?.bakedOnly).toBe(false);
  });

  it('ignores the clipmap of a body whose shadows the viewer turned off', () => {
    expect(summarize({ Moon: shadowBody({ supported: true, mode: 'off' }, status('ready', [0.5])) })).toEqual({ mode: 'off', state: null, unknownFraction: 0, coarseFraction: 0, bakedOnly: false });
  });
});
