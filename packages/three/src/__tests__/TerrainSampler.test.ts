import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TerrainSampler, bodyFixedToGeodetic, geodeticToBodyFixed, type TerrainDatum } from '../TerrainSampler.js';
import { decodeQuantizedMesh } from '../internal/quantized-mesh.js';

const datum: TerrainDatum = {
  referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] },
  verticalDatum: 'ellipsoid',
  heightConvention: 'geodetic-normal',
};

const grid = (over: Partial<Parameters<TerrainSampler['addTile']>[0]> = {}) => ({
  id: 'grid', westDeg: 0, eastDeg: 10, southDeg: 0, northDeg: 10,
  width: 2, height: 2, elevationsKm: new Float32Array([0, 10, 20, 30]),
  ...over,
} as Parameters<TerrainSampler['addTile']>[0]);

describe('TerrainSampler', () => {
  it('bilinearly interpolates decoded CPU height tiles without renderer geometry', () => {
    const sampler = new TerrainSampler(datum, { id: 'test', kind: 'height-grid' });
    sampler.addTile(grid());
    expect(sampler.sample(5, 5)?.elevationKm).toBeCloseTo(15);
    expect(sampler.diagnostics.tileCount).toBe(1);
  });

  it('wraps longitude at the antimeridian and handles polar samples', () => {
    const sampler = new TerrainSampler(datum, { id: 'polar', kind: 'height-grid' });
    sampler.addTile({ id: 'polar', westDeg: 170, eastDeg: -170, southDeg: 80, northDeg: 90, width: 2, height: 2, elevationsKm: new Float32Array([1, 2, 3, 4]) });
    expect(sampler.sample(85, 180)?.elevationKm).toBeCloseTo(2.5);
    expect(sampler.sample(85, -180)?.elevationKm).toBeCloseTo(2.5);
  });

  it('round-trips ellipsoid geodetic and body-fixed coordinates', () => {
    const original = { latDeg: 88.5, lonDeg: -135.25, heightKm: 0.123 };
    const recovered = bodyFixedToGeodetic(geodeticToBodyFixed(original, datum), datum);
    expect(recovered.latDeg).toBeCloseTo(original.latDeg, 9);
    expect(recovered.lonDeg).toBeCloseTo(original.lonDeg, 9);
    expect(recovered.heightKm).toBeCloseTo(original.heightKm, 9);
  });

  it('uses geodetic latitude for body-fixed sampling on an oblate body', () => {
    const sampler = new TerrainSampler(datum, { id: 'oblate', kind: 'height-grid' });
    sampler.addTile(grid({
      id: 'mid-latitude', westDeg: 4.9, eastDeg: 5.1, southDeg: 44.9, northDeg: 45.1,
      elevationsKm: new Float32Array([7, 7, 7, 7]),
    }));
    const point = geodeticToBodyFixed({ latDeg: 45, lonDeg: 5, heightKm: 10 }, datum);
    const planetocentricLatDeg = Math.atan2(point.zKm, Math.hypot(point.xKm, point.yKm)) * (180 / Math.PI);

    // Mars's flattening separates the two latitude conventions enough that a
    // high-LOD tile can cover the geodetic point but not the radial latitude.
    expect(Math.abs(planetocentricLatDeg - 45)).toBeGreaterThan(0.3);
    expect(sampler.sample(planetocentricLatDeg, 5)).toBeNull();
    const sample = sampler.sampleBodyFixedCartesian(point);
    expect(sample?.position.latDeg).toBeCloseTo(45, 9);
    expect(sample?.elevationKm).toBe(7);
  });

  it('recovers height at the exact poles, where the p/cos(lat) form collapses', () => {
    for (const latDeg of [90, -90, 89.9999, -89.9999]) {
      const recovered = bodyFixedToGeodetic(geodeticToBodyFixed({ latDeg, lonDeg: 0, heightKm: 2 }, datum), datum);
      expect(recovered.heightKm).toBeCloseTo(2, 6);
    }
  });

  it('reports unloaded state and preserves tile provenance', () => {
    const sampler = new TerrainSampler(datum, { id: 'default', kind: 'height-grid' }, 2);
    expect(sampler.sample(0, 0)).toBeNull();
    expect(sampler.diagnostics.state).toBe('unloaded');
    sampler.addTile({
      id: 'source-tile', westDeg: 0, eastDeg: 1, southDeg: 0, northDeg: 1,
      width: 2, height: 2, elevationsKm: new Float32Array([1, 1, 1, 1]),
      source: { id: 'regional-dem', kind: 'height-grid', uncertaintyKm: 0.002 },
    });
    const sample = sampler.sample(0.5, 0.5);
    expect(sample?.source.id).toBe('regional-dem');
    expect(sample?.uncertaintyKm).toBe(0.002);
    expect(sampler.diagnostics.state).toBe('ready');
  });

  it('evicts the least recently inserted tile at the configured bound', () => {
    const sampler = new TerrainSampler(datum, { id: 'test', kind: 'height-grid' }, 1);
    const tile = (id: string, elevation: number) => ({
      id, westDeg: 0, eastDeg: 1, southDeg: 0, northDeg: 1,
      width: 2, height: 2, elevationsKm: new Float32Array([elevation, elevation, elevation, elevation]),
    });
    sampler.addTile(tile('first', 1));
    sampler.addTile(tile('second', 2));
    expect(sampler.sample(0.5, 0.5)?.elevationKm).toBe(2);
    expect(sampler.diagnostics.tileCount).toBe(1);
  });

  it('derives a normalized terrain normal from a height slope', () => {
    const sampler = new TerrainSampler({
      referenceShape: { kind: 'sphere', radiusKm: 1 },
      verticalDatum: 'ellipsoid',
      heightConvention: 'radial',
    }, { id: 'test', kind: 'height-grid' });
    sampler.addTile({
      id: 'slope', westDeg: 0, eastDeg: 10, southDeg: 0, northDeg: 10,
      width: 3, height: 3, elevationsKm: new Float32Array([0, 1, 2, 0, 1, 2, 0, 1, 2]),
    });
    const normal = sampler.sample(5, 5, true)?.normal;
    expect(normal).toBeDefined();
    expect(Math.hypot(...normal!)).toBeCloseTo(1, 6);
    expect(normal![0]).toBeLessThan(0);
  });
});

