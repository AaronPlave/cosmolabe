import type { KernelSource } from './SpiceKernel.js';
import type {
  Vec3, StateVector, RotationMatrix, StateTransformMatrix,
  OrbitalElements, IlluminationAngles, SubPoint, SurfaceIntercept,
  TimeWindow, AberrationCorrection,
} from './types.js';

import { Spice as TCSpice, ASM_SPICE_FULL } from 'timecraftjs';

type EmscriptenModule = TCSpice['module'];

const DOUBLE_SIZE = 8;
const INT_SIZE = 4;

export interface SpiceInstance {
  // Kernel management
  furnish(source: KernelSource): Promise<void>;
  unload(filename: string): void;
  clear(): void;
  totalLoaded(): number;
  // Time
  str2et(timeString: string): number;
  et2utc(et: number, format: 'C' | 'D' | 'J' | 'ISOC' | 'ISOD', precision: number): string;
  utc2et(utcString: string): number;
  et2lst(et: number, bodyId: number, longitude: number, type: 'PLANETOCENTRIC' | 'PLANETOGRAPHIC'): { hr: number; mn: number; sc: number; time: string; ampm: string };
  timout(et: number, pictur: string): string;
  unitim(epoch: number, insys: string, outsys: string): number;
  // State
  spkpos(target: string, et: number, frame: string, abcorr: AberrationCorrection, observer: string): { position: Vec3; lightTime: number };
  spkezr(target: string, et: number, frame: string, abcorr: AberrationCorrection, observer: string): { state: StateVector; lightTime: number };
  // Frames
  pxform(from: string, to: string, et: number): RotationMatrix;
  sxform(from: string, to: string, et: number): StateTransformMatrix;
  // Geometry
  sincpt(method: string, target: string, et: number, fixref: string, abcorr: AberrationCorrection, observer: string, dref: string, dvec: Vec3): SurfaceIntercept;
  subpnt(method: string, target: string, et: number, fixref: string, abcorr: AberrationCorrection, observer: string): SubPoint;
  subslr(method: string, target: string, et: number, fixref: string, abcorr: AberrationCorrection, observer: string): SubPoint;
  ilumin(method: string, target: string, et: number, fixref: string, abcorr: AberrationCorrection, observer: string, spoint: Vec3): IlluminationAngles;
  oscelt(state: StateVector, et: number, mu: number): OrbitalElements;
  conics(elements: OrbitalElements, et: number): StateVector;
  bodvcd(bodyId: number, item: string): number[];
  bodvrd(body: string, item: string): number[];
  bodc2n(code: number): string | null;
  bodn2c(name: string): number | null;
  // Events
  gfposc(target: string, frame: string, abcorr: string, observer: string, crdsys: string, coord: string, relate: string, refval: number, adjust: number, step: number, cnfine: TimeWindow[]): TimeWindow[];
  gfsep(target1: string, shape1: string, frame1: string, target2: string, shape2: string, frame2: string, abcorr: string, observer: string, relate: string, refval: number, adjust: number, step: number, cnfine: TimeWindow[]): TimeWindow[];
  gfoclt(occtyp: string, front: string, fshape: string, fframe: string, back: string, bshape: string, bframe: string, abcorr: string, observer: string, step: number, cnfine: TimeWindow[]): TimeWindow[];
  gfdist(target: string, abcorr: string, observer: string, relate: string, refval: number, adjust: number, step: number, cnfine: TimeWindow[]): TimeWindow[];
  // Math
  mxv(matrix: RotationMatrix, vin: Vec3): Vec3;
  mtxv(matrix: RotationMatrix, vin: Vec3): Vec3;
  vcrss(v1: Vec3, v2: Vec3): Vec3;
  vnorm(v: Vec3): number;
  vdot(v1: Vec3, v2: Vec3): number;
  vsep(v1: Vec3, v2: Vec3): number;
  vhat(v: Vec3): Vec3;
  vsub(v1: Vec3, v2: Vec3): Vec3;
  vadd(v1: Vec3, v2: Vec3): Vec3;
  vscl(s: number, v: Vec3): Vec3;
  recrad(rectan: Vec3): { range: number; ra: number; dec: number };
}

let bufferFileCount = 0;

export class Spice implements SpiceInstance {
  private module!: EmscriptenModule;
  private fileMap = new Map<string, string>();
  private kernelCount = 0;

  private constructor() {}

