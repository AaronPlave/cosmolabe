import { describe, expect, it } from 'vitest';
import { geographicStatusPosition, geographicStatusText, geographicSurfaceNote } from '../geographic/GeographicStatus.js';

describe('geographic status presentation', () => {
  it('shows only actionable problems over the scene', () => {
    expect(geographicStatusText(0)).toBe('');
    expect(geographicStatusText(1)).toBe('Surface vectors · 1 problem');
    expect(geographicStatusText(2)).toBe('Surface vectors · 2 problems');
  });

  it('describes each body\'s drawing surface for the layer details, calling out unverified coverage', () => {
    const status = { bodyName: 'Mars', layerIds: ['a'], features: 1, primitives: 1,
      bodySurfaceMode: 'terrain-streaming' as const, featureTerrainCoverage: 'not-assessed' as const,
      accuracy: 'rendered-triangles; source uncertainty unknown' as const };
    expect(geographicSurfaceNote([status], 'Mars')).toMatch(/streamed terrain.*not checked/);
    expect(geographicSurfaceNote([{ ...status, bodySurfaceMode: 'reference-globe' }], 'Mars')).toMatch(/reference globe/);
    expect(geographicSurfaceNote([status], 'Moon')).toBeNull();
  });

  it('avoids top controls and bottom timeline on desktop and mobile', () => {
    expect(geographicStatusPosition(1100, 760, 330, 24, [{ x0: 700, y0: 0, x1: 1100, y1: 55 }]))
      .toEqual({ left: 8, top: 8 });
    expect(geographicStatusPosition(390, 844, 330, 36, [
      { x0: 8, y0: 8, x1: 382, y1: 42 }, { x0: 0, y0: 700, x1: 390, y1: 844 },
    ])).toEqual({ left: 52, top: 50 });
    expect(geographicStatusPosition(390, 844, 330, 36, [{ x0: 0, y0: 0, x1: 390, y1: 844 }])).toBeNull();
  });
});
