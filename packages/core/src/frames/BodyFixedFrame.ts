import type { RotationMatrix } from '@cosmolabe/spice';
import type { Frame } from './Frame.js';
import type { RotationModel, Quaternion } from '../rotations/RotationModel.js';

export class BodyFixedFrame implements Frame {
  readonly name: string;

  constructor(
    private readonly bodyName: string,
    private readonly rotation: RotationModel,
  ) {
    this.name = `IAU_${bodyName.toUpperCase()}`;
  }

  toInertial(et: number): RotationMatrix {
    const q = this.rotation.rotationAt(et);
    return quaternionToMatrix(q);
  }
}

function quaternionToMatrix(q: Quaternion): RotationMatrix {
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z),     2 * (x * z + w * y),
    2 * (x * y + w * z),     1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y),     2 * (y * z + w * x),     1 - 2 * (x * x + y * y),
  ];
}
