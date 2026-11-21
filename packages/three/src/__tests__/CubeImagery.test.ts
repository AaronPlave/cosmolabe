import { describe, expect, it } from 'vitest';
import { cubeFaceToDirection, cubeTileId, directionToCubeFace, type CubeFace } from '../surface/CubeSphere.js';
import {
  CubeImageryAvailability, blockBoundingBox, boxBeyondHorizon, blockRectInTile, clipTrianglesToTileRect, directionToTexel, faceToTexel, imageryLevelFor,
  imageryTextureTransform, imageryTileRect, selectImageryBlocks, texelCenterDirection, texelCenterToFace,
  texelGroundSizeKm, tileProjectiveBasis, validateCubeImageryManifest, type CubeImageryManifest, type ImageryAddress, type Vec3,
} from '../surface/CubeImagery.js';

const T = 256, G = 4, R = 1737.4;
const faces: CubeFace[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const rad = Math.PI / 180;
const latLon = (lat: number, lon: number): Vec3 => [Math.cos(lat * rad) * Math.cos(lon * rad), Math.cos(lat * rad) * Math.sin(lon * rad), Math.sin(lat * rad)];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angle = (a: Vec3, b: Vec3) => Math.acos(Math.min(1, dot(a, b) / Math.hypot(...a) / Math.hypot(...b)));

/** Every tile to `global` on all faces, then a full subtree to `deep` under one tile. */
function availability(global: number, deep = global, under?: ImageryAddress): CubeImageryAvailability {
  const ids: string[] = [];
  for (const face of faces) for (let level = 0; level <= global; level++) for (let x = 0; x < 2 ** level; x++) for (let y = 0; y < 2 ** level; y++) ids.push(cubeTileId({ face, level, x, y }));
  if (under) for (let level = under.level + 1; level <= deep; level++) {
    const k = 2 ** (level - under.level);
    for (let x = under.x * k; x < (under.x + 1) * k; x++) for (let y = under.y * k; y < (under.y + 1) * k; y++) ids.push(cubeTileId({ face: under.face, level, x, y }));
  }
  return new CubeImageryAvailability(ids, 0, deep);
}

describe('imagery visibility bounds', () => {
  it('contains patch interiors and edges on every face, including extrema away from corners', () => {
    for (const face of faces) for (const [level, x, y] of [[0, 0, 0], [2, 1, 2], [5, 17, 7]]) {
      const address = { face, level, x, y }, box = blockBoundingBox(address, [1700, 1740]);
      const { u0, v0, size } = imageryTileRect(address);
      for (let j = 0; j <= 16; j++) for (let i = 0; i <= 16; i++) for (const radius of [1700, 1720, 1740]) {
        const p = cubeFaceToDirection(face, u0 + size * i / 16, v0 + size * j / 16);
        for (let axis = 0; axis < 3; axis++) {
          expect(p[axis] * radius).toBeGreaterThanOrEqual(box.min[axis] - 1e-10);
          expect(p[axis] * radius).toBeLessThanOrEqual(box.max[axis] + 1e-10);
        }
      }
    }
  });

  it('culls only boxes wholly behind the validated inner sphere', () => {
    const eye: Vec3 = [0, 0, 1800];
    const near = blockBoundingBox({ face: 'pz', level: 0, x: 0, y: 0 }, [1730, 1740]);
    const far = blockBoundingBox({ face: 'nz', level: 0, x: 0, y: 0 }, [1730, 1740]);
    expect(boxBeyondHorizon(near, eye, 1700)).toBe(false);
    expect(boxBeyondHorizon(far, eye, 1700)).toBe(true);
    expect(boxBeyondHorizon(far, eye, 0)).toBe(false); // no guessed body radius
    expect(boxBeyondHorizon(far, [0, 0, 1600], 1700)).toBe(false);
    expect(boxBeyondHorizon({ min: [-100, -100, 1700], max: [100, 100, 1800] }, eye, 1700)).toBe(false);
  });
});

describe('cube imagery registration', () => {
  it('puts pixel centres at half-integer corners on every face, with gutters outside the face rectangle', () => {
    for (const face of faces) for (const [level, x, y] of [[0, 0, 0], [3, 5, 2], [12, 4095, 0]]) {
      const a = { face, level, x, y };
      for (const [i, j] of [[0, 0], [G, G], [G + T - 1, G + 17], [T + 2 * G - 1, T + 2 * G - 1]]) {
        const { u, v } = texelCenterToFace(a, i, j, T, G);
        const back = faceToTexel(a, u, v, T, G);
        expect(back.column).toBeCloseTo(i + 0.5, 6);
        expect(back.row).toBeCloseTo(j + 0.5, 6);
      }
      const { u0, v0, size } = imageryTileRect(a);
      // Interior corners: column g at u0, row g at the top (v0 + size).
      expect(faceToTexel(a, u0, v0 + size, T, G)).toEqual({ column: G, row: G });
      expect(faceToTexel(a, u0 + size, v0, T, G).column).toBeCloseTo(G + T, 9);
    }
  });

  it('addresses the exact poles, the antimeridian and face corners continuously', () => {
    // South pole: the nz face centre, an exact child-boundary corner at every level.
    for (const level of [1, 4, 12]) {
      const t = directionToTexel([0, 0, -1], level, T, G);
      expect(t.address).toEqual({ face: 'nz', level, x: 2 ** (level - 1), y: 2 ** (level - 1) });
      expect(t.column).toBe(G);
      expect(t.row).toBe(G + T);
    }
    expect(directionToTexel([0, 0, 1], 5, T, G).address).toMatchObject({ face: 'pz', x: 16, y: 16 });
    // The antimeridian crosses the nx face centre: ±180° spellings agree and neighbours are adjacent texels.
    for (const lat of [0, -60, 30]) {
      const east = directionToTexel(latLon(lat, 180 - 1e-7), 10, T, G), west = directionToTexel(latLon(lat, -180 + 1e-7), 10, T, G);
      expect(east.address.face).toBe(lat === -60 ? 'nz' : 'nx');
      expect(west.address.face).toBe(east.address.face);
      expect(Math.hypot(east.u - west.u, east.v - west.v)).toBeLessThan(1e-8);
    }
    // Near the pole every longitude stays on nz and the pixel grid is smooth (no longitude singularity).
    const ring = Array.from({ length: 36 }, (_, i) => directionToTexel(latLon(-89.999, i * 10), 14, T, G));
    expect(new Set(ring.map(r => r.address.face))).toEqual(new Set(['nz']));
    // The px/py/nz corner is owned by px (X > Y > Z ownership), at its exact corner u = v = 1.
    const corner = directionToTexel([1, 1, -1], 6, T, G);
    expect(corner.address.face).toBe('px');
    expect([corner.u, corner.v]).toEqual([1, 1]);
  });

  it('evaluates gutters on the neighbouring face, within a texel of the edge', () => {
    const a = { face: 'px' as CubeFace, level: 2, x: 3, y: 1 }; // touches px u = +1 (the px/nz edge)
    for (let k = 0; k < G; k++) {
      const gutter = texelCenterDirection(a, G + T + k, G + 100, T, G);
      const owner = directionToCubeFace(gutter);
      expect(owner.face).not.toBe('px');
      const edge = texelCenterDirection(a, G + T - 1, G + 100, T, G);
      expect(angle(gutter, edge)).toBeLessThan((k + 2) * texelGroundSizeKm(2, 1, 0, 1, T));
    }
  });
});

describe('projective face coordinates', () => {
  it('recovers a point\'s tile-local face coordinate exactly at any height', () => {
    for (const face of faces) {
      const a = { face, level: 7, x: 70, y: 12 };
      const { a: A, b: B, n: N } = tileProjectiveBasis(a);
      const { u0, v0, size } = imageryTileRect(a);
      for (const [fu, fv, h] of [[0, 0, -9], [0.3, 0.8, 0], [1, 1, 11], [0.5, 0.25, 4]]) {
        const d = cubeFaceToDirection(face, u0 + fu * size, v0 + fv * size);
        const p = d.map(c => c * (R + h)) as unknown as Vec3;
        expect(dot(p, A) / dot(p, N)).toBeCloseTo(fu, 10);
        expect(dot(p, B) / dot(p, N)).toBeCloseTo(fv, 10);
      }
    }
  });

  it('is exact across a planar triangle where interpolating face coordinates is not', () => {
    // A level-0 lattice cell with a 10 km height step: affine (s, t) interpolation drifts; projective does not.
    const a = { face: 'pz' as CubeFace, level: 0, x: 0, y: 0 };
    const { a: A, b: B, n: N } = tileProjectiveBasis(a);
    const verts = [[0.70, 0.70, 0], [0.73, 0.70, 10], [0.70, 0.73, -5]].map(([u, v, h]) => cubeFaceToDirection('pz', 2 * u - 1, 2 * v - 1).map(c => c * (R + h)));
    const w = [0.2, 0.5, 0.3];
    const p = [0, 1, 2].map(c => w[0] * verts[0][c] + w[1] * verts[1][c] + w[2] * verts[2][c]) as unknown as Vec3;
    const truth = directionToCubeFace(p);
    const lerp = (f: (q: Vec3) => number) => w.reduce((s, wi, i) => s + wi * f(verts[i] as unknown as Vec3), 0);
    const projective = lerp(q => dot(q, A)) / lerp(q => dot(q, N));
    const affine = lerp(q => dot(q, A) / dot(q, N));
    expect(projective).toBeCloseTo((truth.u + 1) / 2, 12);
    expect(Math.abs(affine - (truth.u + 1) / 2) * 2 * R * 1000).toBeGreaterThan(1); // > 1 m on the ground
    expect(lerp(q => dot(q, B)) / lerp(q => dot(q, N))).toBeCloseTo((truth.v + 1) / 2, 12);
  });

  it('maps a geometry tile onto finer, equal and coarser imagery tiles at the right texels', () => {
    const geometry = { face: 'ny' as CubeFace, level: 5, x: 9, y: 22 };
    const { u0, v0, size } = imageryTileRect(geometry);
    for (const level of [2, 5, 9]) for (const [s, t] of [[0.1, 0.9], [0.5, 0.5], [0.97, 0.03]]) {
      const u = u0 + s * size, v = v0 + t * size;
      const image = directionToTexel(cubeFaceToDirection('ny', u, v) as Vec3, level, T, G);
      const [ss, st, os, ot] = imageryTextureTransform(geometry, image.address, T, G);
      const span = T + 2 * G;
      expect(s * ss + os).toBeCloseTo(image.column / span, 9);
      expect(t * st + ot).toBeCloseTo(1 - image.row / span, 9);
    }
    expect(() => imageryTextureTransform(geometry, { face: 'px', level: 5, x: 0, y: 0 }, T, G)).toThrow();
  });
});

describe('imagery level selection is independent of geometry depth', () => {
  const pixelAngle = 2 * Math.tan(30 * rad) / 800;
  const shackleton = latLon(-89.67, 129.78);
  const under = directionToTexel(shackleton, 3, T, G).address;
  const avail = availability(3, 12, under);

  it('chooses levels from projected texel size', () => {
    const t0 = texelGroundSizeKm(0, 0, 0, R, T);
    expect(t0).toBeCloseTo(R * 2 / T, 9);
    expect(texelGroundSizeKm(0, 1, 1, R, T)).toBeCloseTo(t0 * Math.SQRT2 / 3, 9);
    const levels = [1, 10, 100, 1000].map(d => imageryLevelFor(t0, d, pixelAngle, 1));
    expect(levels).toEqual([...levels].sort((x, y) => y - x));
    expect(t0 / 2 ** levels[1]).toBeLessThanOrEqual(10 * pixelAngle);
  });

  it('refines imagery far below a coarse geometry tile and coarsens it above a fine one', () => {
    const camera = shackleton.map(c => c * (R + 3)) as unknown as Vec3;
    const near = selectImageryBlocks({ geometry: under, radiusRangeKm: [R - 6, R + 2], cameraKm: camera, pixelAngleRad: pixelAngle,
      maxScreenTexelError: 1.5, tileSize: T, availability: avail, maxBlocks: 256 });
    const deepest = Math.max(...near.map(b => b.image.level));
    expect(deepest).toBeGreaterThanOrEqual(9);
    expect(near.length).toBeLessThanOrEqual(256);
    for (const block of near) expect(block.level).toBeGreaterThanOrEqual(under.level);
    // The same camera over a level-9 geometry tile wants the same imagery at the nadir point.
    const fine = directionToTexel(shackleton, 9, T, G).address;
    const select = (geometry: ImageryAddress) => selectImageryBlocks({ geometry, radiusRangeKm: [R - 6, R + 2], cameraKm: camera,
      pixelAngleRad: pixelAngle, maxScreenTexelError: 1.5, tileSize: T, availability: avail, maxBlocks: 4096 });
    const nadir = (blocks: ReturnType<typeof select>) => blocks.find(b => {
      const t = directionToTexel(shackleton, b.level, T, G).address;
      return t.face === b.face && t.x === b.x && t.y === b.y;
    })!.image;
    expect(nadir(select(fine))).toEqual(nadir(select(under)));
    // From orbit the geometry tile stays whole and draws an ancestor imagery tile.
    const far = selectImageryBlocks({ geometry: fine, radiusRangeKm: [R - 6, R + 2], cameraKm: shackleton.map(c => c * (R + 3000)) as unknown as Vec3,
      pixelAngleRad: pixelAngle, maxScreenTexelError: 1.5, tileSize: T, availability: avail, maxBlocks: 256 });
    expect(far).toHaveLength(1);
    expect(far[0].image.level).toBeLessThan(fine.level);
    expect(far[0]).toMatchObject({ level: fine.level, x: fine.x, y: fine.y });
  });

  it('respects the block budget, the view test and missing imagery', () => {
    const camera = shackleton.map(c => c * (R + 1)) as unknown as Vec3;
    const base = { geometry: under, radiusRangeKm: [R - 6, R + 2] as const, cameraKm: camera, pixelAngleRad: pixelAngle, maxScreenTexelError: 1, tileSize: T };
    expect(selectImageryBlocks({ ...base, availability: avail, maxBlocks: 10 }).length).toBeLessThanOrEqual(10);
    expect(selectImageryBlocks({ ...base, availability: avail, maxBlocks: 256, inView: () => false })).toHaveLength(1);
    // Imagery that stops at level 3 is drawn whole, however close the camera.
    const flat = selectImageryBlocks({ ...base, availability: availability(3), maxBlocks: 256 });
    expect(flat).toHaveLength(1);
    expect(flat[0].image).toEqual(under);
  });
});

describe('clipping a geometry tile into imagery blocks', () => {
  /** A 9×9 lattice tile with relief, positions relative to its centre like the .glb product. */
  function lattice(a: ImageryAddress, n = 9) {
    const { u0, v0, size } = imageryTileRect(a);
    const abs: number[][] = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const d = cubeFaceToDirection(a.face, u0 + size * i / (n - 1), v0 + size * j / (n - 1));
      const h = 3 * Math.sin(i * 1.7) * Math.cos(j * 2.3);
      abs.push(d.map(c => c * (R + h)));
    }
    const centre = [0, 1, 2].map(c => abs.reduce((s, p) => s + p[c], 0) / abs.length);
    const { a: A, b: B, n: N } = tileProjectiveBasis(a);
    const position = new Float64Array(abs.flatMap(p => p.map((c, k) => c - centre[k])));
    const uvw = new Float64Array(abs.flatMap(p => [dot(p, A), dot(p, B), dot(p, N)]));
    const index: number[] = [];
    for (let j = 0; j + 1 < n; j++) for (let i = 0; i + 1 < n; i++) {
      const k = j * n + i;
      index.push(k, k + 1, k + n + 1, k, k + n + 1, k + n);
    }
    return { position, uvw, index, centre };
  }
  const area = (pos: ArrayLike<number>, index: ArrayLike<number>) => {
    let sum = 0;
    for (let t = 0; t < index.length; t += 3) {
      const [a, b, c] = [index[t], index[t + 1], index[t + 2]].map(i => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]);
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      sum += Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
    }
    return sum;
  };

  it('partitions the tile exactly, on the original triangles, at cell-aligned and sub-cell blocks', () => {
    const tile = { face: 'nz' as CubeFace, level: 6, x: 31, y: 32 }; // touches the south pole
    const { position, uvw, index } = lattice(tile);
    const total = area(position, index);
    for (const depth of [1, 3, 5]) { // 2×2 (cell aligned), 8×8 (one cell), 32×32 (quarter cells: clipped)
      let sum = 0, vertices = 0;
      const k = 2 ** depth;
      for (let bx = 0; bx < k; bx++) for (let by = 0; by < k; by++) {
        const block = { face: tile.face, level: tile.level + depth, x: tile.x * k + bx, y: tile.y * k + by };
        const rect = blockRectInTile(tile, block);
        const out = clipTrianglesToTileRect([{ array: position, itemSize: 3 }, { array: uvw, itemSize: 3 }], 1, index, rect);
        sum += area(out.attributes[0], out.index);
        vertices += out.vertexCount;
        for (let v = 0; v < out.vertexCount; v++) {
          const [a, b, w] = [0, 1, 2].map(c => out.attributes[1][3 * v + c]);
          expect(a / w).toBeGreaterThanOrEqual(rect[0] - 1e-6);
          expect(a / w).toBeLessThanOrEqual(rect[1] + 1e-6);
          expect(b / w).toBeGreaterThanOrEqual(rect[2] - 1e-6);
          expect(b / w).toBeLessThanOrEqual(rect[3] + 1e-6);
        }
      }
      expect(Math.abs(sum - total) / total).toBeLessThan(1e-6);
      expect(vertices).toBeGreaterThan(0);
    }
  });

  it('partitions a simplified tile too: large triangles over a subset of the lattice, vertices compacted', () => {
    // Like `cube-tile --simplify`: every edge vertex kept, the interior reduced to one centre vertex,
    // so each triangle fans across half the tile and most blocks cut through its interior.
    const tile = { face: 'px' as CubeFace, level: 3, x: 7, y: 7 }, n = 9; // the px/py/nz corner tile
    const full = lattice(tile, n);
    const k = [...Array(n).keys()];
    const loop = [...k, ...k.slice(1).map(i => i * n + n - 1), ...k.slice(1).map(i => (n - 1) * n + n - 1 - i), ...k.slice(1, -1).map(i => (n - 1 - i) * n)];
    const keep = [...loop, (n * n - 1) / 2];
    const position = new Float64Array(keep.flatMap(v => [0, 1, 2].map(c => full.position[3 * v + c])));
    const uvw = new Float64Array(keep.flatMap(v => [0, 1, 2].map(c => full.uvw[3 * v + c])));
    const index = loop.flatMap((_, i) => [i, (i + 1) % loop.length, keep.length - 1]);
    const total = area(position, index);
    for (const depth of [1, 3, 5]) {
      let sum = 0;
      const m = 2 ** depth;
      for (let bx = 0; bx < m; bx++) for (let by = 0; by < m; by++) {
        const rect = blockRectInTile(tile, { face: tile.face, level: tile.level + depth, x: tile.x * m + bx, y: tile.y * m + by });
        const out = clipTrianglesToTileRect([{ array: position, itemSize: 3 }, { array: uvw, itemSize: 3 }], 1, index, rect);
        sum += area(out.attributes[0], out.index);
        expect(out.index.length).toBeGreaterThan(0); // the fan covers every block
        for (let v = 0; v < out.vertexCount; v++) {
          const [a, b, w] = [0, 1, 2].map(c => out.attributes[1][3 * v + c]);
          expect(a / w).toBeGreaterThanOrEqual(rect[0] - 1e-6);
          expect(a / w).toBeLessThanOrEqual(rect[1] + 1e-6);
          expect(b / w).toBeGreaterThanOrEqual(rect[2] - 1e-6);
          expect(b / w).toBeLessThanOrEqual(rect[3] + 1e-6);
        }
      }
      expect(Math.abs(sum - total) / total).toBeLessThan(1e-6);
    }
  });

  it('keeps skirts, which lie in the tile-boundary planes, exactly once and textured like their edge', () => {
    const tile = { face: 'nz' as CubeFace, level: 6, x: 31, y: 32 }, n = 9, depth = 40;
    const { position, centre } = lattice(tile, n);
    const { a: A, b: B, n: N } = tileProjectiveBasis(tile);
    // Skirt quads below each edge loop, in float32 like a decoded .glb, uvw from those float32 positions.
    const pos = Array.from(position), skirt: number[] = [];
    const k = [...Array(n).keys()];
    for (const loop of [k, k.map(i => i * n + n - 1), k.map(i => (n - 1) * n + n - 1 - i), k.map(i => (n - 1 - i) * n)]) {
      const base = pos.length / 3;
      for (const v of loop) {
        const p = [0, 1, 2].map(c => position[3 * v + c] + centre[c]), r = Math.hypot(...p);
        pos.push(...p.map((c, i) => c * (1 - depth / r) - centre[i]));
      }
      for (let i = 0; i + 1 < n; i++) skirt.push(loop[i], base + i, loop[i + 1], loop[i + 1], base + i, base + i + 1);
    }
    const p32 = Float32Array.from(pos);
    const uvw = new Float32Array(p32.length);
    for (let v = 0; v < p32.length / 3; v++) {
      const p = [0, 1, 2].map(c => p32[3 * v + c] + centre[c]);
      uvw.set([dot(p, A), dot(p, B), dot(p, N)], 3 * v);
    }
    const whole = area(p32, skirt);
    let sum = 0;
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {
      const rect = blockRectInTile(tile, { face: tile.face, level: tile.level + 2, x: tile.x * 4 + x, y: tile.y * 4 + y });
      const out = clipTrianglesToTileRect([{ array: p32, itemSize: 3 }, { array: uvw, itemSize: 3 }], 1, skirt, rect);
      sum += area(out.attributes[0], out.index);
      if (x > 0 && x < 3 && y > 0 && y < 3) expect(out.index.length).toBe(0); // interior blocks hold no skirt
    }
    expect(Math.abs(sum - whole) / whole).toBeLessThan(1e-5);
    // A skirt vertex's projective coordinates are its edge vertex's: imagery runs straight down the wall.
    for (let v = 0; v < 4 * n; v++) {
      const top = [k, k.map(i => i * n + n - 1), k.map(i => (n - 1) * n + n - 1 - i), k.map(i => (n - 1 - i) * n)].flat()[v];
      const b = n * n + v;
      expect(Math.abs(uvw[3 * b] / uvw[3 * b + 2] - uvw[3 * top] / uvw[3 * top + 2])).toBeLessThan(1e-6);
      expect(Math.abs(uvw[3 * b + 1] / uvw[3 * b + 2] - uvw[3 * top + 1] / uvw[3 * top + 2])).toBeLessThan(1e-6);
    }
  });

  it('keeps clipped vertices on the surface: interpolated uvw matches the clipped position', () => {
    const tile = { face: 'px' as CubeFace, level: 4, x: 15, y: 15 }; // the px/py/pz corner tile
    const { position, uvw, index, centre } = lattice(tile);
    const block = { face: tile.face, level: tile.level + 5, x: tile.x * 32 + 13, y: tile.y * 32 + 30 };
    const out = clipTrianglesToTileRect([{ array: position, itemSize: 3 }, { array: uvw, itemSize: 3 }], 1, index, blockRectInTile(tile, block));
    expect(out.index.length).toBeGreaterThan(0);
    const { a: A, n: N } = tileProjectiveBasis(tile);
    for (let v = 0; v < out.vertexCount; v++) {
      const p = [0, 1, 2].map(c => out.attributes[0][3 * v + c] + centre[c]);
      const s = out.attributes[1][3 * v] / out.attributes[1][3 * v + 2];
      expect(Math.abs(dot(p, A) / dot(p, N) - s)).toBeLessThan(1e-5);
    }
  });
});

