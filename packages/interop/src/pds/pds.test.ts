import { describe, it, expect } from 'vitest';
import { parseWktPolygons, WktError } from './wkt.js';
import { opus, opusColumns, type OpusQuery } from './opus.js';
import { ode } from './ode.js';
import { ArchiveError, type FetchLike } from './types.js';

describe('parseWktPolygons', () => {
  it('reads a POLYGON with its ring closed as written', () => {
    const [poly] = parseWktPolygons('POLYGON ((10 -80, 11 -80, 11 -81, 10 -81, 10 -80))');
    expect(poly).toHaveLength(1);
    expect(poly![0]).toEqual([[10, -80], [11, -80], [11, -81], [10, -81], [10, -80]]);
  });

  it('reads a MULTIPOLYGON, holes, exponents, and drops a Z ordinate', () => {
    const polys = parseWktPolygons(
      'MULTIPOLYGON (((0 0, 1e1 0, 10 10, 0 0)), ((20 20, 30 20, 30 30, 20 20), (21 21, 22 21, 22 22, 21 21)))',
    );
    expect(polys).toHaveLength(2);
    expect(polys[0]![0]![1]).toEqual([10, 0]);
    expect(polys[1]).toHaveLength(2);
    const z = parseWktPolygons('POLYGON Z ((0 0 5, 1 0 5, 1 1 5, 0 0 5))');
    expect(z[0]![0]![2]).toEqual([1, 1]);
  });

  it('reads EMPTY as no polygons', () => {
    expect(parseWktPolygons('MULTIPOLYGON EMPTY')).toEqual([]);
  });

  it('fails with a located error rather than a partial read', () => {
    expect(() => parseWktPolygons('POINT (1 2)')).toThrow(WktError);
    expect(() => parseWktPolygons('POLYGON ((0 0, 1 0, x 1, 0 0))')).toThrow(/expected a number at offset 20/);
    expect(() => parseWktPolygons('POLYGON ((0 0, 1 0, 0 0))')).toThrow(/needs at least 4/);
    expect(() => parseWktPolygons('POLYGON ((0 0, 1 0, 1 1, 0 0)) junk')).toThrow(/end of input/);
  });
});

// Columns as the Cassini demo requests them. The rows are two real ISS NAC
// frames of the SOI ring scan (`pds-geometry-soi.json`), laid out the way
// `data.json` returns them: one array per observation, in `cols` order.
const CASSINI: OpusQuery = {
  params: { instrument: 'Cassini ISS', time1: '2004-07-01T03:00', time2: '2004-07-01T03:20' },
  campaignColumn: 'CASSINIobsname',
  disk: {
    subObsLat: 'SURFACEGEOsaturn_subobslat',
    subObsLonWest: 'SURFACEGEOsaturn_subobswlon',
    centerDistance: 'SURFACEGEOsaturn_centerdistance',
    raMin: 'RAmin',
    raMax: 'RAmax',
    decMin: 'declinationmin',
    decMax: 'declinationmax',
  },
  limit: 2,
};
const ROWS = [
  ['co-iss-n1467344155', '2004-07-01T03:11:39.791', '2004-07-01T03:11:40.791', 'Saturn', 'Cassini ISS',
    'ISS_000RI_SOISPTURN183_SP', '13.139', '308.138', '90825.679', '359.9', '0.3', '-10.2', '-9.8'],
  ['co-iss-n1467344214', '2004-07-01T03:12:38.791', '2004-07-01T03:12:39.791', 'Saturn', 'Cassini ISS',
    'ISS_000RI_SOISPTURN183_SP', 'N/A', '307.683', '91407.31', 'N/A', 'N/A', 'N/A', 'N/A'],
];

