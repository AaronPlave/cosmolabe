import { Color, ShapeUtils, Vector2 } from 'three';
import { geographicProjection, projectGeographic, projectGeographicRings, wrapLon,
  type BodyFixedPosition, type GeographicFeature, type GeographicLayer, type GeographicProjection, type GeographicXY } from '@cosmolabe/core';

export interface GeographicFeatureRef { layerId: string; featureId: string; bodyName: string; }
export interface GeographicRenderDiagnostic { layerId: string; featureId?: string; code: string; message: string; }
export const VECTOR_DETAIL_GRIDS = [64, 32, 16, 8, 6, 5] as const;
export const VECTOR_GRID = [64, 32] as const;
/** Candidate budget per draw, not an admission limit for a geographic cell. */
export const VECTOR_CELL_LIMIT = 256;
/** Limit surface rerenders independently of the index storage budget. */
export const VECTOR_RENDER_PAGE_LIMIT = 16;
export const VECTOR_PRIMITIVE_LIMIT = 100_000;
export const VECTOR_REFERENCE_LIMIT = 1_000_000;
/** Padding allows round screen-space strokes to cross the cell boundary. At
 * unresolved orbit views drawing is culled rather than scanning a whole planet. */
export const VECTOR_PADDING_DEG = 6;
export type VectorPrimitive = {
  kind: 0 | 1 | 2; // point, segment, filled triangle
  a: GeographicXY; b: GeographicXY; c: GeographicXY;
  chart: GeographicProjection;
  feature: number;
  color: readonly [number, number, number]; opacity: number;
};
interface DetailLevel {
  size: number;
  height?: number;
  offset: number;
  pages: number;
  bounds: readonly [number, number, number, number];
  step: readonly [number, number];
}
interface PackedGeographicIndex {
  records: Float32Array;
  cells: Float32Array;
  references: Float32Array;
  pages: number;
  detail?: { cells: Float32Array; levels: DetailLevel[] };
}
const primitiveAnchor = (p: VectorPrimitive) => (Math.min(p.a[0], p.b[0], p.c[0]) + Math.max(p.a[0], p.b[0], p.c[0])) / 2;

export function geographicCell(lon: number, lat: number): number {
  const x = Math.floor((wrapLon(lon) + 180) / 360 * VECTOR_GRID[0]);
  const y = Math.min(VECTOR_GRID[1] - 1, Math.max(0, Math.floor((lat + 90) / 180 * VECTOR_GRID[1])));
  return y * VECTOR_GRID[0] + x;
}

