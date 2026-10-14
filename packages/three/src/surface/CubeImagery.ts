import type { TerrainSourceMetadata } from '../TerrainSampler.js';
import { cubeFaceBasis, cubeFaceToDirection, cubeTileAt, cubeTileId, type CubeFace, type CubeTileAddress } from './CubeSphere.js';

/**
 * Cube-face map imagery for the cube-sphere experiment (#149): addressing,
 * texel registration and the geometry-independent level selection that
 * `CubeImageryLayer` drives. No Three.js.
 *
 * Imagery is preprocessed into the faces of `CubeSphere.ts` (one quadtree per
 * face, the same `{face}/{level}/{x}/{y}` addressing as geometry) but its
 * levels, availability and residency are its own: an imagery tile at level M
 * drapes onto whatever geometry tile, of any level, covers it.
 *
 * Registration. A tile file is `(T + 2g)²` pixels: `T` interior pixels across
 * the tile's face rectangle and a gutter of `g` pixels on every side. Column
 * `i` counts from the left (increasing face u), row `j` from the top of the
 * file (decreasing face v). Pixel corners are integers; pixel `(i, j)` spans
 * `u ∈ [u0 + (i − g)·Δ/T, u0 + (i − g + 1)·Δ/T]` and
 * `v ∈ [v1 − (j − g + 1)·Δ/T, v1 − (j − g)·Δ/T]`, so its centre is
 * `(i + 0.5, j + 0.5)`. Gutter pixels continue the same gnomonic plane past the
 * tile edge (|u| or |v| may exceed 1 there); a builder evaluates them at the
 * direction `normalize(N + uU + vV)`, which lies on the neighbouring face, so
 * filtering across a tile or face edge reads continuous content.
 *
 * Content is registered to the **geocentric direction** of a body-fixed point,
 * like the geometry addressing. On a sphere that is planetocentric latitude
 * and longitude; on an ellipsoid a builder converts each source's latitude
 * convention to the geocentric direction of the zero-height point before
 * sampling.
 */
export interface CubeImageryManifest {
  format: 'cosmolabe-cube-imagery-1';
  /** Product identity: id, immutable version (content hash) and provenance of the source images. */
  source: TerrainSourceMetadata & { attribution?: string };
  bodyId: string;
  registration: {
    /** Versioned layout id, e.g. `cosmolabe:cube-gnomonic-1/IAU_MOON`: the CubeSphere.ts bases on that body frame. */
    crsId: string;
    pixelConvention: 'corner';
    /** Measured or stated registration error of the source mosaic, km; null when unknown. */
    registrationErrorKm: number | null;
    resampling: string;
    /** Human-readable footprint/cutline; texels outside it are transparent (alpha 0). */
    footprint: string;
  };
  tileSize: number;
  gutter: number;
  encoding: 'png' | 'jpeg';
  /** `srgb`: texel bytes are sRGB-encoded reflectance for display. `linear`: data (e.g. a coordinate fixture), never converted. */
  colorSpace: 'srgb' | 'linear';
  minLevel: number;
  maxLevel: number;
  /** Tile URI template relative to the manifest, e.g. `tiles/{face}/{level}/{x}/{y}.png`. */
  uri: string;
  /** Every tile in the product, `face/level/x/y`. A tile's ancestors are always present. */
  tiles: string[];
}

