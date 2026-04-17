import type { RotationMatrix, StateTransformMatrix } from './types.js';

export interface SpiceFrames {
  pxform(from: string, to: string, et: number): RotationMatrix;
  sxform(from: string, to: string, et: number): StateTransformMatrix;
  /** Get the frame name associated with a frame ID code. Returns null if not found. */
  frmnam(frcode: number): string | null;
  /** Get the frame ID and name associated with a body ID. Returns null if not found. */
  cidfrm(cent: number): { frcode: number; frname: string } | null;
}
