import { describe, expect, it } from 'vitest';
import { cubeTileAt } from '../surface/CubeSphere.js';
import { texelCenterDirection, type ImageryAddress } from '../surface/CubeImagery.js';
import {
  MERCATOR_MAX_LATITUDE, VirtualImageryInventory, affordableMatrix, chooseMatrix, directionToSourceLonLat, geocentricDataBounds, mercatorLatitude, mercatorY,
  planReprojection, resample, sourceLatitudeToGeocentric, texelSamplePosition, sourcePosition, upsampleFromParent, virtualLevelRange, xyzSourceGrid,
  type DecodedSourceTile, type ProjectedSourceGrid,
} from '../surface/ProjectedImagery.js';

const WGS84: [number, number] = [6378137, 6356752.314245];
const opts = { tileSize: 32, gutter: 2, ellipsoid: null };
const ctx = xyzSourceGrid({ projection: 'geographic', levels: 13, tileSize: 512, minZoom: 5, latitudeConvention: 'planetocentric' });
const mercator = xyzSourceGrid({ projection: 'mercator', levels: 9, tileSize: 256, latitudeConvention: 'geodetic' });

/** Invert a source pixel position to lon/lat (degrees). */
function inverse(grid: ProjectedSourceGrid, matrixIndex: number, x: number, y: number): [number, number] {
  const m = grid.matrices[matrixIndex];
  const Y = m.y0 - y * m.dy, lon = m.x0 + x * m.dx;
  return [((lon + 540) % 360) - 180, grid.projection === 'geographic' ? Y : mercatorLatitude(Y)];
}
const lonDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

describe('projected source grids', () => {
  it('describes the CTX geographic pyramid and its native cube level', () => {
    const z12 = ctx.matrices[12];
    expect([z12.cols, z12.rows, z12.dx]).toEqual([8192, 4096, 180 / (4096 * 512)]);
    // 5.09 m source pixels: level 13 is the first whose face-centre texel (3.2 m) is no coarser.
    expect(virtualLevelRange(ctx, 256)).toEqual({ minLevel: 4, maxLevel: 13 });
    expect(virtualLevelRange(ctx, 256, 9).maxLevel).toBe(9);
    expect(virtualLevelRange(mercator, 256).minLevel).toBe(0);
  });

  it('converts geocentric directions to geodetic latitude on the ellipsoid and back', () => {
    const latc = 45 * Math.PI / 180;
    const [lon, latd] = directionToSourceLonLat([Math.cos(latc), 0, Math.sin(latc)], 'geodetic', WGS84);
    expect(lon).toBe(0);
    expect(latd).toBeCloseTo(45.19242, 4); // WGS84 geodetic latitude of geocentric 45°
    expect(sourceLatitudeToGeocentric(latd, 'geodetic', WGS84)).toBeCloseTo(45, 9);
    expect(directionToSourceLonLat([Math.cos(latc), 0, Math.sin(latc)], 'planetocentric', WGS84)[1]).toBeCloseTo(45, 12);
  });

  it('maps lon/lat to source pixels and back, wrapping longitude only', () => {
    const p = sourcePosition(ctx, ctx.matrices[3], [179.99, 10]);
    expect(inverse(ctx, 3, ...p)[0]).toBeCloseTo(179.99, 9);
    expect(sourcePosition(ctx, ctx.matrices[3], [-180, 10])[0]).toBe(0);
    expect(sourcePosition(ctx, ctx.matrices[3], [180, 10])[0]).toBe(0);
    expect(mercatorLatitude(mercatorY(60))).toBeCloseTo(60, 12);
    expect(sourcePosition(mercator, mercator.matrices[2], [0, MERCATOR_MAX_LATITUDE + 0.01]).every(Number.isNaN)).toBe(true);
    expect(geocentricDataBounds(mercator, WGS84)![3]).toBeLessThan(MERCATOR_MAX_LATITUDE);
  });
});