export type ImageryAddress = Pick<CubeTileAddress, 'face' | 'level' | 'x' | 'y'>;
export type Vec3 = readonly [number, number, number];
const FACES: readonly CubeFace[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const MAX_LEVEL = 30;

export function parseImageryAddress(id: string): ImageryAddress {
  const m = /^(px|nx|py|ny|pz|nz)\/(\d+)\/(\d+)\/(\d+)$/.exec(id);
  if (!m) throw new Error(`Malformed cube imagery tile id "${id}"`);
  const address = { face: m[1] as CubeFace, level: Number(m[2]), x: Number(m[3]), y: Number(m[4]) };
  if (address.level > MAX_LEVEL || address.x >= 2 ** address.level || address.y >= 2 ** address.level) throw new Error(`Cube imagery tile id out of range "${id}"`);
  return address;
}

/** Validate a manifest's shape and tile tree (every tile's parent present) before use. */
export function validateCubeImageryManifest(manifest: CubeImageryManifest): CubeImageryManifest {
  if (manifest?.format !== 'cosmolabe-cube-imagery-1') throw new Error(`Unsupported cube imagery format ${String(manifest?.format)}`);
  const { tileSize, gutter, minLevel, maxLevel } = manifest;
  if (!Number.isSafeInteger(tileSize) || tileSize < 1 || !Number.isSafeInteger(gutter) || gutter < 0) throw new Error('Malformed cube imagery tile size/gutter');
  if (!Number.isSafeInteger(minLevel) || !Number.isSafeInteger(maxLevel) || minLevel < 0 || maxLevel > MAX_LEVEL || minLevel > maxLevel) throw new Error('Malformed cube imagery level range');
  if (manifest.encoding !== 'png' && manifest.encoding !== 'jpeg') throw new Error(`Unsupported cube imagery encoding ${String(manifest.encoding)}`);
  if (manifest.colorSpace !== 'srgb' && manifest.colorSpace !== 'linear') throw new Error(`Unsupported cube imagery color space ${String(manifest.colorSpace)}`);
  if (typeof manifest.uri !== 'string' || !Array.isArray(manifest.tiles)) throw new Error('Malformed cube imagery manifest');
  const ids = new Set(manifest.tiles);
  for (const id of manifest.tiles) {
    const a = parseImageryAddress(id);
    if (a.level < minLevel || a.level > maxLevel) throw new Error(`Cube imagery tile ${id} outside levels ${minLevel}–${maxLevel}`);
    if (a.level > minLevel && !ids.has(cubeTileId({ face: a.face, level: a.level - 1, x: a.x >> 1, y: a.y >> 1 }))) throw new Error(`Cube imagery tile ${id} has no parent`);
  }
  for (const face of FACES) {
    for (let x = 0; x < 2 ** minLevel; x++) for (let y = 0; y < 2 ** minLevel; y++) {
      if (!ids.has(cubeTileId({ face, level: minLevel, x, y }))) throw new Error(`Cube imagery is missing root tile ${face}/${minLevel}/${x}/${y}`);
    }
  }
  return manifest;
}

export function imageryTileUri(template: string, a: ImageryAddress): string {
  return template.replace('{face}', a.face).replace('{level}', String(a.level)).replace('{x}', String(a.x)).replace('{y}', String(a.y));
}

/** Face rectangle of a tile: `[u0, u0 + size] × [v0, v0 + size]`. */
export function imageryTileRect(a: Pick<ImageryAddress, 'level' | 'x' | 'y'>): { u0: number; v0: number; size: number } {
  const size = 2 / 2 ** a.level;
  return { u0: -1 + a.x * size, v0: -1 + a.y * size, size };
}

/** Face coordinate of a pixel centre (see the registration convention above). */
export function texelCenterToFace(a: ImageryAddress, column: number, row: number, tileSize: number, gutter: number): { u: number; v: number } {
  const { u0, v0, size } = imageryTileRect(a);
  return { u: u0 + (column + 0.5 - gutter) * size / tileSize, v: v0 + size - (row + 0.5 - gutter) * size / tileSize };
}

/** Continuous pixel coordinates (corners at integers) of a face coordinate in a given tile's file. */
export function faceToTexel(a: ImageryAddress, u: number, v: number, tileSize: number, gutter: number): { column: number; row: number } {
  const { u0, v0, size } = imageryTileRect(a);
  return { column: gutter + (u - u0) / size * tileSize, row: gutter + (v0 + size - v) / size * tileSize };
}

/** The level-`level` tile and continuous pixel position holding a body-fixed direction. */
export function directionToTexel(direction: Vec3, level: number, tileSize: number, gutter: number): { address: ImageryAddress; column: number; row: number; u: number; v: number } {
  const t = cubeTileAt(direction, level);
  const address = { face: t.face, level, x: t.x, y: t.y };
  return { address, ...faceToTexel(address, t.u, t.v, tileSize, gutter), u: t.u, v: t.v };
}

/** Unit direction of a pixel centre; gutter pixels beyond a face edge give the neighbouring face's direction. */
export function texelCenterDirection(a: ImageryAddress, column: number, row: number, tileSize: number, gutter: number): Vec3 {
  const { u, v } = texelCenterToFace(a, column, row, tileSize, gutter);
  if (Math.abs(u) <= 1 && Math.abs(v) <= 1) return cubeFaceToDirection(a.face, u, v) as Vec3;
  const [n, b0, b1] = cubeFaceBasis(a.face);
  const p = [n[0] + u * b0[0] + v * b1[0], n[1] + u * b0[1] + v * b1[1], n[2] + u * b0[2] + v * b1[2]];
  const length = Math.hypot(p[0], p[1], p[2]);
  return [p[0] / length, p[1] / length, p[2] / length];
}

/**
 * Projective face coordinates of a geometry tile. For any body-fixed point p
 * (any length), `s = (p·a)/(p·n)` and `t = (p·b)/(p·n)` are its face u and v
 * mapped to `[0, 1]` across the tile. Both numerator and denominator are linear
 * in p, so storing `(p·a, p·b, p·n)` per vertex and dividing per fragment is
 * exact on every planar triangle: no longitude, no wrap, no pole singularity,
 * and no affine approximation of the gnomonic mapping.
 */
export function tileProjectiveBasis(a: ImageryAddress): { a: Vec3; b: Vec3; n: Vec3 } {
  const [n, u, v] = cubeFaceBasis(a.face);
  const { u0, v0, size } = imageryTileRect(a);
  const comb = (axis: readonly number[], origin: number): Vec3 =>
    [(axis[0] - origin * n[0]) / size, (axis[1] - origin * n[1]) / size, (axis[2] - origin * n[2]) / size];
  return { a: comb(u, u0), b: comb(v, v0), n: [n[0], n[1], n[2]] };
}

/**
 * Maps a geometry tile's local `(s, t) ∈ [0, 1]²` to texture coordinates of an
 * imagery tile on the same face, of any level (finer: a sub-square of the
 * geometry tile; coarser: an ancestor's sub-rectangle). Returns
 * `[scaleS, scaleT, offsetS, offsetT]` with `tex = st · scale + offset`, for a
 * texture uploaded with `t = 0` on the file's bottom row (minimum v).
 */
export function imageryTextureTransform(geometry: ImageryAddress, image: ImageryAddress, tileSize: number, gutter: number): [number, number, number, number] {
  if (geometry.face !== image.face) throw new Error('Imagery and geometry tiles must share a face');
  const k = 2 ** (image.level - geometry.level), span = tileSize + 2 * gutter;
  const scale = k * tileSize / span;
  return [scale, scale, (gutter + (geometry.x * k - image.x) * tileSize) / span, (gutter + (geometry.y * k - image.y) * tileSize) / span];
}

/**
 * Largest ground size of one interior texel of a level-`level` tile at face
 * coordinate (u, v), km, on a sphere of `radiusKm`. The gnomonic angular scale
 * along u is `√(1+v²)/(1+u²+v²)` per unit u (v likewise), largest at the face
 * centre and ~2.6× smaller in the corners: the mapping is not equal-area.
 */
export function texelGroundSizeKm(level: number, u: number, v: number, radiusKm: number, tileSize: number): number {
  const q = 1 + u * u + v * v;
  return radiusKm * (2 / 2 ** level / tileSize) * Math.sqrt(1 + Math.max(u * u, v * v)) / q;
}

/** Smallest level whose texel, at this distance, projects to ≤ `maxScreenTexelError` pixels. */
export function imageryLevelFor(texelAtLevel0Km: number, distanceKm: number, pixelAngleRad: number, maxScreenTexelError: number): number {
  const allowed = maxScreenTexelError * Math.max(distanceKm, 1e-9) * pixelAngleRad;
  return Math.max(0, Math.ceil(Math.log2(texelAtLevel0Km / allowed) - 1e-9));
}

/** Tile ids a product holds, with ancestor lookups. */
export class CubeImageryAvailability {
  private readonly ids: Set<string>;
  constructor(tiles: Iterable<string>, readonly minLevel = 0, readonly maxLevel = MAX_LEVEL) { this.ids = new Set(tiles); }
  has(a: ImageryAddress): boolean { return this.ids.has(cubeTileId(a)); }
  /** `a` itself or its deepest present ancestor; null only above the product's root level. */
  deepestAncestor(a: ImageryAddress): ImageryAddress | null {
    for (let level = a.level; level >= 0; level--) {
      const up = { face: a.face, level, x: a.x >> (a.level - level), y: a.y >> (a.level - level) };
      if (this.ids.has(cubeTileId(up))) return up;
    }
    return null;
  }
  hasAnyChild(a: ImageryAddress): boolean {
    for (let i = 0; i < 4; i++) if (this.ids.has(cubeTileId({ face: a.face, level: a.level + 1, x: 2 * a.x + (i & 1), y: 2 * a.y + (i >> 1) }))) return true;
    return false;
  }
  get size(): number { return this.ids.size; }
}

/** A square of a geometry tile drawn with one imagery tile. `level ≥` the geometry level; `image` is what it wants. */
export interface ImageryBlock extends ImageryAddress { image: ImageryAddress; desiredLevel: number; inView: boolean }

export interface BlockSelectionInput {
  geometry: ImageryAddress;
  /** Min/max distance of the geometry tile's vertices from the body centre, km. */
  radiusRangeKm: readonly [number, number];
  /** Camera position, body-fixed km. */
  cameraKm: Vec3;
  /** Angle subtended by one screen pixel at the view centre, radians. */
  pixelAngleRad: number;
  maxScreenTexelError: number;
  tileSize: number;
  availability: CubeImageryAvailability;
  /** Upper bound on blocks per geometry tile; splitting stops before exceeding it. */
  maxBlocks: number;
  /** Sphere-in-view test, body-fixed km. Out-of-view blocks do not split. */
  inView?: (centreKm: Vec3, radiusKm: number) => boolean;
}

/** Bounding sphere (body-fixed km) of a face square at radii within `radiusRangeKm`. */
export function blockBoundingSphere(a: ImageryAddress, radiusRangeKm: readonly [number, number]): { centre: Vec3; radius: number } {
  const { u0, v0, size } = imageryTileRect(a);
  const points: Vec3[] = [];
  for (const [fu, fv] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]) {
    const d = cubeFaceToDirection(a.face, u0 + fu * size, v0 + fv * size);
    for (const r of radiusRangeKm) points.push([d[0] * r, d[1] * r, d[2] * r]);
  }
  const c = points.reduce((s, p) => [s[0] + p[0] / points.length, s[1] + p[1] / points.length, s[2] + p[2] / points.length] as Vec3, [0, 0, 0] as Vec3);
  return { centre: c, radius: Math.max(...points.map(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]))) };
}

