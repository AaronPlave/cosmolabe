// Low-level marshaling over the CSPICE-WASM module. Owns pointer lifetimes and
// the per-function calling contract. Kernel bytes are written into the Emscripten
// in-memory FS and furnsh'd by path: the engine never parses kernels itself, it
// hands paths to CSPICE, satisfying "the SPICE engine never reads kernel bytes
// directly" (the bytes arrive via the PAL, are staged here, then loaded by CSPICE).

import type { CSpiceModule } from 'cspice-wasm/wasm/cspice.mjs';
import {
  SpiceError,
  type AberrationCorrection,
  type CartesianState,
  type DskShape,
  type FovResult,
  type IluminResult,
  type InterceptResult,
  type OsculatingElements,
  type PositionResult,
  type StateBatchArrays,
  type StateVector,
  type SubPointResult,
  type Vec3,
} from './index.ts';

const KERNEL_DIR = '/kernels';

export class SpiceBindings {
  // The stack of active per-call allocation scopes. str() (and any scratch()
  // allocation) registers its pointer in the innermost scope, and scope() frees
  // every registered pointer in a finally when the call returns or throws, so the
  // Emscripten heap does not grow monotonically (the C strings and scratch blocks
  // each SPICE call allocates are reclaimed deterministically, leak-free).
  private readonly scopes: number[][] = [];

  constructor(private readonly mod: CSpiceModule) {
    this.scope(() => {
      // Route SPICE errors to return-mode so failures surface as typed errors
      // rather than aborting the WASM runtime.
      this.call('erract_c', this.str('SET'), 0, this.str('RETURN'));
      this.call('errprt_c', this.str('SET'), 0, this.str('NONE'));
      if (!this.mod.FS.analyzePath(KERNEL_DIR).exists) this.mod.FS.mkdir(KERNEL_DIR);
    });
  }

  /**
   * Run `fn` inside a fresh allocation scope: every pointer str()/scratch() hands
   * out while it runs is freed when fn returns or throws. Scopes nest, so a public
   * method that calls another stays balanced.
   */
  private scope<T>(fn: () => T): T {
    const allocs: number[] = [];
    this.scopes.push(allocs);
    try {
      return fn();
    } finally {
      this.scopes.pop();
      for (const ptr of allocs) this.mod._free(ptr);
    }
  }

  /** Register a heap pointer in the innermost active scope so it is freed on exit. */
  private track(ptr: number): number {
    const top = this.scopes[this.scopes.length - 1];
    if (top) top.push(ptr);
    return ptr;
  }

  /** Allocate `size` scratch bytes whose lifetime is the current call scope. */
  private scratch(size: number): number {
    return this.track(this.mod._malloc(size));
  }

  private call(name: string, ...args: number[]): number {
    const fn = this.mod[`_${name}`];
    if (!fn) throw new SpiceError(`CSPICE export _${name} is not present in the build`);
    return fn(...args);
  }

  /** Allocate a NUL-terminated C string; freed when the current scope() exits. */
  private str(s: string): number {
    const n = this.mod.lengthBytesUTF8(s) + 1;
    const ptr = this.track(this.mod._malloc(n));
    this.mod.stringToUTF8(s, ptr, n);
    return ptr;
  }

  private readDouble(ptr: number): number {
    return this.mod.getValue(ptr, 'double');
  }

  private readInt(ptr: number): number {
    return this.mod.getValue(ptr, 'i32');
  }

  /** Throw a typed SpiceError if the last SPICE call failed; reset the engine. */
  private checkFailed(): void {
    if (this.call('failed_c') === 0) return;
    this.scope(() => {
      const shortPtr = this.scratch(64);
      const longPtr = this.scratch(1841);
      this.call('getmsg_c', this.str('SHORT'), 64, shortPtr);
      this.call('getmsg_c', this.str('LONG'), 1841, longPtr);
      const short = this.mod.UTF8ToString(shortPtr);
      const long = this.mod.UTF8ToString(longPtr);
      this.call('reset_c');
      throw new SpiceError(long || short || 'SPICE call failed', short || undefined);
    });
  }

  tkvrsn(): string {
    return this.scope(() => {
      const ptr = this.call('tkvrsn_c', this.str('TOOLKIT'));
      return this.mod.UTF8ToString(ptr);
    });
  }

  furnsh(name: string, bytes: Uint8Array): void {
    this.scope(() => {
      const path = `${KERNEL_DIR}/${name}`;
      this.mod.FS.writeFile(path, bytes);
      this.call('furnsh_c', this.str(path));
      this.checkFailed();
    });
  }

  unload(name: string): void {
    this.scope(() => {
      const path = `${KERNEL_DIR}/${name}`;
      this.call('unload_c', this.str(path));
      this.checkFailed();
      if (this.mod.FS.analyzePath(path).exists) this.mod.FS.unlink(path);
    });
  }

  kclear(): void {
    this.call('kclear_c');
    this.checkFailed();
  }

  ktotal(kind = 'ALL'): number {
    return this.scope(() => {
      const out = this.scratch(4);
      this.call('ktotal_c', this.str(kind), out);
      this.checkFailed();
      return this.readInt(out);
    });
  }

  str2et(utc: string): number {
    return this.scope(() => {
      const out = this.scratch(8);
      this.call('str2et_c', this.str(utc), out);
      this.checkFailed();
      return this.readDouble(out);
    });
  }

