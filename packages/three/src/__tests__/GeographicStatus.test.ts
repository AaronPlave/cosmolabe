import { describe, expect, it } from 'vitest';
import { geographicStatusPosition, geographicStatusText } from '../geographic/GeographicStatus.js';

describe('geographic status presentation', () => {
  it('scopes terrain information to named body modes and calls out unverified coverage', () => {
    expect(geographicStatusText([], 0)).toBe('');
    expect(geographicStatusText([], 2)).toBe('Vector base · 2 limitations');
    const status = { bodyName: 'Mars', layerIds: ['a'], features: 1, primitives: 1,
      bodySurfaceMode: 'terrain-streaming' as const, featureTerrainCoverage: 'not-assessed' as const,
      accuracy: 'rendered-triangles; source uncertainty unknown' as const };
    expect(geographicStatusText([status, status, { ...status, bodyName: 'Moon', bodySurfaceMode: 'reference-globe' }], 1))
      .toBe('Vector base · Mars: terrain mode (coverage unverified), Moon: reference globe · 1 limitation');
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
