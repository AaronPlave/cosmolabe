import type { FrameRegistry } from '../frames/FrameRegistry.js';
import { mat3Mul, mat3ToQuat, quatToMat3 } from '../frames/mat3.js';
import type { InertialFrameName, Quaternion, RotationModel } from './RotationModel.js';

/** One time window of a {@link CompositeRotation}. */
export interface RotationArc {
  rotation: RotationModel;
  startTime: number;
  endTime: number;
}

/**
 * A rotation that changes model by time window: Cosmographia's per-arc
 * `rotationModel`. The motivating case is a lander that rides its mothership —
 * turning with the mothership's attitude — until separation, then follows its
 * own attitude kernel.
 *
 * Outside every arc the `fallback` (the item-level rotation model) applies;
 * with no fallback the nearest arc is held, as `CompositeTrajectory` holds its
 * first and last arcs.
 *
 * Consumers compose a rotation with its single `sourceFrame`, so each arc's
 * rotation is re-expressed from its own source frame into this one's, through
 * the frame registry, before it is returned.
 */
export class CompositeRotation implements RotationModel {
  readonly sourceFrame: InertialFrameName;
  private warned = false;

  constructor(
    readonly arcs: readonly RotationArc[],
    private readonly fallback: RotationModel | undefined,
    private readonly frames: FrameRegistry,
  ) {
    if (arcs.length === 0) throw new Error('CompositeRotation requires at least one arc');
    this.sourceFrame = (fallback ?? arcs[0]!.rotation).sourceFrame;
  }

  /** The rotation model in effect at `et`. */
  rotationFor(et: number): RotationModel {
    for (const arc of this.arcs) {
      if (et >= arc.startTime && et <= arc.endTime) return arc.rotation;
    }
    if (this.fallback) return this.fallback;
    const first = this.arcs[0]!;
    const last = this.arcs[this.arcs.length - 1]!;
    return et < first.startTime ? first.rotation : last.rotation;
  }

  rotationAt(et: number): Quaternion {
    const model = this.rotationFor(et);
    const q = model.rotationAt(et);
    if (this.frames.sameFrame(model.sourceFrame, this.sourceFrame)) return q;
    // (common → body) = (arc source → body) · (common → arc source)
    const m = this.frames.rotation(this.sourceFrame, model.sourceFrame, et);
    if (!m) {
      if (!this.warned) {
        this.warned = true;
        console.warn(
          `[Cosmolabe] CompositeRotation: cannot relate ${model.sourceFrame} to ${this.sourceFrame}; ` +
            `using the arc's rotation unconverted`,
        );
      }
      return q;
    }
    return mat3ToQuat(mat3Mul(quatToMat3(q), m));
  }
}