  utc2et(utc: string): number {
    return this.scope(() => {
      const out = this.scratch(8);
      this.call('utc2et_c', this.str(utc), out);
      this.checkFailed();
      return this.readDouble(out);
    });
  }

  et2utc(et: number, format: string, precision: number): string {
    return this.scope(() => {
      const len = 64;
      const out = this.scratch(len);
      this.call('et2utc_c', et, this.str(format), precision, len, out);
      this.checkFailed();
      return this.mod.UTF8ToString(out);
    });
  }

  // Ephemeris time to a TDB ISO calendar string via timout_c with a ::TDB picture, so
  // the displayed epoch can carry its actual time system rather than implying UTC.
  et2tdb(et: number, precision: number): string {
    return this.scope(() => {
      const len = 64;
      const frac = Math.max(0, Math.min(9, Math.trunc(precision)));
      const pic =
        frac > 0 ? `YYYY-MM-DDTHR:MN:SC.${'#'.repeat(frac)} ::TDB` : 'YYYY-MM-DDTHR:MN:SC ::TDB';
      const out = this.scratch(len);
      this.call('timout_c', et, this.str(pic), len, out);
      this.checkFailed();
      return this.mod.UTF8ToString(out);
    });
  }

  /** Rectangular (body-fixed km) to geodetic longitude/latitude (rad) and altitude (km). */
  recgeo(rectan: Vec3, re: number, f: number): { lon: number; lat: number; alt: number } {
    return this.scope(() => {
      const r = this.scratch(24);
      const lon = this.scratch(8);
      const lat = this.scratch(8);
      const alt = this.scratch(8);
      this.writeVec3(r, rectan);
      this.call('recgeo_c', r, re, f, lon, lat, alt);
      this.checkFailed();
      return { lon: this.readDouble(lon), lat: this.readDouble(lat), alt: this.readDouble(alt) };
    });
  }

  /** Local solar time at a body-fixed longitude (rad): hour/min/sec and formatted strings. */
  et2lst(
    et: number,
    body: number,
    lon: number,
    type: string,
  ): { hr: number; mn: number; sc: number; time: string; ampm: string } {
    return this.scope(() => {
      const len = 64;
      const hr = this.scratch(4);
      const mn = this.scratch(4);
      const sc = this.scratch(4);
      const time = this.scratch(len);
      const ampm = this.scratch(len);
      this.call('et2lst_c', et, body, lon, this.str(type), len, len, hr, mn, sc, time, ampm);
      this.checkFailed();
      return {
        hr: this.readInt(hr),
        mn: this.readInt(mn),
        sc: this.readInt(sc),
        time: this.mod.UTF8ToString(time),
        ampm: this.mod.UTF8ToString(ampm),
      };
    });
  }

  spkpos(
    target: string,
    et: number,
    frame: string,
    abcorr: AberrationCorrection,
    observer: string,
  ): PositionResult {
    return this.scope(() => {
      const pos = this.scratch(3 * 8);
      const lt = this.scratch(8);
      this.call(
        'spkpos_c',
        this.str(target),
        et,
        this.str(frame),
        this.str(abcorr),
        this.str(observer),
        pos,
        lt,
      );
      this.checkFailed();
      return {
        position: {
          x: this.readDouble(pos),
          y: this.readDouble(pos + 8),
          z: this.readDouble(pos + 16),
        },
        lightTime: this.readDouble(lt),
      };
    });
  }

  spkezr(
    target: string,
    et: number,
    frame: string,
    abcorr: AberrationCorrection,
    observer: string,
  ): StateVector {
    return this.scope(() => {
      const state = this.scratch(6 * 8);
      const lt = this.scratch(8);
      this.call(
        'spkezr_c',
        this.str(target),
        et,
        this.str(frame),
        this.str(abcorr),
        this.str(observer),
        state,
        lt,
      );
      this.checkFailed();
      return {
        position: {
          x: this.readDouble(state),
          y: this.readDouble(state + 8),
          z: this.readDouble(state + 16),
        },
        velocity: {
          x: this.readDouble(state + 24),
          y: this.readDouble(state + 32),
          z: this.readDouble(state + 40),
        },
        lightTime: this.readDouble(lt),
      };
    });
  }

  private readVec3(ptr: number): Vec3 {
    return { x: this.readDouble(ptr), y: this.readDouble(ptr + 8), z: this.readDouble(ptr + 16) };
  }

  /**
   * Batched spkpos over an epoch array: returns n*3 interleaved positions (km) in a
   * single call (one worker round-trip instead of n), reusing the string and scratch
   * allocations across the loop. (STK_PARITY_SPEC F3.)
   */
  spkposBatch(
    target: string,
    etArray: Float64Array,
    frame: string,
    abcorr: AberrationCorrection,
    observer: string,
  ): Float64Array {
    return this.scope(() => {
      const n = etArray.length;
      const out = new Float64Array(n * 3);
      const t = this.str(target);
      const f = this.str(frame);
      const a = this.str(abcorr);
      const o = this.str(observer);
      const pos = this.scratch(24);
      const lt = this.scratch(8);
      for (let k = 0; k < n; k++) {
        this.call('spkpos_c', t, etArray[k]!, f, a, o, pos, lt);
        this.checkFailed();
        out[k * 3] = this.readDouble(pos);
        out[k * 3 + 1] = this.readDouble(pos + 8);
        out[k * 3 + 2] = this.readDouble(pos + 16);
      }
      return out;
    });
  }

