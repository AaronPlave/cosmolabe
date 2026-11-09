import { describe, expect, it } from 'vitest';
import { CpuMeshSurface } from '../surface/CpuMeshSurface.js';
import { clipmapSourceFromSurface } from '../SolarShadowSurfaceSource.js';

const R = 1737.4;
const datum = { referenceShape: { kind: 'sphere' as const, radiusKm: R }, verticalDatum: 'reference-sphere' as const, heightConvention: 'radial' as const };

describe('clipmapSourceFromSurface (#205)', () => {
  it('reads a mesh surface by radial rays; outside the mesh is unknown', () => {
    // A 4 km square patch 0.5 km above the datum, centred on (0°, 0°).
    const x = R + 0.5, h = 2;
    const mesh = new CpuMeshSurface(
      { bodyId: 'Moon', frame: 'IAU_MOON', source: { id: 'dsk', kind: 'triangle-mesh' }, shape: { kind: 'mesh' }, coverage: 'complete-product' },
      { positionsKm: new Float64Array([x, -h, -h, x, h, -h, x, h, h, x, -h, h]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) },
      { meshDeviationBoundKm: 0 },
    );
    const src = clipmapSourceFromSurface(mesh, datum);
    expect(src.elevationKm(0, 0, 0.1)).toBeCloseTo(0.5, 4);
    expect(src.elevationKm(0.02, 0.02, 0.1)).toBeCloseTo(0.5, 3);
    expect(src.elevationKm(5, 5, 0.1)).toBeNull();
  });

  it('uses a height-field surface\'s own elevation sampler', () => {
    const surface = { metadata: {} as never, intersectRay: () => { throw new Error('unused'); },
      sampleElevation: (lat: number) => (lat < 1 ? { elevationKm: 1.25 } as never : null) };
    const src = clipmapSourceFromSurface(surface, datum);
    expect(src.elevationKm(0, 0, 0.1)).toBe(1.25);
    expect(src.elevationKm(2, 0, 0.1)).toBeNull();
  });
});
