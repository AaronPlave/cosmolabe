import type { RotationMatrix } from '@spicecraft/spice';
import type { Frame } from './Frame.js';

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

// Obliquity of the ecliptic at J2000: 23.4392911 degrees
const eps = 23.4392911 * Math.PI / 180;
const cosEps = Math.cos(eps);
const sinEps = Math.sin(eps);

// Rotation from equatorial J2000 to ecliptic J2000 (rotate about X by obliquity)
const EQUATOR_TO_ECLIPTIC: RotationMatrix = [
  1, 0, 0,
  0, cosEps, sinEps,
  0, -sinEps, cosEps,
];

export const EclipticJ2000 = new InertialFrame('EclipticJ2000', IDENTITY);
export const ICRF = new InertialFrame('ICRF', EQUATOR_TO_ECLIPTIC); // ICRF ~ EquatorJ2000
export const EquatorJ2000 = new InertialFrame('EquatorJ2000', EQUATOR_TO_ECLIPTIC);