  spkezrBatch(
    target: string,
    etArray: Float64Array,
    frame: string,
    abcorr: AberrationCorrection,
    observer: string,
  ): StateBatchArrays {
    return this.scope(() => {
      const n = etArray.length;
      const states = new Float64Array(n * 6);
      const lightTimes = new Float64Array(n);
      const t = this.str(target);
      const f = this.str(frame);
      const a = this.str(abcorr);
      const o = this.str(observer);
      const st = this.scratch(48);
      const lt = this.scratch(8);
      for (let k = 0; k < n; k++) {
        this.call('spkezr_c', t, etArray[k]!, f, a, o, st, lt);
        this.checkFailed();
        for (let j = 0; j < 6; j++) states[k * 6 + j] = this.readDouble(st + j * 8);
        lightTimes[k] = this.readDouble(lt);
      }
      return { states, lightTimes };
    });
  }

  /** Frame name to NAIF frame id (namfrm); 0 when the name is not recognized. */
  namfrm(name: string): number {
    return this.scope(() => {
      const out = this.scratch(4);
      this.call('namfrm_c', this.str(name), out);
      this.checkFailed();
      return this.readInt(out);
    });
  }

  /** NAIF frame id to frame name (frmnam); empty string when the id is unknown. */
  frmnam(code: number): string {
    return this.scope(() => {
      const out = this.scratch(33);
      this.call('frmnam_c', code, 33, out);
      this.checkFailed();
      return this.mod.UTF8ToString(out);
    });
  }

  private writeState(ptr: number, s: CartesianState): void {
    this.mod.setValue(ptr, s.position.x, 'double');
    this.mod.setValue(ptr + 8, s.position.y, 'double');
    this.mod.setValue(ptr + 16, s.position.z, 'double');
    this.mod.setValue(ptr + 24, s.velocity.x, 'double');
    this.mod.setValue(ptr + 32, s.velocity.y, 'double');
    this.mod.setValue(ptr + 40, s.velocity.z, 'double');
  }

  private readState(ptr: number): CartesianState {
    return { position: this.readVec3(ptr), velocity: this.readVec3(ptr + 24) };
  }

  private writeVec3(ptr: number, v: Vec3): void {
    this.mod.setValue(ptr, v.x, 'double');
    this.mod.setValue(ptr + 8, v.y, 'double');
    this.mod.setValue(ptr + 16, v.z, 'double');
  }

  private readMat3(ptr: number): number[] {
    const m: number[] = [];
    for (let i = 0; i < 9; i++) m.push(this.readDouble(ptr + i * 8));
    return m;
  }

  private writeMat3(ptr: number, m: readonly number[]): void {
    for (let i = 0; i < 9; i++) this.mod.setValue(ptr + i * 8, m[i]!, 'double');
  }

  /** Two-vector attitude (twovec): the rotation whose axis `indexa` aligns with
   * `axdef` and whose axis `indexp` lies in the axdef-plndef plane (indices 1..3). */
  twovec(axdef: Vec3, indexa: number, plndef: Vec3, indexp: number): number[] {
    return this.scope(() => {
      const ax = this.scratch(24);
      const pl = this.scratch(24);
      const out = this.scratch(72);
      this.writeVec3(ax, axdef);
      this.writeVec3(pl, plndef);
      this.call('twovec_c', ax, indexa, pl, indexp, out);
      this.checkFailed();
      return this.readMat3(out);
    });
  }

  /** Rotation matrix -> SPICE quaternion [w, x, y, z] (m2q). */
  m2q(matrix: readonly number[]): number[] {
    return this.scope(() => {
      const r = this.scratch(72);
      const q = this.scratch(32);
      this.writeMat3(r, matrix);
      this.call('m2q_c', r, q);
      this.checkFailed();
      return [0, 1, 2, 3].map((i) => this.readDouble(q + i * 8));
    });
  }

  /** SPICE quaternion [w, x, y, z] -> rotation matrix (q2m). */
  q2m(quat: readonly number[]): number[] {
    return this.scope(() => {
      const q = this.scratch(32);
      const r = this.scratch(72);
      for (let i = 0; i < 4; i++) this.mod.setValue(q + i * 8, quat[i]!, 'double');
      this.call('q2m_c', q, r);
      this.checkFailed();
      return this.readMat3(r);
    });
  }

  /** Rotation axis and angle of a rotation matrix (raxisa). */
  raxisa(matrix: readonly number[]): { axis: Vec3; angle: number } {
    return this.scope(() => {
      const r = this.scratch(72);
      const axis = this.scratch(24);
      const angle = this.scratch(8);
      this.writeMat3(r, matrix);
      this.call('raxisa_c', r, axis, angle);
      this.checkFailed();
      return { axis: this.readVec3(axis), angle: this.readDouble(angle) };
    });
  }

  /** Osculating elements (RP,ECC,INC,LNODE,ARGP,M0,T0,MU) of a state about mu. */
  oscelt(state: CartesianState, et: number, mu: number): OsculatingElements {
    return this.scope(() => {
      const st = this.scratch(48);
      this.writeState(st, state);
      const elts = this.scratch(64);
      this.call('oscelt_c', st, et, mu, elts);
      this.checkFailed();
      return {
        rp: this.readDouble(elts),
        ecc: this.readDouble(elts + 8),
        inc: this.readDouble(elts + 16),
        lnode: this.readDouble(elts + 24),
        argp: this.readDouble(elts + 32),
        m0: this.readDouble(elts + 40),
        t0: this.readDouble(elts + 48),
        mu: this.readDouble(elts + 56),
      };
    });
  }

