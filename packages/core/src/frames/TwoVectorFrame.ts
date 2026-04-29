import type { Vec3, RotationMatrix, SpiceInstance, AberrationCorrection } from '@cosmolabe/spice';
import type { Frame } from './Frame.js';

export type VectorDefinition = {
  type: 'position' | 'velocity';
  target: string;
  observer: string;
  frame?: string; // defaults to ECLIPJ2000
  abcorr?: AberrationCorrection;
};

export class TwoVectorFrame implements Frame {
  readonly name: string;

  constructor(
    name: string,
    private readonly spice: SpiceInstance,
    private readonly primaryAxis: 'X' | 'Y' | 'Z',
    private readonly primaryDef: VectorDefinition,
    private readonly secondaryAxis: 'X' | 'Y' | 'Z',
    private readonly secondaryDef: VectorDefinition,
  ) {
    this.name = name;
  }

  toInertial(et: number): RotationMatrix {
    // Compute primary and secondary vectors
    let primary = this.computeVector(this.primaryDef, et);
    let secondary = this.computeVector(this.secondaryDef, et);

    // Normalize primary
    primary = normalize(primary);

    // Gram-Schmidt: remove component of secondary along primary
    const dot = primary[0] * secondary[0] + primary[1] * secondary[1] + primary[2] * secondary[2];
    secondary = normalize([
      secondary[0] - dot * primary[0],
      secondary[1] - dot * primary[1],
      secondary[2] - dot * primary[2],
    ]);

    // Third axis = primary × secondary (right-handed)
    const third: Vec3 = [
      primary[1] * secondary[2] - primary[2] * secondary[1],
      primary[2] * secondary[0] - primary[0] * secondary[2],
      primary[0] * secondary[1] - primary[1] * secondary[0],
    ];

    // Assign axes to build rotation matrix (rows = frame axes in inertial coords)
    const axes: Record<string, Vec3> = {};
    axes[this.primaryAxis] = primary;
    axes[this.secondaryAxis] = secondary;

    // Find the third axis label
    const labels = ['X', 'Y', 'Z'];
    const thirdAxis = labels.find(l => l !== this.primaryAxis && l !== this.secondaryAxis)!;

    // Determine sign: for right-handed system, X×Y=Z, Y×Z=X, Z×X=Y
    // If primary×secondary doesn't match the expected third axis direction, negate
    const crossSign = rightHandedSign(this.primaryAxis, this.secondaryAxis, thirdAxis);
    axes[thirdAxis] = crossSign > 0 ? third : [-third[0], -third[1], -third[2]];

    const x = axes['X']!;
    const y = axes['Y']!;
    const z = axes['Z']!;

    // Rotation matrix (frame→inertial): columns are the frame's X, Y, Z axes
    return [
      x[0], y[0], z[0],
      x[1], y[1], z[1],
      x[2], y[2], z[2],
    ];
  }

  private computeVector(def: VectorDefinition, et: number): Vec3 {
    const frame = def.frame ?? 'ECLIPJ2000';
    const abcorr = def.abcorr ?? 'NONE';

    if (def.type === 'position') {
      const { position } = this.spice.spkpos(def.target, et, frame, abcorr, def.observer);
      return position;
    }
    // velocity
    const { state } = this.spice.spkezr(def.target, et, frame, abcorr, def.observer);
    return [state[3], state[4], state[5]];
  }
}

function normalize(v: Vec3): Vec3 {
  const mag = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (mag < 1e-30) return [1, 0, 0];
  return [v[0] / mag, v[1] / mag, v[2] / mag];
}

/** Returns +1 if (a, b, c) is a cyclic permutation of (X, Y, Z), -1 otherwise */
function rightHandedSign(primary: string, secondary: string, third: string): number {
  const order = primary + secondary + third;
  return (order === 'XYZ' || order === 'YZX' || order === 'ZXY') ? 1 : -1;
}