function primitiveCells(p: VectorPrimitive, grid: readonly [number, number] = VECTOR_GRID, padding = VECTOR_PADDING_DEG): number[] {
  const vertices = p.kind === 0 ? [p.a] : p.kind === 1 ? [p.a, p.b] : [p.a, p.b, p.c];
  let west = -180, east = 180, south = -90, north = 90;
  if (p.chart === 'longitude-latitude') {
    west = Math.min(...vertices.map(p => p[0])) - padding;
    east = Math.max(...vertices.map(p => p[0])) + padding;
    south = Math.min(...vertices.map(p => p[1])) - padding;
    north = Math.max(...vertices.map(p => p[1])) + padding;
  } else {
    // A convex polar primitive occupies an angular wedge unless it contains
    // the origin. Bound its actual radius and wedge, rather than repeating
    // every Antarctic coastal segment across every longitude in the cap.
    const cross = (a: GeographicXY, b: GeographicXY) => a[0] * b[1] - a[1] * b[0];
    const signs = p.kind === 2 ? [cross(p.a, p.b), cross(p.b, p.c), cross(p.c, p.a)] : [];
    const containsPole = signs.length > 0 && (signs.every(x => x >= 0) || signs.every(x => x <= 0));
    let minRadius = Math.min(...vertices.map(v => Math.hypot(...v)));
    const maxRadius = Math.max(...vertices.map(v => Math.hypot(...v)));
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i], b = vertices[(i + 1) % vertices.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / (dx * dx + dy * dy || 1)));
      minRadius = Math.min(minRadius, Math.hypot(a[0] + t * dx, a[1] + t * dy));
    }
    if (containsPole) minRadius = 0;
    if (p.chart === 'north-polar') { south = 90 - maxRadius - padding; north = 90 - minRadius + padding; }
    else { south = -90 + minRadius - padding; north = -90 + maxRadius + padding; }
    if (minRadius > padding) {
      const angles = vertices.map(v => Math.atan2(v[1], v[0]) * 180 / Math.PI).sort((a, b) => a - b);
      let gap = -1, start = 0;
      for (let i = 0; i < angles.length; i++) {
        const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + 360;
        if (next - angles[i] > gap) { gap = next - angles[i]; start = (i + 1) % angles.length; }
      }
      const angularPadding = Math.asin(Math.min(1, padding / minRadius)) * 180 / Math.PI;
      west = angles[start] - Math.max(padding, angularPadding); east = angles[start] + 360 - gap + Math.max(padding, angularPadding);
    }
  }
  const cells = new Set<number>();
  const y0 = Math.max(0, Math.floor((south + 90) / 180 * grid[1]));
  const y1 = Math.min(grid[1] - 1, Math.floor((north + 90) / 180 * grid[1]));
  const x0 = Math.floor((west + 180) / 360 * grid[0]);
  const x1 = Math.min(x0 + grid[0] - 1, Math.floor((east + 180) / 360 * grid[0]));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    cells.add(y * grid[0] + ((x % grid[0]) + grid[0]) % grid[0]);
  }
  return [...cells];
}

/** Same rank/source paging at every spatial scale. */
function pageCells(cells: number[][], primitives: readonly VectorPrimitive[]): number[][][] {
  if (cells.every(ids => ids.length <= VECTOR_CELL_LIMIT)) return [cells];
  const grids: number[][][] = [];
  for (const kind of [2, 1, 0]) {
    const bins = cells.map(ids => ids.filter(id => primitives[id].kind === kind));
    const pages = Math.ceil(Math.max(...bins.map(ids => ids.length)) / VECTOR_CELL_LIMIT);
    for (let page = pages - 1; page >= 0; page--) {
      grids.push(bins.map(ids => ids.slice(page * VECTOR_CELL_LIMIT, (page + 1) * VECTOR_CELL_LIMIT)));
    }
  }
  return grids;
}

/** Immutable, bounded spatial index shared by CPU picking and the GPU. Features
 * commit atomically: a budget failure never leaves a polygon without its holes. */
export class GeographicIndex {
  readonly primitives: VectorPrimitive[] = [];
  readonly features: GeographicFeatureRef[] = [];
  readonly cells: number[][] = Array.from({ length: VECTOR_GRID[0] * VECTOR_GRID[1] }, () => []);
  readonly diagnostics: GeographicRenderDiagnostic[] = [];
  private references = 0;

  constructor(layers: readonly GeographicLayer[]) {
    for (const layer of layers) {
      if (layer.definition.display?.visible === false || layer.definition.display?.opacity === 0) continue;
      for (const feature of layer.features) this.addFeature(layer, feature);
    }
  }

