/**
 * Pins core's injection interface to the implementations that have to satisfy
 * it, at compile time.
 *
 * core imports no SPICE package: it declares the surface it calls in
 * src/spice-injection.ts and takes an engine by injection, which two
 * implementations satisfy structurally — @cosmolabe/frames' heritage adapter
 * (the runtime path) and @cosmolabe/spice's Spice (the reference
 * implementation). Structural typing makes them interoperable; on its own it
 * does nothing to stop them drifting apart, and a drift would only surface
 * wherever someone happened to pass the wrong one.
 *
 * The assignments below are that check, and they run under
 * `npm run typecheck:tests`: if either implementation stops satisfying what
 * core calls — a renamed method, a changed signature, a narrowed return — this
 * file fails to compile, naming the member.
 *
 * Note what it deliberately does NOT check: that core's interface mirrors
 * everything the implementations offer. An implementation growing members core
 * does not call (ckcov, ckobj, sxform, getfov, …) is not drift — core's
 * interface is what core calls, and it is meant to shrink toward the M-0002
 * contracts, not to track the heritage surface. Adding a member here to match
 * an implementation is the thing this file exists to discourage.
 */
import { describe, it, expect } from 'vitest';
import { createHeritageSpice } from '@cosmolabe/frames';
import { Spice } from '@cosmolabe/spice';
import type { SpiceInstance } from '../spice-injection.js';

// The runtime path: @cosmolabe/frames' cspice-wasm adapter.
type HeritageAdapter = Awaited<ReturnType<typeof createHeritageSpice>>;
const _adapterSatisfiesCore = (a: HeritageAdapter): SpiceInstance => a;

// The reference implementation: @cosmolabe/spice's timecraftjs wrapper.
const _referenceSatisfiesCore = (s: Spice): SpiceInstance => s;

describe('spice-injection conformance', () => {
  it('is a compile-time pin; both implementations satisfy what core calls', () => {
    // The assertions above are the test — they are checked by
    // `npm run typecheck:tests`, which typechecks this file. Reaching this
    // line at runtime means the module compiled, so both conversions held.
    expect(typeof _adapterSatisfiesCore).toBe('function');
    expect(typeof _referenceSatisfiesCore).toBe('function');
  });
});
