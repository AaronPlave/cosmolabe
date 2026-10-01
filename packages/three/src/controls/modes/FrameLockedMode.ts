import * as THREE from 'three';
import { CameraModeName, ensureQuatContinuity, type ICameraMode, type CameraModeContext, type CameraModeParams } from '../CameraModes.js';
import type { FrameOrientationSource } from '../frameOrientation.js';

type Axis = NonNullable<CameraModeParams['axis']>;

/** Camera forward and up for a look axis, both in the locked frame's coordinates. */
export type AxisBasis = Record<Axis, { forward: [number, number, number]; up: [number, number, number] }>;

/**
 * Literal frame axes: look along the named axis, with +Z up — or +X up when
 * looking along ±Z.
 */
export const FRAME_AXIS_BASIS: AxisBasis = {
  '+X': { forward: [1, 0, 0], up: [0, 0, 1] },
  '-X': { forward: [-1, 0, 0], up: [0, 0, 1] },
  '+Y': { forward: [0, 1, 0], up: [0, 0, 1] },
  '-Y': { forward: [0, -1, 0], up: [0, 0, 1] },
  '+Z': { forward: [0, 0, 1], up: [1, 0, 0] },
  '-Z': { forward: [0, 0, -1], up: [1, 0, 0] },
};

/**
 * How the camera uses the frame's basis.
 * - `corotate`: the camera keeps its own orbit around the pivot body, and that
 *   orbit co-rotates with the frame (Body-Fixed, SC-Locked). TrackballControls
 *   orbit/zoom act in the rotating frame.
 * - `attached`: the camera sits at the pivot body and looks along a frame axis
 *   (LVLH), optionally backed off along that axis by `offset` km.
 */
export type FrameLockBehavior = 'corotate' | 'attached';

export interface FrameLockedModeOptions {
  name: CameraModeName;
  behavior: FrameLockBehavior;
  allowsKeyboard?: boolean;
  /** Resolve the frame to follow from the activation params. */
  resolveFrame(ctx: CameraModeContext, params: CameraModeParams): FrameOrientationSource | null;
  /** `attached` only: axis label → frame-space forward/up. Defaults to literal frame axes. */
  axisBasis?: AxisBasis;
}

const _offset = /* @__PURE__ */ new THREE.Vector3();
const _curQ = /* @__PURE__ */ new THREE.Quaternion();
const _deltaQ = /* @__PURE__ */ new THREE.Quaternion();
const _forward = /* @__PURE__ */ new THREE.Vector3();
const _up = /* @__PURE__ */ new THREE.Vector3();
const _lookTarget = /* @__PURE__ */ new THREE.Vector3();

/**
 * Generic frame-locked camera: orients the camera by any reference frame's
 * frame→world rotation. Body-Fixed, SC-Locked and LVLH are instances of this
 * with different frame sources and behaviors; a caller can lock to any
 * furnished SPICE frame by passing `frameName` to a `corotate` instance.
 *
 * This is deliberately the low-level mechanism only. Which frame a named,
 * user-facing view means is the semantic viewpoint layer's job (#114); the
 * resolved frame stays inspectable here via `frameId`.
 */
export class FrameLockedMode implements ICameraMode {
  readonly name: CameraModeName;
  readonly allowsOrbitControls: boolean;
  readonly allowsKeyboard: boolean;
  readonly behavior: FrameLockBehavior;

  private readonly resolveFrame: FrameLockedModeOptions['resolveFrame'];
  private readonly axisBasis: AxisBasis;

  private bodyName = '';
  private axis: Axis = '-Z';
  private offsetKm = 0;
  private source: FrameOrientationSource | null = null;
  private readonly prevQuat = new THREE.Quaternion();
  private hasPrevQuat = false;

  constructor(opts: FrameLockedModeOptions) {
    this.name = opts.name;
    this.behavior = opts.behavior;
    this.allowsOrbitControls = opts.behavior === 'corotate';
    this.allowsKeyboard = opts.allowsKeyboard ?? false;
    this.resolveFrame = opts.resolveFrame;
    this.axisBasis = opts.axisBasis ?? FRAME_AXIS_BASIS;
  }

  /** The resolved frame the camera follows (e.g. `spice:IAU_MOON`), or null when inactive. */
  get frameId(): string | null {
    return this.source?.frameId ?? null;
  }

  activate(ctx: CameraModeContext, params: CameraModeParams): void {
    this.bodyName = params.bodyName ?? '';
    this.axis = params.axis ?? '-Z';
    this.offsetKm = params.offset ?? 0;
    this.source = this.resolveFrame(ctx, params);
    this.hasPrevQuat = false;

    if (this.behavior === 'corotate' && this.source?.orientation(ctx, this.prevQuat)) {
      this.hasPrevQuat = true;
    }
  }

  update(ctx: CameraModeContext): void {
    const bm = ctx.bodyMeshes.get(this.bodyName);
    if (!bm || !this.source) return;

    const curQuat = this.source.orientation(ctx, _curQ);
    if (!curQuat) return;

    if (this.behavior === 'attached') {
      this.updateAttached(ctx, bm.position, curQuat);
      return;
    }

    if (this.hasPrevQuat) {
      ensureQuatContinuity(curQuat, this.prevQuat);
      _deltaQ.copy(this.prevQuat).invert().premultiply(curQuat);

      // Rotate camera position around the pivot
      _offset.copy(ctx.camera.position).sub(bm.position);
      _offset.applyQuaternion(_deltaQ);
      ctx.camera.position.copy(bm.position).add(_offset);

      // Rotate orbit target around the pivot (preserves camera→target direction)
      _offset.copy(ctx.controls.target).sub(bm.position);
      _offset.applyQuaternion(_deltaQ);
      ctx.controls.target.copy(bm.position).add(_offset);

      // Rotate camera orientation and up vector
      ctx.camera.quaternion.premultiply(_deltaQ);
      ctx.camera.up.applyQuaternion(_deltaQ).normalize();
    }

    this.prevQuat.copy(curQuat);
    this.hasPrevQuat = true;
  }

  deactivate(_ctx: CameraModeContext): void {
    this.bodyName = '';
    this.source = null;
    this.hasPrevQuat = false;
  }

  private updateAttached(ctx: CameraModeContext, pivot: THREE.Vector3, frameToWorld: THREE.Quaternion): void {
    const basis = this.axisBasis[this.axis] ?? this.axisBasis['-Z'];
    _forward.fromArray(basis.forward).applyQuaternion(frameToWorld);
    _up.fromArray(basis.up).applyQuaternion(frameToWorld);

    const sceneOffset = this.offsetKm * ctx.scaleFactor;
    ctx.camera.position.copy(pivot);
    if (sceneOffset > 0) {
      ctx.camera.position.addScaledVector(_forward, -sceneOffset);
    }

    _lookTarget.copy(ctx.camera.position).add(_forward);
    ctx.camera.up.copy(_up);
    ctx.camera.lookAt(_lookTarget);
  }
}
