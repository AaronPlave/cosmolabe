// Validates DSK type-2 shape-model reading against a committed fixture (the New
// Horizons MU69 low-poly model). Asserts vertex and plate counts, that plate
// indices are valid 0-based references, and a pinned vertex coordinate.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { createSpiceEngine, type DskShape, type SpiceEngine } from './index.ts';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../kernels/fixtures/${name}`, import.meta.url))));

describe('cspice-wasm DSK type-2 reader', () => {
  let engine: SpiceEngine;
  let shape: DskShape;

  beforeAll(async () => {
    engine = await createSpiceEngine();
    shape = await engine.readDsk('mu69_lopoly.bds', fixture('mu69_lopoly.bds'));
  });

  it('reads a non-empty triangle mesh', () => {
    expect(shape.vertices.length).toBeGreaterThan(0);
    expect(shape.plates.length).toBeGreaterThan(0);
    expect(shape.vertices.length % 3).toBe(0);
    expect(shape.plates.length % 3).toBe(0);
  });

  it('produces valid 0-based plate indices within the vertex range', () => {
    const nv = shape.vertices.length / 3;
    expect(Math.min(...shape.plates)).toBe(0);
    expect(Math.max(...shape.plates)).toBeLessThan(nv);
  });

  it('matches the pinned first vertex of the MU69 model', () => {
    expect(shape.vertices[0]).toBeCloseTo(5.84, 1);
    expect(Math.abs(shape.vertices[1]!)).toBeLessThan(0.01);
    expect(shape.vertices[2]).toBeCloseTo(4.79, 1);
  });

  it('has a physically plausible MU69 extent (tens of km)', () => {
    let maxR = 0;
    for (let i = 0; i < shape.vertices.length; i += 3) {
      maxR = Math.max(maxR, Math.hypot(shape.vertices[i]!, shape.vertices[i + 1]!, shape.vertices[i + 2]!));
    }
    expect(maxR).toBeGreaterThan(5);
    expect(maxR).toBeLessThan(40);
  });
});