/**
 * Imagery blocks for one geometry tile: a quadtree cut chosen from projected
 * texel size alone, never from the geometry tile's depth. A block finer than
 * the geometry splits the tile (clipping its triangles, see
 * `clipTrianglesToTileRect`); imagery coarser than the geometry uses an
 * ancestor imagery tile's sub-rectangle with no split.
 */
export function selectImageryBlocks(input: BlockSelectionInput): ImageryBlock[] {
  const { geometry, availability } = input;
  const queue: ImageryAddress[] = [geometry];
  const leaves: ImageryBlock[] = [];
  let count = 1;
  while (queue.length) {
    const block = queue.shift()!;
    const sphere = blockBoundingSphere(block, input.radiusRangeKm);
    const c = input.cameraKm;
    const distance = Math.max(Math.hypot(c[0] - sphere.centre[0], c[1] - sphere.centre[1], c[2] - sphere.centre[2]) - sphere.radius, 1e-6);
    const { u0, v0, size } = imageryTileRect(block);
    // Nearest point of the square to the face centre carries its largest texel.
    const uc = Math.min(Math.max(0, u0), u0 + size), vc = Math.min(Math.max(0, v0), v0 + size);
    const desiredLevel = Math.min(availability.maxLevel, imageryLevelFor(texelGroundSizeKm(0, uc, vc, input.radiusRangeKm[1], input.tileSize), distance, input.pixelAngleRad, input.maxScreenTexelError));
    const inView = input.inView ? input.inView(sphere.centre, sphere.radius) : true;
    if (inView && desiredLevel > block.level && count + 3 <= input.maxBlocks && availability.hasAnyChild(block)) {
      for (let i = 0; i < 4; i++) queue.push({ face: block.face, level: block.level + 1, x: 2 * block.x + (i & 1), y: 2 * block.y + (i >> 1) });
      count += 3;
      continue;
    }
    const wantLevel = Math.min(desiredLevel, block.level);
    const shift = block.level - wantLevel;
    const image = availability.deepestAncestor({ face: block.face, level: wantLevel, x: block.x >> shift, y: block.y >> shift });
    if (image) leaves.push({ ...block, image, desiredLevel, inView });
  }
  return leaves;
}

