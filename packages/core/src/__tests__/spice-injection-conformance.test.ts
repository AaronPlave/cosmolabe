/** Compile-time pin: frames satisfies core’s consumer-owned injection interface. */
import { describe, it, expect } from 'vitest';
import { createHeritageSpice } from '@cosmolabe/frames';
import type { SpiceInstance } from '../spice-injection.js';

// The runtime path: @cosmolabe/frames' cspice-wasm adapter.
type HeritageAdapter = Awaited<ReturnType<typeof createHeritageSpice>>;
const _adapterSatisfiesCore = (a: HeritageAdapter): SpiceInstance => a;

describe('spice-injection conformance', () => {
  it('is a compile-time pin; the supported adapter satisfies what core calls', () => {
    // The assertions above are the test — they are checked by
    // `npm run typecheck:tests`, which typechecks this file. Reaching this
    // line at runtime means the module compiled, so the conversion held.
    expect(typeof _adapterSatisfiesCore).toBe('function');
  });
});
