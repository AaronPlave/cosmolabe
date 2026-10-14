import { isSupportedGeodeticDatum, wrapLon, type TerrainDatum, type TerrainSample, type TerrainSourceMetadata } from '../TerrainSampler.js';

export type CubeFace = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz';
export interface CubeFaceCoordinate { face: CubeFace; u: number; v: number; }
export interface CubeTileAddress extends CubeFaceCoordinate { level: number; x: number; y: number; }

/**
 * Experimental gnomonic cube-sphere orientation. Face ties use the declared
 * X, Y, Z priority, making edges and corners single-addressed and repeatable.
 * u and v both increase from -1 to +1 in the face basis below.
 */
const BASES: Readonly<Record<CubeFace, readonly [readonly number[], readonly number[], readonly number[]]>> = {
  px: [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
  nx: [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  py: [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
  ny: [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  pz: [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  nz: [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
};
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A face's orthonormal basis `(N, U, V)`: a face point is `normalize(N + u U + v V)`. */
export function cubeFaceBasis(face: CubeFace): readonly [readonly number[], readonly number[], readonly number[]] {
  if (!Object.hasOwn(BASES, face)) throw new Error(`Unknown cube face ${String(face)}`);
  return BASES[face];
}

/** Map a face square to a unit geocentric direction (not an ellipsoid normal). */
export function cubeFaceToDirection(face: CubeFace, u: number, v: number): readonly [number, number, number] {
  if (!Number.isFinite(u) || !Number.isFinite(v) || Math.abs(u) > 1 || Math.abs(v) > 1) throw new Error('Cube coordinates must be finite and in [-1, 1]');
  const [n, a, b] = BASES[face];
  const p = [n[0] + u * a[0] + v * b[0], n[1] + u * a[1] + v * b[1], n[2] + u * a[2] + v * b[2]];
  const length = Math.hypot(...p);
  return [p[0] / length, p[1] / length, p[2] / length];
}

/** Inverse of cubeFaceToDirection with deterministic ownership at seams. */
export function directionToCubeFace(direction: readonly [number, number, number]): CubeFaceCoordinate {
  const [x, y, z] = direction;
  if (![x, y, z].every(Number.isFinite) || (x === 0 && y === 0 && z === 0)) throw new Error('Cube direction must be finite and nonzero');
  let face: CubeFace;
  // >= establishes X > Y > Z ownership for exact ties.
  if (Math.abs(x) >= Math.abs(y) && Math.abs(x) >= Math.abs(z)) face = x >= 0 ? 'px' : 'nx';
  else if (Math.abs(y) >= Math.abs(z)) face = y >= 0 ? 'py' : 'ny';
  else face = z >= 0 ? 'pz' : 'nz';
  // Ratios of the raw components: normalizing first would add rounding that can
  // move an exact child boundary (u or v = 0) to one side.
  const [n, a, b] = BASES[face];
  const scale = dot(direction, n);
  return { face, u: dot(direction, a) / scale + 0, v: dot(direction, b) / scale + 0 };
}

const tileIndex = (coordinate: number, count: number) => Math.min(count - 1, Math.floor((coordinate + 1) * 0.5 * count));

export function cubeTileAt(direction: readonly [number, number, number], level: number): CubeTileAddress {
  if (!isValidLevel(level)) throw new Error('Cube tile level must be an integer in [0, 30]');
  const coordinate = directionToCubeFace(direction);
  const count = 2 ** level;
  return { ...coordinate, level, x: tileIndex(coordinate.u, count), y: tileIndex(coordinate.v, count) };
}

export function cubeTileId(address: Pick<CubeTileAddress, 'face' | 'level' | 'x' | 'y'>): string {
  return `${address.face}/${address.level}/${address.x}/${address.y}`;
}

const MAX_LEVEL = 30;
const isValidLevel = (level: number) => Number.isSafeInteger(level) && level >= 0 && level <= MAX_LEVEL;

/**
 * sin and cos of an angle in degrees, exact (0, ±1) at multiples of 90 degrees.
 * Plain Math.sin/cos leave ~1e-16 residuals there whose sign depends on the
 * longitude spelling (180 vs -180, 0 vs 360) or, at a pole, on the longitude
 * itself; those residuals select different children across exact u/v = 0
 * boundaries. Other angles are only range-reduced, never snapped.
 */
function sinCosDeg(deg: number): [number, number] {
  const r = deg % 360;
  const quadrant = Math.round(r / 90);
  const a = (r - 90 * quadrant) * Math.PI / 180;
  const s = Math.sin(a), c = Math.cos(a);
  switch (((quadrant % 4) + 4) % 4) {
    case 0: return [s + 0, c + 0];
    case 1: return [c + 0, -s + 0];
    case 2: return [-s + 0, -c + 0];
    default: return [-c + 0, s + 0];
  }
}

export interface CubeHeightTile {
  face: CubeFace; level: number; x: number; y: number;
  width: number; height: number;
  /** Row-major samples in face-v then face-u order, including tile edges. */
  elevationsKm: Float32Array | Float64Array;
  source?: TerrainSourceMetadata;
  uncertaintyKm?: number;
}

/** CPU payload for the experiment; independent of renderer and imagery residency. */
export class CubeSphereSampler {
  private readonly tiles = new Map<string, CubeHeightTile>();
  /** Squared polar/equatorial radius ratio mapping a geodetic latitude to its geocentric ray. */
  private readonly zScale: number;
  constructor(readonly datum: TerrainDatum, readonly source: TerrainSourceMetadata) {
    // Same boundary as the shared physical-surface proof: spheres and geodetic
    // oblate ellipsoids. A triaxial shape would otherwise be addressed as an
    // oblate substitute while still reporting the original datum.
    if (!isSupportedGeodeticDatum(datum)) throw new Error('Unsupported cube-sphere datum: expected a sphere or geodetic oblate ellipsoid');
    const shape = datum.referenceShape;
    this.zScale = shape.kind === 'sphere' ? 1 : (shape.radiiKm[2] / shape.radiiKm[0]) ** 2;
  }

  addTile(tile: CubeHeightTile): void {
    if (!Object.hasOwn(BASES, tile.face) || !isValidLevel(tile.level) || !Number.isSafeInteger(tile.x) || !Number.isSafeInteger(tile.y)
      || tile.x < 0 || tile.y < 0 || tile.x >= 2 ** tile.level || tile.y >= 2 ** tile.level
      || !Number.isSafeInteger(tile.width) || !Number.isSafeInteger(tile.height) || tile.width < 2 || tile.height < 2
      || tile.elevationsKm.length !== tile.width * tile.height) throw new Error('Malformed cube-sphere height tile');
    this.tiles.set(cubeTileId(tile), tile);
  }
  removeTile(address: Pick<CubeTileAddress, 'face' | 'level' | 'x' | 'y'>): void { this.tiles.delete(cubeTileId(address)); }
  getTile(address: Pick<CubeTileAddress, 'face' | 'level' | 'x' | 'y'>): CubeHeightTile | undefined { return this.tiles.get(cubeTileId(address)); }
  get tileCount(): number { return this.tiles.size; }

  /**
   * Face coordinate of the geocentric ray to the zero-height point on the
   * declared shape: on an ellipsoid it intentionally differs from the geodetic
   * surface normal. Equivalent latitude/longitude spellings give one answer.
   */
  faceCoordinate(latDeg: number, lonDeg: number): CubeFaceCoordinate {
    if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || latDeg < -90 || latDeg > 90) throw new Error('Invalid latitude/longitude');
    const [sinLat, cosLat] = sinCosDeg(latDeg), [sinLon, cosLon] = sinCosDeg(wrapLon(lonDeg));
    return directionToCubeFace([cosLat * cosLon, cosLat * sinLon, this.zScale * sinLat]);
  }

  /** The finest resident tile containing a face coordinate, with its local fractions. */
  finestResident(coordinate: CubeFaceCoordinate): { tile: CubeHeightTile; localU: number; localV: number } | null {
    for (let level = MAX_LEVEL; level >= 0; level--) {
      const count = 2 ** level;
      const x = tileIndex(coordinate.u, count), y = tileIndex(coordinate.v, count);
      const tile = this.tiles.get(cubeTileId({ face: coordinate.face, level, x, y }));
      if (tile) return { tile, localU: (coordinate.u + 1) * 0.5 * count - x, localV: (coordinate.v + 1) * 0.5 * count - y };
    }
    return null;
  }

  sample(latDeg: number, lonDeg: number): TerrainSample | null {
    const resident = this.finestResident(this.faceCoordinate(latDeg, lonDeg));
    if (!resident) return null;
    const { tile, localU, localV } = resident;
    const px = localU * (tile.width - 1), py = localV * (tile.height - 1);
    const x0 = Math.floor(px), y0 = Math.floor(py), x1 = Math.min(x0 + 1, tile.width - 1), y1 = Math.min(y0 + 1, tile.height - 1);
    const tx = px - x0, ty = py - y0, at = (x: number, y: number) => tile.elevationsKm[y * tile.width + x];
    const elevationKm = (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
    return { position: { latDeg, lonDeg: wrapLon(lonDeg) }, elevationKm, datum: this.datum, source: tile.source ?? this.source,
      tileId: cubeTileId(tile), uncertaintyKm: tile.uncertaintyKm ?? tile.source?.uncertaintyKm ?? this.source.uncertaintyKm };
  }
}