/** Local `[s0, s1, t0, t1]` of an imagery block within its geometry tile. */
export function blockRectInTile(geometry: ImageryAddress, block: ImageryAddress): [number, number, number, number] {
  const k = 2 ** (block.level - geometry.level);
  const s0 = block.x / k - geometry.x, t0 = block.y / k - geometry.y;
  return [s0, s0 + 1 / k, t0, t0 + 1 / k];
}

export interface ClipAttribute { array: ArrayLike<number>; itemSize: number }
export interface ClippedGeometry { attributes: Float32Array[]; index: Uint32Array; vertexCount: number }

/**
 * Triangles of a geometry tile restricted to a local rectangle `[s0, s1] × [t0, t1]`
 * of its projective coordinates (attribute `uvwIndex`, holding `(p·a, p·b, p·n)`).
 * Each boundary `s = s0` is the plane `p·a − s0·p·n = 0` through the body
 * centre, so clipping happens exactly in 3D: a new vertex is the linear
 * interpolation of an edge at that plane, and every attribute (position,
 * normal, uvw) interpolates with the same weight. Clipped geometry therefore
 * lies on the original triangles: the rendered surface does not change.
 * Whole triangles keep their original vertices; edge points are computed
 * from the lower-indexed endpoint so neighbours split an edge identically.
 */