describe('virtual cube tile reprojection', () => {
  const cases: Array<[string, ImageryAddress]> = [
    ['equator, face centre', cubeTileAt([1, 0, 0], 5)],
    ['antimeridian', cubeTileAt([-1, 1e-9, 0.01], 6)],
    ['face corner (three faces)', { face: 'px', level: 3, x: 7, y: 7 }],
    ['south pole', cubeTileAt([0, 0, -1], 4)],
  ];
  for (const [name, address] of cases) it(`registers every texel centre, gutters included: ${name}`, () => {
    for (const grid of [ctx, mercator]) {
      const plan = planReprojection(grid, address, { ...opts, ellipsoid: grid === mercator ? WGS84 : null, maxSamples: 1 });
      expect(plan.samplesX * plan.samplesY).toBe(1);
      let checked = 0;
      for (let j = 0; j < plan.span; j += 3) for (let i = 0; i < plan.span; i += 3) {
        const [lon, lat] = directionToSourceLonLat(texelCenterDirection(address, i, j, opts.tileSize, opts.gutter), grid.latitudeConvention, grid === mercator ? WGS84 : null);
        const [x, y] = texelSamplePosition(plan, i, j);
        if (!Number.isFinite(x)) { expect(grid === mercator && Math.abs(lat) > MERCATOR_MAX_LATITUDE - 0.5).toBe(true); continue; }
        // Interpolated texel centres register to within 0.05 source pixel (smooth gnomonic→source mapping).
        const [lon2, lat2] = inverse(grid, plan.matrix.index, x, y);
        const m = grid.matrices[plan.matrix.index];
        const latTol = grid === mercator ? 0.05 * m.dy * Math.cos(lat * Math.PI / 180) : 0.05 * m.dy;
        expect(Math.abs(lat2 - lat)).toBeLessThan(latTol);
        if (Math.abs(lat) < 89) expect(lonDiff(lon2, lon) * Math.cos(lat * Math.PI / 180)).toBeLessThan(0.05 * m.dx);
        checked++;
      }
      if (grid === ctx) expect(checked).toBeGreaterThan(100);
    }
  });

  it('chooses source detail from the texel size, capped at the native matrix', () => {
    const levels = [4, 6, 8, 10, 12, 14].map(level => chooseMatrix(ctx, cubeTileAt([0.3, 0.9, 0.3], level), { ...opts, tileSize: 256, gutter: 4 }));
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
    expect(levels[0]).toBe(ctx.minMatrix);
    expect(levels.at(-1)).toBe(12);
  });

  it('bounds source tiles per cube tile near a geographic pole and records the coarsening', () => {
    const o = { tileSize: 256, gutter: 4, ellipsoid: null };
    // A cap holding the pole spans every longitude: no CTX data matrix (z5+, 64+ columns) fits nine tiles.
    expect(affordableMatrix(ctx, cubeTileAt([0.0001, 0.0001, 1], 11), o)).toBeNull();
    // Near, but not on, the pole the read is coarsened to fit and the coarsening is recorded.
    const near = cubeTileAt([Math.cos(88.5 * Math.PI / 180), 0, Math.sin(88.5 * Math.PI / 180)], 9);
    const plan = planReprojection(ctx, near, o);
    expect(plan.tiles.length).toBeLessThanOrEqual(12);
    expect(plan.wantedMatrix).toBeGreaterThan(plan.matrix.index);
    // Web Mercator holds no data poleward of its limit; the polar face reads only its coarse top rows.
    expect(affordableMatrix(mercator, { face: 'pz', level: 0, x: 0, y: 0 }, { ...o, ellipsoid: WGS84 })).not.toBeNull();
    // Away from the pole the wanted matrix is used and few tiles are read.
    const equatorial = planReprojection(ctx, cubeTileAt([0.6, 0.8, 0.05], 11), { tileSize: 256, gutter: 4, ellipsoid: null });
    expect(equatorial.matrix.index).toBe(equatorial.wantedMatrix);
    expect(equatorial.tiles.length).toBeLessThanOrEqual(9);
  });

  it('area-filters where the source is finer than the texel', () => {
    const coarseTile = cubeTileAt([0.2, 0.2, 0.96], 6);
    const plan = planReprojection(ctx, coarseTile, { tileSize: 64, gutter: 2, ellipsoid: null });
    expect(Math.max(plan.samplesX, plan.samplesY)).toBeGreaterThan(1);
    expect(Math.max(plan.samplesX, plan.samplesY)).toBeLessThanOrEqual(4);
  });

  it('resamples premultiplied, transparent where tiles are missing, rows bottom-up', () => {
    const grid = xyzSourceGrid({ projection: 'geographic', levels: 3, tileSize: 4, latitudeConvention: 'planetocentric' });
    const solid = (r: number, g: number, b: number, a: number): DecodedSourceTile => ({ width: 4, height: 4, data: new Uint8ClampedArray(64).map((_, i) => [r, g, b, a][i % 4]) });
    const address: ImageryAddress = { face: 'px', level: 0, x: 0, y: 0 }; // longitudes −45…45
    const plan = planReprojection(grid, address, { tileSize: 8, gutter: 0, ellipsoid: null, maxSamples: 1 });
    // West of the prime meridian red and opaque; east 50 % blue; no tile → transparent.
    const west = (col: number) => col < plan.matrix.cols / 2;
    const out = resample(plan, (col) => (west(col) ? solid(255, 0, 0, 255) : solid(0, 0, 255, 128)));
    const gap = resample(plan, (col) => (west(col) ? solid(255, 0, 0, 255) : undefined));
    let checked = 0;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
      const [lon] = directionToSourceLonLat(texelCenterDirection(address, i, j, 8, 0), 'planetocentric', null);
      if (Math.abs(lon) < 12) continue; // bilinear blend across the meridian
      const o = ((8 - 1 - j) * 8 + i) * 4; // file row j is written bottom-up
      expect([...out.subarray(o, o + 4)]).toEqual(lon < 0 ? [255, 0, 0, 255] : [0, 0, 255, 128]);
      expect([...gap.subarray(o, o + 4)]).toEqual(lon < 0 ? [255, 0, 0, 255] : [0, 0, 0, 0]);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
    // Declared gap (404): data null → transparent too.
    const declared = resample(plan, () => ({ width: 4, height: 4, data: null }));
    expect(declared.every(v => v === 0)).toBe(true);
  });

  it('upsamples a failed tile from the matching part of its parent', () => {
    const grid = xyzSourceGrid({ projection: 'geographic', levels: 2, tileSize: 2, latitudeConvention: 'planetocentric' });
    // Parent level 0, tile (0,0): 2×2 pixels, NW red, NE green, SW blue, SE white.
    const parent: DecodedSourceTile = { width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]) };
    const child = upsampleFromParent(parent, grid.matrices[0], grid.matrices[1], 1, 1); // SE quarter of parent (0,0)
    expect([...child.data!.subarray(12, 16)]).toEqual([255, 255, 255, 255]);
  });

  it('computes availability from coverage and level range without a tile list', () => {
    const regional = xyzSourceGrid({ projection: 'geographic', levels: 13, tileSize: 512, minZoom: 5, latitudeConvention: 'planetocentric', bounds: [77.16, 18.21, 77.7, 18.72] });
    const inventory = new VirtualImageryInventory(virtualLevelRange(regional, 256), geocentricDataBounds(regional, null));
    const inside = cubeTileAt([Math.cos(18.4 * Math.PI / 180) * Math.cos(77.4 * Math.PI / 180), Math.cos(18.4 * Math.PI / 180) * Math.sin(77.4 * Math.PI / 180), Math.sin(18.4 * Math.PI / 180)], 10);
    const id = (a: ImageryAddress) => `${a.face}/${a.level}/${a.x}/${a.y}`;
    expect(inventory.available.has(id(inside))).toBe(true);
    expect(inventory.available.has(id({ ...inside, level: 2, x: inside.x >> 8, y: inside.y >> 8 }))).toBe(false); // above minLevel
    expect(inventory.topology.has(id({ ...inside, level: 2, x: inside.x >> 8, y: inside.y >> 8 }))).toBe(true);
    expect(inventory.available.has(id(cubeTileAt([-1, 0, 0], 10)))).toBe(false);
    expect(inventory.available.has(id({ ...inside, level: 13, x: inside.x * 8, y: inside.y * 8 }))).toBe(true);
    expect(inventory.available.has(id({ ...inside, level: 14, x: inside.x * 16, y: inside.y * 16 }))).toBe(false); // beyond native
  });
});
