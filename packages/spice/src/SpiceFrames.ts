import type { RotationMatrix, StateTransformMatrix } from './types.js';

export interface SpiceFrames {
  pxform(from: string, to: string, et: number): RotationMatrix;
  sxform(from: string, to: string, et: number): StateTransformMatrix;
}
