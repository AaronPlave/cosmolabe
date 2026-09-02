// Conformance tests for the frames tier against the M-0002 contracts, driven
// over the committed Cassini SOI fixtures (the GS-2 reference geometry). The
// differential harness at tests/rig/seam.rig.ts is the cross-core gate; these
// tests pin the tier's own semantics: explicit correction, batch layout,
// epoch expansion, quaternion convention, chain composition, and the
// provenance hash.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { createSpiceBindings, type SpiceBindings } from 'cspice-wasm';
import { createFramesLayer, describeChain, type FramesLayer } from './index.ts';
import type { Correction, StateQuery } from './index.ts';

const fixtureBytes = (name: string) =>
  new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../../../kernels/fixtures/${name}`, import.meta.url))),
  );

const FIXTURES = ['naif0012.tls', 'pck00011.tpc', 'de440s-inner-cassini.bsp', 'cassini-soi.bsp'];

describe('@cosmolabe/frames M-0002 conformance', () => {
  let frames: FramesLayer;
  let oracle: SpiceBindings; // independent cspice-wasm instance, same kernel bytes
  let et0: number;

  beforeAll(async () => {
    frames = await createFramesLayer();
    oracle = await createSpiceBindings();
    for (const name of FIXTURES) {
      const bytes = fixtureBytes(name);
      frames.furnish(name, bytes);
      oracle.furnsh(name, bytes);
    }
    et0 = frames.toEt('2004-07-01T02:48:00Z');
  });

  it('toEt is the conversion authority and accepts the ISO Z suffix', () => {
    expect(et0).toBeCloseTo(oracle.str2et('2004-07-01T02:48:00'), 9);
    expect(frames.toEt('2004-07-01T02:48:00')).toBe(et0);
  });

  it('refuses a missing or invalid correction, never defaulting it', async () => {
    const q = {
      targets: ['CASSINI'],
      observer: 'SATURN',
      frame: 'J2000',
      epochs: [et0],
    } as unknown as StateQuery;
    await expect(frames.states(q)).rejects.toThrow(/correction is required/);
    await expect(
      frames.states({ ...q, correction: 'LT+S ' as Correction }),
    ).rejects.toThrow(/correction is required/);
  });

  it('states() matches spkezr per epoch and per target in the documented layout', async () => {
    const epochs = [et0 - 3600, et0, et0 + 3600];
    const batch = await frames.states({
      targets: ['CASSINI', 'SUN'],
      observer: 'SATURN',
      frame: 'J2000',
      correction: 'NONE',
      epochs,
    });
    expect(batch.states.length).toBe(2 * 3 * 6);
    expect(batch.lightTimes.length).toBe(2 * 3);
    for (let t = 0; t < 2; t++) {
      const target = ['CASSINI', 'SUN'][t]!;
      for (let i = 0; i < 3; i++) {
        const ref = oracle.spkezr(target, epochs[i]!, 'J2000', 'NONE', 'SATURN');
        const base = (t * 3 + i) * 6;
        expect(batch.states[base]).toBe(ref.position.x);
        expect(batch.states[base + 1]).toBe(ref.position.y);
        expect(batch.states[base + 2]).toBe(ref.position.z);
        expect(batch.states[base + 3]).toBe(ref.velocity.x);
        expect(batch.states[base + 4]).toBe(ref.velocity.y);
        expect(batch.states[base + 5]).toBe(ref.velocity.z);
        expect(batch.lightTimes[t * 3 + i]).toBe(ref.lightTime);
      }
    }
  });

  it('expands a range epoch spec inclusively of start with the documented end rule', async () => {
    const batch = await frames.states({
      targets: ['SUN'],
      observer: 'SATURN',
      frame: 'J2000',
      correction: 'LT',
      epochs: { start: et0, end: et0 + 100, step: 40 },
    });
    expect(Array.from(batch.epochs)).toEqual([et0, et0 + 40, et0 + 80]);
    expect(batch.correction).toBe('LT');
  });

  it('carries a light-time corrected state distinct from the geometric one', async () => {
    const geometric = await frames.states({
      targets: ['SUN'],
      observer: 'CASSINI',
      frame: 'J2000',
      correction: 'NONE',
      epochs: [et0],
    });
    const corrected = await frames.states({
      targets: ['SUN'],
      observer: 'CASSINI',
      frame: 'J2000',
      correction: 'LT+S',
      epochs: [et0],
    });
    const dx = geometric.states[0]! - corrected.states[0]!;
    const dy = geometric.states[1]! - corrected.states[1]!;
    const dz = geometric.states[2]! - corrected.states[2]!;
    expect(Math.hypot(dx, dy, dz)).toBeGreaterThan(1); // km scale, the M-0002 rationale
  });

  it('orientation() returns scalar-first quaternions matching pxform plus m2q', async () => {
    const batch = await frames.orientation('SATURN', 'J2000', [et0]);
    expect(batch.bodyFrame).toBe('IAU_SATURN');
    const ref = oracle.m2q(oracle.pxform('J2000', 'IAU_SATURN', et0));
    expect(Array.from(batch.quats)).toEqual(ref);
    const norm = Math.hypot(batch.quats[0]!, batch.quats[1]!, batch.quats[2]!, batch.quats[3]!);
    expect(norm).toBeCloseTo(1, 12);
  });

  it('chain() is inspectable and its legs compose to the direct rotation', () => {
    const chain = frames.chain('ECLIPJ2000', 'IAU_SATURN', et0);
    expect(chain.nodes.map((n) => n.frame)).toEqual(['ECLIPJ2000', 'J2000', 'IAU_SATURN']);
    expect(chain.nodes.every((n) => n.frameId !== 0)).toBe(true);
    expect(chain.legs.length).toBe(2);
    expect(describeChain(chain)).toContain('ECLIPJ2000');

    // Compose the two legs (row-major) and compare to the direct pxform.
    const [a, b] = [chain.legs[0]!.rotation, chain.legs[1]!.rotation];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) sum += b[r * 3 + k]! * a[k * 3 + c]!;
        expect(Math.abs(sum - chain.rotation[r * 3 + c]!)).toBeLessThan(1e-14);
      }
    }
  });

  it('kernels() reports a furnish-order list and an order-independent set hash', async () => {
    const info = frames.kernels();
    expect(info.count).toBe(FIXTURES.length);
    expect(info.kernels.map((k) => k.name)).toEqual(FIXTURES);
    expect(info.setHash).toMatch(/^[0-9a-f]{64}$/);

    const reordered = await createFramesLayer();
    for (const name of [...FIXTURES].reverse()) reordered.furnish(name, fixtureBytes(name));
    expect(reordered.kernels().setHash).toBe(info.setHash);

    reordered.unload('cassini-soi.bsp');
    expect(reordered.kernels().count).toBe(FIXTURES.length - 1);
    expect(reordered.kernels().setHash).not.toBe(info.setHash);
  });
});
