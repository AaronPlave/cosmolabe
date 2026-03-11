import type { TimeWindow } from './types.js';

export interface SpiceEvents {
  gfposc(
    target: string, frame: string, abcorr: string, observer: string,
    crdsys: string, coord: string, relate: string, refval: number,
    adjust: number, step: number, cnfine: TimeWindow[]
  ): TimeWindow[];

  gfsep(
    target1: string, shape1: string, frame1: string,
    target2: string, shape2: string, frame2: string,
    abcorr: string, observer: string,
    relate: string, refval: number,
    adjust: number, step: number, cnfine: TimeWindow[]
  ): TimeWindow[];

  gfoclt(
    occtyp: string, front: string, fshape: string, fframe: string,
    back: string, bshape: string, bframe: string,
    abcorr: string, observer: string,
    step: number, cnfine: TimeWindow[]
  ): TimeWindow[];

  gfdist(
    target: string, abcorr: string, observer: string,
    relate: string, refval: number,
    adjust: number, step: number, cnfine: TimeWindow[]
  ): TimeWindow[];
}