  private addFeature(layer: GeographicLayer, feature: GeographicFeature): void {
    const staged: VectorPrimitive[] = [];
    const color = new Color(layer.definition.display?.color ?? '#59c5dd').toArray() as [number, number, number];
    const opacity = layer.definition.display?.opacity ?? 1;
    const featureIndex = this.features.length + 1;
    const emit = (kind: VectorPrimitive['kind'], a: GeographicXY, b = a, c = a, chart: GeographicProjection = 'longitude-latitude') => {
      if (staged.length + this.primitives.length >= VECTOR_PRIMITIVE_LIMIT) throw new Error('primitive budget exceeded');
      staged.push({ kind, a, b, c, chart, feature: featureIndex, color, opacity });
    };
    const point = (p: BodyFixedPosition) => {
      const chart: GeographicProjection = Math.abs(p.latDeg) > 80 ? p.latDeg > 0 ? 'north-polar' : 'south-polar' : 'longitude-latitude';
      const xy = projectGeographic(p, chart);
      emit(0, xy, xy, xy, chart);
    };
    const line = (points: BodyFixedPosition[], chart: GeographicProjection = 'longitude-latitude') => {
      const xy = projectGeographicRings([points], chart)[0];
      for (let i = 1; i < xy.length; i++) emit(1, xy[i - 1], xy[i], xy[i], chart);
    };
    const polygon = (rings: BodyFixedPosition[][]) => {
      const chart = geographicProjection(rings[0]);
      const xy = projectGeographicRings(rings, chart).map(r => r.slice(0, -1));
      const vertices = xy.flat();
      // ShapeUtils delegates to earcut and respects independent hole rings.
      const triangles = ShapeUtils.triangulateShape(xy[0].map(p => new Vector2(...p)), xy.slice(1).map(r => r.map(p => new Vector2(...p))));
      if (!triangles.length) throw new Error('polygon could not be triangulated');
      for (const [a, b, c] of triangles) emit(2, vertices[a], vertices[b], vertices[c], chart);
      for (const ring of rings) line(ring, chart);
    };
    try {
      const g = feature.geometry;
      switch (g.type) {
        case 'Point': point(g.coordinates); break;
        case 'MultiPoint': g.coordinates.forEach(point); break;
        case 'LineString': line(g.coordinates); break;
        case 'MultiLineString': g.coordinates.forEach(p => line(p)); break;
        case 'Polygon': polygon(g.coordinates); break;
        case 'MultiPolygon': g.coordinates.forEach(polygon); break;
      }
      const bins: number[][] = [];
      let references = 0;
      for (const primitive of staged) {
        const bin = primitiveCells(primitive);
        references += bin.length;
        if (this.references + references > VECTOR_REFERENCE_LIMIT) throw new Error('spatial reference budget exceeded');
        bins.push(bin);
      }
      const first = this.primitives.length;
      for (const primitive of staged) this.primitives.push(primitive);
      bins.forEach((bin, i) => bin.forEach(cell => this.cells[cell].push(first + i)));
      this.references += references;
      this.features.push({ layerId: layer.id, featureId: feature.id, bodyName: layer.body });
    } catch (error) {
      this.diagnostics.push({ layerId: layer.id, featureId: feature.id, code: 'vector-budget', message: String(error) });
    }
  }

  get renderPages(): number {
    let peak = 0;
    const peaks = [0, 0, 0];
    for (const ids of this.cells) {
      peak = Math.max(peak, ids.length);
      const counts = [0, 0, 0];
      for (const id of ids) counts[this.primitives[id].kind]++;
      for (let kind = 0; kind < 3; kind++) peaks[kind] = Math.max(peaks[kind], counts[kind]);
    }
    return peak <= VECTOR_CELL_LIMIT ? 1 : peaks.reduce((n, count) => n + Math.ceil(count / VECTOR_CELL_LIMIT), 0);
  }

  /** A padded global level for distributed data, including polar primitives.
   * Selection uses the same derivative-footprint rule as the local levels. */
  private globalGrid(): { grids: number[][][]; level: DetailLevel }[] {
    const size = 256, height = 128;
    const step: readonly [number, number] = [360 / size, 180 / height];
    const bins: number[][] = Array.from({ length: size * height }, () => []);
    let references = this.references;
    for (const [id, p] of this.primitives.entries()) {
      // One full cell covers the mark footprint admitted by the shader.
      for (const cell of primitiveCells(p, [size, height], step[0])) {
        if (++references > VECTOR_REFERENCE_LIMIT) return [];
        bins[cell].push(id);
      }
    }
    const grids = pageCells(bins, this.primitives);
    if (grids.length > this.renderPages) return [];
    return [{ grids, level: { size, height, offset: 0, pages: grids.length,
      bounds: [-180, -90, 180, 90], step } }];
  }

