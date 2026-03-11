import type { Vec3, StateVector, AberrationCorrection } from './types.js';

export interface SpiceState {
  spkpos(target: string, et: number, frame: string, abcorr: AberrationCorrection, observer: string): {
    position: Vec3;
    lightTime: number;
  };
  spkezr(target: string, et: number, frame: string, abcorr: AberrationCorrection, observer: string): {
    state: StateVector;
    lightTime: number;
  };
}
