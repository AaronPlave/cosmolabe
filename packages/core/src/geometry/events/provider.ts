import type { EtInterval, EtSeconds } from './types.js';

/**
 * The boundary between Cosmolabe's event model and SPICE Geometry Finder.
 *
 * Everything above this interface — queries, results, timeline and 3D
 * integration — is Cosmolabe's. Everything below it is CSPICE's, and stays
 * there: event kinds compose GF calls, they do not reimplement the geometry.
 *
 * The signatures mirror CSPICE's `gf*_c` routines so a synchronous `Spice`
 * instance satisfies this interface structurally, with no adapter. The
 * worker-backed `@cosmolabe/cspice-wasm` engine answers asynchronously and
 * takes scalar bounds instead of a confinement window, so it is bridged by
 * {@link cspiceWasmGeometryFinder}.
 */
export interface GeometryFinderProvider {
  /** Intervals where observer→target distance (km) satisfies `relate` vs `refval`. */
  gfdist(
    target: string, abcorr: string, observer: string,
    relate: string, refval: number,
    adjust: number, step: EtSeconds, cnfine: EtInterval[],
  ): Awaitable<EtInterval[]>;

  /** Intervals where apparent angular separation (rad) satisfies `relate` vs `refval`. */
  gfsep(
    target1: string, shape1: string, frame1: string,
    target2: string, shape2: string, frame2: string,
    abcorr: string, observer: string,
    relate: string, refval: number,
    adjust: number, step: EtSeconds, cnfine: EtInterval[],
  ): Awaitable<EtInterval[]>;

  /** Intervals where `back` is occulted by `front` as seen from the observer. */
  gfoclt(
    occtyp: string, front: string, fshape: string, fframe: string,
    back: string, bshape: string, bframe: string,
    abcorr: string, observer: string,
    step: EtSeconds, cnfine: EtInterval[],
  ): Awaitable<EtInterval[]>;

  /**
   * Observer→target distance (km) at one instant.
   *
   * Optional, and deliberately not a GF call: GF answers *when* a condition
   * holds, never *how far* it was. Reporting the range at a closest approach —
   * the number the search is actually about — needs one position lookup, so
   * providers that can do one expose it here and kinds annotate their events
   * with it. A provider without it still searches; its events simply carry no
   * distance metric.
   */
  range?(target: string, abcorr: string, observer: string, et: EtSeconds): Awaitable<number>;

  /** Intervals where one coordinate of the observer→target vector satisfies `relate`. */
  gfposc(
    target: string, frame: string, abcorr: string, observer: string,
    crdsys: string, coord: string, relate: string, refval: number,
    adjust: number, step: EtSeconds, cnfine: EtInterval[],
  ): Awaitable<EtInterval[]>;
}

export type Awaitable<T> = T | Promise<T>;

/**
 * The shape `@cosmolabe/cspice-wasm` exposes: promise-returning, one scalar
 * `[start, stop]` bound per call, `[start, end]` tuples out. Declared
 * structurally so `@cosmolabe/core` keeps no dependency on the wasm package.
 */
export interface CspiceWasmGeometryFinder {
  gfdist(
    target: string, abcorr: string, observer: string,
    relate: string, refval: number,
    step: number, start: number, stop: number,
  ): Promise<[number, number][]>;
  gfsep(
    targ1: string, shape1: string, frame1: string,
    targ2: string, shape2: string, frame2: string,
    abcorr: string, observer: string,
    relate: string, refval: number, adjust: number,
    step: number, start: number, stop: number,
  ): Promise<[number, number][]>;
  gfoclt(
    occtyp: string, front: string, fshape: string, fframe: string,
    back: string, bshape: string, bframe: string,
    abcorr: string, observer: string,
    step: number, start: number, stop: number,
  ): Promise<[number, number][]>;
  gfposc(
    target: string, frame: string, abcorr: string, observer: string,
    crdsys: string, coord: string, relate: string, refval: number,
    adjust: number, step: number, start: number, stop: number,
  ): Promise<[number, number][]>;
  /**
   * The engine's position lookup, which is what lets the adapter satisfy
   * {@link GeometryFinderProvider.range}. Optional: an engine without it still
   * searches, and its events simply carry no distance metric.
   */
  spkpos?(
    target: string, et: number, frame: string, abcorr: string, observer: string,
  ): Promise<{ position: { x: number; y: number; z: number } }>;
}

function toIntervals(tuples: [number, number][]): EtInterval[] {
  return tuples.map(([start, end]) => ({ start, end }));
}

/**
 * Runs `call` once per confinement window and concatenates the results, since
 * the wasm engine accepts a single scalar bound rather than a SPICE window.
 * Note the loss relative to native GF: intervals are found within each window
 * independently, so adjacent windows are not coalesced.
 */
async function overWindows(
  cnfine: EtInterval[],
  call: (start: number, stop: number) => Promise<[number, number][]>,
): Promise<EtInterval[]> {
  const out: EtInterval[] = [];
  for (const window of cnfine) {
    out.push(...toIntervals(await call(window.start, window.end)));
  }
  return out;
}

/** Adapts the worker-backed wasm engine to {@link GeometryFinderProvider}. */
export function cspiceWasmGeometryFinder(engine: CspiceWasmGeometryFinder): GeometryFinderProvider {
  const spkpos = engine.spkpos?.bind(engine);

  return {
    // J2000 is an arbitrary choice for a *distance*: the magnitude of the
    // observer→target vector is frame-independent, so the frame only has to be
    // one every kernel set can chain to.
    ...(spkpos
      ? {
          range: async (target: string, abcorr: string, observer: string, et: number) => {
            const { position } = await spkpos(target, et, 'J2000', abcorr, observer);
            return Math.hypot(position.x, position.y, position.z);
          },
        }
      : {}),

    gfdist: (target, abcorr, observer, relate, refval, adjust, step, cnfine) => {
      // The wasm binding exposes no `adjust`; failing loudly beats silently
      // searching for unadjusted extrema.
      if (adjust !== 0) {
        throw new Error('cspiceWasmGeometryFinder: gfdist does not support a nonzero adjust');
      }
      return overWindows(cnfine, (start, stop) =>
        engine.gfdist(target, abcorr, observer, relate, refval, step, start, stop));
    },

    gfsep: (targ1, shape1, frame1, targ2, shape2, frame2, abcorr, observer, relate, refval, adjust, step, cnfine) =>
      overWindows(cnfine, (start, stop) =>
        engine.gfsep(targ1, shape1, frame1, targ2, shape2, frame2, abcorr, observer, relate, refval, adjust, step, start, stop)),

    gfoclt: (occtyp, front, fshape, fframe, back, bshape, bframe, abcorr, observer, step, cnfine) =>
      overWindows(cnfine, (start, stop) =>
        engine.gfoclt(occtyp, front, fshape, fframe, back, bshape, bframe, abcorr, observer, step, start, stop)),

    gfposc: (target, frame, abcorr, observer, crdsys, coord, relate, refval, adjust, step, cnfine) =>
      overWindows(cnfine, (start, stop) =>
        engine.gfposc(target, frame, abcorr, observer, crdsys, coord, relate, refval, adjust, step, start, stop)),
  };
}
