import * as THREE from 'three';

export interface KeyboardControlsConfig {
  /** Translation speed multiplier relative to camera–target distance (default: 1.0) */
  translateSpeed?: number;
  /** Roll speed in radians/second (default: 1.0) */
  rollSpeed?: number;
  /** Speed multiplier when Shift is held (default: 5) */
  boostMultiplier?: number;
  /** Speed multiplier when Alt is held (default: 0.2) */
  slowMultiplier?: number;
  /** Whether keyboard controls are enabled (default: true) */
  enabled?: boolean;
}

/**
 * Key-to-action bindings using KeyboardEvent.code (layout-independent).
 *
 *   W / S  = translate forward / backward
 *   A / D  = translate left / right
 *   Z / C  = translate up / down
 *   Q / E  = roll left / right
 *
 * Pitch and yaw are handled by mouse orbit (TrackballControls left-drag).
 * Translation is also available via right-click drag (TrackballControls pan).
 */
const ACTIONS = {
  // Translation
  forward:   ['KeyW'],
  backward:  ['KeyS'],
  left:      ['KeyA'],
  right:     ['KeyD'],
  up:        ['KeyZ'],
  down:      ['KeyC'],
  // Roll
  rollLeft:  ['KeyQ'],
  rollRight: ['KeyE'],
} as const;

/** All key codes we handle — used for preventDefault */
const ALL_CODES = new Set(
  (Object.values(ACTIONS) as readonly (readonly string[])[]).flat(),
);

export class KeyboardControls {
  enabled: boolean;

  /** Translation speed multiplier (1.0 = camera–target distance per second) */
  translateSpeed: number;
  /** Roll speed (rad/s) */
  rollSpeed: number;
  /** Boost multiplier when Shift is held */
  boostMultiplier: number;
  /** Slow multiplier when Alt is held */
  slowMultiplier: number;

  /** True during the frame if translation was applied */
  translatedThisFrame = false;

  private readonly _keys = new Set<string>();
  private readonly _onKeyDown: (e: KeyboardEvent) => void;
  private readonly _onKeyUp: (e: KeyboardEvent) => void;
  private readonly _onBlur: () => void;

  /** Slew (smooth rotation) state */
  private _slew: {
    target: THREE.Vector3;
    rate: number;
    onComplete?: () => void;
  } | null = null;

