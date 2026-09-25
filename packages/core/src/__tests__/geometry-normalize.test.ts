// Cosmographia geometry spellings the loader normalises, and TimeSwitched
// windows in ET, so a stock ESA / NAIF Cosmographia configuration loads as is.

import { describe, expect, it } from 'vitest';
import { Universe, type CatalogJson } from '../index.js';
import { normalizeGeometry } from '../catalog/CatalogLoader.js';

describe('normalizeGeometry', () => {
  it('reads { type: "DSK", kernel } as a Dsk with a source', () => {
    expect(normalizeGeometry({ type: 'DSK', kernel: 'a.bds' })).toEqual({ type: 'Dsk', kernel: 'a.bds', source: 'a.bds' });
    expect(normalizeGeometry({ type: 'Dsk', source: 'b.bds' })).toEqual({ type: 'Dsk', source: 'b.bds' });
  });

  it('normalises the entries of a TimeSwitched sequence and copies rather than mutates', () => {
    const spec = { type: 'TimeSwitched', sequence: [{ startTime: 'x', geometry: { type: 'DSK', kernel: 'c.bds' } }] };
    const out = normalizeGeometry(spec) as { sequence: { geometry: Record<string, unknown> }[] };
    expect(out.sequence[0]!.geometry).toEqual({ type: 'Dsk', kernel: 'c.bds', source: 'c.bds' });
    expect(spec.sequence[0]!.geometry.type).toBe('DSK');
  });
});

describe('TimeSwitched windows', () => {
  it('gives each entry an ET window, open ends running to the neighbours', () => {
    const u = new Universe();
    u.loadCatalog({
      name: 't',
      items: [{
        name: 'Orbiter',
        trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
        geometry: {
          type: 'TimeSwitched',
          sequence: [
            { startTime: '2004-03-02T09:25:18Z', geometry: { type: 'DSK', kernel: 'bus_lr.bds' } },
            { startTime: '2014-11-12T08:35:15Z', geometry: { type: 'DSK', kernel: 'bus.bds' } },
          ],
        },
      }],
    } as unknown as CatalogJson);
    const seq = u.getBody('Orbiter')!.geometryData!.sequence as { startEt: number; endEt: number; geometry: { type: string } }[];
    expect(seq[0]!.geometry.type).toBe('Dsk');
    // The first entry ends where the second starts; the last runs on.
    expect(seq[0]!.endEt).toBe(seq[1]!.startEt);
    expect(seq[1]!.endEt).toBe(Infinity);
    expect(seq[1]!.startEt - seq[0]!.startEt).toBeGreaterThan(10 * 365 * 86400);
  });
});
