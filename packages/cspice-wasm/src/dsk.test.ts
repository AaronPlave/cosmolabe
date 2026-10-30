// Validates DSK type-2 shape-model reading against committed fixtures: the New
// Horizons MU69 low-poly model (a real mission product) for counts, 0-based
// plate indices, a pinned vertex and the segment descriptor; and two synthetic
// files from scripts/make-dsk-fixtures.py for the multi-segment merge and the
// refusal to merge segments of different bodies.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { createSpiceEngine, type DskShape, type SpiceEngine } from './index.js';

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

  it('returns typed arrays', () => {
    expect(shape.vertices).toBeInstanceOf(Float64Array);
    expect(shape.plates).toBeInstanceOf(Uint32Array);
  });

  it('reports the segment centre and frame from the descriptor', () => {
    // 2486958 is (486958) Arrokoth. Its body-fixed frame id is not a built-in,
    // and no FK is loaded here, so the name is empty rather than invented.
    expect(shape.centerId).toBe(2486958);
    expect(shape.segments).toHaveLength(1);
    expect(shape.segments[0]).toMatchObject({
      centerId: 2486958,
      frameId: 10111,
      frame: '',
      vertexCount: shape.vertices.length / 3,
      plateCount: shape.plates.length / 3,
    });
    expect(shape.skippedSegments).toBe(0);
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

describe('cspice-wasm DSK multi-segment merge', () => {
  let engine: SpiceEngine;

  beforeAll(async () => {
    engine = await createSpiceEngine();
  });

  it('concatenates segments, offsetting each segment\'s plate indices', async () => {
    const shape = await engine.readDsk('dsk-two-segments.bds', fixture('dsk-two-segments.bds'));
    // A tetrahedron (4 vertices, 4 plates) then a cube (8 vertices, 12 plates).
    expect(shape.segments.map((s) => [s.vertexCount, s.plateCount])).toEqual([[4, 4], [8, 12]]);
    expect(shape.vertices.length).toBe(12 * 3);
    expect(shape.plates.length).toBe(16 * 3);
    expect(shape.centerId).toBe(499);
    expect(shape.frame).toBe('IAU_MARS');

    // The tetrahedron's plates index vertices 0..3 only.
    const tetra = Array.from(shape.plates.subarray(0, 12));
    expect(Math.min(...tetra)).toBe(0);
    expect(Math.max(...tetra)).toBe(3);
    // Every cube plate lands on a cube vertex (4..11), all at x = 10 or 12.
    const cube = Array.from(shape.plates.subarray(12));
    expect(Math.min(...cube)).toBe(4);
    expect(Math.max(...cube)).toBe(11);
    for (const i of cube) expect([10, 12]).toContain(shape.vertices[i * 3]);
  });

  it('refuses to merge segments of different bodies or frames', async () => {
    await expect(engine.readDsk('dsk-mixed-frames.bds', fixture('dsk-mixed-frames.bds'))).rejects.toThrow(
      /mixes segments/,
    );
  });

  it('leaves no staged file behind, so the same name can be read again', async () => {
    const a = await engine.readDsk('dsk-two-segments.bds', fixture('dsk-two-segments.bds'));
    const b = await engine.readDsk('dsk-two-segments.bds', fixture('dsk-two-segments.bds'));
    expect(b.vertices).toEqual(a.vertices);
    expect(await engine.ktotal('ALL')).toBe(0);
  });
});
