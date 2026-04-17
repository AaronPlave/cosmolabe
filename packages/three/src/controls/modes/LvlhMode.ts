import * as THREE from 'three';
import { CameraModeName, type ICameraMode, type CameraModeContext, type CameraModeParams } from '../CameraModes.js';

const _r = /* @__PURE__ */ new THREE.Vector3();
const _v = /* @__PURE__ */ new THREE.Vector3();
const _nadir = /* @__PURE__ */ new THREE.Vector3();
const _normal = /* @__PURE__ */ new THREE.Vector3();
const _along = /* @__PURE__ */ new THREE.Vector3();
const _forward = /* @__PURE__ */ new THREE.Vector3();
const _up = /* @__PURE__ */ new THREE.Vector3();
const _lookTarget = /* @__PURE__ */ new THREE.Vector3();

/** Column mapping for which LVLH axis the camera looks along */
const LVLH_AXIS: Record<string, { getForward: (n: THREE.Vector3, a: THREE.Vector3, d: THREE.Vector3) => THREE.Vector3; getUp: (n: THREE.Vector3, a: THREE.Vector3, d: THREE.Vector3) => THREE.Vector3 }> = {
  '-Z': {
    getForward: (_n, _a, d) => _forward.copy(d),      // nadir (down)
    getUp: (_n, a, _d) => _up.copy(a),                 // along-track
  },
  '+Z': {
    getForward: (_n, _a, d) => _forward.copy(d).negate(), // zenith (up)
    getUp: (_n, a, _d) => _up.copy(a),
  },
  '+X': {
    getForward: (_n, a, _d) => _forward.copy(a),       // along-track (forward)
    getUp: (_n, _a, d) => _up.copy(d).negate(),         // zenith
  },
  '-X': {
    getForward: (_n, a, _d) => _forward.copy(a).negate(), // anti-velocity
    getUp: (_n, _a, d) => _up.copy(d).negate(),
  },
  '+Y': {
    getForward: (n, _a, _d) => _forward.copy(n),       // orbit normal
    getUp: (_n, _a, d) => _up.copy(d).negate(),
  },
  '-Y': {
    getForward: (n, _a, _d) => _forward.copy(n).negate(),
    getUp: (_n, _a, d) => _up.copy(d).negate(),
  },
};

/**
 * LVLH (Local Vertical Local Horizontal) Camera.
 * Camera aligned to the orbital frame: nadir is "down", velocity is "forward".
 * Computed purely from the orbit (SPK), no CK attitude data needed.
 */
export class LvlhMode implements ICameraMode {
  readonly name = CameraModeName.LVLH;
  readonly allowsOrbitControls = false;
  readonly allowsKeyboard = false;

  private bodyName = '';
  private centerBodyName = '';
  private axis = '-Z';
  private offsetKm = 0;

  activate(_ctx: CameraModeContext, params: CameraModeParams): void {
    this.bodyName = params.bodyName ?? '';
    this.centerBodyName = params.centerBodyName ?? '';
    this.axis = params.axis ?? '-Z';
    this.offsetKm = params.offset ?? 0;
  }

  update(ctx: CameraModeContext): void {
    const bm = ctx.bodyMeshes.get(this.bodyName);
    if (!bm) return;

    // Get velocity via SPICE state vector if available
    const state = this.getStateVector(ctx);
    if (!state) return;

    // Position and velocity relative to center body (in km, ECLIPJ2000)
    _r.set(state[0], state[1], state[2]);
    _v.set(state[3], state[4], state[5]);

    // LVLH triad:
    // nadir = -normalize(r)
    _nadir.copy(_r).normalize().negate();
    // orbit normal = normalize(r × v)
    _normal.crossVectors(_r, _v).normalize();
    // along-track = normal × nadir (completes right-hand triad)
    _along.crossVectors(_normal, _nadir).normalize();

    const axisDef = LVLH_AXIS[this.axis] ?? LVLH_AXIS['-Z'];
    axisDef.getForward(_normal, _along, _nadir);
    axisDef.getUp(_normal, _along, _nadir);

    // Position at spacecraft with optional offset
    const sceneOffset = this.offsetKm * ctx.scaleFactor;
    ctx.camera.position.copy(bm.position);
    if (sceneOffset > 0) {
      ctx.camera.position.addScaledVector(_forward, -sceneOffset);
    }

    _lookTarget.copy(ctx.camera.position).addScaledVector(_forward, 1);
    ctx.camera.up.copy(_up);
    ctx.camera.lookAt(_lookTarget);
  }

  deactivate(_ctx: CameraModeContext): void {
    this.bodyName = '';
    this.centerBodyName = '';
  }

  /** Get state vector [x,y,z,vx,vy,vz] in km and km/s relative to center body */
  private getStateVector(ctx: CameraModeContext): [number, number, number, number, number, number] | null {
    if (!ctx.spice || !this.centerBodyName) return null;
    try {
      const result = ctx.spice.spkezr(
        this.bodyName, ctx.et, 'ECLIPJ2000', 'NONE', this.centerBodyName,
      );
      return result.state;
    } catch {
      return null;
    }
  }
}
