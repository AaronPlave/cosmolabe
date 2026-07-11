// The heritage adapter of the Session 4 re-point: a drop-in implementation of
// the @cosmolabe/spice SpiceInstance runtime surface over the frames tier and
// its cspice-wasm bindings. Cosmolabe's injection sites (the viewer loader,
// the trajectory cache worker, the test harness) construct this instead of
// the timecraftjs Spice, so every state and orientation the core consumes
// flows through the M-0002 contracts (iron rule 1) while the core's own code
// keeps its existing interface. The types below are structural mirrors of
// @cosmolabe/spice's: the federated trees cannot import each other's type
// declarations before the packages/ restructure, and TypeScript matches the
// shapes, not the names.
//
// Members whose CSPICE entry points are absent from the WASM export allowlist
// (cidfrm, fovray, fovtrg, and a nonzero gfdist adjust) throw a typed
// SpiceError: no cosmolabe runtime path calls them today, and silence would
// hide a semantic gap. Extend the allowlist deliberately when one is needed.

import {
  createSpiceBindings,
  SpiceError,
  type SpiceBindings,
  type AberrationCorrection,
  type SpiceEngineOptions,
  type Vec3 as WVec3,
} from 'cspice-wasm';
import { framesLayerOver, type FramesLayer } from './frames.ts';

// ── structural mirrors of the @cosmolabe/spice types ────────────────────────

export type HVec3 = [number, number, number];
export type HState = [number, number, number, number, number, number];
export type HMat3 = [
  number, number, number, number, number, number, number, number, number,
];
export interface HTimeWindow {
  start: number;
  end: number;
}
export interface HOrbitalElements {
  rp: number;
  ecc: number;
  inc: number;
  lnode: number;
  argp: number;
  m0: number;
  t0: number;
  mu: number;
}
export interface HSubPoint {
  point: HVec3;
  altitude: number;
  longitude: number;
  latitude: number;
}
export interface HSurfaceIntercept {
  point: HVec3;
  found: boolean;
  trgepc: number;
  srfvec: HVec3;
}
export interface HIlluminationAngles {
  phaseAngle: number;
  solarIncidence: number;
  emission: number;
}
export type HFovShape = 'POLYGON' | 'RECTANGLE' | 'CIRCLE' | 'ELLIPSE';
export interface HInstrumentFov {
  shape: HFovShape;
  frame: string;
  boresight: HVec3;
  bounds: HVec3[];
}
export type HKernelSource =
  | { type: 'file'; path: string }
  | { type: 'url'; url: string }
  | { type: 'buffer'; data: ArrayBuffer; filename: string };

const vec = (v: WVec3): HVec3 => [v.x, v.y, v.z];

/** The SpiceInstance-compatible surface plus the seam beneath it. */
export interface HeritageSpice {
  /** The frames tier under the adapter, for provenance (the kernel set hash). */
  readonly frames: FramesLayer;

