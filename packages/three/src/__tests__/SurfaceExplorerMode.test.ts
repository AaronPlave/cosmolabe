import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { BodyMesh } from '../BodyMesh.js';
import type { CameraModeContext } from '../controls/CameraModes.js';
import { SurfaceExplorerMode } from '../controls/modes/SurfaceExplorerMode.js';

describe('SurfaceExplorerMode orbit pivot', () => {
  it('uses the exact rendered hit instead of reconstructing from sampled altitude', () => {
    const mode = new SurfaceExplorerMode();
    const body = {
      position: new THREE.Vector3(),
      mesh: { quaternion: new THREE.Quaternion() },
    } as unknown as BodyMesh;
    let pickedNdc: [number, number] | null = null;
    const ctx = {
      camera: new THREE.PerspectiveCamera(),
      controls: {
        domElement: {
          getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }),
        },
      },
      bodyMeshes: new Map([['Mars', body]]),
      scaleFactor: 1e-6,
      markerScene: new THREE.Scene(),
      pickSurface: (x: number, y: number) => {
        pickedNdc = [x, y];
        return {
          bodyName: 'Mars',
          latDeg: 45,
          lonDeg: 90,
          // Deliberately incompatible with the exact point: using these
          // sampled coordinates would put the pivot somewhere else entirely.
          altKm: 999,
          bodyFixedHitKm: [100, 200, 300] as const,
        };
      },
    } as unknown as CameraModeContext;
    const testMode = mode as unknown as {
      bodyName: string;
      pivotBodyFixed: THREE.Vector3;
      initOrbitPivot(clientX: number, clientY: number, ctx: CameraModeContext): void;
      disposePivotDot(): void;
    };
    testMode.bodyName = 'Mars';

    testMode.initOrbitPivot(60, 95, ctx);

    expect(pickedNdc).toEqual([-0.5, -0.5]);
    expect(testMode.pivotBodyFixed.toArray()).toEqual([100, 300, -200]);
    testMode.disposePivotDot();
  });
});

describe('SurfaceExplorerMode near the lunar south pole', () => {
  const R = 1737.4;
  const DEG = Math.PI / 180;

  function setup(terrainKm: number | null = 0) {
    const body = {
      position: new THREE.Vector3(),
      mesh: { quaternion: new THREE.Quaternion() },
      body: { radii: [R, R, R] },
      sampleTerrainElevation: () => (terrainKm == null ? null : { elevationKm: terrainKm }),
    } as unknown as BodyMesh;
    const ctx = {
      camera: new THREE.PerspectiveCamera(),
      controls: { domElement: null },
      bodyMeshes: new Map([['Moon', body]]),
      scaleFactor: 1,
      et: 0,
      dt: 1 / 60,
    } as unknown as CameraModeContext;
    const mode = new SurfaceExplorerMode();
    mode.activate(ctx, { bodyName: 'Moon', latDeg: -89.9, lonDeg: 0, altKm: 0.05 });
    const m = mode as unknown as {
      keys: Set<string>; latRad: number; lonRad: number; altKm: number; heading: number; pitch: number;
      rightDragging: boolean; hasPivot: boolean;
      dolly(stepKm: number, ctx: CameraModeContext): void;
    };
    return { mode, ctx, m };
  }

  it('puts the camera at the requested geodetic point with geodetic up', () => {
    const { ctx } = setup();
    const p = ctx.camera.position;
    // Geometry Y-up: body-fixed z → y.
    expect(Math.asin(p.y / p.length()) / DEG).toBeCloseTo(-89.9, 9);
    expect(p.length()).toBeCloseTo(R + 0.05, 9);
    expect(ctx.camera.up.angleTo(p)).toBeLessThan(1e-9);
  });

  it('drives over the pole with W without jumps, and keeps going straight', () => {
    const { mode, ctx, m } = setup();
    m.heading = Math.PI; // due south, toward the pole ~3 km ahead
    m.keys.add('KeyW');
    let prev = ctx.camera.position.clone();
    let maxStep = 0;
    for (let i = 0; i < 3000; i++) {
      mode.update(ctx);
      const step = ctx.camera.position.distanceTo(prev);
      maxStep = Math.max(maxStep, step);
      prev = ctx.camera.position.clone();
      expect(Number.isFinite(step)).toBe(true);
    }
    // ~0.15 km/s at 50 m for 50 s ≈ 7.5 km: well past the pole, ~2.5 m per frame, never a jump.
    expect(maxStep).toBeLessThan(0.005);
    // Crossed the pole: now on the far meridian heading north, same altitude.
    expect(Math.abs(m.lonRad)).toBeCloseTo(Math.PI, 2);
    expect(Math.cos(m.heading)).toBeGreaterThan(0.999);
    expect(m.altKm).toBeCloseTo(0.05, 9);
  });

  it('wheel dolly follows the view ray and stops above sampled terrain', () => {
    const { ctx, m } = setup(0.03);
    const before = ctx.camera.position.clone();
    m.pitch = -0.5;
    m.dolly(10, ctx);
    expect(m.altKm).toBeGreaterThanOrEqual(0.032 - 1e-9);
    expect(m.altKm).toBeCloseTo(0.032, 5);
    m.dolly(10, ctx);
    expect(m.altKm).toBeCloseTo(0.032, 5);
    expect(before.length()).toBeGreaterThan(0);
  });

  it('orbit-drag dolly moves the camera itself but also stops above sampled terrain', () => {
    const { mode, ctx, m } = setup(0.03);
    // Look steeply down at the ground from 50 m.
    m.pitch = -1.2;
    (m as unknown as { dirty: boolean }).dirty = true;
    mode.update(ctx);
    ctx.camera.updateMatrixWorld(true);
    m.rightDragging = true;
    m.hasPivot = true;
    const before = ctx.camera.position.clone();
    m.dolly(10, ctx);
    const r = ctx.camera.position.length();
    // Sphere: altitude is radius minus R. Stops at 30 m terrain + 2 m clearance.
    expect(r - R).toBeCloseTo(0.032, 5);
    expect(ctx.camera.position.distanceTo(before)).toBeGreaterThan(0.01);
    // Pulling back out is unrestricted.
    m.dolly(-1, ctx);
    expect(ctx.camera.position.length() - R).toBeGreaterThan(0.032);
  });
});
