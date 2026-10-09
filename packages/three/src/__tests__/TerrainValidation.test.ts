import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  QuantizedMeshTileset,
  boundaryContinuityReport,
  controlPointReport,
  fitPlane,
  geographicTileBounds,
  geographicTilesCovering,
  parentChildReport,
  parseTileKey,
  pyramidReport,
  registrationReport,
  samplingCostReport,
  seamReport,
  sharedEdgeReport,
  summarizeDifferences,
  tileChildren,
  tileNeighbor,
  tileParent,
  type KeyedTile,
  type TerrainLayer,
} from '../TerrainValidation.js';
import { bodyFixedToGeodetic, geodeticToBodyFixed, type TerrainDatum, type TerrainHeightTile, type TerrainSample } from '../TerrainSampler.js';

const MARS: TerrainDatum = {
  referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] },
  verticalDatum: 'ellipsoid',
  heightConvention: 'geodetic-normal',
};
const MOON: TerrainDatum = { referenceShape: { kind: 'sphere', radiusKm: 1737.4 }, verticalDatum: 'reference-sphere', heightConvention: 'radial' };
const EARTH: TerrainDatum = {
  referenceShape: { kind: 'ellipsoid', radiiKm: [6378.137, 6378.137, 6356.752314245] },
  verticalDatum: 'ellipsoid',
  heightConvention: 'geodetic-normal',
};

/** A height-grid tile whose samples come from an analytic surface, so every expected number is exact. */
function gridTile(id: string, bounds: { westDeg: number; eastDeg: number; southDeg: number; northDeg: number }, f: (lat: number, lon: number) => number, size = 9): TerrainHeightTile {
  const elevationsKm = new Float64Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const lat = bounds.southDeg + (j / (size - 1)) * (bounds.northDeg - bounds.southDeg);
      const lon = bounds.westDeg + (i / (size - 1)) * (bounds.eastDeg - bounds.westDeg);
      elevationsKm[j * size + i] = f(lat, lon);
    }
  }
  return { id, ...bounds, width: size, height: size, elevationsKm };
}

/** An analytic layer — no tiles at all — for reports that only need `sample(lat, lon)`. */
function fnLayer(id: string, f: (lat: number, lon: number) => number | null): TerrainLayer {
  return {
    id,
    sample: (lat, lon) => {
      const h = f(lat, lon);
      return h == null ? null : {
        position: { latDeg: lat, lonDeg: lon }, elevationKm: h, datum: MARS,
        source: { id, kind: 'unknown' }, tileId: `${id}-tile`,
      } satisfies TerrainSample;
    },
  };
}

