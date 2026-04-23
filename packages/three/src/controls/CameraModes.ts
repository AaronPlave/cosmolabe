import type * as THREE from 'three';
import type { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import type { BodyMesh } from '../BodyMesh.js';

/** SPICE-like interface for frame transforms — matches SpiceFrames + SpiceState */
export interface CameraModeSpice {
  pxform(from: string, to: string, et: number): number[];
  spkezr(target: string, et: number, frame: string, abcorr: string, observer: string): {
    state: [number, number, number, number, number, number];
    lightTime: number;
  };
  /** Get frame name from frame ID code. Returns null if not found. */
  frmnam?(frcode: number): string | null;
  /** Get frame ID and name associated with a body ID. Returns null if not found. */
  cidfrm?(cent: number): { frcode: number; frname: string } | null;
}

export enum CameraModeName {
  FREE_ORBIT = 'free-orbit',
  SC_FIXED = 'sc-fixed',
  BODY_FIXED = 'body-fixed',
  LVLH = 'lvlh',
  CHASE = 'chase',
  SURFACE = 'surface',
  SURFACE_EXPLORER = 'surface-explorer',
  INSTRUMENT = 'instrument',
}

/** Context passed to camera modes each frame */
export interface CameraModeContext {
  camera: THREE.PerspectiveCamera;
  controls: TrackballControls;
  bodyMeshes: Map<string, BodyMesh>;
  spice: CameraModeSpice | null;
  et: number;
  dt: number;
  scaleFactor: number;
  originBody: BodyMesh | null;
  /** Raycast from screen coordinates to body surface. Uses the renderer's proven pickSurface. */
  pickSurface?: (ndcX: number, ndcY: number) => { bodyName: string; latDeg: number; lonDeg: number; altKm: number } | null;
}

/** Parameters for activating a camera mode */
export interface CameraModeParams {
  /** Target body name (spacecraft for SC_FIXED/LVLH/CHASE, body for BODY_FIXED/SURFACE) */
  bodyName?: string;
  /** SPICE frame name override (e.g. 'LRO_SC_BUS'). Auto-resolved if omitted. */
  frameName?: string;
  /** Which spacecraft axis is camera "forward" for SC_FIXED/LVLH (default: '-Z') */
  axis?: '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';
  /** Camera offset distance in km (SC_FIXED, CHASE) */
  offset?: number;
  /** Center body name for LVLH (body being orbited) */
  centerBodyName?: string;
  /** Damping factor 0-1 for CHASE smoothing (default: 0.05) */
  damping?: number;
  /** Geodetic latitude in degrees for SURFACE */
  latDeg?: number;
  /** Geodetic longitude in degrees for SURFACE */
  lonDeg?: number;
  /** Altitude above surface in km for SURFACE */
  altKm?: number;
  /** Body to look at from surface (SURFACE mode) */
  lookTarget?: string;
  /** Sensor name for INSTRUMENT mode */
  sensorName?: string;
}

/**
 * Ensure quaternion sign continuity: if curQ is in the opposite hemisphere from prevQ,
 * negate it. q and -q represent the same rotation, but the delta curQ*prevQ⁻¹ would
 * compute a near-360° rotation if the signs differ, causing a camera flip.
 */
export function ensureQuatContinuity(cur: import('three').Quaternion, prev: import('three').Quaternion): void {
  if (cur.dot(prev) < 0) {
    cur.set(-cur.x, -cur.y, -cur.z, -cur.w);
  }
}

export interface ICameraMode {
  readonly name: CameraModeName;
  /** Whether TrackballControls orbit/zoom should be active */
  readonly allowsOrbitControls: boolean;
  /** Whether WASD keyboard controls should be active */
  readonly allowsKeyboard: boolean;
  /** Called when entering this mode */
  activate(ctx: CameraModeContext, params: CameraModeParams): void;
  /** Called every frame to position/orient the camera */
  update(ctx: CameraModeContext): void;
  /** Called when leaving this mode */
  deactivate(ctx: CameraModeContext): void;
}
