import type { Universe, Vec3 } from '@cosmolabe/core';
import * as THREE from 'three';

/** Local, anchored plot coordinates. Historical state epochs select positions;
 * the current epoch orients the whole path. This preserves body-fixed surface
 * registration without baking a rotating planet's motion into parked trails. */
export class TrajectoryPlotFrame {
  readonly frame: string;
  private readonly sourceFrameOf: () => string;
  private _anchor: Vec3 | null = null;
  /** `sourceFrame` as a function: the frame of `state`, read at each
   * evaluation — a host-supplied trajectory only names its frame once its
   * source exists, which may be after the scene is built. */
  constructor(private readonly universe: Universe, sourceFrame: string | (() => string), frame: string,
    readonly center: string | undefined, private readonly state: (et: number) => Vec3, anchorEt: number) {
    this.frame = universe.resolveFrame(frame, center);
    this.sourceFrameOf = typeof sourceFrame === 'function' ? sourceFrame : () => sourceFrame;
    if (!universe.frames.isResolvable(this.frame, anchorEt) || !universe.frames.isResolvable(this.sourceFrame, anchorEt)) {
      throw new Error(`Unresolved trajectory plot frame: ${this.sourceFrame} → ${this.frame}`);
    }
    this.anchorAt(anchorEt);
  }
  /** The plot origin: the path's position at the anchor epoch or, when the
   * trajectory has no state there yet (a host source added after the scene
   * was built, data still loading), the first position it does give. */
  get sourceFrame(): string { return this.universe.resolveFrame(this.sourceFrameOf(), this.center); }
  get anchor(): Vec3 { return this._anchor ?? [NaN, NaN, NaN]; }
  private anchorAt(et: number): Vec3 {
    const p = this.universe.frames.transform(this.state(et), this.sourceFrame, this.frame, et);
    if (!this._anchor && p.every(Number.isFinite)) this._anchor = [p[0], p[1], p[2]];
    return p;
  }
  readonly resolve = (_name: string, et: number): Vec3 => {
    const p = this.anchorAt(et), a = this.anchor;
    return [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  };
  toWorld(p: Vec3, et: number): Vec3 { return this.universe.toWorldFrame(p, this.frame, this.center, et); }
  place(object: THREE.Object3D, centerRelativeKm: Vec3, scaleFactor: number, et: number): void {
    const anchor = this.toWorld(this.anchor, et);
    object.position.set(...anchor.map((v, i) => v + centerRelativeKm[i]) as Vec3).multiplyScalar(scaleFactor);
    // TrajectoryLine stores native XYZ, unlike a globe's Y-up mesh. Do not
    // apply the globe geometry's axis permutation to path vertices or poses.
    const axis = (v: Vec3) => new THREE.Vector3(...this.toWorld(v, et));
    object.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(axis([1, 0, 0]), axis([0, 1, 0]), axis([0, 0, 1])));
    object.updateMatrixWorld(true);
  }
}
