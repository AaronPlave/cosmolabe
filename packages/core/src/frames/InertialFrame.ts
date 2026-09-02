import type { RotationMatrix } from '@cosmolabe/spice';
import type { Frame } from './Frame.js';
import { OBLIQUITY_J2000_RAD } from '../constants.js';

export class InertialFrame implements Frame {
  constructor(
    readonly name: string,
    private readonly toEclipJ2000: RotationMatrix,
  ) {}

  toInertial(_et: number): RotationMatrix {
    return this.toEclipJ2000;
  }
}

const IDENTITY: RotationMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const cosEps = Math.cos(OBLIQUITY_J2000_RAD);
const sinEps = Math.sin(OBLIQUITY_J2000_RAD);

// Rotation from equatorial J2000 to ecliptic J2000 (rotate about X by obliquity)
const EQUATOR_TO_ECLIPTIC: RotationMatrix = [
  1, 0, 0,
  0, cosEps, sinEps,
  0, -sinEps, cosEps,
];

export const EclipticJ2000 = new InertialFrame('EclipticJ2000', IDENTITY);
export const ICRF = new InertialFrame('ICRF', EQUATOR_TO_ECLIPTIC); // ICRF ~ EquatorJ2000
export const EquatorJ2000 = new InertialFrame('EquatorJ2000', EQUATOR_TO_ECLIPTIC);