describe('manifest validation', () => {
  const base = (): CubeImageryManifest => ({
    format: 'cosmolabe-cube-imagery-1', source: { id: 'fixture', kind: 'imagery', version: 'v1' }, bodyId: 'Moon',
    registration: { crsId: 'cosmolabe:cube-gnomonic-1/IAU_MOON', pixelConvention: 'corner', registrationErrorKm: 0, resampling: 'analytic', footprint: 'global' },
    tileSize: T, gutter: G, encoding: 'png', colorSpace: 'linear', minLevel: 0, maxLevel: 2, uri: 'tiles/{face}/{level}/{x}/{y}.png',
    tiles: [...faces.map(f => `${f}/0/0/0`), 'nz/1/1/1'],
  });
  it('accepts a complete tree and refuses orphans, missing roots and bad layouts', () => {
    expect(validateCubeImageryManifest(base())).toBeTruthy();
    expect(() => validateCubeImageryManifest({ ...base(), tiles: [...base().tiles, 'nz/2/0/0'] })).toThrow(/parent/);
    expect(() => validateCubeImageryManifest({ ...base(), tiles: base().tiles.slice(1) })).toThrow(/root/);
    expect(() => validateCubeImageryManifest({ ...base(), gutter: -1 })).toThrow();
    expect(() => validateCubeImageryManifest({ ...base(), tiles: ['xx/0/0/0'] })).toThrow();
  });
});