  /** Cartesian state from osculating elements, propagated to et. */
  conics(el: OsculatingElements, et: number): CartesianState {
    return this.scope(() => {
      const elts = this.scratch(64);
      const values = [el.rp, el.ecc, el.inc, el.lnode, el.argp, el.m0, el.t0, el.mu];
      values.forEach((v, i) => this.mod.setValue(elts + i * 8, v, 'double'));
      const st = this.scratch(48);
      this.call('conics_c', elts, et, st);
      this.checkFailed();
      return this.readState(st);
    });
  }

  /** Two-body propagation of a state by dt seconds about gravitational parameter mu. */
  prop2b(mu: number, state: CartesianState, dt: number): CartesianState {
    return this.scope(() => {
      const pv = this.scratch(48);
      this.writeState(pv, state);
      const out = this.scratch(48);
      this.call('prop2b_c', mu, pv, dt, out);
      this.checkFailed();
      return this.readState(out);
    });
  }

  /**
   * Write an SPK Type 13 (Hermite, unequal step) segment for `body` about `center`
   * into the in-memory FS and furnsh it, so the propagated arc is queryable through
   * the identical spkpos/spkezr path. `states` is n*6 interleaved (x,y,z,vx,vy,vz);
   * `et` is the n epochs (strictly increasing). (STK_PARITY_SPEC PROP-6.)
   */
  writeSpkType13(
    name: string,
    body: number,
    center: number,
    frame: string,
    segid: string,
    degree: number,
    et: Float64Array,
    states: Float64Array,
  ): void {
    this.scope(() => {
      const path = `${KERNEL_DIR}/${name}`;
      if (this.mod.FS.analyzePath(path).exists) this.mod.FS.unlink(path);
      const n = et.length;
      if (n < 2 || states.length !== n * 6) {
        throw new SpiceError(`writeSpkType13: need >=2 epochs and states of length 6n (n=${n})`);
      }
      const handlePtr = this.scratch(4);
      this.call('spkopn_c', this.str(path), this.str(segid.slice(0, 60) || 'BESSEL'), 0, handlePtr);
      this.checkFailed();
      const handle = this.readInt(handlePtr);

      const statesPtr = this.scratch(n * 6 * 8);
      for (let i = 0; i < n * 6; i++) this.mod.setValue(statesPtr + i * 8, states[i]!, 'double');
      const epochsPtr = this.scratch(n * 8);
      for (let k = 0; k < n; k++) this.mod.setValue(epochsPtr + k * 8, et[k]!, 'double');

      this.call(
        'spkw13_c',
        handle,
        body,
        center,
        this.str(frame),
        et[0]!,
        et[n - 1]!,
        this.str(segid),
        degree,
        n,
        statesPtr,
        epochsPtr,
      );
      this.checkFailed();
      this.call('spkcls_c', handle);
      this.checkFailed();

      this.call('furnsh_c', this.str(path));
      this.checkFailed();
    });
  }

  /**
   * Read back the bytes of a kernel in the staging FS by its furnsh/write
   * name. Lets a generated kernel (writeSpkType13, writeCk03) be furnished
   * byte-identically into another SPICE stack, which is how the differential
   * harness feeds one synthetic fixture to both wrappers (ADR M-0002).
   */
  readKernelBytes(name: string): Uint8Array {
    const path = `${KERNEL_DIR}/${name}`;
    if (!this.mod.FS.analyzePath(path).exists) {
      throw new SpiceError(`readKernelBytes: no staged kernel named '${name}'`);
    }
    return this.mod.FS.readFile(path);
  }

  /** Ephemeris seconds past J2000 (ET) to continuous encoded SCLK ticks (sce2c). */
  sce2c(sc: number, et: number): number {
    return this.scope(() => {
      const out = this.scratch(8);
      this.call('sce2c_c', sc, et, out);
      this.checkFailed();
      return this.readDouble(out);
    });
  }

  /** Continuous encoded SCLK ticks to ephemeris seconds past J2000 (ET) (sct2e). */
  sct2e(sc: number, sclkdp: number): number {
    return this.scope(() => {
      const out = this.scratch(8);
      this.call('sct2e_c', sc, sclkdp, out);
      this.checkFailed();
      return this.readDouble(out);
    });
  }

  /**
   * CK pointing query (ckgp): the C-matrix (frame -> base) for instrument/structure
   * `inst` at encoded SCLK `sclkdp`, within tolerance `tol` ticks, in reference frame
   * `ref`. Returns the row-major 3x3 plus the actual SCLK and whether a record was
   * found (no record within tolerance is `found: false`, not an error).
   */
  ckgp(inst: number, sclkdp: number, tol: number, ref: string): {
    found: boolean;
    cmat: number[];
    clkout: number;
  } {
    return this.scope(() => {
      const cmat = this.scratch(72);
      const clkout = this.scratch(8);
      const found = this.scratch(4);
      this.call('ckgp_c', inst, sclkdp, tol, this.str(ref), cmat, clkout, found);
      this.checkFailed();
      return {
        found: this.readInt(found) !== 0,
        cmat: this.readMat3(cmat),
        clkout: this.readDouble(clkout),
      };
    });
  }

