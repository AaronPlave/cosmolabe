import * as THREE from 'three';
import {
  composeBodyToWorldQuat,
  mat3ToQuat,
  type FrameRegistry,
  type InertialFrameName,
  type Quaternion,
  type RotationMatrix,
} from '@cosmolabe/core';
import { bodyWorldOrientation, type CameraModeContext } from './CameraModes.js';

/**
 * Where a frame-locked camera gets its basis from: the frame→world rotation of
 * one reference frame at the current epoch.
 *
 * This is the arbitrary-frame orientation mechanism the locked camera modes
 * share (issue #13). A source only answers "how is this frame oriented in the
 * rendered world right now"; what the camera does with that basis (co-rotate an
 * orbit, or sit at a body and look along an axis) belongs to `FrameLockedMode`,
 * and which frame a user-facing mode means belongs to the semantic layer above.
 */
export interface FrameOrientationSource {
  /**
   * The resolved frame identity, kept inspectable so a friendly mode name never
   * hides the exact frame the camera follows — e.g. `spice:IAU_MOON`,
   * `body:Moon`, `lvlh:LRO/MOON`.
   */
  readonly frameId: string;
  /**
   * Frame→world quaternion (THREE x,y,z,w order) at `ctx.et`, written into
   * `out`. Null when the frame cannot be evaluated (no SPICE, coverage gap,
   * body not loaded); callers hold the camera still rather than snap it.
   */
  orientation(ctx: CameraModeContext, out: THREE.Quaternion): THREE.Quaternion | null;
}

/**
 * Frame→world quaternion for a frame whose orientation is known as a rotation
 * FROM `sourceFrame` TO the frame (the `RotationModel.rotationAt` / `pxform`
 * direction), in THREE order.
 *
 * Every frame source goes through `composeBodyToWorldQuat`, never a bare
 * conjugate: a bare conjugate silently drops the source→world alignment (the
 * EquatorJ2000→EclipticJ2000 obliquity for J2000-stated rotations), which is
 * the bug fixed twice already for locked modes and lat/lon viewpoints.
 */
export function frameToWorldQuat(
  sourceToFrame: Quaternion,
  sourceFrame: InertialFrameName,
  et: number,
  frames: FrameRegistry | undefined,
  out: THREE.Quaternion,
): THREE.Quaternion {
  const q = composeBodyToWorldQuat(sourceToFrame, sourceFrame, undefined, et, frames);
  return out.set(q[1], q[2], q[3], q[0]);
}

/**
 * A body's own rotation model — exactly the orientation its mesh renders with.
 * This is the frame Body-Fixed and SC-Locked follow by default, and works for
 * SPICE CK, TLE and catalog rotations alike.
 */
export function bodyRotationFrame(bodyName: string): FrameOrientationSource {
  return {
    frameId: `body:${bodyName}`,
    orientation(ctx, out) {
      const bm = ctx.bodyMeshes.get(bodyName);
      return bm ? bodyWorldOrientation(bm, ctx.et, out) : null;
    },
  };
}

/**
 * Any furnished SPICE frame (`IAU_MOON`, `LRO_SC_BUS`, `CASSINI_ISS_NAC`, a
 * dynamic frame, …), oriented by `pxform('J2000', frame, et)`. The J2000 leg is
 * then composed into the world frame through the registry, so the obliquity is
 * applied exactly once.
 */
export function spiceFrame(frameName: string, frames?: FrameRegistry): FrameOrientationSource {
  return {
    frameId: `spice:${frameName}`,
    orientation(ctx, out) {
      if (!ctx.spice) return null;
      let m: number[];
      try {
        m = ctx.spice.pxform('J2000', frameName, ctx.et);
      } catch {
        return null;
      }
      if (!m || m.length !== 9) return null;
      return frameToWorldQuat(mat3ToQuat(m as unknown as RotationMatrix), 'J2000', ctx.et, frames, out);
    },
  };
}

const _r = /* @__PURE__ */ new THREE.Vector3();
const _v = /* @__PURE__ */ new THREE.Vector3();
const _nadir = /* @__PURE__ */ new THREE.Vector3();
const _normal = /* @__PURE__ */ new THREE.Vector3();
const _along = /* @__PURE__ */ new THREE.Vector3();

/**
 * Local Vertical Local Horizontal frame of `bodyName` about `centerBodyName`,
 * built from the SPK state alone (no CK needed). Axes, right-handed:
 *   X = along-track (normal × nadir), Y = orbit normal (r × v), Z = nadir (−r̂).
 * The state is taken in ECLIPJ2000, so the source→world leg is identity — it
 * still goes through `frameToWorldQuat` so every source shares one composition.
 */
export function lvlhFrame(bodyName: string, centerBodyName: string): FrameOrientationSource {
  return {
    frameId: `lvlh:${bodyName}/${centerBodyName}`,
    orientation(ctx, out) {
      if (!ctx.spice || !bodyName || !centerBodyName) return null;
      let state: readonly number[];
      try {
        state = ctx.spice.spkezr(bodyName, ctx.et, 'ECLIPJ2000', 'NONE', centerBodyName).state;
      } catch {
        return null;
      }
      _r.set(state[0], state[1], state[2]);
      _v.set(state[3], state[4], state[5]);
      _nadir.copy(_r).normalize().negate();
      _normal.crossVectors(_r, _v).normalize();
      _along.crossVectors(_normal, _nadir).normalize();
      // Rows of the ECLIPJ2000→LVLH matrix are the LVLH axes in ECLIPJ2000.
      const toLvlh: RotationMatrix = [
        _along.x, _along.y, _along.z,
        _normal.x, _normal.y, _normal.z,
        _nadir.x, _nadir.y, _nadir.z,
      ];
      return frameToWorldQuat(mat3ToQuat(toLvlh), 'ECLIPJ2000', ctx.et, undefined, out);
    },
  };
}
