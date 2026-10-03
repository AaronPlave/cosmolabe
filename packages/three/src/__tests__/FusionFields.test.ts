import { describe, expect, it } from 'vitest';
import { FusionFields, type DebugFieldsDescription } from '../FusionFields.js';

/** Mirrors dem.py's selftest layout: 8×4 cells over 77..77.4E, 18.2..18.4N. */
function sample(): FusionFields {
  const W = 8, H = 4, n = W * H;
  const buf = new ArrayBuffer(n * 10);
  const dv = new DataView(buf);
  for (let i = 0; i < n; i++) {
    const x = i % W;
    dv.setFloat32(i * 4, 1000, true);                       // baseM
    dv.setFloat32(n * 4 + i * 4, x < 5 ? 4 : x === 5 ? 2.4 : 0, true); // residualM
  }
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < n; i++) {
    const x = i % W;
    u8[n * 8 + i] = x < 5 ? 255 : x === 5 ? 153 : 0;        // weight
    u8[n * 9 + i] = x < 5 ? 255 : x === 5 ? 153 : 0;        // coverage
  }
  const desc: DebugFieldsDescription = {
    path: 'fusion-fields.bin', byteLength: n * 10, byteOrder: 'little-endian',
    grid: { bounds: [77, 18.2, 77.4, 18.4], width: W, height: H, rowOrder: 'north-to-south' },
    fields: [
      { name: 'baseM', type: 'float32', offset: 0 },
      { name: 'residualM', type: 'float32', offset: n * 4 },
      { name: 'weight', type: 'uint8', offset: n * 8, scale: 1 / 255 },
      { name: 'coverage', type: 'uint8', offset: n * 9, scale: 1 / 255 },
    ],
  };
  return FusionFields.parse(desc, buf);
}

describe('FusionFields', () => {
  it('decodes the layout', () => {
    const f = sample();
    expect(f.maxAbsResidualM).toBe(4);
    expect(f.coverage[5]).toBeCloseTo(0.6, 5);
    expect(f.baseM[0]).toBe(1000);
  });

  it('classifies footprints', () => {
    const f = sample();
    const cell = 0.05;
    const box = (x0: number, x1: number) => ({ westDeg: 77 + x0 * cell + 1e-6, eastDeg: 77 + x1 * cell - 1e-6, southDeg: 18.2, northDeg: 18.4 });
    expect(f.boundsStats(box(0, 4))).toMatchObject({ allDetail: true, touchesBlend: false, touchesCoverageEdge: false, meanResidualM: 4 });
    expect(f.boundsStats(box(4, 6))).toMatchObject({ allDetail: false, touchesBlend: true, touchesCoverageEdge: true });
    expect(f.boundsStats(box(6, 8))).toMatchObject({ meanWeight: 0, touchesBlend: false });
    expect(f.boundsStats({ westDeg: 10, eastDeg: 11, southDeg: 0, northDeg: 1 })).toBeNull();
  });

  it('rejects truncated files', () => {
    expect(() => FusionFields.parse({ path: 'x', byteLength: 100, byteOrder: 'little-endian', grid: { bounds: [0, 0, 1, 1], width: 1, height: 1, rowOrder: 'north-to-south' }, fields: [] }, new ArrayBuffer(4))).toThrow();
  });
});
