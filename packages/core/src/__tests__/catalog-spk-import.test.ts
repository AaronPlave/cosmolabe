import { describe, it, expect, vi } from 'vitest';
import { CatalogLoader } from '../catalog/CatalogLoader.js';
import type { SpiceInstance } from '../spice-injection.js';

// Minimal SPICE stub: only the calls that CatalogLoader exercises during
// spkImport. Anything else throws so missing wiring shows up as a test failure.
function makeSpice(opts: {
  spkobj?: (filename: string) => number[];
  bodc2n?: (id: number) => string | null;
  str2et?: (s: string) => number;
}): SpiceInstance {
  return {
    furnish: vi.fn(),
    unload: vi.fn(),
    spkobj: opts.spkobj ?? (() => []),
    bodc2n: opts.bodc2n ?? (() => null),
    str2et: opts.str2et ?? ((s: string) => Date.parse(s) / 1000),
    // Populate just enough for SpiceTrajectory creation paths in loadItem.
    spkezr: vi.fn(() => ({ state: [0, 0, 0, 0, 0, 0], lightTime: 0 })),
    spkcov: vi.fn(() => []),
    bodvcd: vi.fn(() => { throw new Error('not in PCK'); }),
    bodvrd: vi.fn(() => { throw new Error('not in PCK'); }),
    pxform: vi.fn(),
    sxform: vi.fn(),
    et2utc: vi.fn(),
    utc2et: vi.fn((s: string) => Date.parse(s) / 1000),
    totalLoaded: vi.fn(() => 0),
  } as unknown as SpiceInstance;
}

describe('spkImport directive', () => {
  it('imports every NAIF ID in the kernel as a Body', () => {
    const spice = makeSpice({
      spkobj: () => [2000001, 2000002, 2000004],
      bodc2n: (id) => ({ 2000001: '1 Ceres', 2000002: '2 Pallas', 2000004: '4 Vesta' })[id] ?? null,
    });
    const loader = new CatalogLoader({ spice });
    const result = loader.load({
      name: 'main belt',
      spkImport: [{ kernel: 'codes_300ast.bsp', center: 'SUN' }],
    });
    expect(result.bodies.map(b => b.name)).toEqual(['1 Ceres', '2 Pallas', '4 Vesta']);
    for (const b of result.bodies) expect(b.parentName).toBe('SUN');
  });

  it('filters by naifIdRange', () => {
    const spice = makeSpice({
      spkobj: () => [2000001, 2000002, 2000003, 2000004, 2000005],
      bodc2n: (id) => `Body ${id}`,
    });
    const loader = new CatalogLoader({ spice });
    const result = loader.load({
      name: 'subset',
      spkImport: [{
        kernel: 'codes_300ast.bsp',
        center: 'SUN',
        naifIdRange: [2000002, 2000004],
      }],
    });
    expect(result.bodies.map(b => b.naifId)).toEqual([2000002, 2000003, 2000004]);
  });

  it('falls back to "Body {id}" when bodc2n returns null', () => {
    const spice = makeSpice({
      spkobj: () => [2000999],
      bodc2n: () => null,
    });
    const loader = new CatalogLoader({ spice });
    const result = loader.load({
      name: 'no-name',
      spkImport: [{ kernel: 'k.bsp', center: 'SUN' }],
    });
    expect(result.bodies[0].name).toBe('Body 2000999');
  });

  it('applies defaults to every imported body', () => {
    const spice = makeSpice({
      spkobj: () => [2000001, 2000002],
      bodc2n: (id) => `${id}`,
    });
    const loader = new CatalogLoader({ spice });
    const result = loader.load({
      name: 'with-defaults',
      spkImport: [{
        kernel: 'k.bsp',
        center: 'SUN',
        defaults: {
          class: 'asteroid',
          label: { color: '#aabbcc' },
          radii: [10, 10, 10],
        },
      }],
    });
    expect(result.bodies).toHaveLength(2);
    for (const b of result.bodies) {
      expect(b.classification).toBe('asteroid');
      expect(b.radii).toEqual([10, 10, 10]);
    }
  });

  it('explicit items override spk-imported bodies of the same name', () => {
    const spice = makeSpice({
      spkobj: () => [2000004],
      bodc2n: () => '4 Vesta',
    });
    const loader = new CatalogLoader({ spice });
    const result = loader.load({
      name: 'override',
      spkImport: [{ kernel: 'k.bsp', center: 'SUN', defaults: { class: 'asteroid' } }],
      items: [
        { name: '4 Vesta', class: 'highRes', center: 'SUN', radii: [286, 278, 223] },
      ],
    });
    // Both bodies are pushed, but the second occurrence wins by name when applied
    // to a Universe via Map.set. CatalogLoader returns them in declaration order:
    // imported first, then explicit.
    expect(result.bodies).toHaveLength(2);
    expect(result.bodies[0].classification).toBe('asteroid');
    expect(result.bodies[1].classification).toBe('highRes');
  });

  it('skips spkImport silently when no SPICE instance is available', () => {
    const loader = new CatalogLoader();
    const result = loader.load({
      name: 'no-spice',
      spkImport: [{ kernel: 'k.bsp', center: 'SUN' }],
    });
    expect(result.bodies).toHaveLength(0);
  });

  it('continues when one spkImport throws', () => {
    const spice = makeSpice({
      spkobj: (filename) => {
        if (filename === 'broken.bsp') throw new Error('kernel not furnished');
        return [2000001];
      },
      bodc2n: () => 'Ceres',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loader = new CatalogLoader({ spice });
    const result = loader.load({
      name: 'partial',
      spkImport: [
        { kernel: 'broken.bsp', center: 'SUN' },
        { kernel: 'good.bsp', center: 'SUN' },
      ],
    });
    expect(result.bodies.map(b => b.name)).toEqual(['Ceres']);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('spkImport failed'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});