  furnish(source: HKernelSource): Promise<void>;
  unload(filename: string): void;
  clear(): void;
  totalLoaded(): number;
  str2et(timeString: string): number;
  et2utc(et: number, format: 'C' | 'D' | 'J' | 'ISOC' | 'ISOD', precision: number): string;
  utc2et(utcString: string): number;
  et2lst(
    et: number,
    bodyId: number,
    longitude: number,
    type: 'PLANETOCENTRIC' | 'PLANETOGRAPHIC',
  ): { hr: number; mn: number; sc: number; time: string; ampm: string };
  timout(et: number, pictur: string): string;
  unitim(epoch: number, insys: string, outsys: string): number;
  spkpos(
    target: string,
    et: number,
    frame: string,
    abcorr: AberrationCorrection,
    observer: string,
  ): { position: HVec3; lightTime: number };
  spkezr(
    target: string,
    et: number,
    frame: string,
    abcorr: AberrationCorrection,
    observer: string,
  ): { state: HState; lightTime: number };
  pxform(from: string, to: string, et: number): HMat3;
  sxform(from: string, to: string, et: number): number[];
  frmnam(frcode: number): string | null;
  cidfrm(cent: number): { frcode: number; frname: string } | null;
  sincpt(
    method: string,
    target: string,
    et: number,
    fixref: string,
    abcorr: AberrationCorrection,
    observer: string,
    dref: string,
    dvec: HVec3,
  ): HSurfaceIntercept;
  subpnt(
    method: string,
    target: string,
    et: number,
    fixref: string,
    abcorr: AberrationCorrection,
    observer: string,
  ): HSubPoint;
  subslr(
    method: string,
    target: string,
    et: number,
    fixref: string,
    abcorr: AberrationCorrection,
    observer: string,
  ): HSubPoint;
  ilumin(
    method: string,
    target: string,
    et: number,
    fixref: string,
    abcorr: AberrationCorrection,
    observer: string,
    spoint: HVec3,
  ): HIlluminationAngles;
  oscelt(state: HState, et: number, mu: number): HOrbitalElements;
  conics(elements: HOrbitalElements, et: number): HState;
  bodvcd(bodyId: number, item: string): number[];
  bodvrd(body: string, item: string): number[];
  bodc2n(code: number): string | null;
  bodn2c(name: string): number | null;
  gfposc(
    target: string,
    frame: string,
    abcorr: string,
    observer: string,
    crdsys: string,
    coord: string,
    relate: string,
    refval: number,
    adjust: number,
    step: number,
    cnfine: HTimeWindow[],
  ): HTimeWindow[];
  gfsep(
    target1: string,
    shape1: string,
    frame1: string,
    target2: string,
    shape2: string,
    frame2: string,
    abcorr: string,
    observer: string,
    relate: string,
    refval: number,
    adjust: number,
    step: number,
    cnfine: HTimeWindow[],
  ): HTimeWindow[];
  gfoclt(
    occtyp: string,
    front: string,
    fshape: string,
    fframe: string,
    back: string,
    bshape: string,
    bframe: string,
    abcorr: string,
    observer: string,
    step: number,
    cnfine: HTimeWindow[],
  ): HTimeWindow[];
  gfdist(
    target: string,
    abcorr: string,
    observer: string,
    relate: string,
    refval: number,
    adjust: number,
    step: number,
    cnfine: HTimeWindow[],
  ): HTimeWindow[];
  spkcov(idcode: number): HTimeWindow[];
  spkobj(filename: string): number[];
  getfov(instId: number, maxBounds?: number): HInstrumentFov;
  fovray(
    inst: string,
    raydir: HVec3,
    rframe: string,
    abcorr: AberrationCorrection,
    observer: string,
    et: number,
  ): boolean;
  fovtrg(
    inst: string,
    target: string,
    tshape: string,
    tframe: string,
    abcorr: AberrationCorrection,
    observer: string,
    et: number,
  ): boolean;
  mxv(matrix: HMat3, vin: HVec3): HVec3;
  mtxv(matrix: HMat3, vin: HVec3): HVec3;
  vcrss(v1: HVec3, v2: HVec3): HVec3;
  vnorm(v: HVec3): number;
  vdot(v1: HVec3, v2: HVec3): number;
  vsep(v1: HVec3, v2: HVec3): number;
  vhat(v: HVec3): HVec3;
  vsub(v1: HVec3, v2: HVec3): HVec3;
  vadd(v1: HVec3, v2: HVec3): HVec3;
  vscl(s: number, v: HVec3): HVec3;
  recrad(rectan: HVec3): { range: number; ra: number; dec: number };
}

export type HeritageSpiceOptions = SpiceEngineOptions;