export function clipTrianglesToTileRect(
  attributes: readonly ClipAttribute[], uvwIndex: number, index: ArrayLike<number> | null, rect: readonly [number, number, number, number],
): ClippedGeometry {
  const uvw = attributes[uvwIndex].array;
  const vertexCount = Math.floor(uvw.length / 3);
  const triCount = index ? Math.floor(index.length / 3) : Math.floor(vertexCount / 3);
  const at = (i: number) => (index ? index[i] : i);
  const [s0, s1, t0, t1] = rect;
  // Signed plane values per vertex: ≥ 0 inside each of the four half-spaces.
  const plane = (v: number, k: number) => {
    const a = uvw[3 * v], b = uvw[3 * v + 1], w = uvw[3 * v + 2];
    return k === 0 ? a - s0 * w : k === 1 ? s1 * w - a : k === 2 ? b - t0 * w : t1 * w - b;
  };
  const width = attributes.reduce((s, a) => s + a.itemSize, 0);
  const out: number[] = [];
  const outIndex: number[] = [];
  const remap = new Int32Array(vertexCount).fill(-1);
  let next = 0;
  const pushOriginal = (v: number) => {
    if (remap[v] < 0) {
      remap[v] = next++;
      for (const a of attributes) for (let c = 0; c < a.itemSize; c++) out.push(a.array[v * a.itemSize + c]);
    }
    return remap[v];
  };
  const pushValues = (values: number[]) => { out.push(...values); return next++; };
  const valuesOf = (v: number) => { const r: number[] = []; for (const a of attributes) for (let c = 0; c < a.itemSize; c++) r.push(a.array[v * a.itemSize + c]); return r; };
  // Plane values of interpolated vertices, from their own uvw slot.
  let uvwOffset = 0;
  for (let i = 0; i < uvwIndex; i++) uvwOffset += attributes[i].itemSize;
  const planeOf = (values: number[], k: number) => {
    const a = values[uvwOffset], b = values[uvwOffset + 1], w = values[uvwOffset + 2];
    return k === 0 ? a - s0 * w : k === 1 ? s1 * w - a : k === 2 ? b - t0 * w : t1 * w - b;
  };
  type PolyVertex = { original: number; values: number[] | null };
  for (let t = 0; t < triCount; t++) {
    const tri = [at(3 * t), at(3 * t + 1), at(3 * t + 2)];
    let inside = true, outside = false;
    for (let k = 0; k < 4 && !outside; k++) {
      const p0 = plane(tri[0], k), p1 = plane(tri[1], k), p2 = plane(tri[2], k);
      if (p0 < 0 && p1 < 0 && p2 < 0) outside = true;
      else if (p0 < 0 || p1 < 0 || p2 < 0) inside = false;
    }
    if (outside) continue;
    if (inside) { for (const v of tri) outIndex.push(pushOriginal(v)); continue; }
    // Sutherland–Hodgman against the four planes, in 3D.
    let poly: PolyVertex[] = tri.map(v => ({ original: v, values: null }));
    for (let k = 0; k < 4 && poly.length >= 3; k++) {
      const value = (p: PolyVertex) => (p.values ? planeOf(p.values, k) : plane(p.original, k));
      const clipped: PolyVertex[] = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const fa = value(a), fb = value(b);
        if (fa >= 0) clipped.push(a);
        if ((fa >= 0) !== (fb >= 0)) {
          // Interpolate from a canonical endpoint so a shared edge splits identically in both triangles.
          const swap = a.values === null && b.values === null ? a.original > b.original : false;
          const [p, q, fp, fq] = swap ? [b, a, fb, fa] : [a, b, fa, fb];
          const w = fp / (fp - fq);
          const vp = p.values ?? valuesOf(p.original), vq = q.values ?? valuesOf(q.original);
          clipped.push({ original: -1, values: vp.map((x, c) => x + (vq[c] - x) * w) });
        }
      }
      poly = clipped;
    }
    if (poly.length < 3) continue;
    const ids = poly.map(p => (p.values ? pushValues(p.values) : pushOriginal(p.original)));
    for (let i = 1; i + 1 < ids.length; i++) outIndex.push(ids[0], ids[i], ids[i + 1]);
  }
  const arrays: Float32Array[] = attributes.map(a => new Float32Array(next * a.itemSize));
  for (let v = 0; v < next; v++) {
    let o = v * width;
    attributes.forEach((a, k) => { for (let c = 0; c < a.itemSize; c++) arrays[k][v * a.itemSize + c] = out[o++]; });
  }
  return { attributes: arrays, index: Uint32Array.from(outIndex), vertexCount: next };
}