describe('OPUS adapter', () => {
  it('asks for exactly the columns it maps, in a stable order', () => {
    const url = new URL(opus.url(CASSINI));
    expect(url.pathname).toBe('/opus/api/data.json');
    expect(url.searchParams.get('instrument')).toBe('Cassini ISS');
    expect(url.searchParams.get('cols')!.split(',')).toEqual(opusColumns(CASSINI));
    expect(opusColumns(CASSINI).slice(0, 6)).toEqual(['opusid', 'time1', 'time2', 'target', 'instrument', 'CASSINIobsname']);
  });

  it('maps rows onto ArchiveObservation, campaign undecoded and longitude east', () => {
    const [a, b] = opus.parse({ start_obs: 1, limit: 2, count: 2, page: ROWS }, CASSINI);
    expect(a).toEqual({
      archive: 'OPUS',
      id: 'co-iss-n1467344155',
      startTime: '2004-07-01T03:11:39.791',
      stopTime: '2004-07-01T03:11:40.791',
      timeSystem: 'UTC',
      target: 'Saturn',
      instrument: 'Cassini ISS',
      campaign: 'ISS_000RI_SOISPTURN183_SP',
      disk: {
        subObsLatDeg: 13.139,
        subObsLonDeg: expect.closeTo(51.862, 9),
        distanceKm: 90825.679,
        // The RA box straddles 0h: its centre is 0.1°, not 180.1°.
        boresightRaDecDeg: [expect.closeTo(0.1, 9), -10],
      },
    });
    // N/A reads as absent: no latitude means no disk at all, not a zero.
    expect(b!.disk).toBeUndefined();
  });

  it('reads rows from `data` as well as `page`', () => {
    expect(opus.parse({ data: ROWS }, CASSINI)).toHaveLength(2);
  });

  it('fails with a located error', () => {
    expect(() => opus.parse({ count: 0 }, CASSINI)).toThrow(/no `page`/);
    expect(() => opus.parse({ page: [ROWS[0]!.slice(0, 3)] }, CASSINI)).toThrow(/OPUS row 0: expected 13 values/);
    const bad = [...ROWS[0]!];
    bad[8] = 'far';
    expect(() => opus.parse({ page: [bad] }, CASSINI)).toThrow(/co-iss-n1467344155.*SURFACEGEOsaturn_centerdistance/);
  });

  it('searches through an injected fetch', async () => {
    const seen: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => ({ page: ROWS }) };
    };
    expect(await opus.search(CASSINI, fetchFn)).toHaveLength(2);
    expect(seen).toEqual([opus.url(CASSINI)]);
    const down: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await expect(opus.search(CASSINI, down)).rejects.toThrow(ArchiveError);
  });
});

// Shaped like an ODE REST product-query answer. Illustrative values, not a
// captured response: the sandbox this was written in could not reach ODE.
const ODE_PRODUCT = {
  pdsid: 'M1234567890LE',
  ihid: 'LRO',
  iid: 'LROC',
  Target_name: 'MOON',
  UTC_start_time: '2025-01-15T10:00:00.000',
  UTC_stop_time: '2025-01-15T10:00:20.000',
  Incidence_angle: '88.1',
  Emission_angle: '1.2',
  Phase_angle: '87.5',
  Map_resolution: '0.98',
  Orbit_number: '61234',
  Footprint_C0_geometry: 'POLYGON ((10 -88, 11 -88, 11 -89, 10 -89, 10 -88))',
};

describe('ODE adapter', () => {
  it('fixes only query=product and output=JSON on top of the caller params', () => {
    const url = new URL(ode.url({ params: { target: 'moon', ihid: 'LRO', iid: 'LROC', pt: 'EDRNAC' }, limit: 10 }));
    expect(url.searchParams.get('query')).toBe('product');
    expect(url.searchParams.get('output')).toBe('JSON');
    expect(url.searchParams.get('pt')).toBe('EDRNAC');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('maps a product onto ArchiveObservation with its given footprint', () => {
    const [o] = ode.parse({ ODEResults: { Status: 'Success', Count: '1', Products: { Product: [ODE_PRODUCT] } } }, { params: {} });
    expect(o).toEqual({
      archive: 'ODE',
      id: 'M1234567890LE',
      startTime: '2025-01-15T10:00:00.000',
      stopTime: '2025-01-15T10:00:20.000',
      timeSystem: 'UTC',
      target: 'MOON',
      instrument: 'LROC',
      campaign: '61234',
      footprint: [[[[10, -88], [11, -88], [11, -89], [10, -89], [10, -88]]]],
      illumination: { phaseDeg: 87.5, incidenceDeg: 88.1, emissionDeg: 1.2 },
      resolutionKm: 0.00098,
    });
  });

  it('reads a single bare Product, field names case-insensitively, and an empty result', () => {
    const lower = Object.fromEntries(Object.entries(ODE_PRODUCT).map(([k, v]) => [k.toLowerCase(), v]));
    expect(ode.parse({ ODEResults: { Status: 'Success', Products: { Product: lower } } }, { params: {} })).toHaveLength(1);
    expect(ode.parse({ ODEResults: { Status: 'Success', Products: 'No Products Found' } }, { params: {} })).toEqual([]);
  });

  it('fails with a located error', () => {
    expect(() => ode.parse({ ODEResults: { Status: 'ERROR', Error: 'bad target' } }, { params: {} })).toThrow(/ERROR: bad target/);
    const broken = { ...ODE_PRODUCT, Footprint_C0_geometry: 'POLYGON ((10 -88, 11 -88))' };
    expect(() => ode.parse({ ODEResults: { Status: 'Success', Products: { Product: broken } } }, { params: {} }))
      .toThrow(/ODE product 0 \(M1234567890LE\): footprint: WKT/);
    const { UTC_start_time: _drop, ...noTime } = ODE_PRODUCT;
    expect(() => ode.parse({ ODEResults: { Status: 'Success', Products: { Product: noTime } } }, { params: {} }))
      .toThrow(/UTC_start_time/);
  });
});