  static async init(): Promise<Spice> {
    const tc = new TCSpice();
    await tc.init(ASM_SPICE_FULL);

    const spice = new Spice();
    spice.module = tc.module;

    // Set error handling to RETURN mode so we can check failed() ourselves
    spice.module.ccall('erract_c', null, ['string', 'number', 'number'],
      ['SET', 100, spice.allocString('RETURN')]);
    // Suppress CSPICE's own error output — we handle errors in JS via checkError()
    spice.module.ccall('errprt_c', null, ['string', 'number', 'number'],
      ['SET', 100, spice.allocString('NONE')]);

    return spice;
  }

  // --- Error handling helpers ---

  private checkError(): void {
    const failed = this.module.ccall('failed_c', 'number', [], []) as number;
    if (failed) {
      const msgPtr = this.module._malloc(1841);
      this.module.ccall('getmsg_c', null, ['string', 'number', 'number'], ['LONG', 1841, msgPtr]);
      const msg = this.module.UTF8ToString(msgPtr, 1841);
      this.module._free(msgPtr);
      this.module.ccall('reset_c', null, [], []);
      throw new Error(`SPICE: ${msg}`);
    }
  }

  private allocString(str: string): number {
    const ptr = this.module._malloc(str.length + 1);
    this.module.stringToUTF8(str, ptr, str.length + 1);
    return ptr; // caller must free
  }