describe('TerrainSampler longitude containment', () => {
  it('rejects longitudes outside a tile instead of matching on latitude alone', () => {
    const sampler = new TerrainSampler(datum, { id: 'test', kind: 'height-grid' });
    sampler.addTile(grid());
    // Inside the 0..10E span.
    expect(sampler.sample(5, 5)).not.toBeNull();
    // Same latitude band, unrelated longitudes — must not resolve to this tile.
    for (const lon of [20, 90, 170, -5, -90, -170, 180]) {
      expect(sampler.sample(5, lon), `lon=${lon}`).toBeNull();
    }
  });

  it('contains longitudes across an antimeridian-crossing tile and excludes the far side', () => {
    const sampler = new TerrainSampler(datum, { id: 'test', kind: 'height-grid' });
    sampler.addTile(grid({ id: 'am', westDeg: 170, eastDeg: -170, southDeg: 0, northDeg: 10 }));
    for (const lon of [170, 175, 180, -180, -175, -170]) {
      expect(sampler.sample(5, lon), `inside lon=${lon}`).not.toBeNull();
    }
    for (const lon of [0, 90, -90, 160, -160]) {
      expect(sampler.sample(5, lon), `outside lon=${lon}`).toBeNull();
    }
  });

  it('rejects a degenerate zero-width tile rather than treating it as global', () => {
    const sampler = new TerrainSampler(datum, { id: 'test', kind: 'height-grid' });
    expect(() => sampler.addTile(grid({ westDeg: 30, eastDeg: 30 }))).toThrow(/zero longitude span/);
    expect(() => sampler.addTile(grid({ southDeg: 10, northDeg: 10 }))).toThrow(/latitude span/);
  });

  it('accepts a genuine full-globe tile spanning the full ±180', () => {
    const sampler = new TerrainSampler(datum, { id: 'test', kind: 'height-grid' });
    sampler.addTile(grid({ id: 'globe', westDeg: -180, eastDeg: 180, southDeg: -90, northDeg: 90 }));
    for (const lon of [-180, -90, 0, 90, 179.9]) {
      expect(sampler.sample(0, lon), `lon=${lon}`).not.toBeNull();
    }
  });
});

describe('TerrainSampler overlapping-tile resolution', () => {
  it('prefers the smaller-footprint tile regardless of insertion order', () => {
    const overview = grid({ id: 'overview', westDeg: 0, eastDeg: 40, southDeg: 0, northDeg: 40, elevationsKm: new Float32Array([1, 1, 1, 1]) });
    const detail = grid({ id: 'detail', westDeg: 4, eastDeg: 6, southDeg: 4, northDeg: 6, elevationsKm: new Float32Array([9, 9, 9, 9]) });

    const detailLast = new TerrainSampler(datum, { id: 'test', kind: 'height-grid' });
    detailLast.addTile(overview);
    detailLast.addTile(detail);
    expect(detailLast.sample(5, 5)?.elevationKm).toBe(9);

    // The overview arriving last must not clobber the detailed tile.
    const overviewLast = new TerrainSampler(datum, { id: 'test', kind: 'height-grid' });
    overviewLast.addTile(detail);
    overviewLast.addTile(overview);
    expect(overviewLast.sample(5, 5)?.elevationKm).toBe(9);
    // Outside the detailed tile the overview still answers.
    expect(overviewLast.sample(30, 30)?.elevationKm).toBe(1);
  });
});

