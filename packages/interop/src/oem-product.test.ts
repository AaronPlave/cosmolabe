// The OEM ingest adapter, pinned: authority 'host' with the file's own
// provenance carried through in its own terms (M-0011's charter, second
// adapter), the re-layout into geometry and series forms, and the loud
// refusal to invent a time model.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseOem } from './oem.ts';
import { oemToProduct } from './oem-product.ts';

const text = readFileSync(
  fileURLToPath(new URL('../test-fixtures/mgs.oem', import.meta.url)),
  'utf8',
);

describe('oemToProduct (the host door, M-0011, second adapter)', () => {
  it('carries the file provenance faithfully in the file terms with authority host', () => {
    const oem = parseOem(text);
    const product = oemToProduct(oem, { fileName: 'mgs.oem', kind: 'geometry' });
    expect(product.provenance.authority).toBe('host');
    expect(product.provenance.engine).toBe('oem:NASA/JPL');
    expect(product.provenance.version).toBe('2.0');
    expect(product.provenance.kernels.setHash).toBe('file:mgs.oem');
    expect(product.provenance.kernels.names).toEqual(['mgs.oem']);
    expect(product.provenance.frame).toBe('EME2000');
    expect(product.provenance.correction).toBe('NONE');
    expect(product.provenance.computedAt).toBe('1996-11-04T17:22:31');
    expect(product.provenance.jobId).toBe('1996-062A');
  });

  it('geometry: re-packs the tabulated positions (km) into one polyline layer', () => {
    const product = oemToProduct(parseOem(text), { fileName: 'mgs.oem', kind: 'geometry' });
    const p = product.product;
    if (p.kind !== 'geometry') throw new Error('expected geometry');
    expect(p.layers).toHaveLength(1);
    expect(p.layers[0]!.label).toBe('MARS GLOBAL SURVEYOR');
    expect(p.layers[0]!.frame).toBe('EME2000');
    expect(p.layers[0]!.form).toBe('polyline');
    expect(Array.from(p.layers[0]!.positions.slice(0, 3))).toEqual([2789.6, -280.0, -1746.8]);
    expect(p.layers[0]!.positions).toHaveLength(9);
  });

  it('series: re-columns positions per axis on the caller-supplied ET mapping', () => {
    const toEt = (epoch: string): number => Date.parse(`${epoch}Z`) / 1000;
    const product = oemToProduct(parseOem(text), { fileName: 'mgs.oem', kind: 'series', toEt });
    const p = product.product;
    if (p.kind !== 'series') throw new Error('expected series');
    expect(p.series.map((s) => s.name)).toEqual(['x', 'y', 'z']);
    expect(p.series[0]!.unit).toBe('km');
    expect(p.series[0]!.et[1]! - p.series[0]!.et[0]!).toBeCloseTo(60, 6);
    expect(p.series[0]!.values[0]).toBe(2789.6);
    expect(p.series[2]!.values[2]).toBe(-2008.7);
  });

  it('refuses to invent a time model: series without toEt throws loudly', () => {
    expect(() =>
      oemToProduct(parseOem(text), { fileName: 'mgs.oem', kind: 'series' }),
    ).toThrow(/asserts no time model/);
  });
});