const fixture = (name: string) => {
  const buf = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

describe('difference statistics', () => {
  it('reports mean, RMS, nearest-rank p95 and max |d|', () => {
    const values = Array.from({ length: 100 }, (_, i) => (i % 2 ? -1 : 1) * (i + 1));
    const s = summarizeDifferences(values);
    expect(s.count).toBe(100);
    expect(s.meanKm).toBeCloseTo(-0.5, 12);
    expect(s.p95AbsKm).toBe(95);
    expect(s.maxAbsKm).toBe(100);
    expect(s.rmsKm).toBeCloseTo(Math.sqrt(values.reduce((a, v) => a + v * v, 0) / 100), 12);
  });

  it('reports NaN, not zero, when nothing was compared', () => {
    const s = summarizeDifferences([]);
    expect(s.count).toBe(0);
    expect(s.rmsKm).toBeNaN();
    expect(s.maxAbsKm).toBeNaN();
  });
});

describe('planar fit', () => {
  it('recovers an offset and slopes exactly from a tilted plane', () => {
    const pts = [];
    for (let e = -5; e <= 5; e++) for (let n = -3; n <= 7; n++) pts.push({ eastKm: e, northKm: n, valueKm: 0.02 + 0.001 * e - 0.0005 * n });
    const fit = fitPlane(pts);
    // The offset is reported at the centroid (north centroid is 2).
    expect(fit.offsetKm).toBeCloseTo(0.02 - 0.0005 * 2, 12);
    expect(fit.slopeEast).toBeCloseTo(0.001, 12);
    expect(fit.slopeNorth).toBeCloseTo(-0.0005, 12);
    expect(fit.residual.maxAbsKm).toBeLessThan(1e-12);
  });

  it('leaves slopes unidentified for collinear points instead of inventing them', () => {
    const fit = fitPlane([0, 1, 2, 3].map((e) => ({ eastKm: e, northKm: 0, valueKm: e })));
    expect(fit.slopeEast).toBeNaN();
    expect(fit.offsetKm).toBeCloseTo(1.5, 12);
  });
});

describe('geographic TMS tiling', () => {
  it('matches the quantized-mesh EPSG:4326 layout (2×1 at level 0, y from the south)', () => {
    expect(geographicTileBounds({ z: 0, x: 0, y: 0 })).toEqual({ westDeg: -180, eastDeg: 0, southDeg: -90, northDeg: 90 });
    expect(geographicTileBounds({ z: 1, x: 3, y: 1 })).toEqual({ westDeg: 90, eastDeg: 180, southDeg: 0, northDeg: 90 });
  });

  it('covers an antimeridian-crossing box from both sides', () => {
    const keys = geographicTilesCovering({ westDeg: 170, eastDeg: -170, southDeg: 0, northDeg: 10 }, 3);
    expect(keys.map((k) => k.x).sort((a, b) => a - b)).toEqual([0, 15]);
    expect(new Set(keys.map((k) => k.y))).toEqual(new Set([4]));
  });

  it('walks parents, children and neighbours, wrapping east at ±180', () => {
    const k = { z: 4, x: 31, y: 15 };
    expect(tileParent(k)).toEqual({ z: 3, x: 15, y: 7 });
    expect(tileChildren(k).map((c) => tileParent(c))).toEqual(Array(4).fill({ z: 4, x: 31, y: 15 }));
    expect(tileNeighbor(k, 'east')).toEqual({ z: 4, x: 0, y: 15 });
    expect(tileNeighbor(k, 'north')).toBeNull();
  });

  it('reads tile keys out of runtime ids and request paths', () => {
    expect(parseTileKey('decoded:14/23433/9870.terrain?v=2.0')).toEqual({ z: 14, x: 23433, y: 9870 });
    expect(parseTileKey('mars_v14:13/11716/4935')).toEqual({ z: 13, x: 11716, y: 4935 });
    expect(parseTileKey('layer.json')).toBeNull();
  });
});

describe('same-LOD shared edges', () => {
  const plane = (lat: number, lon: number) => 0.001 * lat + 0.002 * lon;
  const west = { westDeg: 0, eastDeg: 1, southDeg: 0, northDeg: 1 };
  const east = { westDeg: 1, eastDeg: 2, southDeg: 0, northDeg: 1 };

  it('reports zero error for a continuous surface', () => {
    const r = sharedEdgeReport(gridTile('w', west, plane), gridTile('e', east, plane))!;
    expect(r.direction).toBe('east');
    expect(r.missing).toBe(0);
    expect(r.stats.maxAbsKm).toBeLessThan(1e-9);
  });

  it('measures a step between neighbours, signed east minus west, in either argument order', () => {
    const r = sharedEdgeReport(gridTile('e', east, (la, lo) => plane(la, lo) + 0.003), gridTile('w', west, plane))!;
    expect([r.a, r.b]).toEqual(['w', 'e']);
    expect(r.stats.meanKm).toBeCloseTo(0.003, 9);
    expect(r.stats.maxAbsKm).toBeCloseTo(0.003, 9);
  });

  it('finds north edges and the antimeridian edge, and rejects tiles that only touch at a corner', () => {
    const south = gridTile('s', west, plane), north = gridTile('n', { ...west, southDeg: 1, northDeg: 2 }, plane);
    expect(sharedEdgeReport(south, north)?.direction).toBe('north');
    const a = gridTile('a', { westDeg: 179, eastDeg: 180, southDeg: 0, northDeg: 1 }, () => 1);
    const b = gridTile('b', { westDeg: -180, eastDeg: -179, southDeg: 0, northDeg: 1 }, () => 1.5);
    expect(sharedEdgeReport(a, b)?.stats.meanKm).toBeCloseTo(0.5, 9);
    expect(sharedEdgeReport(south, gridTile('c', { westDeg: 1, eastDeg: 2, southDeg: 1, northDeg: 2 }, plane))).toBeNull();
  });

  it('aggregates every shared edge in a block exactly once', () => {
    const tiles: KeyedTile[] = [];
    for (const x of [0, 1]) for (const y of [0, 1]) {
      const key = { z: 6, x, y };
      tiles.push({ key, tile: gridTile(`${x}${y}`, geographicTileBounds(key), (la) => (x === 1 ? 0.002 : 0) + la * 0.001) });
    }
    const r = seamReport(tiles);
    expect(r.edges).toBe(4);
    expect(r.byLevel).toEqual([expect.objectContaining({ level: 6, comparisons: 4 })]);
    // Only the two east-west edges carry the 2 m step.
    expect(r.worst.slice(0, 2).every((e) => Math.abs(e.stats.meanKm - 0.002) < 1e-9)).toBe(true);
    expect(r.worst[2].stats.maxAbsKm).toBeLessThan(1e-9);
  });
});

describe('parent/child consistency', () => {
  it('measures what a child adds over its parent at dyadic positions', () => {
    const parentKey = { z: 5, x: 40, y: 20 };
    const childKey = tileChildren(parentKey)[3];
    const base = (lat: number, lon: number) => 0.01 * lat - 0.004 * lon;
    const parent = gridTile('p', geographicTileBounds(parentKey), base);
    const child = gridTile('c', geographicTileBounds(childKey), (la, lo) => base(la, lo) - 0.0015);
    const r = parentChildReport(parent, child);
    expect(r.samples).toBe(17 * 17);
    expect(r.missing).toBe(0);
    expect(r.stats.meanKm).toBeCloseTo(-0.0015, 9);
    const pyramid = pyramidReport([{ key: parentKey, tile: parent }, { key: childKey, tile: child }]);
    expect(pyramid.pairs).toBe(1);
    expect(pyramid.byLevel[0].level).toBe(6);
  });
});

describe('regional registration', () => {
  it('discloses a planar bias between two layers and the residual left after removing it', () => {
    const bounds = { westDeg: 77.3, eastDeg: 77.6, southDeg: 18.3, northDeg: 18.6 };
    const reference = fnLayer('canonical', (lat, lon) => 0.3 * Math.sin(lat * 40) + 0.2 * Math.cos(lon * 30));
    // candidate = reference + 12 m + 1 m per km east − 0.5 m per km north (about the box centre)
    const lat0 = 18.45, lon0 = 77.45;
    const R = 3396.19 * 3376.2 / Math.sqrt((3376.2 * Math.cos(lat0 * Math.PI / 180)) ** 2 + (3396.19 * Math.sin(lat0 * Math.PI / 180)) ** 2);
    const eastKm = (lon: number) => R * Math.cos(lat0 * Math.PI / 180) * (lon - lon0) * Math.PI / 180;
    const northKm = (lat: number) => R * (lat - lat0) * Math.PI / 180;
    const candidate = fnLayer('detail', (lat, lon) => reference.sample(lat, lon)!.elevationKm + 0.012 + 0.001 * eastKm(lon) - 0.0005 * northKm(lat));
    const r = registrationReport(reference, candidate, bounds, MARS);
    expect(r.missing).toBe(0);
    expect(r.plane.offsetKm).toBeCloseTo(0.012, 9);
    expect(r.plane.slopeEast).toBeCloseTo(0.001, 9);
    expect(r.plane.slopeNorth).toBeCloseTo(-0.0005, 9);
    expect(r.plane.residual.maxAbsKm).toBeLessThan(1e-9);
    expect(r.difference.maxAbsKm).toBeGreaterThan(0.012);
  });
});

describe('blend-boundary continuity', () => {
  const box = { westDeg: 77.4, eastDeg: 77.5, southDeg: 18.4, northDeg: 18.5 };
  const terrain = (lat: number, lon: number) => 0.02 * Math.sin(lat * 900) * Math.cos(lon * 700);
  const inside = (lat: number, lon: number) => lat >= box.southDeg && lat <= box.northDeg && lon >= box.westDeg && lon <= box.eastDeg;
  // Distance (deg) from the box edge, inside only — used for a linear taper.
  const depth = (lat: number, lon: number) => Math.min(lat - box.southDeg, box.northDeg - lat, lon - box.westDeg, box.eastDeg - lon);

  it('flags an untapered residual as a hard boundary', () => {
    const hard = fnLayer('hard', (lat, lon) => terrain(lat, lon) + (inside(lat, lon) ? 0.03 : 0));
    const r = boundaryContinuityReport(hard, box, MARS, { spacingKm: 0.05 });
    expect(r.transects).toBe(32);
    expect(r.ratio).toBeGreaterThan(3); // ≈5.3 here; an untouched surface scores ≈1
  });

  it('accepts a residual tapered to zero across the blend band', () => {
    const taperDeg = 0.02;
    const tapered = fnLayer('tapered', (lat, lon) => {
      if (!inside(lat, lon)) return terrain(lat, lon);
      const w = Math.min(1, depth(lat, lon) / taperDeg);
      return terrain(lat, lon) + 0.03 * w * w * (3 - 2 * w); // smoothstep
    });
    const r = boundaryContinuityReport(tapered, box, MARS, { spacingKm: 0.05 });
    expect(r.ratio).toBeLessThan(1.5);
  });
});

describe('control points', () => {
  it('reports per-layer values, provenance, and delta from an expected value', () => {
    const points = [
      { id: 'wbf', latDeg: 18.44, lonDeg: 77.45, expectedElevationKm: -2.57, expectedDatum: 'MOLA areoid' },
      { id: 'no-expected', latDeg: 18.5, lonDeg: 77.5 },
      { id: 'outside', latDeg: 50, lonDeg: 0, expectedElevationKm: 0 },
    ];
    const covered = (lat: number) => lat < 20;
    const canonical = fnLayer('canonical', (lat) => (covered(lat) ? -2.56 : null));
    const detail = fnLayer('detail', (lat) => (covered(lat) ? -2.575 : null));
    const r = controlPointReport(points, [canonical, detail]);
    expect(r.layers).toEqual(['canonical', 'detail']);
    expect(r.results[0].values.canonical.deltaKm).toBeCloseTo(0.01, 12);
    expect(r.results[0].values.detail).toMatchObject({ sourceId: 'detail', tileId: 'detail-tile' });
    expect(r.results[1].values.detail.deltaKm).toBeNull();
    expect(r.results[2].values.detail.elevationKm).toBeNull();
    expect(r.byLayer.detail).toMatchObject({ sampled: 2, missing: 1 });
    expect(r.byLayer.detail.delta.count).toBe(1);
  });
});

describe('real Mars Hub tiles at Jezero (z13 parent + z14 children)', () => {
  const PARENT = { z: 13, x: 11716, y: 4935 };
  const keys = [PARENT, ...tileChildren(PARENT)];
  const files = new Map(keys.map((k) => [`${k.z}/${k.x}/${k.y}.terrain?v=2.0`, `marshub-${k.z}-${k.x}-${k.y}.terrain`]));
  const tileset = () => new QuantizedMeshTileset({
    id: 'mars_v14',
    layer: { tiles: ['{z}/{x}/{y}.terrain?v={version}'], version: '2.0', projection: 'EPSG:4326', scheme: 'tms', maxzoom: 14 },
    heightOffsetKm: 8.765,
    fetchTile: async (path) => (files.has(path) ? fixture(files.get(path)!) : null),
  });

  it('loads the block through the tileset reader and measures its real seams', async () => {
    const tiles = await tileset().loadRegion(geographicTileBounds(PARENT), [13, 14]);
    expect(tiles).toHaveLength(5);
    const seams = seamReport(tiles);
    expect(seams.edges).toBe(4);
    expect(seams.samples).toBe(4 * 65);
    expect(seams.missing).toBe(0);
    expect(seams.overall.count).toBeGreaterThan(200);
    // Regression anchor for this source: independent TINs leave metre-scale
    // cracks along shared edges, never zero and never tens of metres.
    expect(seams.overall.maxAbsKm).toBeGreaterThan(1e-4);
    expect(seams.overall.maxAbsKm).toBeLessThan(0.01);
    const pyramid = pyramidReport(tiles);
    expect(pyramid.pairs).toBe(4);
    expect(pyramid.overall.maxAbsKm).toBeLessThan(0.02);
  });

  it('reports heights on the corrected datum: Jezero sits below the reference surface', async () => {
    const tiles = await tileset().loadRegion(geographicTileBounds(PARENT), [14]);
    const b = geographicTileBounds(PARENT);
    const point = { id: 'centre', latDeg: (b.southDeg + b.northDeg) / 2 + 1e-4, lonDeg: (b.westDeg + b.eastDeg) / 2 + 1e-4 };
    const layer = await tileset().layerForPoints('detail', [point]);
    const r = controlPointReport([point], [layer]);
    const v = r.results[0].values.detail;
    expect(v.tileId).toMatch(/^mars_v14:14\//);
    // Jezero's floor is roughly 2.5 km below the Mars reference; well clear of 0 either way.
    expect(v.elevationKm!).toBeLessThan(-1);
    expect(v.elevationKm!).toBeGreaterThan(-4);
    expect(tiles.length).toBe(4);
  });

  it('enforces one tile budget across region and point loads, before any request', async () => {
    let fetches = 0;
    const ts = new QuantizedMeshTileset({
      id: 'mars_v14',
      layer: { tiles: ['{z}/{x}/{y}.terrain?v={version}'], version: '2.0', projection: 'EPSG:4326', scheme: 'tms', maxzoom: 14 },
      heightOffsetKm: 8.765,
      maxTiles: 5,
      fetchTile: async (path) => { fetches++; return files.has(path) ? fixture(files.get(path)!) : null; },
    });
    await ts.loadRegion(geographicTileBounds(PARENT), [13, 14]);
    expect(ts.requestedTiles).toBe(5);
    const b = geographicTileBounds(PARENT);
    const inside = { latDeg: (b.southDeg + b.northDeg) / 2 + 1e-4, lonDeg: (b.westDeg + b.eastDeg) / 2 + 1e-4 };
    // Served by a tile already requested: free.
    await ts.layerForPoints('detail', [inside], 14);
    // Needs a z12 tile: over budget, refused without fetching.
    const before = fetches;
    await expect(ts.layerForPoints('canonical', [inside], 12)).rejects.toThrow(/limit 5/);
    expect(fetches).toBe(before);
  });

  it('records tiles layer.json lists but the server does not return', async () => {
    const ts = tileset();
    const tiles = await ts.loadRegion(geographicTileBounds(PARENT), [12, 13]);
    expect(tiles).toHaveLength(1);
    expect(ts.missingTiles()).toEqual([`12/${PARENT.x >> 1}/${PARENT.y >> 1}`]);
  });

  it('refuses an accidental large build instead of fetching it', async () => {
    await expect(tileset().loadRegion({ westDeg: 0, eastDeg: 90, southDeg: 0, northDeg: 45 }, [10])).rejects.toThrow(/limit/);
  });

  it('reports a per-sample cost for every tile it decoded', async () => {
    const tiles = await tileset().loadRegion(geographicTileBounds(PARENT), [13, 14]);
    const rows = samplingCostReport(tiles.map((t) => t.tile), 500);
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.microsPerSample).toBeGreaterThan(0);
  });
});

describe('verification-set coordinate round trips', () => {
  const cases: Array<[string, TerrainDatum, number, number, number]> = [
    ['Earth equator', EARTH, 0, -78.5, 2.8],
    ['Earth mid-latitude', EARTH, 45, 7.6, 0.4],
    ['Earth high latitude', EARTH, 78.2, 15.6, 0.1],
    ['Mars Wright Brothers Field (below reference)', MARS, 18.4447, 77.4508, -2.57],
    ['Mars Jezero rim', MARS, 18.6, 77.7, -2.0],
    ['Moon Shackleton rim', MOON, -89.55, -45, -0.9315],
    ['Moon Shackleton floor', MOON, -89.9, 0, -4.2],
  ];
  it.each(cases)('%s survives geodetic → body-fixed → geodetic', (_name, datum, latDeg, lonDeg, heightKm) => {
    const xyz = geodeticToBodyFixed({ latDeg, lonDeg, heightKm }, datum);
    const back = bodyFixedToGeodetic(xyz, datum);
    expect(back.latDeg).toBeCloseTo(latDeg, 9);
    expect(back.lonDeg).toBeCloseTo(lonDeg, 9);
    expect(back.heightKm!).toBeCloseTo(heightKm, 8);
  });
});
