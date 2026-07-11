// Validates the propagation primitives (oscelt / conics / prop2b) against the
// committed de440 fixture. Seeds a real state from spkezr, then checks the
// element round-trip, two-body period closure, and that conics and prop2b — two
// independent CSPICE routines — agree. (STK_PARITY_SPEC F1, Phase A.)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { createSpiceEngine, type CartesianState, type SpiceEngine } from './index.ts';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../kernels/fixtures/${name}`, import.meta.url))));

/** Relative closeness over a 3-vector (handles solar-system magnitudes). */
function relClose(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const scale = Math.max(1, Math.hypot(b.x, b.y, b.z));
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) / scale;
}

// Heliocentric gravitational parameter (km^3/s^2), the IAU/DE value. The fixture
// PCK carries radii but not GM, and the round-trip/closure checks only require a
// self-consistent mu, so a constant is used (and asserted to echo through oscelt).
const MU_SUN = 1.32712440018e11;

describe('cspice-wasm propagation primitives', () => {
  let spice: SpiceEngine;
  let et: number;
  const muSun = MU_SUN;
  let state: CartesianState;
  let period: number;

  beforeAll(async () => {
    spice = await createSpiceEngine();
    for (const k of ['naif0012.tls', 'pck00011.tpc', 'de440s-inner-cassini.bsp']) {
      await spice.furnsh(k, fixture(k));
    }
    et = await spice.str2et('2004-07-01T00:00:00');
    // Saturn barycenter (6) about the Sun (10): a real, bound heliocentric state.
    const sv = await spice.spkezr('6', et, 'J2000', 'NONE', '10');
    state = { position: sv.position, velocity: sv.velocity };
    const r = Math.hypot(state.position.x, state.position.y, state.position.z);
    const v2 = state.velocity.x ** 2 + state.velocity.y ** 2 + state.velocity.z ** 2;
    const a = -muSun / (2 * (v2 / 2 - muSun / r)); // vis-viva semi-major axis
    period = 2 * Math.PI * Math.sqrt(a ** 3 / muSun);
  });

  it('oscelt reports the central GM and the epoch it was given', async () => {
    const el = await spice.oscelt(state, et, muSun);
    expect(el.mu).toBeCloseTo(muSun, 6);
    expect(el.t0).toBeCloseTo(et, 6);
    expect(el.ecc).toBeGreaterThanOrEqual(0);
    expect(el.ecc).toBeLessThan(1); // Saturn's heliocentric orbit is bound
  });

  it('oscelt -> conics round-trips the state', async () => {
    const el = await spice.oscelt(state, et, muSun);
    const back = await spice.conics(el, et);
    expect(relClose(back.position, state.position)).toBeLessThan(1e-9);
    expect(relClose(back.velocity, state.velocity)).toBeLessThan(1e-9);
  });

  it('prop2b by zero time is the identity', async () => {
    const same = await spice.prop2b(muSun, state, 0);
    expect(relClose(same.position, state.position)).toBeLessThan(1e-12);
    expect(relClose(same.velocity, state.velocity)).toBeLessThan(1e-12);
  });

  it('prop2b over one two-body period returns to the start', async () => {
    const looped = await spice.prop2b(muSun, state, period);
    expect(relClose(looped.position, state.position)).toBeLessThan(1e-6);
    expect(relClose(looped.velocity, state.velocity)).toBeLessThan(1e-6);
  });

  it('conics(et+dt) and prop2b(dt) agree (two independent CSPICE routines)', async () => {
    const dt = period / 7;
    const el = await spice.oscelt(state, et, muSun);
    const viaConics = await spice.conics(el, et + dt);
    const viaProp2b = await spice.prop2b(muSun, state, dt);
    expect(relClose(viaConics.position, viaProp2b.position)).toBeLessThan(1e-9);
    expect(relClose(viaConics.velocity, viaProp2b.velocity)).toBeLessThan(1e-9);
  });
});
