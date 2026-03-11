import type { Trajectory, CartesianState } from './Trajectory.js';
import type { Vec3 } from '@spicecraft/spice';

const HEADER_MAGIC = 'CHEBPOLY';
const MAX_DEGREE = 32;

/**
 * Trajectory represented as piecewise Chebyshev polynomial interpolation.
 * Reads Cosmographia's binary .cheb file format.
 *
 * File format (little-endian):
 *   8 bytes  - header "CHEBPOLY"
 *   4 bytes  - uint32 record count (granules)
 *   4 bytes  - uint32 polynomial degree
 *   8 bytes  - float64 start time (seconds since J2000 TDB)
 *   8 bytes  - float64 interval length (seconds per granule)
 *   rest     - float64[] coefficients: 3 * (degree + 1) * recordCount values
 *
 * Coefficients per granule are stored as structure-of-arrays:
 *   x0 x1 x2...xn y0 y1 y2...yn z0 z1 z2...zn
 */
export class ChebyshevPolyTrajectory implements Trajectory {
  private readonly coeffs: Float64Array;
  private readonly degree: number;
  private readonly granuleCount: number;
  private readonly _startTime: number;
  private readonly granuleLength: number;
  private _period = 0;

  get startTime(): number { return this._startTime; }
  get endTime(): number { return this._startTime + this.granuleCount * this.granuleLength; }
  get period(): number | undefined { return this._period > 0 ? this._period : undefined; }

  constructor(coeffs: Float64Array, degree: number, granuleCount: number, startTime: number, granuleLength: number) {
    this.coeffs = coeffs;
    this.degree = degree;
    this.granuleCount = granuleCount;
    this._startTime = startTime;
    this.granuleLength = granuleLength;
  }

  setPeriod(p: number): void {
    this._period = p;
  }

  stateAt(et: number): CartesianState {
    // Clamp to valid range
    et = Math.max(this._startTime, Math.min(this.endTime, et));

    let granuleIndex = Math.floor((et - this._startTime) / this.granuleLength);
    const granuleStart = this._startTime + this.granuleLength * granuleIndex;

    // Interpolation parameter u ∈ [-1, 1]
    let u = 2.0 * (et - granuleStart) / this.granuleLength - 1.0;

    if (granuleIndex < 0) {
      u = -1.0;
      granuleIndex = 0;
    } else if (granuleIndex >= this.granuleCount) {
      u = 1.0;
      granuleIndex = this.granuleCount - 1;
    }

    const deg = this.degree;
    const nCoeffs = deg + 1;

    // Chebyshev basis T_i(u) and derivative T'_i(u)
    const T = new Float64Array(nCoeffs);
    const dT = new Float64Array(nCoeffs);
    T[0] = 1.0;
    T[1] = u;
    dT[0] = 0.0;
    dT[1] = 1.0;
    for (let i = 2; i <= deg; i++) {
      T[i] = 2.0 * u * T[i - 1] - T[i - 2];
      dT[i] = 2.0 * u * dT[i - 1] - dT[i - 2] + 2.0 * T[i - 1];
    }

    // Coefficients for this granule: stored as [x0..xn, y0..yn, z0..zn]
    const base = granuleIndex * nCoeffs * 3;
    const position: Vec3 = [0, 0, 0];
    const velocity: Vec3 = [0, 0, 0];

    for (let axis = 0; axis < 3; axis++) {
      let p = 0, v = 0;
      const axisBase = base + axis * nCoeffs;
      for (let i = 0; i <= deg; i++) {
        p += this.coeffs[axisBase + i] * T[i];
        v += this.coeffs[axisBase + i] * dT[i];
      }
      position[axis] = p;
      velocity[axis] = v * (2.0 / this.granuleLength);
    }

    return { position, velocity };
  }

  /**
   * Parse a .cheb binary file (ArrayBuffer) into a ChebyshevPolyTrajectory.
   */
  static fromBuffer(buffer: ArrayBuffer): ChebyshevPolyTrajectory | null {
    const view = new DataView(buffer);

    // Validate header
    let header = '';
    for (let i = 0; i < 8; i++) header += String.fromCharCode(view.getUint8(i));
    if (header !== HEADER_MAGIC) return null;

    const recordCount = view.getUint32(8, true);
    const degree = view.getUint32(12, true);
    const startTime = view.getFloat64(16, true);
    const intervalLength = view.getFloat64(24, true);

    if (degree > MAX_DEGREE || recordCount === 0) return null;

    const coeffCount = 3 * (degree + 1) * recordCount;
    const headerSize = 32; // 8 + 4 + 4 + 8 + 8

    if (buffer.byteLength < headerSize + coeffCount * 8) return null;

    const coeffs = new Float64Array(coeffCount);
    for (let i = 0; i < coeffCount; i++) {
      coeffs[i] = view.getFloat64(headerSize + i * 8, true);
    }

    return new ChebyshevPolyTrajectory(coeffs, degree, recordCount, startTime, intervalLength);
  }
}