  private readDoubleArray(ptr: number, count: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < count; i++) {
      result.push(this.module.getValue(ptr + i * DOUBLE_SIZE, 'double'));
    }
    return result;
  }

  private writeDoubleArray(values: number[]): number {
    const ptr = this.module._malloc(DOUBLE_SIZE * values.length);
    for (let i = 0; i < values.length; i++) {
      this.module.setValue(ptr + i * DOUBLE_SIZE, values[i], 'double');
    }
    return ptr; // caller must free
  }

  // --- Kernel Management ---

  async furnish(source: KernelSource): Promise<void> {
    if (source.type === 'buffer') {
      const data = new Uint8Array(source.data);
      const path = `_buffer_${bufferFileCount++}.bin`;
      this.module.FS.writeFile(path, data, { encoding: 'binary' });
      this.module.ccall('furnsh_c', null, ['string'], [path]);
      this.checkError();
      this.fileMap.set(source.filename, path);
      this.kernelCount++;
    } else if (source.type === 'url') {
      const response = await fetch(source.url);
      if (!response.ok) throw new Error(`Failed to fetch kernel: ${source.url} (${response.status})`);
      const buffer = await response.arrayBuffer();
      await this.furnish({ type: 'buffer', data: buffer, filename: source.url });
    } else {
      // file path — write directly to Emscripten FS
      this.module.ccall('furnsh_c', null, ['string'], [source.path]);
      this.checkError();
      this.kernelCount++;
    }
  }

  unload(filename: string): void {
    const path = this.fileMap.get(filename) ?? filename;
    this.module.ccall('unload_c', null, ['string'], [path]);
    this.checkError();
    if (this.fileMap.has(filename)) {
      this.module.FS.unlink(path);
      this.fileMap.delete(filename);
    }
    this.kernelCount--;
  }

  clear(): void {
    this.module.ccall('kclear_c', null, [], []);
    this.checkError();
    this.fileMap.clear();
    this.kernelCount = 0;
  }

  totalLoaded(): number {
    return this.kernelCount;
  }

  // --- Time ---

  str2et(timeString: string): number {
    // CSPICE str2et_c doesn't accept trailing "Z" (ISO 8601 UTC marker)
    const ts = timeString.endsWith('Z') ? timeString.slice(0, -1) : timeString;
    const etPtr = this.module._malloc(DOUBLE_SIZE);
    this.module.ccall('str2et_c', null, ['string', 'number'], [ts, etPtr]);
    const et = this.module.getValue(etPtr, 'double');
    this.module._free(etPtr);
    this.checkError();
    return et;
  }

  et2utc(et: number, format: 'C' | 'D' | 'J' | 'ISOC' | 'ISOD', precision: number): string {
    const strPtr = this.module._malloc(100);
    this.module.ccall('et2utc_c', null,
      ['number', 'string', 'number', 'number', 'number'],
      [et, format, precision, 100, strPtr]);
    const str = this.module.UTF8ToString(strPtr, 100);
    this.module._free(strPtr);
    this.checkError();
    return str;
  }

  utc2et(utcString: string): number {
    const etPtr = this.module._malloc(DOUBLE_SIZE);
    this.module.ccall('utc2et_c', null, ['string', 'number'], [utcString, etPtr]);
    const et = this.module.getValue(etPtr, 'double');
    this.module._free(etPtr);
    this.checkError();
    return et;
  }

  et2lst(et: number, bodyId: number, longitude: number, type: 'PLANETOCENTRIC' | 'PLANETOGRAPHIC'): { hr: number; mn: number; sc: number; time: string; ampm: string } {
    const hrPtr = this.module._malloc(INT_SIZE);
    const mnPtr = this.module._malloc(INT_SIZE);
    const scPtr = this.module._malloc(INT_SIZE);
    const timePtr = this.module._malloc(100);
    const ampmPtr = this.module._malloc(100);
    this.module.ccall('et2lst_c', null,
      ['number', 'number', 'number', 'string', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
      [et, bodyId, longitude, type, 100, 100, hrPtr, mnPtr, scPtr, timePtr, ampmPtr]);
    const hr = this.module.getValue(hrPtr, 'i32');
    const mn = this.module.getValue(mnPtr, 'i32');
    const sc = this.module.getValue(scPtr, 'i32');
    const time = this.module.UTF8ToString(timePtr, 100);
    const ampm = this.module.UTF8ToString(ampmPtr, 100);
    this.module._free(hrPtr); this.module._free(mnPtr); this.module._free(scPtr);
    this.module._free(timePtr); this.module._free(ampmPtr);
    this.checkError();
    return { hr, mn, sc, time, ampm };
  }

  timout(et: number, pictur: string): string {
    const strPtr = this.module._malloc(100);
    this.module.ccall('timout_c', null,
      ['number', 'string', 'number', 'number'],
      [et, pictur, 100, strPtr]);
    const str = this.module.UTF8ToString(strPtr, 100);
    this.module._free(strPtr);
    this.checkError();
    return str;
  }

  unitim(epoch: number, insys: string, outsys: string): number {
    const result = this.module.ccall('unitim_c', 'number',
      ['number', 'string', 'string'],
      [epoch, insys, outsys]) as number;
    this.checkError();
    return result;
  }

  // --- State vectors ---

  spkpos(target: string, et: number, frame: string, abcorr: AberrationCorrection, observer: string): { position: Vec3; lightTime: number } {
    const ptargPtr = this.module._malloc(DOUBLE_SIZE * 3);
    const ltPtr = this.module._malloc(DOUBLE_SIZE);
    this.module.ccall('spkpos_c', null,
      ['string', 'number', 'string', 'string', 'string', 'number', 'number'],
      [target, et, frame, abcorr, observer, ptargPtr, ltPtr]);
    const position = this.readDoubleArray(ptargPtr, 3) as unknown as Vec3;
    const lightTime = this.module.getValue(ltPtr, 'double');
    this.module._free(ptargPtr); this.module._free(ltPtr);
    this.checkError();
    return { position, lightTime };
  }

  spkezr(target: string, et: number, frame: string, abcorr: AberrationCorrection, observer: string): { state: StateVector; lightTime: number } {
    const statePtr = this.module._malloc(DOUBLE_SIZE * 6);
    const ltPtr = this.module._malloc(DOUBLE_SIZE);
    this.module.ccall('spkezr_c', null,
      ['string', 'number', 'string', 'string', 'string', 'number', 'number'],
      [target, et, frame, abcorr, observer, statePtr, ltPtr]);
    const state = this.readDoubleArray(statePtr, 6) as unknown as StateVector;
    const lightTime = this.module.getValue(ltPtr, 'double');
    this.module._free(statePtr); this.module._free(ltPtr);
    this.checkError();
    return { state, lightTime };
  }

  // --- Frame transforms ---

  pxform(from: string, to: string, et: number): RotationMatrix {
    const matPtr = this.module._malloc(DOUBLE_SIZE * 9);
    this.module.ccall('pxform_c', null,
      ['string', 'string', 'number', 'number'],
      [from, to, et, matPtr]);
    const mat = this.readDoubleArray(matPtr, 9) as unknown as RotationMatrix;
    this.module._free(matPtr);
    this.checkError();
    return mat;
  }

  sxform(from: string, to: string, et: number): StateTransformMatrix {
    const matPtr = this.module._malloc(DOUBLE_SIZE * 36);
    this.module.ccall('sxform_c', null,
      ['string', 'string', 'number', 'number'],
      [from, to, et, matPtr]);
    const mat = this.readDoubleArray(matPtr, 36);
    this.module._free(matPtr);
    this.checkError();
    return mat;
  }

  // --- Surface geometry ---

  sincpt(method: string, target: string, et: number, fixref: string, abcorr: AberrationCorrection, observer: string, dref: string, dvec: Vec3): SurfaceIntercept {
    const spointPtr = this.module._malloc(DOUBLE_SIZE * 3);
    const trgepcPtr = this.module._malloc(DOUBLE_SIZE);
    const srfvecPtr = this.module._malloc(DOUBLE_SIZE * 3);
    const foundPtr = this.module._malloc(INT_SIZE);
    const dvecPtr = this.writeDoubleArray(dvec);

    this.module.ccall('sincpt_c', null,
      ['string', 'string', 'number', 'string', 'string', 'string', 'string', 'number', 'number', 'number', 'number', 'number'],
      [method, target, et, fixref, abcorr, observer, dref, dvecPtr, spointPtr, trgepcPtr, srfvecPtr, foundPtr]);

    const point = this.readDoubleArray(spointPtr, 3) as unknown as Vec3;
    const trgepc = this.module.getValue(trgepcPtr, 'double');
    const srfvec = this.readDoubleArray(srfvecPtr, 3) as unknown as Vec3;
    const found = this.module.getValue(foundPtr, 'i32') !== 0;

    this.module._free(dvecPtr); this.module._free(spointPtr);
    this.module._free(trgepcPtr); this.module._free(srfvecPtr); this.module._free(foundPtr);
    this.checkError();
    return { point, found, trgepc, srfvec };
  }

  subpnt(method: string, target: string, et: number, fixref: string, abcorr: AberrationCorrection, observer: string): SubPoint {
    const spointPtr = this.module._malloc(DOUBLE_SIZE * 3);
    const trgepcPtr = this.module._malloc(DOUBLE_SIZE);
    const srfvecPtr = this.module._malloc(DOUBLE_SIZE * 3);

    this.module.ccall('subpnt_c', null,
      ['string', 'string', 'number', 'string', 'string', 'string', 'number', 'number', 'number'],
      [method, target, et, fixref, abcorr, observer, spointPtr, trgepcPtr, srfvecPtr]);

    const point = this.readDoubleArray(spointPtr, 3) as unknown as Vec3;
    const srfvec = this.readDoubleArray(srfvecPtr, 3) as unknown as Vec3;
    const altitude = Math.sqrt(srfvec[0] * srfvec[0] + srfvec[1] * srfvec[1] + srfvec[2] * srfvec[2]);

    // Convert point to lat/lon using reclat
    const { latitude, longitude } = this.reclat(point);

    this.module._free(spointPtr); this.module._free(trgepcPtr); this.module._free(srfvecPtr);
    this.checkError();
    return { point, altitude, longitude, latitude };
  }

  subslr(method: string, target: string, et: number, fixref: string, abcorr: AberrationCorrection, observer: string): SubPoint {
    const spointPtr = this.module._malloc(DOUBLE_SIZE * 3);
    const trgepcPtr = this.module._malloc(DOUBLE_SIZE);
    const srfvecPtr = this.module._malloc(DOUBLE_SIZE * 3);

    this.module.ccall('subslr_c', null,
      ['string', 'string', 'number', 'string', 'string', 'string', 'number', 'number', 'number'],
      [method, target, et, fixref, abcorr, observer, spointPtr, trgepcPtr, srfvecPtr]);

    const point = this.readDoubleArray(spointPtr, 3) as unknown as Vec3;
    const srfvec = this.readDoubleArray(srfvecPtr, 3) as unknown as Vec3;
    const altitude = Math.sqrt(srfvec[0] * srfvec[0] + srfvec[1] * srfvec[1] + srfvec[2] * srfvec[2]);
    const { latitude, longitude } = this.reclat(point);

    this.module._free(spointPtr); this.module._free(trgepcPtr); this.module._free(srfvecPtr);
    this.checkError();
    return { point, altitude, longitude, latitude };
  }

  ilumin(method: string, target: string, et: number, fixref: string, abcorr: AberrationCorrection, observer: string, spoint: Vec3): IlluminationAngles {
    const trgepcPtr = this.module._malloc(DOUBLE_SIZE);
    const srfvecPtr = this.module._malloc(DOUBLE_SIZE * 3);
    const phasePtr = this.module._malloc(DOUBLE_SIZE);
    const solarPtr = this.module._malloc(DOUBLE_SIZE);
    const emissnPtr = this.module._malloc(DOUBLE_SIZE);
    const spointPtr = this.writeDoubleArray(spoint);

    this.module.ccall('ilumin_c', null,
      ['string', 'string', 'number', 'string', 'string', 'string', 'number', 'number', 'number', 'number', 'number'],
      [method, target, et, fixref, abcorr, observer, spointPtr, trgepcPtr, srfvecPtr, phasePtr, solarPtr, emissnPtr]);

    const phaseAngle = this.module.getValue(phasePtr, 'double');
    const solarIncidence = this.module.getValue(solarPtr, 'double');
    const emission = this.module.getValue(emissnPtr, 'double');

    this.module._free(spointPtr); this.module._free(trgepcPtr);
    this.module._free(srfvecPtr); this.module._free(phasePtr);
    this.module._free(solarPtr); this.module._free(emissnPtr);
    this.checkError();
    return { phaseAngle, solarIncidence, emission };
  }

  // --- Orbital elements ---

  oscelt(state: StateVector, et: number, mu: number): OrbitalElements {
    const statePtr = this.writeDoubleArray(state);
    const eltsPtr = this.module._malloc(DOUBLE_SIZE * 8);

    this.module.ccall('oscelt_c', null,
      ['number', 'number', 'number', 'number'],
      [statePtr, et, mu, eltsPtr]);

    const elts = this.readDoubleArray(eltsPtr, 8);
    this.module._free(statePtr); this.module._free(eltsPtr);
    this.checkError();
    return {
      rp: elts[0], ecc: elts[1], inc: elts[2], lnode: elts[3],
      argp: elts[4], m0: elts[5], t0: elts[6], mu: elts[7],
    };
  }

  conics(elements: OrbitalElements, et: number): StateVector {
    const eltsPtr = this.writeDoubleArray([
      elements.rp, elements.ecc, elements.inc, elements.lnode,
      elements.argp, elements.m0, elements.t0, elements.mu,
    ]);
    const statePtr = this.module._malloc(DOUBLE_SIZE * 6);

    this.module.ccall('conics_c', null,
      ['number', 'number', 'number'],
      [eltsPtr, et, statePtr]);

    const state = this.readDoubleArray(statePtr, 6) as unknown as StateVector;
    this.module._free(eltsPtr); this.module._free(statePtr);
    this.checkError();
    return state;
  }

  // --- Body data ---

  bodvcd(bodyId: number, item: string): number[] {
    const dimPtr = this.module._malloc(INT_SIZE);
    const valuesPtr = this.module._malloc(DOUBLE_SIZE * 10);
    this.module.ccall('bodvcd_c', null,
      ['number', 'string', 'number', 'number', 'number'],
      [bodyId, item, 10, dimPtr, valuesPtr]);
    const dim = this.module.getValue(dimPtr, 'i32');
    const values = this.readDoubleArray(valuesPtr, dim);
    this.module._free(dimPtr); this.module._free(valuesPtr);
    this.checkError();
    return values;
  }

  bodvrd(body: string, item: string): number[] {
    const dimPtr = this.module._malloc(INT_SIZE);
    const valuesPtr = this.module._malloc(DOUBLE_SIZE * 10);
    this.module.ccall('bodvrd_c', null,
      ['string', 'string', 'number', 'number', 'number'],
      [body, item, 10, dimPtr, valuesPtr]);
    const dim = this.module.getValue(dimPtr, 'i32');
    const values = this.readDoubleArray(valuesPtr, dim);
    this.module._free(dimPtr); this.module._free(valuesPtr);
    this.checkError();
    return values;
  }

  bodc2n(code: number): string | null {
    const namePtr = this.module._malloc(100);
    const foundPtr = this.module._malloc(INT_SIZE);
    this.module.ccall('bodc2n_c', null,
      ['number', 'number', 'number', 'number'],
      [code, 100, namePtr, foundPtr]);
    const found = this.module.getValue(foundPtr, 'i32');
    const name = this.module.UTF8ToString(namePtr, 100);
    this.module._free(namePtr); this.module._free(foundPtr);
    this.checkError();
    return found ? name : null;
  }

  bodn2c(name: string): number | null {
    const codePtr = this.module._malloc(INT_SIZE);
    const foundPtr = this.module._malloc(INT_SIZE);
    this.module.ccall('bodn2c_c', null,
      ['string', 'number', 'number'],
      [name, codePtr, foundPtr]);
    const found = this.module.getValue(foundPtr, 'i32');
    const code = this.module.getValue(codePtr, 'i32');
    this.module._free(codePtr); this.module._free(foundPtr);
    this.checkError();
    return found ? code : null;
  }

  // --- Geometry finders ---

  gfposc(target: string, frame: string, abcorr: string, observer: string, crdsys: string, coord: string, relate: string, refval: number, adjust: number, step: number, cnfine: TimeWindow[]): TimeWindow[] {
    const MAXWIN = 2000;
    const cnfineCell = this.createSpiceWindow(cnfine, MAXWIN);
    const resultCell = this.createEmptySpiceWindow(MAXWIN);

    this.module.ccall('gfposc_c', null,
      ['string', 'string', 'string', 'string', 'string', 'string', 'string', 'number', 'number', 'number', 'number', 'number'],
      [target, frame, abcorr, observer, crdsys, coord, relate, refval, adjust, step, MAXWIN, cnfineCell.cellPtr, resultCell.cellPtr]);

    const windows = this.readSpiceWindow(resultCell.cellPtr);
    this.freeSpiceCell(cnfineCell);
    this.freeSpiceCell(resultCell);
    this.checkError();
    return windows;
  }

  gfsep(target1: string, shape1: string, frame1: string, target2: string, shape2: string, frame2: string, abcorr: string, observer: string, relate: string, refval: number, adjust: number, step: number, cnfine: TimeWindow[]): TimeWindow[] {
    const MAXWIN = 2000;
    const cnfineCell = this.createSpiceWindow(cnfine, MAXWIN);
    const resultCell = this.createEmptySpiceWindow(MAXWIN);

    this.module.ccall('gfsep_c', null,
      ['string', 'string', 'string', 'string', 'string', 'string', 'string', 'string', 'string', 'number', 'number', 'number', 'number', 'number'],
      [target1, shape1, frame1, target2, shape2, frame2, abcorr, observer, relate, refval, adjust, step, MAXWIN, cnfineCell.cellPtr, resultCell.cellPtr]);

    const windows = this.readSpiceWindow(resultCell.cellPtr);
    this.freeSpiceCell(cnfineCell);
    this.freeSpiceCell(resultCell);
    this.checkError();
    return windows;
  }

  gfoclt(occtyp: string, front: string, fshape: string, fframe: string, back: string, bshape: string, bframe: string, abcorr: string, observer: string, step: number, cnfine: TimeWindow[]): TimeWindow[] {
    const MAXWIN = 2000;
    const cnfineCell = this.createSpiceWindow(cnfine, MAXWIN);
    const resultCell = this.createEmptySpiceWindow(MAXWIN);

    this.module.ccall('gfoclt_c', null,
      ['string', 'string', 'string', 'string', 'string', 'string', 'string', 'string', 'string', 'number', 'number', 'number'],
      [occtyp, front, fshape, fframe, back, bshape, bframe, abcorr, observer, step, cnfineCell.cellPtr, resultCell.cellPtr]);

    const windows = this.readSpiceWindow(resultCell.cellPtr);
    this.freeSpiceCell(cnfineCell);
    this.freeSpiceCell(resultCell);
    this.checkError();
    return windows;
  }

  gfdist(target: string, abcorr: string, observer: string, relate: string, refval: number, adjust: number, step: number, cnfine: TimeWindow[]): TimeWindow[] {
    const MAXWIN = 2000;
    const cnfineCell = this.createSpiceWindow(cnfine, MAXWIN);
    const resultCell = this.createEmptySpiceWindow(MAXWIN);

    this.module.ccall('gfdist_c', null,
      ['string', 'string', 'string', 'string', 'number', 'number', 'number', 'number', 'number'],
      [target, abcorr, observer, relate, refval, adjust, step, MAXWIN, cnfineCell.cellPtr, resultCell.cellPtr]);

    const windows = this.readSpiceWindow(resultCell.cellPtr);
    this.freeSpiceCell(cnfineCell);
    this.freeSpiceCell(resultCell);
    this.checkError();
    return windows;
  }

  // --- SPICE window helpers ---
  //
  // CSPICE cells consist of a SpiceCell struct (9 fields = 36 bytes in WASM32)
  // plus a separate data array of (CTRLSZ + size) doubles.
  //
  // SpiceCell layout (WASM32, 4-byte aligned):
  //   +0  dtype    (i32)  — SPICE_DP=1 for double windows
  //   +4  length   (i32)  — 0 for doubles
  //   +8  size     (i32)  — max # of elements
  //  +12  card     (i32)  — current # of elements
  //  +16  isSet    (i32)  — SPICETRUE=1
  //  +20  adjust   (i32)  — 0
  //  +24  init     (i32)  — 0
  //  +28  base     (ptr)  — start of data array
  //  +32  data     (ptr)  — start of actual elements (base + CTRLSZ*8)
  //
  // zzsynccl_c syncs struct ↔ data array's first CTRLSZ doubles.

  private static readonly SPICE_CELL_CTRLSZ = 6;
  private static readonly CELL_STRUCT_SIZE = 36; // 7 ints + 2 pointers, all 4 bytes

  private allocSpiceDoubleCell(maxSize: number): { cellPtr: number; dataPtr: number } {
    const ctrlsz = Spice.SPICE_CELL_CTRLSZ;

    // Allocate data array: CTRLSZ + maxSize doubles
    const totalDoubles = ctrlsz + maxSize;
    const dataPtr = this.module._malloc(DOUBLE_SIZE * totalDoubles);
    // Zero the data region
    for (let i = 0; i < totalDoubles; i++) {
      this.module.setValue(dataPtr + i * DOUBLE_SIZE, 0, 'double');
    }

    // Allocate SpiceCell struct
    const cellPtr = this.module._malloc(Spice.CELL_STRUCT_SIZE);

    // Initialize struct fields (must set dtype before any CSPICE call)
    this.module.setValue(cellPtr + 0, 1, 'i32');       // dtype = SPICE_DP
    this.module.setValue(cellPtr + 4, 0, 'i32');       // length = 0
    this.module.setValue(cellPtr + 8, maxSize, 'i32'); // size
    this.module.setValue(cellPtr + 12, 0, 'i32');      // card = 0
    this.module.setValue(cellPtr + 16, 1, 'i32');      // isSet = SPICETRUE
    this.module.setValue(cellPtr + 20, 0, 'i32');      // adjust = SPICEFALSE
    this.module.setValue(cellPtr + 24, 0, 'i32');      // init = SPICEFALSE
    this.module.setValue(cellPtr + 28, dataPtr, 'i32');                        // base
    this.module.setValue(cellPtr + 32, dataPtr + ctrlsz * DOUBLE_SIZE, 'i32'); // data

    // ssize_c validates + syncs the cell
    this.module.ccall('ssize_c', null, ['number', 'number'], [maxSize, cellPtr]);

    return { cellPtr, dataPtr };
  }

  private createSpiceWindow(windows: TimeWindow[], maxSize: number): { cellPtr: number; dataPtr: number } {
    const cell = this.allocSpiceDoubleCell(maxSize);
    for (const w of windows) {
      this.module.ccall('wninsd_c', null, ['number', 'number', 'number'], [w.start, w.end, cell.cellPtr]);
    }
    return cell;
  }

  private createEmptySpiceWindow(maxSize: number): { cellPtr: number; dataPtr: number } {
    return this.allocSpiceDoubleCell(maxSize);
  }

  private readSpiceWindow(cellPtr: number): TimeWindow[] {
    const card = this.module.ccall('wncard_c', 'number', ['number'], [cellPtr]) as number;
    const result: TimeWindow[] = [];
    const startPtr = this.module._malloc(DOUBLE_SIZE);
    const endPtr = this.module._malloc(DOUBLE_SIZE);
    for (let i = 0; i < card; i++) {
      this.module.ccall('wnfetd_c', null, ['number', 'number', 'number', 'number'], [cellPtr, i, startPtr, endPtr]);
      result.push({
        start: this.module.getValue(startPtr, 'double'),
        end: this.module.getValue(endPtr, 'double'),
      });
    }
    this.module._free(startPtr);
    this.module._free(endPtr);
    return result;
  }

  private freeSpiceCell(cell: { cellPtr: number; dataPtr: number }): void {
    this.module._free(cell.cellPtr);
    this.module._free(cell.dataPtr);
  }

  // --- Math ---

  mxv(matrix: RotationMatrix, vin: Vec3): Vec3 {
    const mPtr = this.writeDoubleArray(matrix);
    const vPtr = this.writeDoubleArray(vin);
    const outPtr = this.module._malloc(DOUBLE_SIZE * 3);
    this.module.ccall('mxv_c', null, ['number', 'number', 'number'], [mPtr, vPtr, outPtr]);
    const result = this.readDoubleArray(outPtr, 3) as unknown as Vec3;
    this.module._free(mPtr); this.module._free(vPtr); this.module._free(outPtr);
    return result;
  }

  mtxv(matrix: RotationMatrix, vin: Vec3): Vec3 {
    const mPtr = this.writeDoubleArray(matrix);
    const vPtr = this.writeDoubleArray(vin);
    const outPtr = this.module._malloc(DOUBLE_SIZE * 3);
    this.module.ccall('mtxv_c', null, ['number', 'number', 'number'], [mPtr, vPtr, outPtr]);
    const result = this.readDoubleArray(outPtr, 3) as unknown as Vec3;
    this.module._free(mPtr); this.module._free(vPtr); this.module._free(outPtr);
    return result;
  }

  vcrss(v1: Vec3, v2: Vec3): Vec3 {
    const v1Ptr = this.writeDoubleArray(v1);
    const v2Ptr = this.writeDoubleArray(v2);
    const outPtr = this.module._malloc(DOUBLE_SIZE * 3);
    this.module.ccall('vcrss_c', null, ['number', 'number', 'number'], [v1Ptr, v2Ptr, outPtr]);
    const result = this.readDoubleArray(outPtr, 3) as unknown as Vec3;
    this.module._free(v1Ptr); this.module._free(v2Ptr); this.module._free(outPtr);
    return result;
  }

  vnorm(v: Vec3): number {
    const vPtr = this.writeDoubleArray(v);
    const result = this.module.ccall('vnorm_c', 'number', ['number'], [vPtr]) as number;
    this.module._free(vPtr);
    return result;
  }

  vdot(v1: Vec3, v2: Vec3): number {
    const v1Ptr = this.writeDoubleArray(v1);
    const v2Ptr = this.writeDoubleArray(v2);
    const result = this.module.ccall('vdot_c', 'number', ['number', 'number'], [v1Ptr, v2Ptr]) as number;
    this.module._free(v1Ptr); this.module._free(v2Ptr);
    return result;
  }

  vhat(v: Vec3): Vec3 {
    const vPtr = this.writeDoubleArray(v);
    const outPtr = this.module._malloc(DOUBLE_SIZE * 3);
    this.module.ccall('vhat_c', null, ['number', 'number'], [vPtr, outPtr]);
    const result = this.readDoubleArray(outPtr, 3) as unknown as Vec3;
    this.module._free(vPtr); this.module._free(outPtr);
    return result;
  }

  vsub(v1: Vec3, v2: Vec3): Vec3 {
    const v1Ptr = this.writeDoubleArray(v1);
    const v2Ptr = this.writeDoubleArray(v2);
    const outPtr = this.module._malloc(DOUBLE_SIZE * 3);
    this.module.ccall('vsub_c', null, ['number', 'number', 'number'], [v1Ptr, v2Ptr, outPtr]);
    const result = this.readDoubleArray(outPtr, 3) as unknown as Vec3;
    this.module._free(v1Ptr); this.module._free(v2Ptr); this.module._free(outPtr);
    return result;
  }

  vadd(v1: Vec3, v2: Vec3): Vec3 {
    const v1Ptr = this.writeDoubleArray(v1);
    const v2Ptr = this.writeDoubleArray(v2);
    const outPtr = this.module._malloc(DOUBLE_SIZE * 3);
    this.module.ccall('vadd_c', null, ['number', 'number', 'number'], [v1Ptr, v2Ptr, outPtr]);
    const result = this.readDoubleArray(outPtr, 3) as unknown as Vec3;
    this.module._free(v1Ptr); this.module._free(v2Ptr); this.module._free(outPtr);
    return result;
  }

  vscl(s: number, v: Vec3): Vec3 {
    const vPtr = this.writeDoubleArray(v);
    const outPtr = this.module._malloc(DOUBLE_SIZE * 3);
    this.module.ccall('vscl_c', null, ['number', 'number', 'number'], [s, vPtr, outPtr]);
    const result = this.readDoubleArray(outPtr, 3) as unknown as Vec3;
    this.module._free(vPtr); this.module._free(outPtr);
    return result;
  }

  vsep(v1: Vec3, v2: Vec3): number {
    const v1Ptr = this.writeDoubleArray(v1);
    const v2Ptr = this.writeDoubleArray(v2);
    const result = this.module.ccall('vsep_c', 'number', ['number', 'number'], [v1Ptr, v2Ptr]) as number;
    this.module._free(v1Ptr); this.module._free(v2Ptr);
    return result;
  }

  recrad(rectan: Vec3): { range: number; ra: number; dec: number } {
    const recPtr = this.writeDoubleArray(rectan);
    const rangePtr = this.module._malloc(DOUBLE_SIZE);
    const raPtr = this.module._malloc(DOUBLE_SIZE);
    const decPtr = this.module._malloc(DOUBLE_SIZE);
    this.module.ccall('recrad_c', null,
      ['number', 'number', 'number', 'number'],
      [recPtr, rangePtr, raPtr, decPtr]);
    const range = this.module.getValue(rangePtr, 'double');
    const ra = this.module.getValue(raPtr, 'double');
    const dec = this.module.getValue(decPtr, 'double');
    this.module._free(recPtr); this.module._free(rangePtr);
    this.module._free(raPtr); this.module._free(decPtr);
    return { range, ra, dec };
  }

  // --- Internal helpers ---

  private reclat(rectan: Vec3): { radius: number; longitude: number; latitude: number } {
    const recPtr = this.writeDoubleArray(rectan);
    const rPtr = this.module._malloc(DOUBLE_SIZE);
    const lonPtr = this.module._malloc(DOUBLE_SIZE);
    const latPtr = this.module._malloc(DOUBLE_SIZE);
    this.module.ccall('reclat_c', null,
      ['number', 'number', 'number', 'number'],
      [recPtr, rPtr, lonPtr, latPtr]);
    const radius = this.module.getValue(rPtr, 'double');
    const longitude = this.module.getValue(lonPtr, 'double');
    const latitude = this.module.getValue(latPtr, 'double');
    this.module._free(recPtr); this.module._free(rPtr);
    this.module._free(lonPtr); this.module._free(latPtr);
    return { radius, longitude, latitude };
  }
}