  /**
   * Write a CK Type 3 (discrete quaternions + angular rate, linear interpolation
   * within each interpolation interval) segment for `inst` into the in-memory FS and
   * furnsh it, so the attitude history is queryable through the identical pxform/ckgp
   * path. `sclkdp` is n encoded-SCLK tags (strictly increasing); `quats` is n*4
   * scalar-first quaternions (frame -> base, the SPICE m2q convention); `avvs`, if
   * present, is n*3 angular-rate vectors and sets the av flag; `starts` are the
   * interpolation-interval start tags (a subset of `sclkdp`, default the first tag so
   * the whole segment is one interpolation interval). (STK_PARITY_SPEC ATT-6/ATT-7.)
   */
  writeCk03(
    name: string,
    inst: number,
    ref: string,
    segid: string,
    sclkdp: Float64Array,
    quats: Float64Array,
    avvs: Float64Array | null,
    starts: Float64Array,
  ): void {
    this.scope(() => {
      const path = `${KERNEL_DIR}/${name}`;
      if (this.mod.FS.analyzePath(path).exists) this.mod.FS.unlink(path);
      const n = sclkdp.length;
      if (n < 1 || quats.length !== n * 4) {
        throw new SpiceError(`writeCk03: need >=1 record and quats of length 4n (n=${n})`);
      }
      const avflag = avvs !== null;
      if (avvs !== null && avvs.length !== n * 3) {
        throw new SpiceError(`writeCk03: avvs must be length 3n when present (n=${n})`);
      }
      const nints = starts.length;
      if (nints < 1) throw new SpiceError('writeCk03: need at least one interpolation interval start');

      const handlePtr = this.scratch(4);
      // ckopn reserves comment space (ncomch); 0 is fine for a generated segment.
      this.call('ckopn_c', this.str(path), this.str(segid.slice(0, 60) || 'BESSEL_CK'), 0, handlePtr);
      this.checkFailed();
      const handle = this.readInt(handlePtr);

      const sclkPtr = this.scratch(n * 8);
      for (let k = 0; k < n; k++) this.mod.setValue(sclkPtr + k * 8, sclkdp[k]!, 'double');
      const quatPtr = this.scratch(n * 4 * 8);
      for (let i = 0; i < n * 4; i++) this.mod.setValue(quatPtr + i * 8, quats[i]!, 'double');
      // ckw03 always reads the avvs argument; pass a zero buffer when avflag is false.
      const avPtr = this.scratch(n * 3 * 8);
      for (let i = 0; i < n * 3; i++) {
        this.mod.setValue(avPtr + i * 8, avvs !== null ? avvs[i]! : 0, 'double');
      }
      const startPtr = this.scratch(nints * 8);
      for (let k = 0; k < nints; k++) this.mod.setValue(startPtr + k * 8, starts[k]!, 'double');

      this.call(
        'ckw03_c',
        handle,
        sclkdp[0]!,
        sclkdp[n - 1]!,
        inst,
        this.str(ref),
        avflag ? 1 : 0,
        this.str(segid),
        n,
        sclkPtr,
        quatPtr,
        avPtr,
        nints,
        startPtr,
      );
      this.checkFailed();
      this.call('ckcls_c', handle);
      this.checkFailed();

      this.call('furnsh_c', this.str(path));
      this.checkFailed();
    });
  }

  // --- SpiceCell windows (geometry-finder confinement and result cells) ---------
  // A SpiceCell double window is a 9-field struct (36 bytes in wasm32) pointing at
  // a (CTRLSZ + size) double array; the first CTRLSZ=6 doubles are the control
  // area, the rest hold interval endpoints. Mirrors the SPICEDOUBLE_CELL macro.
  private static readonly CELL_CTRLSZ = 6;
  private static readonly CELL_BYTES = 36;

  /**
   * Allocate a double window cell holding up to `size` endpoints (size/2 intervals).
   * Both blocks are tracked in the active scope, so the enclosing finder call frees
   * them when it returns or throws.
   */
  private makeWindowCell(size: number): { cell: number; data: number } {
    const ctrl = SpiceBindings.CELL_CTRLSZ;
    const data = this.scratch((ctrl + size) * 8);
    for (let i = 0; i < ctrl; i++) this.mod.setValue(data + i * 8, 0, 'double'); // zero control area
    const cell = this.scratch(SpiceBindings.CELL_BYTES);
    this.mod.setValue(cell + 0, 1, 'i32'); // dtype = SPICE_DP
    this.mod.setValue(cell + 4, 0, 'i32'); // length (strings only)
    this.mod.setValue(cell + 8, size, 'i32'); // size (max elements)
    this.mod.setValue(cell + 12, 0, 'i32'); // card (current elements)
    this.mod.setValue(cell + 16, 1, 'i32'); // isSet = SPICETRUE
    this.mod.setValue(cell + 20, 0, 'i32'); // adjust
    this.mod.setValue(cell + 24, 0, 'i32'); // init (CSPICE initializes on first use)
    this.mod.setValue(cell + 28, data, 'i32'); // base
    this.mod.setValue(cell + 32, data + ctrl * 8, 'i32'); // data (first endpoint)
    return { cell, data };
  }