  constructor(config?: KeyboardControlsConfig) {
    this.translateSpeed = config?.translateSpeed ?? 1.0;
    this.rollSpeed = config?.rollSpeed ?? 1.0;
    this.boostMultiplier = config?.boostMultiplier ?? 5;
    this.slowMultiplier = config?.slowMultiplier ?? 0.2;
    this.enabled = config?.enabled ?? true;

    this._onKeyDown = (e: KeyboardEvent) => {
      if (!this.enabled) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (ALL_CODES.has(e.code)) e.preventDefault();
      this._keys.add(e.code);
    };

    this._onKeyUp = (e: KeyboardEvent) => {
      this._keys.delete(e.code);
    };

    this._onBlur = () => {
      this._keys.clear();
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  /** Whether any action key is currently pressed or a slew is active */
  get active(): boolean {
    if (!this.enabled) return false;
    if (this._slew) return true;
    for (const codes of Object.values(ACTIONS)) {
      for (const c of codes) {
        if (this._keys.has(c)) return true;
      }
    }
    return false;
  }

  /**
   * Smoothly rotate the camera to face a world-space target position.
   * @param target World position to slew toward
   * @param rate Angular rate in radians/second (default: 0.5)
   * @param onComplete Called when slew reaches the target direction
   */
  slewTo(target: THREE.Vector3, rate = 0.5, onComplete?: () => void): void {
    this._slew = { target: target.clone(), rate, onComplete };
  }

  /** Cancel any active slew */
  cancelSlew(): void {
    this._slew = null;
  }

  /** Whether a slew is currently in progress */
  get slewing(): boolean {
    return this._slew !== null;
  }

  /**
   * Apply keyboard state to the camera. Call once per frame, AFTER controls.update().
   *
   * Roll modifies camera.up (persists across TrackballControls frames).
   * Translation moves both camera.position and orbitTarget together.
   * Slew rotates the camera toward a target by adjusting orbitTarget and camera.up.
   *
   * @returns true if any input was applied this frame
   */
  update(
    camera: THREE.PerspectiveCamera,
    orbitTarget: THREE.Vector3,
    dt: number,
  ): boolean {
    if (!this.enabled) return false;
    this.translatedThisFrame = false;
    let acted = false;

    // Speed modifier
    let speedMod = 1;
    if (this._keys.has('ShiftLeft') || this._keys.has('ShiftRight')) {
      speedMod = this.boostMultiplier;
    }
    if (this._keys.has('AltLeft') || this._keys.has('AltRight')) {
      speedMod = this.slowMultiplier;
    }

    // Camera local axes (read from current camera state, after controls.update())
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();

    // ── Roll (Q / E) ──
    // Modifies camera.up, which TrackballControls reads but does not reset.
    let roll = 0;
    if (this._pressed(ACTIONS.rollLeft))  roll += this.rollSpeed * dt * speedMod;
    if (this._pressed(ACTIONS.rollRight)) roll -= this.rollSpeed * dt * speedMod;

    if (roll !== 0) {
      const rollQ = new THREE.Quaternion().setFromAxisAngle(forward, roll);
      camera.up.applyQuaternion(rollQ).normalize();
      acted = true;
    }

    // ── Translation (WASD + Z/C) ──
    // Moves camera.position and orbitTarget together, preserving the relative
    // offset so TrackballControls orbit/zoom state is undisturbed.
    const dist = camera.position.distanceTo(orbitTarget);
    const transAmt = dist * this.translateSpeed * dt * speedMod;
    const move = new THREE.Vector3();

    if (this._pressed(ACTIONS.forward))  move.addScaledVector(forward, transAmt);
    if (this._pressed(ACTIONS.backward)) move.addScaledVector(forward, -transAmt);
    if (this._pressed(ACTIONS.right))    move.addScaledVector(right, transAmt);
    if (this._pressed(ACTIONS.left))     move.addScaledVector(right, -transAmt);
    if (this._pressed(ACTIONS.up))       move.addScaledVector(up, transAmt);
    if (this._pressed(ACTIONS.down))     move.addScaledVector(up, -transAmt);

    if (move.lengthSq() > 0) {
      camera.position.add(move);
      orbitTarget.add(move);
      this.translatedThisFrame = true;
      acted = true;
    }

    // ── Slew (smooth rotation toward a target position) ──
    if (this._slew) {
      const targetDir = new THREE.Vector3()
        .copy(this._slew.target)
        .sub(camera.position)
        .normalize();
      const currentDir = new THREE.Vector3()
        .subVectors(orbitTarget, camera.position)
        .normalize();

      const angle = currentDir.angleTo(targetDir);
      const SLEW_THRESHOLD = 0.001; // ~0.06°

      if (angle < SLEW_THRESHOLD) {
        const d = camera.position.distanceTo(orbitTarget);
        orbitTarget.copy(camera.position).addScaledVector(targetDir, d);
        const cb = this._slew.onComplete;
        this._slew = null;
        cb?.();
      } else {
        const step = Math.min(this._slew.rate * dt, angle);
        const axis = new THREE.Vector3().crossVectors(currentDir, targetDir);
        if (axis.lengthSq() > 1e-10) {
          axis.normalize();
          const q = new THREE.Quaternion().setFromAxisAngle(axis, step);
          const d = camera.position.distanceTo(orbitTarget);
          const newDir = currentDir.applyQuaternion(q).normalize();
          orbitTarget.copy(camera.position).addScaledVector(newDir, d);
          camera.up.applyQuaternion(q).normalize();
        }
      }
      acted = true;
    }

    return acted;
  }

  dispose(): void {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this._keys.clear();
    this._slew = null;
  }

  private _pressed(codes: readonly string[]): boolean {
    for (const c of codes) {
      if (this._keys.has(c)) return true;
    }
    return false;
  }
}
