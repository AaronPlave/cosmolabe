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