  /** Read a window cell's intervals: card endpoints from the data pointer. */
  private readWindowCell(cell: number): [number, number][] {
    const card = this.readInt(cell + 12);
    const dataPtr = this.readInt(cell + 32);
    const out: [number, number][] = [];
    for (let i = 0; i + 1 < card; i += 2) {
      out.push([this.readDouble(dataPtr + i * 8), this.readDouble(dataPtr + (i + 1) * 8)]);
    }
    return out;
  }

  /**
   * Shared geometry-finder window scaffold: build the [start, stop] confinement window,
   * allocate a result window for up to `maxIntervals` intervals, run the caller's gfX_c
   * call against the two cells, check for a SPICE failure, and return the result intervals.
   * Every gfX binding differs only in the finder-specific call, so this owns the common
   * cnfine/result cell lifetime and the wninsd/checkFailed/readWindowCell boilerplate.
   */
  private runGfWindow(
    start: number,
    stop: number,
    maxIntervals: number,
    call: (cnfineCell: number, resultCell: number) => void,
  ): [number, number][] {
    return this.scope(() => {
      const cnfine = this.makeWindowCell(2);
      this.call('wninsd_c', start, stop, cnfine.cell);
      this.checkFailed();
      const result = this.makeWindowCell(2 * maxIntervals);
      call(cnfine.cell, result.cell);
      this.checkFailed();
      return this.readWindowCell(result.cell);
    });
  }

  /**
   * Occultation/eclipse interval finder (gfoclt): intervals over [start,stop] in
   * which `back` is occulted by `front` as seen from the observer. Returns [s,e]
   * ET-second intervals.
   */
  gfoclt(
    occtyp: string,
    front: string,
    fshape: string,
    fframe: string,
    back: string,
    bshape: string,
    bframe: string,
    abcorr: AberrationCorrection,
    observer: string,
    step: number,
    start: number,
    stop: number,
    maxIntervals = 1000,
  ): [number, number][] {
    return this.runGfWindow(start, stop, maxIntervals, (cnfineCell, resultCell) =>
      this.call(
        'gfoclt_c',
        this.str(occtyp),
        this.str(front),
        this.str(fshape),
        this.str(fframe),
        this.str(back),
        this.str(bshape),
        this.str(bframe),
        this.str(abcorr),
        this.str(observer),
        step,
        cnfineCell,
        resultCell,
      ),
    );
  }

  /**
   * Distance interval finder (gfdist): intervals over [start,stop] in which the
   * observer-to-target distance (km) satisfies `relate` (e.g. "<", ">") against
   * refval. Returns [s,e] ET-second intervals.
   */
  gfdist(
    target: string,
    abcorr: AberrationCorrection,
    observer: string,
    relate: string,
    refval: number,
    step: number,
    start: number,
    stop: number,
    maxIntervals = 1000,
  ): [number, number][] {
    return this.runGfWindow(start, stop, maxIntervals, (cnfineCell, resultCell) =>
      this.call(
        'gfdist_c',
        this.str(target),
        this.str(abcorr),
        this.str(observer),
        this.str(relate),
        refval,
        0, // adjust (used only by ABSMAX/ABSMIN/LOCMAX/LOCMIN)
        step,
        maxIntervals,
        cnfineCell,
        resultCell,
      ),
    );
  }

  /**
   * Angular-separation interval finder (gfsep): intervals over [start,stop] in which
   * the apparent angular separation (rad) between targ1 (shape1/frame1) and targ2
   * (shape2/frame2), as seen from the observer, satisfies `relate` (e.g. "<", ">",
   * "=") against refval. `shape` is "POINT" or "SPHERE"; `frame` is used only for a
   * SPHERE target (pass a non-blank frame, e.g. "J2000", but it is ignored for a
   * POINT). `adjust` applies only to the ABSMAX/ABSMIN/LOCMAX/LOCMIN relations.
   * Returns [s,e] ET-second intervals. Mirrors gfdist's relate/refval handling.
   */
  gfsep(
    targ1: string,
    shape1: string,
    frame1: string,
    targ2: string,
    shape2: string,
    frame2: string,
    abcorr: AberrationCorrection,
    observer: string,
    relate: string,
    refval: number,
    adjust: number,
    step: number,
    start: number,
    stop: number,
    maxIntervals = 1000,
  ): [number, number][] {
    return this.runGfWindow(start, stop, maxIntervals, (cnfineCell, resultCell) =>
      this.call(
        'gfsep_c',
        this.str(targ1),
        this.str(shape1),
        this.str(frame1),
        this.str(targ2),
        this.str(shape2),
        this.str(frame2),
        this.str(abcorr),
        this.str(observer),
        this.str(relate),
        refval,
        adjust,
        step,
        maxIntervals,
        cnfineCell,
        resultCell,
      ),
    );
  }

