import { afterEach, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { SouthPolarRaster, type PolarRasterManifest } from '../surface/SouthPolarRaster.js';

afterEach(() => vi.unstubAllGlobals());

it.each([undefined, 'mean-with-coverage'] as const)('uses native cells for inspection with %s overview encoding', async overviewEncoding => {
  const manifest: PolarRasterManifest = {
    format: 'cosmolabe-south-polar-raster-1', frame: 'MOON_ME_DE421', radiusKm: 1737.4, polarLimitDeg: -80,
    grid: { westM: -100, northM: 100, stepM: 100, width: 2, height: 2 }, displayStride: 2, tileSize: 256,
    overviewEncoding,
    nativeTiles: ['0/0'], source: { product: 'test', reference: 'test grid', url: 'https://example.com', originalResolutionM: 100 },
    files: {},
  };
  function grid(values: number[]): Response {
    const bytes = new ArrayBuffer(4 * values.length);
    const view = new DataView(bytes);
    values.forEach((value, i) => view.setFloat32(4 * i, value, true));
    return new Response(Uint8Array.from(gzipSync(new Uint8Array(bytes))));
  }
  const fetch = vi.fn(async (url: URL) => {
    if (url.pathname.endsWith('/science.json')) return Response.json(manifest);
    if (url.pathname.endsWith('/overview.f32.gz')) return grid(overviewEncoding ? [42.5, 0.75] : [42.5]);
    if (url.pathname.endsWith('/native/0/0.f32.gz')) return grid([901.125, 0, NaN, 42.5]);
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetch);
  const r = new SouthPolarRaster({
    id: 'test', name: 'Test', body: 'Moon', source: 'https://example.com/science.json',
    description: 'Test', quantity: 'Test', unit: 'K', opacity: 1, colorScale: [{ value: 0, color: '#000000' }, { value: 1000, color: '#ffffff' }],
  });
  await r.load();
  expect(r.status).toBe('ready');
  expect(Array.from(r.texture!.image.data!)).toEqual(overviewEncoding ? [42.5, 0.75] : [42.5]);
  const sample = (x: number, y: number, frame: string = 'MOON_ME_DE421') =>
    r.sample({ bodyName: 'Moon', frame, bodyFixedPositionKm: [x, y, -1737.4] });
  expect(await sample(0.05, -0.05)).toBe(901.125);
  expect(await sample(0.05, 0.05)).toBe(0);
  expect(await sample(-0.05, -0.05)).toBeNull();
  expect(await sample(-0.05, 0.3)).toBeNull();
  expect(await sample(-0.05, 0.05, 'IAU_MOON')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(3);
  r.dispose();
});