/** TMS tile bounds for the quantized-mesh 2×1 root tiling, in degrees. */
function tmsBounds(z: number, x: number, y: number) {
  const nx = 2 ** (z + 1), ny = 2 ** z;
  return {
    westDeg: (x / nx) * 360 - 180, eastDeg: ((x + 1) / nx) * 360 - 180,
    southDeg: (y / ny) * 180 - 90, northDeg: ((y + 1) / ny) * 180 - 90,
  };
}

const fixture = (name: string) => {
  const buf = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

const REAL_TILES = [
  { file: 'marshub-14-9366-7669.terrain', z: 14, x: 9366, y: 7669 },
  { file: 'marshub-6-63-31.terrain', z: 6, x: 63, y: 31 },
] as const;

describe('quantized-mesh load path (real Mars Hub tiles)', () => {
  it('decodes real tiles into a consistent triangulation', () => {
    for (const { file } of REAL_TILES) {
      const mesh = decodeQuantizedMesh(fixture(file));
      expect(mesh.u.length, file).toBeGreaterThan(2);
      expect(mesh.u.length).toBe(mesh.v.length);
      expect(mesh.u.length).toBe(mesh.heightMeters.length);
      expect(mesh.indices.length % 3, file).toBe(0);
      expect(mesh.indices.length).toBeGreaterThan(0);
      for (let i = 0; i < mesh.u.length; i++) {
        expect(mesh.u[i]).toBeGreaterThanOrEqual(-1e-6);
        expect(mesh.u[i]).toBeLessThanOrEqual(1 + 1e-6);
        expect(mesh.v[i]).toBeGreaterThanOrEqual(-1e-6);
        expect(mesh.v[i]).toBeLessThanOrEqual(1 + 1e-6);
        expect(mesh.heightMeters[i]).toBeGreaterThanOrEqual(mesh.minHeight - 1e-3);
        expect(mesh.heightMeters[i]).toBeLessThanOrEqual(mesh.maxHeight + 1e-3);
      }
      for (const idx of mesh.indices) expect(idx).toBeLessThan(mesh.u.length);
    }
  });

  it('real tiles are irregular TINs, not U×V rasters', () => {
    // This is why grid reconstruction from u/v cannot work: the vertices of a
    // real quantized-mesh tile are nowhere near a complete Cartesian product.
    for (const { file } of REAL_TILES) {
      const mesh = decodeQuantizedMesh(fixture(file));
      const distinctU = new Set(mesh.u).size, distinctV = new Set(mesh.v).size;
      expect(distinctU * distinctV, file).not.toBe(mesh.u.length);
    }
  });

  it('samples real terrain across the whole tile footprint', () => {
    for (const { file, z, x, y } of REAL_TILES) {
      const mesh = decodeQuantizedMesh(fixture(file));
      const bounds = tmsBounds(z, x, y);
      const sampler = new TerrainSampler(datum, { id: 'marshub', kind: 'quantized-mesh' });
      sampler.addTile({
        id: file, kind: 'mesh', ...bounds,
        u: mesh.u, v: mesh.v,
        elevationsKm: Float32Array.from(mesh.heightMeters, (h) => h / 1000),
        indices: mesh.indices,
      });

      let hits = 0, total = 0;
      const N = 24;
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const lat = bounds.southDeg + ((i + 0.5) / N) * (bounds.northDeg - bounds.southDeg);
          const lon = bounds.westDeg + ((j + 0.5) / N) * (bounds.eastDeg - bounds.westDeg);
          const sample = sampler.sample(lat, lon);
          total++;
          if (sample) {
            hits++;
            // Interpolated height can never leave the tile's declared range.
            expect(sample.elevationKm).toBeGreaterThanOrEqual(mesh.minHeight / 1000 - 1e-6);
            expect(sample.elevationKm).toBeLessThanOrEqual(mesh.maxHeight / 1000 + 1e-6);
          }
        }
      }
      expect(hits, `${file} coverage`).toBe(total);
    }
  });

  it('reproduces vertex heights exactly at vertex positions', () => {
    const { file, z, x, y } = REAL_TILES[0];
    const mesh = decodeQuantizedMesh(fixture(file));
    const bounds = tmsBounds(z, x, y);
    const sampler = new TerrainSampler(datum, { id: 'marshub', kind: 'quantized-mesh' });
    sampler.addTile({
      id: file, kind: 'mesh', ...bounds,
      u: mesh.u, v: mesh.v,
      elevationsKm: Float32Array.from(mesh.heightMeters, (h) => h / 1000),
      indices: mesh.indices,
    });
    // Interior vertices only — edge vertices sit exactly on the hull boundary.
    let checked = 0;
    for (let i = 0; i < mesh.u.length && checked < 25; i++) {
      if (mesh.u[i] < 0.05 || mesh.u[i] > 0.95 || mesh.v[i] < 0.05 || mesh.v[i] > 0.95) continue;
      const lat = bounds.southDeg + mesh.v[i] * (bounds.northDeg - bounds.southDeg);
      const lon = bounds.westDeg + mesh.u[i] * (bounds.eastDeg - bounds.westDeg);
      expect(sampler.sample(lat, lon)?.elevationKm).toBeCloseTo(mesh.heightMeters[i] / 1000, 5);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('rejects a truncated tile loudly rather than returning silent garbage', () => {
    const full = fixture(REAL_TILES[0].file);
    expect(() => decodeQuantizedMesh(full.slice(0, 40))).toThrow();
    expect(() => decodeQuantizedMesh(full.slice(0, 200))).toThrow();
  });
});

describe('tileset height-encoding offset', () => {
  it('keeps reference radius + elevation equal to the rendered radius', () => {
    // Mars Hub v14 encodes heights ~8.765 km above the IAU surface; the renderer
    // shrinks its decode ellipsoid by that amount, so CPU elevations carry the
    // same correction and the two agree. See TerrainConfig.referenceRadiusOffsetKm.
    const offsetKm = 8.765;
    const rawHeightKm = 12.5;
    const sampler = new TerrainSampler(datum, { id: 'marshub', kind: 'quantized-mesh' });
    sampler.addTile(grid({
      id: 'corrected',
      elevationsKm: new Float32Array(4).fill(rawHeightKm - offsetKm),
    }));
    const latDeg = 5;
    const sample = sampler.sample(latDeg, 5)!;
    const renderedRadiusKm = sampler.referenceRadiusAt(latDeg) - offsetKm + rawHeightKm;
    // 5 places (1 cm) — elevations are stored as Float32, as they are in flight.
    expect(sampler.referenceRadiusAt(latDeg) + sample.elevationKm).toBeCloseTo(renderedRadiusKm, 5);
  });
});

describe('TerrainSampler mesh coverage edges', () => {
  // One triangle over the lower-left half of the tile, so the upper-right half
  // is a genuine hole. Vertex heights 0/1/2 make the interpolant exactly u + 2v.
  const holeTile = () => ({
    id: 'half', kind: 'mesh' as const,
    westDeg: 0, eastDeg: 10, southDeg: 0, northDeg: 10,
    u: new Float32Array([0, 1, 0]),
    v: new Float32Array([0, 0, 1]),
    elevationsKm: new Float32Array([0, 1, 2]),
    indices: new Uint16Array([0, 1, 2]),
  });

  it('interpolates inside the triangulation', () => {
    const sampler = new TerrainSampler(datum, { id: 'test', kind: 'quantized-mesh' });
    sampler.addTile(holeTile());
    expect(sampler.sample(2, 2)?.elevationKm).toBeCloseTo(0.6, 6);
    expect(sampler.sample(0.5, 8)?.elevationKm).toBeCloseTo(0.9, 6);
  });

  it('returns null in a real hole rather than inventing a height', () => {
    const sampler = new TerrainSampler(datum, { id: 'test', kind: 'quantized-mesh' });
    sampler.addTile(holeTile());
    // Well inside the tile bounds, but outside the triangulated half.
    expect(sampler.sample(6, 6)).toBeNull();
    expect(sampler.sample(9, 9)).toBeNull();
  });

  it('absorbs a sub-tolerance miss at a triangle edge', () => {
    const sampler = new TerrainSampler(datum, { id: 'test', kind: 'quantized-mesh' });
    sampler.addTile(holeTile());
    // A hair past the hypotenuse: numerically outside, physically on the surface.
    const sample = sampler.sample(5.002, 5.002);
    expect(sample).not.toBeNull();
    expect(sample!.elevationKm).toBeCloseTo(1.5006, 3);
  });

  it('rejects a mesh tile with malformed vertex or index arrays', () => {
    const sampler = new TerrainSampler(datum, { id: 'test', kind: 'quantized-mesh' });
    expect(() => sampler.addTile({ ...holeTile(), v: new Float32Array([0, 0]) })).toThrow(/vertex arrays/);
    expect(() => sampler.addTile({ ...holeTile(), indices: new Uint16Array([0, 1]) })).toThrow(/index buffer/);
  });
});