  /** Local grids retain every primitive and one cell of padding at each scale.
   * Derivatives select a grid whose padding covers the CSS-pixel mark; wide,
   * seam and polar views retain the bounded global fallback. */
  private detailGrids(): { grids: number[][][]; level: DetailLevel }[] {
    const result: { grids: number[][][]; level: DetailLevel }[] = [];
    const coarsePages = this.renderPages;
    if (this.primitives.some(p => p.chart !== 'longitude-latitude')) return this.globalGrid();
    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    for (const p of this.primitives) for (const v of [p.a, p.b, p.c]) {
      west = Math.min(west, v[0]); east = Math.max(east, v[0]); south = Math.min(south, v[1]); north = Math.max(north, v[1]);
    }
    if (east - west <= 1e-8 || north - south <= 1e-8 || east - west > 10 || north - south > 10
      || west < -180 || east >= 180 || south < -80 || north > 80) return this.globalGrid();
    if (coarsePages <= 1) return result;
    let references = this.references, offset = 0;
    for (const size of VECTOR_DETAIL_GRIDS) {
      const dx = (east - west) / (size - 4), dy = (north - south) / (size - 4);
      const xOrigin = west - 2 * dx, yOrigin = south - 2 * dy;
      // A padded chart may not cross the longitude seam or a pole.
      if (xOrigin < -180 || xOrigin + size * dx >= 180 || yOrigin < -90 || yOrigin + size * dy > 90) continue;
      const bins: number[][] = Array.from({ length: size ** 2 }, () => []);
      let added = 0;
      for (const [id, p] of this.primitives.entries()) {
        const x0 = Math.max(0, Math.floor((Math.min(p.a[0], p.b[0], p.c[0]) - xOrigin) / dx - 1));
        const x1 = Math.min(size - 1, Math.floor((Math.max(p.a[0], p.b[0], p.c[0]) - xOrigin) / dx + 1));
        const y0 = Math.max(0, Math.floor((Math.min(p.a[1], p.b[1], p.c[1]) - yOrigin) / dy - 1));
        const y1 = Math.min(size - 1, Math.floor((Math.max(p.a[1], p.b[1], p.c[1]) - yOrigin) / dy + 1));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          if (references + ++added > VECTOR_REFERENCE_LIMIT) return result;
          bins[y * size + x].push(id);
        }
      }
      const grids = pageCells(bins, this.primitives);
      if (grids.length > coarsePages) continue;
      result.push({ grids, level: { size, offset, pages: grids.length,
        bounds: [xOrigin, yOrigin, xOrigin + dx * size, yOrigin + dy * size], step: [dx, dy] } });
      offset += grids.length * size ** 2; references += added;
    }
    return result;
  }

  /** Sparse cells retain the original single-pass ordering. Overflow uses
   * bounded pages, fills before strokes before points; earlier source pages
   * draw last. Translucent overlaps between pages composite normally.
   * Four RGBA texels per primitive; integer IDs remain exact in float32.
   * Each page is a complete grid; no fragment scans more than 256 references.
   * Total pages/references remain bounded by the batch admission budgets. */
  pack(): PackedGeographicIndex {
    const records = new Float32Array(this.primitives.length * 16);
    this.primitives.forEach((p, i) => records.set([
      ...p.a, ...p.b, ...p.c, p.kind, p.chart === 'longitude-latitude' ? 0 : p.chart === 'north-polar' ? 1 : -1,
      ...p.color, p.opacity, p.feature, primitiveAnchor(p), 0, 0,
    ], i * 16));
    const grids = pageCells(this.cells, this.primitives);
    const cells = new Float32Array(grids.length * this.cells.length * 4);
    const details = this.detailGrids();
    const extraReferences = details.reduce((n, d) => n + d.grids.reduce((m, grid) => m + grid.reduce((sum, ids) => sum + ids.length, 0), 0), 0);
    const references = new Float32Array((this.references + extraReferences) * 4);
    let offset = 0;
    grids.forEach((grid, page) => grid.forEach((ids, cell) => {
      cells.set([offset, ids.length, 0, 0], (page * this.cells.length + cell) * 4);
      for (const id of ids) {
        const p = this.primitives[id];
        references.set([id, p.kind, p.chart === 'longitude-latitude' ? 0 : p.chart === 'north-polar' ? 1 : -1, primitiveAnchor(p)], 4 * offset++);
      }
    }));
    let packedDetail;
    if (details.length) {
      const cells = new Float32Array(details.reduce((n, d) => n + d.grids.length * d.level.size * (d.level.height ?? d.level.size), 0) * 4);
      for (const { grids, level } of details) grids.forEach((grid, page) => grid.forEach((ids, cell) => {
        cells.set([offset, ids.length, 0, 0], (level.offset + page * level.size * (level.height ?? level.size) + cell) * 4);
        for (const id of ids) {
          const p = this.primitives[id];
          references.set([id, p.kind, p.chart === 'longitude-latitude' ? 0 : p.chart === 'north-polar' ? 1 : -1, primitiveAnchor(p)], 4 * offset++);
        }
      }));
      packedDetail = { cells, levels: details.map(d => d.level) };
    }
    return { records, cells, references, pages: grids.length, detail: packedDetail };
  }

  /** Jacobian columns are the change in degrees for a one-CSS-pixel step. */
  pick(position: BodyFixedPosition, dx: GeographicXY, dy: GeographicXY, radiusPx = 4): GeographicFeatureRef | null {
    let best: { feature: number; rank: number; distance: number } | undefined;
    for (const id of this.cells[geographicCell(position.lonDeg, position.latDeg)]) {
      const p = this.primitives[id];
      const q = projectGeographic(position, p.chart, primitiveAnchor(p));
      const x = projectGeographic({ lonDeg: position.lonDeg + dx[0], latDeg: position.latDeg + dx[1] }, p.chart, q[0]);
      const y = projectGeographic({ lonDeg: position.lonDeg + dy[0], latDeg: position.latDeg + dy[1] }, p.chart, q[0]);
      const jx = [x[0] - q[0], x[1] - q[1]], jy = [y[0] - q[0], y[1] - q[1]];
      const determinant = jx[0] * jy[1] - jy[0] * jx[1];
      if (Math.abs(determinant) < 1e-18) continue;
      const pixel = (v: GeographicXY): GeographicXY => {
        const a = v[0] - q[0], b = v[1] - q[1];
        return [(jy[1] * a - jy[0] * b) / determinant, (-jx[1] * a + jx[0] * b) / determinant];
      };
      const a = pixel(p.a), b = pixel(p.b), c = pixel(p.c);
      let distance = 0;
      if (p.kind === 2) {
        const cross = (v: GeographicXY, w: GeographicXY) => v[0] * w[1] - v[1] * w[0];
        const signs = [cross(a, b), cross(b, c), cross(c, a)];
        if (!(signs.every(x => x >= 0) || signs.every(x => x <= 0))) continue;
      } else if (p.kind === 0) distance = Math.hypot(...a);
      else {
        const v = [b[0] - a[0], b[1] - a[1]];
        const t = Math.max(0, Math.min(1, -(a[0] * v[0] + a[1] * v[1]) / (v[0] ** 2 + v[1] ** 2 || 1)));
        distance = Math.hypot(a[0] + t * v[0], a[1] + t * v[1]);
      }
      if (p.kind !== 2 && distance > radiusPx) continue;
      const rank = 2 - p.kind; // dots, then strokes, then fills; source order breaks ties
      if (!best || rank > best.rank || (rank === best.rank && distance < best.distance)) best = { feature: p.feature, rank, distance };
    }
    return best ? this.features[best.feature - 1] : null;
  }
}
