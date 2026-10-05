import { geodeticToBodyFixed, type TerrainDatum, type TerrainSample, type TerrainSourceMetadata } from '../TerrainSampler.js';

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
  const length = Math.hypot(...direction);
  if (!Number.isFinite(length) || length === 0) throw new Error('Cube direction must be finite and nonzero');
  const q = direction.map(value => value / length);
  const [x, y, z] = q;
  let face: CubeFace;
  // >= establishes X > Y > Z ownership for exact ties.
  if (Math.abs(x) >= Math.abs(y) && Math.abs(x) >= Math.abs(z)) face = x >= 0 ? 'px' : 'nx';
  else if (Math.abs(y) >= Math.abs(z)) face = y >= 0 ? 'py' : 'ny';
  else face = z >= 0 ? 'pz' : 'nz';
  const [n, a, b] = BASES[face];
  const scale = dot(q, n);
  return { face, u: dot(q, a) / scale, v: dot(q, b) / scale };
}

export function cubeTileAt(direction: readonly [number, number, number], level: number): CubeTileAddress {
  if (!Number.isSafeInteger(level) || level < 0 || level > 30) throw new Error('Cube tile level must be an integer in [0, 30]');
  const coordinate = directionToCubeFace(direction);
  const count = 2 ** level;
  const x = Math.min(count - 1, Math.floor((coordinate.u + 1) * 0.5 * count));
  const y = Math.min(count - 1, Math.floor((coordinate.v + 1) * 0.5 * count));
  return { ...coordinate, level, x, y };
}

export function cubeTileId(address: Pick<CubeTileAddress, 'face' | 'level' | 'x' | 'y'>): string {
  return `${address.face}/${address.level}/${address.x}/${address.y}`;
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
  constructor(readonly datum: TerrainDatum, readonly source: TerrainSourceMetadata) {}

  addTile(tile: CubeHeightTile): void {
    const count = 2 ** tile.level;
    if (!Number.isSafeInteger(tile.level) || tile.level < 0 || tile.level > 30 || !Number.isSafeInteger(tile.x) || !Number.isSafeInteger(tile.y)
      || tile.x < 0 || tile.y < 0 || tile.x >= count || tile.y >= count || tile.width < 2 || tile.height < 2
      || tile.elevationsKm.length !== tile.width * tile.height) throw new Error('Malformed cube-sphere height tile');
    this.tiles.set(cubeTileId(tile), tile);
  }
  removeTile(address: Pick<CubeTileAddress, 'face' | 'level' | 'x' | 'y'>): void { this.tiles.delete(cubeTileId(address)); }

  sample(latDeg: number, lonDeg: number): TerrainSample | null {
    if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || latDeg < -90 || latDeg > 90) throw new Error('Invalid latitude/longitude');
    // Start from a geodetic point on the declared shape: on an ellipsoid its
    // geocentric ray intentionally differs from the geodetic surface normal.
    const point = geodeticToBodyFixed({ latDeg, lonDeg }, this.datum);
    const coordinate = directionToCubeFace([point.xKm, point.yKm, point.zKm]);
    let tile: CubeHeightTile | undefined;
    let localU = 0, localV = 0;
    for (const candidate of this.tiles.values()) {
      if (candidate.face !== coordinate.face || (tile && candidate.level <= tile.level)) continue;
      const count = 2 ** candidate.level;
      const gx = (coordinate.u + 1) * 0.5 * count, gy = (coordinate.v + 1) * 0.5 * count;
      const x = Math.min(count - 1, Math.floor(gx)), y = Math.min(count - 1, Math.floor(gy));
      if (x === candidate.x && y === candidate.y) { tile = candidate; localU = gx - x; localV = gy - y; }
    }
    if (!tile) return null;
    const px = localU * (tile.width - 1), py = localV * (tile.height - 1);
    const x0 = Math.floor(px), y0 = Math.floor(py), x1 = Math.min(x0 + 1, tile.width - 1), y1 = Math.min(y0 + 1, tile.height - 1);
    const tx = px - x0, ty = py - y0, at = (x: number, y: number) => tile!.elevationsKm[y * tile!.width + x];
    const elevationKm = (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
    return { position: { latDeg, lonDeg }, elevationKm, datum: this.datum, source: tile.source ?? this.source,
      tileId: cubeTileId(tile), uncertaintyKm: tile.uncertaintyKm ?? tile.source?.uncertaintyKm ?? this.source.uncertaintyKm };
  }
}
