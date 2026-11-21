import type { Universe, Vec3 } from '@cosmolabe/core';
import * as THREE from 'three';

/** Local, anchored plot coordinates. Historical state epochs select positions;
 * the current epoch orients the whole path. This preserves body-fixed surface
 * registration without baking a rotating planet's motion into parked trails. */
export class TrajectoryPlotFrame {
  readonly frame: string;
  readonly sourceFrame: string;
  readonly anchor: Vec3;
  constructor(private readonly universe: Universe, sourceFrame: string, frame: string,
    readonly center: string | undefined, private readonly state: (et: number) => Vec3, anchorEt: number) {
    this.frame = universe.resolveFrame(frame, center);
    this.sourceFrame = universe.resolveFrame(sourceFrame, center);
    if (!universe.frames.isResolvable(this.frame, anchorEt) || !universe.frames.isResolvable(this.sourceFrame, anchorEt)) {
      throw new Error(`Unresolved trajectory plot frame: ${this.sourceFrame} → ${this.frame}`);
    }
    this.anchor = universe.frames.transform(state(anchorEt), this.sourceFrame, this.frame, anchorEt);
  }
  readonly resolve = (_name: string, et: number): Vec3 => {
    const p = this.universe.frames.transform(this.state(et), this.sourceFrame, this.frame, et);
    return [p[0] - this.anchor[0], p[1] - this.anchor[1], p[2] - this.anchor[2]];
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
