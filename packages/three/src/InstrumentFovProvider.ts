// The one SPICE capability the renderer needs that core's injection interface
// does not carry: instrument field-of-view geometry, read from a furnished IK.
//
// core's SpiceInstance (packages/core/src/spice-injection.ts) is deliberately
// only what core itself calls, and core calls no FOV routine — the renderer
// does, to draw sensor footprints. Rather than widen core's interface for a
// consumer core has nothing to do with, the renderer declares the requirement
// it actually has, right here, and narrows to it at the point of use. That is
// the same shape as core's own GeometryFinderProvider: a purpose-named
// contract owned by its consumer, satisfied structurally by any engine that
// implements getfov — which @cosmolabe/frames' heritage adapter does.

/** A SPICE instrument FOV, the getfov_c result. */
export interface InstrumentFov {
  shape: 'POLYGON' | 'RECTANGLE' | 'CIRCLE' | 'ELLIPSE';
  frame: string;
  boresight: [number, number, number];
  bounds: [number, number, number][];
}

/** An engine that can answer for an instrument's field of view. */
export interface InstrumentFovProvider {
  getfov(instId: number, maxBounds?: number): InstrumentFov;
}

/**
 * Narrow an injected engine to the FOV capability, or null if it has none.
 * Returning null rather than throwing matches how the call sites already treat
 * a missing IK: no FOV geometry is a degraded scene, not an error.
 */
export function instrumentFovProviderOf(spice: unknown): InstrumentFovProvider | null {
  return spice != null && typeof (spice as InstrumentFovProvider).getfov === 'function'
    ? (spice as InstrumentFovProvider)
    : null;
}
