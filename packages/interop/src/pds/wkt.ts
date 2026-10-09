// A small Well-Known Text reader for the two geometry types planetary archives
// use for footprints: POLYGON and MULTIPOLYGON (OGC 06-103r4 §7). Pure and
// headless. ODE serves every product footprint this way, as lon/lat degrees.
//
// Deliberately not a GIS library: no POINT/LINESTRING/GEOMETRYCOLLECTION, no
// Z/M ordinates beyond ignoring a trailing one, no CRS. Anything else is a
// located error rather than a partial read.

/** A `[longitude, latitude]` pair in degrees, in the order WKT writes them. */
export type LonLat = readonly [number, number];

/** One polygon: its exterior ring first, then any holes. Rings are closed as
 *  written (WKT repeats the first vertex last). */
export type WktPolygon = readonly (readonly LonLat[])[];

export class WktError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WktError';
  }
}

/**
 * Parse a WKT `POLYGON` or `MULTIPOLYGON` into polygons. A POLYGON returns one
 * element; `EMPTY` returns none.
 */
export function parseWktPolygons(text: string): WktPolygon[] {
  const src = text.trim();
  const head = /^(MULTIPOLYGON|POLYGON)\s*(?:(Z|M|ZM)\s*)?/i.exec(src);
  if (!head) {
    throw new WktError(`WKT: expected POLYGON or MULTIPOLYGON at offset 0, got ${JSON.stringify(src.slice(0, 24))}`);
  }
  const kind = head[1]!.toUpperCase();
  let pos = head[0].length;
  if (/^EMPTY\s*$/i.test(src.slice(pos))) return [];

  const fail = (what: string): never => {
    throw new WktError(`WKT: expected ${what} at offset ${pos}, got ${JSON.stringify(src.slice(pos, pos + 16))}`);
  };
  const skipWs = () => {
    while (pos < src.length && /\s/.test(src[pos]!)) pos++;
  };
  const expect = (ch: string) => {
    skipWs();
    if (src[pos] !== ch) fail(`'${ch}'`);
    pos++;
  };
  /** True (and consumed) if the next non-space character is a comma. */
  const comma = () => {
    skipWs();
    if (src[pos] === ',') {
      pos++;
      return true;
    }
    return false;
  };
  const number = (): number => {
    skipWs();
    const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(src.slice(pos));
    if (!m) fail('a number');
    pos += m![0].length;
    return Number(m![0]);
  };
  const ring = (): LonLat[] => {
    expect('(');
    const pts: LonLat[] = [];
    do {
      const lon = number();
      const lat = number();
      // A Z or M ordinate, if the geometry declared one: read and dropped.
      skipWs();
      if (/[-+.\d]/.test(src[pos] ?? '')) number();
      pts.push([lon, lat]);
    } while (comma());
    expect(')');
    if (pts.length < 4) {
      throw new WktError(`WKT: ring ending at offset ${pos} has ${pts.length} vertices; a closed ring needs at least 4`);
    }
    return pts;
  };
  const polygon = (): WktPolygon => {
    expect('(');
    const rings: LonLat[][] = [];
    do rings.push(ring());
    while (comma());
    expect(')');
    return rings;
  };

  const out: WktPolygon[] = [];
  if (kind === 'POLYGON') {
    out.push(polygon());
  } else {
    expect('(');
    do out.push(polygon());
    while (comma());
    expect(')');
  }
  skipWs();
  if (pos !== src.length) fail('end of input');
  return out;
}