  /**
   * Coordinate interval finder on an observer-target position (gfposc): intervals
   * over [start,stop] in which a single coordinate of the observer-to-target
   * position, expressed in reference frame `frame` and coordinate system `crdsys`
   * (e.g. "LATITUDINAL", "RECTANGULAR", "RA/DEC", "SPHERICAL", "CYLINDRICAL",
   * "GEODETIC"), satisfies `relate` against refval. For topocentric az/el, use a
   * topocentric `frame` with crdsys="LATITUDINAL" and coord="LATITUDE" (elevation,
   * rad) or coord="LONGITUDE" (azimuth, rad). `adjust` applies only to the
   * ABSMAX/ABSMIN/LOCMAX/LOCMIN relations. Returns [s,e] ET-second intervals.
   */
  gfposc(
    target: string,
    frame: string,
    abcorr: AberrationCorrection,
    observer: string,
    crdsys: string,
    coord: string,
    relate: string,
    refval: number,
    adjust: number,
    step: number,
    start: number,
    stop: number,
    maxIntervals = 1000,
  ): [number, number][] {
    return this.runGfWindow(start, stop, maxIntervals, (cnfineCell, resultCell) =>
      this.call(
        'gfposc_c',
        this.str(target),
        this.str(frame),
        this.str(abcorr),
        this.str(observer),
        this.str(crdsys),
        this.str(coord),
        this.str(relate),
        refval,
        adjust,
        step,
        maxIntervals,
        cnfineCell,
        resultCell,
      ),
    );
  }

  /**
   * Instantaneous occultation state (occult) at et: the occultation code for the
   * configuration of targ1 (shape1/frame1) and targ2 (shape2/frame2) seen from the
   * observer. Negative = targ1 occulted by targ2; positive = the reverse; 0 = none.
   */
  occult(
    targ1: string,
    shape1: string,
    frame1: string,
    targ2: string,
    shape2: string,
    frame2: string,
    abcorr: AberrationCorrection,
    observer: string,
    et: number,
  ): number {
    return this.scope(() => {
      const out = this.scratch(4);
      this.call(
        'occult_c',
        this.str(targ1),
        this.str(shape1),
        this.str(frame1),
        this.str(targ2),
        this.str(shape2),
        this.str(frame2),
        this.str(abcorr),
        this.str(observer),
        et,
        out,
      );
      this.checkFailed();
      return this.readInt(out);
    });
  }

  getfov(instId: number, room = 16): FovResult {
    return this.scope(() => {
      const shapeLen = 64;
      const frameLen = 64;
      const shape = this.scratch(shapeLen);
      const frame = this.scratch(frameLen);
      const bsight = this.scratch(24);
      const nPtr = this.scratch(4);
      const bounds = this.scratch(room * 24);
      this.call('getfov_c', instId, room, shapeLen, frameLen, shape, frame, bsight, nPtr, bounds);
      this.checkFailed();
      // Clamp to room: the bounds buffer holds room*24 bytes, so never read past it
      // even if getfov_c reports more vectors than were requested.
      const count = Math.min(this.readInt(nPtr), room);
      const boundsArr: Vec3[] = [];
      for (let i = 0; i < count; i++) boundsArr.push(this.readVec3(bounds + i * 24));
      return {
        shape: this.mod.UTF8ToString(shape),
        frame: this.mod.UTF8ToString(frame),
        boresight: this.readVec3(bsight),
        bounds: boundsArr,
      };
    });
  }

  private readDoubles(item: string, dim: number, fill: (valuesPtr: number, dimPtr: number) => void): number[] {
    return this.scope(() => {
      const maxn = Math.max(1, dim);
      const dimPtr = this.scratch(4);
      const values = this.scratch(maxn * 8);
      fill(values, dimPtr);
      this.checkFailed();
      const out: number[] = [];
      const got = this.readInt(dimPtr);
      for (let i = 0; i < got; i++) out.push(this.readDouble(values + i * 8));
      return out;
    });
  }

  bodvrd(body: string, item: string, maxn = 3): number[] {
    return this.readDoubles(item, maxn, (values, dimPtr) =>
      this.call('bodvrd_c', this.str(body), this.str(item), maxn, dimPtr, values),
    );
  }

  bodvcd(bodyId: number, item: string, maxn = 3): number[] {
    return this.readDoubles(item, maxn, (values, dimPtr) =>
      this.call('bodvcd_c', bodyId, this.str(item), maxn, dimPtr, values),
    );
  }

  pxform(from: string, to: string, et: number): number[] {
    return this.scope(() => {
      const rot = this.scratch(9 * 8);
      this.call('pxform_c', this.str(from), this.str(to), et, rot);
      this.checkFailed();
      const out: number[] = [];
      for (let i = 0; i < 9; i++) out.push(this.readDouble(rot + i * 8));
      return out;
    });
  }

  sxform(from: string, to: string, et: number): number[] {
    return this.scope(() => {
      const xf = this.scratch(36 * 8);
      this.call('sxform_c', this.str(from), this.str(to), et, xf);
      this.checkFailed();
      const out: number[] = [];
      for (let i = 0; i < 36; i++) out.push(this.readDouble(xf + i * 8));
      return out;
    });
  }

  sincpt(
    method: string,
    target: string,
    et: number,
    fixref: string,
    abcorr: AberrationCorrection,
    observer: string,
    dref: string,
    dvec: Vec3,
  ): InterceptResult {
    return this.scope(() => {
      const dvecPtr = this.scratch(24);
      this.mod.setValue(dvecPtr, dvec.x, 'double');
      this.mod.setValue(dvecPtr + 8, dvec.y, 'double');
      this.mod.setValue(dvecPtr + 16, dvec.z, 'double');
      const spoint = this.scratch(24);
      const trgepc = this.scratch(8);
      const srfvec = this.scratch(24);
      const found = this.scratch(4);
      this.call(
        'sincpt_c',
        this.str(method),
        this.str(target),
        et,
        this.str(fixref),
        this.str(abcorr),
        this.str(observer),
        this.str(dref),
        dvecPtr,
        spoint,
        trgepc,
        srfvec,
        found,
      );
      this.checkFailed();
      return {
        found: this.readInt(found) !== 0,
        point: this.readVec3(spoint),
        trgepc: this.readDouble(trgepc),
        srfvec: this.readVec3(srfvec),
      };
    });
  }