/** Build the heritage adapter: one WASM instance, one frames layer, one pool. */
export async function createHeritageSpice(options?: HeritageSpiceOptions): Promise<HeritageSpice> {
  const bindings: SpiceBindings = await createSpiceBindings(options);
  const frames = framesLayerOver(bindings);

  /** A single state, synchronously, for the heritage signature. This is the
   * identical primitive StateProvider.states batches over (the tier's own
   * spkezr binding); the heritage interface is synchronous, so the adapter
   * cannot await the batched contract and calls the primitive directly.
   * Correction stays explicit and required by the signature. */
  const stateAt = (
    target: string,
    et: number,
    frame: string,
    abcorr: AberrationCorrection,
    observer: string,
  ): { state: HState; lightTime: number } => {
    const s = bindings.spkezr(target, et, frame, abcorr, observer);
    return {
      state: [s.position.x, s.position.y, s.position.z, s.velocity.x, s.velocity.y, s.velocity.z],
      lightTime: s.lightTime,
    };
  };

  const windows = (intervals: [number, number][]): HTimeWindow[] =>
    intervals.map(([start, end]) => ({ start, end }));

  const overCnfine = (
    cnfine: HTimeWindow[],
    find: (start: number, stop: number) => [number, number][],
  ): HTimeWindow[] => {
    const out: HTimeWindow[] = [];
    for (const w of cnfine) out.push(...windows(find(w.start, w.end)));
    return out;
  };

  return {
    frames,

    async furnish(source) {
      if (source.type === 'buffer') {
        const bytes = new Uint8Array(source.data);
        frames.furnish(source.filename.split('/').pop()!, bytes);
        return;
      }
      if (source.type === 'url') {
        const res = await fetch(source.url);
        if (!res.ok) throw new SpiceError(`furnish: fetch of ${source.url} failed (${res.status})`);
        frames.furnish(
          source.url.split('/').pop()!.replace(/\.gz$/, ''),
          new Uint8Array(await res.arrayBuffer()),
        );
        return;
      }
      throw new SpiceError(
        "furnish: the frames tier takes kernel bytes, not paths; the host layer reads storage (KernelSource type 'file' is not supported by the heritage adapter)",
      );
    },
    unload(filename) {
      frames.unload(filename);
    },
    clear() {
      for (const k of [...frames.kernels().kernels]) frames.unload(k.name);
    },
    totalLoaded() {
      return bindings.ktotal('ALL');
    },

    str2et(timeString) {
      return frames.toEt(timeString);
    },
    et2utc(et, format, precision) {
      return bindings.et2utc(et, format, precision);
    },
    utc2et(utcString) {
      return bindings.utc2et(utcString.endsWith('Z') ? utcString.slice(0, -1) : utcString);
    },
    et2lst(et, bodyId, longitude, type) {
      return bindings.et2lst(et, bodyId, longitude, type);
    },
    timout(et, pictur) {
      return bindings.timout(et, pictur);
    },
    unitim(epoch, insys, outsys) {
      return bindings.unitim(epoch, insys, outsys);
    },

    spkpos(target, et, frame, abcorr, observer) {
      // The true spkpos_c, not a spkezr projection: the two CSPICE entry
      // points can differ in the last bits under corrections, and the
      // adapter must be bit-faithful to the heritage call it replaces.
      const s = bindings.spkpos(target, et, frame, abcorr, observer);
      return { position: vec(s.position), lightTime: s.lightTime };
    },
    spkezr(target, et, frame, abcorr, observer) {
      return stateAt(target, et, frame, abcorr, observer);
    },

    pxform(from, to, et) {
      return [...frames.chain(from, to, et).rotation] as HMat3;
    },
    sxform(from, to, et) {
      return [...bindings.sxform(from, to, et)];
    },
    frmnam(frcode) {
      const name = bindings.frmnam(frcode);
      return name === '' ? null : name;
    },
    cidfrm() {
      throw new SpiceError(
        'cidfrm is not in the CSPICE WASM export allowlist; extend it deliberately if a caller appears',
      );
    },

    sincpt(method, target, et, fixref, abcorr, observer, dref, dvec) {
      const r = bindings.sincpt(method, target, et, fixref, abcorr, observer, dref, {
        x: dvec[0],
        y: dvec[1],
        z: dvec[2],
      });
      return { point: vec(r.point), found: r.found, trgepc: r.trgepc, srfvec: vec(r.srfvec) };
    },
    subpnt(method, target, et, fixref, abcorr, observer) {
      const r = bindings.subpnt(method, target, et, fixref, abcorr, observer);
      const p = r.point;
      return {
        point: vec(p),
        altitude: Math.hypot(r.srfvec.x, r.srfvec.y, r.srfvec.z),
        longitude: Math.atan2(p.y, p.x),
        latitude: Math.atan2(p.z, Math.hypot(p.x, p.y)),
      };
    },
    subslr(method, target, et, fixref, abcorr, observer) {
      const r = bindings.subslr(method, target, et, fixref, abcorr, observer);
      const p = r.point;
      return {
        point: vec(p),
        altitude: Math.hypot(r.srfvec.x, r.srfvec.y, r.srfvec.z),
        longitude: Math.atan2(p.y, p.x),
        latitude: Math.atan2(p.z, Math.hypot(p.x, p.y)),
      };
    },
    ilumin(method, target, et, fixref, abcorr, observer, spoint) {
      const r = bindings.ilumin(method, target, et, fixref, abcorr, observer, {
        x: spoint[0],
        y: spoint[1],
        z: spoint[2],
      });
      return { phaseAngle: r.phase, solarIncidence: r.incidence, emission: r.emission };
    },
    oscelt(state, et, mu) {
      return bindings.oscelt(
        {
          position: { x: state[0], y: state[1], z: state[2] },
          velocity: { x: state[3], y: state[4], z: state[5] },
        },
        et,
        mu,
      );
    },
    conics(elements, et) {
      const s = bindings.conics(elements, et);
      return [s.position.x, s.position.y, s.position.z, s.velocity.x, s.velocity.y, s.velocity.z];
    },
    bodvcd(bodyId, item) {
      return bindings.bodvcd(bodyId, item);
    },
    bodvrd(body, item) {
      return bindings.bodvrd(body, item);
    },
    bodc2n(code) {
      return bindings.bodc2n(code);
    },
    bodn2c(name) {
      return bindings.bodn2c(name);
    },

    gfposc(target, frame, abcorr, observer, crdsys, coord, relate, refval, adjust, step, cnfine) {
      return overCnfine(cnfine, (start, stop) =>
        bindings.gfposc(
          target, frame, abcorr as AberrationCorrection, observer,
          crdsys, coord, relate, refval, adjust, step, start, stop,
        ),
      );
    },
    gfsep(target1, shape1, frame1, target2, shape2, frame2, abcorr, observer, relate, refval, adjust, step, cnfine) {
      return overCnfine(cnfine, (start, stop) =>
        bindings.gfsep(
          target1, shape1, frame1, target2, shape2, frame2,
          abcorr as AberrationCorrection, observer, relate, refval, adjust, step, start, stop,
        ),
      );
    },
    gfoclt(occtyp, front, fshape, fframe, back, bshape, bframe, abcorr, observer, step, cnfine) {
      return overCnfine(cnfine, (start, stop) =>
        bindings.gfoclt(
          occtyp, front, fshape, fframe, back, bshape, bframe,
          abcorr as AberrationCorrection, observer, step, start, stop,
        ),
      );
    },
    gfdist(target, abcorr, observer, relate, refval, adjust, step, cnfine) {
      if (adjust !== 0) {
        throw new SpiceError(
          'gfdist: the cspice-wasm wrapper does not carry the adjust parameter; extend it deliberately if a nonzero adjust caller appears',
        );
      }
      return overCnfine(cnfine, (start, stop) =>
        bindings.gfdist(target, abcorr as AberrationCorrection, observer, relate, refval, step, start, stop),
      );
    },

    spkcov(idcode) {
      const raw: [number, number][] = [];
      for (const k of frames.kernels().kernels) {
        if (!/\.bsp$/i.test(k.name)) continue;
        raw.push(...bindings.spkCoverage(k.name, idcode));
      }
      raw.sort((a, b) => a[0] - b[0]);
      const merged: HTimeWindow[] = [];
      for (const [start, end] of raw) {
        const last = merged[merged.length - 1];
        if (last && start <= last.end) last.end = Math.max(last.end, end);
        else merged.push({ start, end });
      }
      return merged;
    },
    spkobj(filename) {
      return bindings.spkObjects(filename);
    },

    getfov(instId, maxBounds = 20) {
      const r = bindings.getfov(instId, maxBounds);
      return {
        // getfov_c returns exactly these shape words; the wrapper types them
        // loosely as string, so the adapter narrows to the heritage union.
        shape: r.shape as HFovShape,
        frame: r.frame,
        boresight: vec(r.boresight),
        bounds: r.bounds.map(vec),
      };
    },
    fovray() {
      throw new SpiceError(
        'fovray is not in the CSPICE WASM export allowlist; extend it deliberately if a caller appears',
      );
    },
    fovtrg() {
      throw new SpiceError(
        'fovtrg is not in the CSPICE WASM export allowlist; extend it deliberately if a caller appears',
      );
    },

    mxv(m, v) {
      return [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
      ];
    },
    mtxv(m, v) {
      return [
        m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
        m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
        m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
      ];
    },
    vcrss(a, b) {
      return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
      ];
    },
    vnorm(v) {
      return Math.hypot(v[0], v[1], v[2]);
    },
    vdot(a, b) {
      return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    },
    vsep(a, b) {
      const na = Math.hypot(a[0], a[1], a[2]);
      const nb = Math.hypot(b[0], b[1], b[2]);
      if (na === 0 || nb === 0) return 0;
      const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb);
      return Math.acos(Math.min(1, Math.max(-1, d)));
    },
    vhat(v) {
      const n = Math.hypot(v[0], v[1], v[2]);
      return n === 0 ? [0, 0, 0] : [v[0] / n, v[1] / n, v[2] / n];
    },
    vsub(a, b) {
      return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    },
    vadd(a, b) {
      return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    },
    vscl(s, v) {
      return [s * v[0], s * v[1], s * v[2]];
    },
    recrad(rectan) {
      const range = Math.hypot(rectan[0], rectan[1], rectan[2]);
      if (range === 0) return { range: 0, ra: 0, dec: 0 };
      let ra = Math.atan2(rectan[1], rectan[0]);
      if (ra < 0) ra += 2 * Math.PI;
      return { range, ra, dec: Math.asin(rectan[2] / range) };
    },
  };
}