  ilumin(
    method: string,
    target: string,
    et: number,
    fixref: string,
    abcorr: AberrationCorrection,
    observer: string,
    point: Vec3,
  ): IluminResult {
    return this.scope(() => {
      const spoint = this.scratch(24);
      this.mod.setValue(spoint, point.x, 'double');
      this.mod.setValue(spoint + 8, point.y, 'double');
      this.mod.setValue(spoint + 16, point.z, 'double');
      const trgepc = this.scratch(8);
      const srfvec = this.scratch(24);
      const phase = this.scratch(8);
      const incdnc = this.scratch(8);
      const emissn = this.scratch(8);
      this.call(
        'ilumin_c',
        this.str(method),
        this.str(target),
        et,
        this.str(fixref),
        this.str(abcorr),
        this.str(observer),
        spoint,
        trgepc,
        srfvec,
        phase,
        incdnc,
        emissn,
      );
      this.checkFailed();
      return {
        phase: this.readDouble(phase),
        incidence: this.readDouble(incdnc),
        emission: this.readDouble(emissn),
        trgepc: this.readDouble(trgepc),
        srfvec: this.readVec3(srfvec),
      };
    });
  }

  /** Read a DSK type-2 shape model by staging bytes and using DAS-level readers. */
  readDsk(name: string, bytes: Uint8Array): DskShape {
    return this.scope(() => {
      const path = `${KERNEL_DIR}/${name}`;
      this.mod.FS.writeFile(path, bytes);
      const handlePtr = this.scratch(4);
      this.call('dasopr_c', this.str(path), handlePtr);
      this.checkFailed();
      const handle = this.readInt(handlePtr);

      const descr = this.scratch(8 * 4); // SpiceDLADescr: 8 ints
      const found = this.scratch(4);
      this.call('dlabfs_c', handle, descr, found);
      this.checkFailed();
      if (this.readInt(found) === 0) {
        this.call('dascls_c', handle);
        throw new SpiceError(`DSK "${name}" has no segments`);
      }

      const nvPtr = this.scratch(4);
      const npPtr = this.scratch(4);
      this.call('dskz02_c', handle, descr, nvPtr, npPtr);
      this.checkFailed();
      const nv = this.readInt(nvPtr);
      const np = this.readInt(npPtr);

      const vertices = this.readDskChunked(nv, 3, 8, (start, room, nPtr, buf) =>
        this.call('dskv02_c', handle, descr, start, room, nPtr, buf),
      );
      const platesRaw = this.readDskChunked(np, 3, 4, (start, room, nPtr, buf) =>
        this.call('dskp02_c', handle, descr, start, room, nPtr, buf),
      );

      this.call('dascls_c', handle);
      this.checkFailed();

      // Plate vertex indices are 1-based in CSPICE; convert to 0-based.
      const plates = platesRaw.map((i) => i - 1);
      return { vertices, plates };
    });
  }

  /** Read count rows of `cols` values (`bytes` each: 8 double, 4 int) in chunks. */
  private readDskChunked(
    count: number,
    cols: number,
    bytes: number,
    fetch: (start: number, room: number, nPtr: number, buf: number) => number,
  ): number[] {
    return this.scope(() => this.readDskChunkedInner(count, cols, bytes, fetch));
  }

  private readDskChunkedInner(
    count: number,
    cols: number,
    bytes: number,
    fetch: (start: number, room: number, nPtr: number, buf: number) => number,
  ): number[] {
    const CHUNK = 1000;
    const nPtr = this.scratch(4);
    const buf = this.scratch(CHUNK * cols * bytes);
    const out: number[] = [];
    const isDouble = bytes === 8;
    let start = 1;
    while (start <= count) {
      const room = Math.min(CHUNK, count - start + 1);
      fetch(start, room, nPtr, buf);
      this.checkFailed();
      const n = this.readInt(nPtr);
      if (n <= 0) break;
      for (let i = 0; i < n * cols; i++) {
        out.push(isDouble ? this.readDouble(buf + i * 8) : this.readInt(buf + i * 4));
      }
      start += n;
    }
    return out;
  }

  subpnt(
    method: string,
    target: string,
    et: number,
    fixref: string,
    abcorr: AberrationCorrection,
    observer: string,
  ): SubPointResult {
    return this.scope(() => {
      const spoint = this.scratch(24);
      const trgepc = this.scratch(8);
      const srfvec = this.scratch(24);
      this.call(
        'subpnt_c',
        this.str(method),
        this.str(target),
        et,
        this.str(fixref),
        this.str(abcorr),
        this.str(observer),
        spoint,
        trgepc,
        srfvec,
      );
      this.checkFailed();
      return {
        point: this.readVec3(spoint),
        trgepc: this.readDouble(trgepc),
        srfvec: this.readVec3(srfvec),
      };
    });
  }
}
