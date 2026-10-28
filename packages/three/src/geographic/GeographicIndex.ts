import { Color, ShapeUtils, Vector2 } from 'three';
import { geographicProjection, projectGeographic, projectGeographicRings, resolveGeographicStyle, wrapLon,
  type BodyFixedPosition, type GeographicFeature, type GeographicLayer, type GeographicProjection, type GeographicXY,
  type ResolvedGeographicStyle } from '@cosmolabe/core';

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
  /** Which part of the feature's style applies; a polygon's ring segments are its outline. */
  role: 'point' | 'line' | 'fill' | 'outline';
  a: GeographicXY; b: GeographicXY; c: GeographicXY;
  chart: GeographicProjection;
  feature: number;
  color: readonly [number, number, number]; opacity: number;
  /** Mark radius or stroke half-width in CSS pixels; 0 for fills. */
  size: number;
  /** VECTOR_FLAG bits plus the point shape times VECTOR_SHAPE_STEP. */
  flags: number;
};
/** Small integers, exact in float32 textures. */
export const VECTOR_FLAG = { dashed: 1, halo: 2, hatch: 4 } as const;
export const VECTOR_SHAPE_STEP = 8;
/** Extra CSS pixels a halo or outline adds around a mark or stroke. */
export const VECTOR_HALO_PX = 1.5;
/** How a feature's style is decided; the default reads only the catalog display defaults. */
export type GeographicStyleResolver = (layer: GeographicLayer, feature: GeographicFeature) => ResolvedGeographicStyle;
const defaultStyle: GeographicStyleResolver = (layer, feature) => resolveGeographicStyle(layer, null, feature);

/** A resolved part's colour, opacity, size and flags, as a primitive stores them. */
function primitiveStyle(style: ResolvedGeographicStyle, role: VectorPrimitive['role']): Pick<VectorPrimitive, 'color' | 'opacity' | 'size' | 'flags'> {
  const rgb = (hex: string) => new Color(hex).toArray() as [number, number, number];
  switch (role) {
    case 'point': return { color: rgb(style.point.color), opacity: style.point.opacity, size: style.point.sizePx / 2,
      flags: (style.point.halo ? VECTOR_FLAG.halo : 0) + VECTOR_SHAPE_STEP * ['circle', 'square', 'diamond'].indexOf(style.point.shape) };
    case 'line': return { color: rgb(style.line.color), opacity: style.line.opacity, size: style.line.widthPx / 2,
      flags: (style.line.dashed ? VECTOR_FLAG.dashed : 0) + (style.line.outline ? VECTOR_FLAG.halo : 0) };
    case 'fill': return { color: rgb(style.fill.color), opacity: style.fill.opacity, size: 0, flags: style.fill.hatch ? VECTOR_FLAG.hatch : 0 };
    case 'outline': return { color: rgb(style.outline.color), opacity: style.outline.opacity, size: style.outline.widthPx / 2, flags: 0 };
  }
}
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

/** How many pages `pageCells` would make, without building them: a grid that
 * cannot fit its page budget is skipped before half a million cells are sliced. */
function pageCount(cells: number[][], primitives: readonly VectorPrimitive[]): number {
  if (cells.every(ids => ids.length <= VECTOR_CELL_LIMIT)) return 1;
  let pages = 0;
  for (const kind of [2, 1, 0]) {
    let most = 0;
    for (const ids of cells) {
      let n = 0;
      for (const id of ids) if ((id < 0 ? 2 : primitives[id].kind) === kind) n++;
      most = Math.max(most, n);
    }
    pages += Math.ceil(most / VECTOR_CELL_LIMIT);
  }
  return pages;
}

/** Same rank/source paging at every spatial scale. A covered-cell reference (see `coveredCells`) pages with fills. */
function pageCells(cells: number[][], primitives: readonly VectorPrimitive[]): number[][][] {
  if (cells.every(ids => ids.length <= VECTOR_CELL_LIMIT)) return [cells];
  const grids: number[][][] = [];
  // Global grids are mostly empty cells: they share one empty list.
  const none: number[] = [];
  for (const kind of [2, 1, 0]) {
    const bins = cells.map(ids => ids.length ? ids.filter(id => (id < 0 ? 2 : primitives[id].kind) === kind) : none);
    const pages = Math.ceil(bins.reduce((n, ids) => Math.max(n, ids.length), 0) / VECTOR_CELL_LIMIT);
    for (let page = pages - 1; page >= 0; page--) {
      grids.push(bins.map(ids => ids.length > page * VECTOR_CELL_LIMIT ? ids.slice(page * VECTOR_CELL_LIMIT, (page + 1) * VECTOR_CELL_LIMIT) : none));
    }
  }
  return grids;
}

/**
 * For a global grid of `size` × `height` cells: the cells each longitude/
 * latitude fill triangle must stay in, and the cells wholly inside a polygon.
 * A polygon's outline is its boundary, so a cell no outline segment of it
 * touches is entirely inside or entirely outside it, decided by the cell's
 * centre. Its triangles stay only in cells the outline touches (where they
 * overlap the cell); `full` pairs each inside cell with one triangle of the
 * polygon, which carries its style. Exported for tests.
 */
export function coveredCells(primitives: readonly VectorPrimitive[], size: number, height: number): Map<number, number[]> & { full: [number, number][] } {
  const sx = 360 / size, sy = 180 / height, eps = 1e-9;
  const column = (lon: number) => Math.floor((lon + 180) / sx), row = (lat: number) => Math.min(height - 1, Math.max(0, Math.floor((lat + 90) / sy)));
  const key = (x: number, y: number) => y * size + ((x % size) + size) % size;
  // Outline cells per feature: a segment touches a cell when it meets the cell's box.
  const edges = new Map<number, Set<number>>();
  for (const p of primitives) {
    if (p.role !== 'outline' || p.chart !== 'longitude-latitude') continue;
    let set = edges.get(p.feature);
    if (!set) edges.set(p.feature, set = new Set());
    for (let y = row(Math.min(p.a[1], p.b[1]) - eps); y <= row(Math.max(p.a[1], p.b[1]) + eps); y++)
      for (let x = column(Math.min(p.a[0], p.b[0]) - eps); x <= column(Math.max(p.a[0], p.b[0]) + eps); x++)
        if (segmentMeetsBox(p.a, p.b, -180 + x * sx - eps, -90 + y * sy - eps, -180 + (x + 1) * sx + eps, -90 + (y + 1) * sy + eps)) set.add(key(x, y));
  }
  const result = new Map<number, number[]>() as Map<number, number[]> & { full: [number, number][] };
  result.full = [];
  const inside = new Map<number, Set<number>>();
  primitives.forEach((p, id) => {
    if (p.kind !== 2 || p.chart !== 'longitude-latitude') return;
    const outline = edges.get(p.feature);
    if (!outline) return;
    let full = inside.get(p.feature);
    if (!full) inside.set(p.feature, full = new Set());
    const cells: number[] = [];
    const xs = [p.a[0], p.b[0], p.c[0]], ys = [p.a[1], p.b[1], p.c[1]];
    for (let y = row(Math.min(...ys)); y <= row(Math.max(...ys)); y++) for (let x = column(Math.min(...xs)); x <= column(Math.max(...xs)); x++) {
      const k = key(x, y), west = -180 + x * sx, south = -90 + y * sy;
      if (outline.has(k)) { if (triangleMeetsBox(p.a, p.b, p.c, west - eps, south - eps, west + sx + eps, south + sy + eps)) cells.push(k); }
      else if (!full.has(k) && triangleContains(p.a, p.b, p.c, west + sx / 2, south + sy / 2)) { full.add(k); result.full.push([k, id]); }
    }
    result.set(id, cells);
  });
  return result;
}
/** Cells of a global grid whose box, grown by `padding` degrees, a longitude/latitude segment meets. */
function segmentCells(a: GeographicXY, b: GeographicXY, size: number, height: number, padding: number): number[] {
  const sx = 360 / size, sy = 180 / height, cells: number[] = [];
  const y0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - padding + 90) / sy)), y1 = Math.min(height - 1, Math.floor((Math.max(a[1], b[1]) + padding + 90) / sy));
  const x0 = Math.floor((Math.min(a[0], b[0]) - padding + 180) / sx), x1 = Math.min(x0 + size - 1, Math.floor((Math.max(a[0], b[0]) + padding + 180) / sx));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const west = -180 + x * sx, south = -90 + y * sy;
    if (segmentMeetsBox(a, b, west - padding, south - padding, west + sx + padding, south + sy + padding)) cells.push(y * size + ((x % size) + size) % size);
  }
  return cells;
}
const cross2 = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
function triangleContains(a: GeographicXY, b: GeographicXY, c: GeographicXY, x: number, y: number): boolean {
  const s = [cross2(b[0] - a[0], b[1] - a[1], x - a[0], y - a[1]), cross2(c[0] - b[0], c[1] - b[1], x - b[0], y - b[1]), cross2(a[0] - c[0], a[1] - c[1], x - c[0], y - c[1])];
  return s.every(v => v >= 0) || s.every(v => v <= 0);
}
/** Separating axes: the box's two, then each edge's normal. */
function convexMeetsBox(points: readonly GeographicXY[], west: number, south: number, east: number, north: number): boolean {
  if (Math.max(...points.map(p => p[0])) < west || Math.min(...points.map(p => p[0])) > east) return false;
  if (Math.max(...points.map(p => p[1])) < south || Math.min(...points.map(p => p[1])) > north) return false;
  const corners: GeographicXY[] = [[west, south], [east, south], [east, north], [west, north]];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const nx = a[1] - b[1], ny = b[0] - a[0];
    const side = (p: GeographicXY) => nx * (p[0] - a[0]) + ny * (p[1] - a[1]);
    const box = corners.map(side), own = points.map(side);
    if (Math.min(...box) > Math.max(...own) || Math.max(...box) < Math.min(...own)) return false;
  }
  return true;
}
const segmentMeetsBox = (a: GeographicXY, b: GeographicXY, w: number, s: number, e: number, n: number) => convexMeetsBox([a, b], w, s, e, n);
const triangleMeetsBox = (a: GeographicXY, b: GeographicXY, c: GeographicXY, w: number, s: number, e: number, n: number) => convexMeetsBox([a, b, c], w, s, e, n);

/** Immutable, bounded spatial index shared by CPU picking and the GPU. Features
 * commit atomically: a budget failure never leaves a polygon without its holes. */
export class GeographicIndex {
  readonly primitives: VectorPrimitive[] = [];
  readonly features: GeographicFeatureRef[] = [];
  readonly cells: number[][] = Array.from({ length: VECTOR_GRID[0] * VECTOR_GRID[1] }, () => []);
  readonly diagnostics: GeographicRenderDiagnostic[] = [];
  private references = 0;
  /** Source of each admitted feature, by `feature - 1`, for restyling without re-triangulating. */
  private readonly sources: { layer: GeographicLayer; feature: GeographicFeature }[] = [];

  constructor(layers: readonly GeographicLayer[], private readonly fineSinglePage = false, private styleOf: GeographicStyleResolver = defaultStyle) {
    for (const layer of layers) {
      if (layer.definition.display?.visible === false || layer.definition.display?.opacity === 0) continue;
      for (const feature of layer.features) this.addFeature(layer, feature);
    }
  }

  private addFeature(layer: GeographicLayer, feature: GeographicFeature): void {
    const staged: VectorPrimitive[] = [];
    const style = this.styleOf(layer, feature);
    const styles = new Map<VectorPrimitive['role'], ReturnType<typeof primitiveStyle>>();
    const featureIndex = this.features.length + 1;
    const emit = (kind: VectorPrimitive['kind'], role: VectorPrimitive['role'], a: GeographicXY, b = a, c = a, chart: GeographicProjection = 'longitude-latitude') => {
      if (staged.length + this.primitives.length >= VECTOR_PRIMITIVE_LIMIT) throw new Error('primitive budget exceeded');
      let part = styles.get(role);
      if (!part) { part = primitiveStyle(style, role); styles.set(role, part); }
      staged.push({ kind, role, a, b, c, chart, feature: featureIndex, ...part });
    };
    const point = (p: BodyFixedPosition) => {
      const chart: GeographicProjection = Math.abs(p.latDeg) > 80 ? p.latDeg > 0 ? 'north-polar' : 'south-polar' : 'longitude-latitude';
      const xy = projectGeographic(p, chart);
      emit(0, 'point', xy, xy, xy, chart);
    };
    const line = (points: BodyFixedPosition[], chart: GeographicProjection = 'longitude-latitude', role: 'line' | 'outline' = 'line') => {
      const xy = projectGeographicRings([points], chart)[0];
      for (let i = 1; i < xy.length; i++) emit(1, role, xy[i - 1], xy[i], xy[i], chart);
    };
    const polygon = (rings: BodyFixedPosition[][]) => {
      const chart = geographicProjection(rings[0]);
      const xy = projectGeographicRings(rings, chart).map(r => r.slice(0, -1));
      const vertices = xy.flat();
      // ShapeUtils delegates to earcut and respects independent hole rings.
      const triangles = ShapeUtils.triangulateShape(xy[0].map(p => new Vector2(...p)), xy.slice(1).map(r => r.map(p => new Vector2(...p))));
      if (!triangles.length) throw new Error('polygon could not be triangulated');
      for (const [a, b, c] of triangles) emit(2, 'fill', vertices[a], vertices[b], vertices[c], chart);
      for (const ring of rings) line(ring, chart, 'outline');
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
      this.sources.push({ layer, feature });
    } catch (error) {
      this.diagnostics.push({ layerId: layer.id, featureId: feature.id, code: 'vector-budget', message: String(error) });
    }
  }

  /**
   * Apply new styles to the admitted primitives in place. Geometry, cells and
   * pages do not depend on style, so only the record texture needs repacking:
   * no re-triangulation, no new GPU resources, no shader recompile.
   */
  restyle(styleOf: GeographicStyleResolver): void {
    this.styleOf = styleOf;
    let feature = 0;
    let parts = new Map<VectorPrimitive['role'], ReturnType<typeof primitiveStyle>>();
    let style: ResolvedGeographicStyle | null = null;
    for (const p of this.primitives) {
      if (p.feature !== feature) {
        feature = p.feature; parts = new Map();
        const source = this.sources[feature - 1];
        style = source ? styleOf(source.layer, source.feature) : null;
      }
      if (!style) continue;
      let part = parts.get(p.role);
      if (!part) { part = primitiveStyle(style, p.role); parts.set(p.role, part); }
      Object.assign(p, part);
    }
  }

  /** The largest CSS-pixel reach of any mark or stroke, halo included, for candidate rejection and grid choice. */
  get reachPx(): number {
    let reach = 4.5;
    for (const p of this.primitives) if (p.kind !== 2) reach = Math.max(reach, p.size + 1 + ((p.flags & VECTOR_FLAG.halo) ? VECTOR_HALO_PX : 0));
    return reach;
  }

  /** Four RGBA texels per primitive: endpoints; third vertex, kind, chart; colour, opacity; feature, anchor, size, flags. */
  packRecords(records: Float32Array<ArrayBufferLike> = new Float32Array(this.primitives.length * 16)): Float32Array<ArrayBufferLike> {
    this.primitives.forEach((p, i) => records.set([
      ...p.a, ...p.b, ...p.c, p.kind, p.chart === 'longitude-latitude' ? 0 : p.chart === 'north-polar' ? 1 : -1,
      ...p.color, p.opacity, p.feature, primitiveAnchor(p), p.size, p.flags,
    ], i * 16));
    return records;
  }

  /** Bounded strokes-only view of this immutable index for at most two active
   * highlights. Reuse the admitted primitives and identities, not GeoJSON parsing
   * or triangulation. Sparse lookup avoids rescanning every country's candidates. */
  highlight(feature: number): GeographicIndex {
    const result = new GeographicIndex([], true);
    result.features.push(...this.features);
    const ids = new Map<number, number>();
    this.primitives.forEach((p, id) => {
      if (p.feature === feature && p.kind === 1) {
        ids.set(id, result.primitives.length); result.primitives.push(p);
      }
    });
    this.cells.forEach((cell, i) => {
      for (const id of cell) {
        const mapped = ids.get(id);
        if (mapped !== undefined) { result.cells[i].push(mapped); result.references++; }
      }
    });
    return result;
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

  /** Padded global levels for distributed data, including polar primitives,
   * finest first. Selection uses the same derivative-footprint rule as the
   * local levels. The fine level is for close views of broad areas (countries
   * seen from a few hundred km): a fragment there scanned every fill triangle
   * and stroke within 1.4° of the coarse level's cell. At both levels a
   * polygon's fill triangles stay only in cells its outline crosses, and a
   * cell wholly inside it holds one covered reference instead (`coveredCells`);
   * segments go only in the cells they pass near. The fine level is left out
   * when it would exceed the reference budget or the page count. */
  private globalGrid(): { grids: number[][][]; level: DetailLevel }[] {
    const result: { grids: number[][][]; level: DetailLevel }[] = [];
    let references = this.references, offset = 0;
    for (const [size, fine] of [[1024, true], [256, false]] as const) {
      const step: readonly [number, number] = [360 / size, 180 / (size / 2)];
      // The fine level spans only the latitudes clear of polar-chart primitives
      // (with a cell of padding): a polar triangle's cells there would be a
      // wedge of every longitude. Elsewhere the shader falls back to the next level.
      let south = -90, north = 90;
      if (fine) for (const p of this.primitives) {
        if (p.chart === 'longitude-latitude') continue;
        const reach = Math.max(...[p.a, p.b, p.c].map(v => Math.hypot(...v)));
        if (p.chart === 'south-polar') south = Math.max(south, -90 + reach + step[1]); else north = Math.min(north, 90 - reach - step[1]);
      }
      const first = Math.ceil((south + 90) / step[1]), rows = Math.floor((north + 90) / step[1]) - first;
      if (rows <= 0) continue;
      const bins: number[][] = Array.from({ length: size * rows }, () => []);
      let added = 0;
      const add = (cell: number, id: number) => {
        const row = Math.floor(cell / size) - first;
        if (row < 0 || row >= rows) return;
        bins[row * size + cell % size].push(id); added++;
      };
      const covered = coveredCells(this.primitives, size, size / 2);
      for (const [id, p] of this.primitives.entries()) {
        if (fine && p.chart !== 'longitude-latitude') continue;
        // One full cell covers the mark footprint admitted by the shader. A segment
        // goes only in cells it passes within that of, not its whole box.
        const cells = covered.get(id) ?? (p.kind === 1 && p.chart === 'longitude-latitude' ? segmentCells(p.a, p.b, size, size / 2, step[0]) : primitiveCells(p, [size, size / 2], step[0]));
        for (const cell of cells) add(cell, id);
      }
      for (const [cell, id] of covered.full) add(cell, -id - 1);
      // In source order, as everywhere else: the shader composites fills in it.
      if (covered.full.length) for (const ids of bins) ids.sort((x, y) => (x < 0 ? -x - 1 : x) - (y < 0 ? -y - 1 : y));
      if (references + added > VECTOR_REFERENCE_LIMIT) { if (fine) continue; return result; }
      if (pageCount(bins, this.primitives) > this.renderPages) { if (fine) continue; return result; }
      const grids = pageCells(bins, this.primitives);
      result.push({ grids, level: { size, height: rows, offset, pages: grids.length, bounds: [-180, -90 + first * step[1], 180, -90 + (first + rows) * step[1]], step } });
      references += added; offset += grids.length * size * rows;
    }
    return result;
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
    if (coarsePages <= 1) return this.fineSinglePage ? this.globalGrid() : result;
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
      if (pageCount(bins, this.primitives) > coarsePages) continue;
      const grids = pageCells(bins, this.primitives);
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
    const records = this.packRecords();
    const grids = pageCells(this.cells, this.primitives);
    const cells = new Float32Array(grids.length * this.cells.length * 4);
    const details = this.detailGrids();
    const extraReferences = details.reduce((n, d) => n + d.grids.reduce((m, grid) => m + grid.reduce((sum, ids) => sum + ids.length, 0), 0), 0);
    const references = new Float32Array((this.references + extraReferences) * 4);
    let offset = 0;
    grids.forEach((grid, page) => grid.forEach((ids, cell) => {
      const at = (page * this.cells.length + cell) * 4;
      cells[at] = offset; cells[at + 1] = ids.length;
      for (const id of ids) {
        const p = this.primitives[id];
        references.set([id, p.kind, p.chart === 'longitude-latitude' ? 0 : p.chart === 'north-polar' ? 1 : -1, primitiveAnchor(p)], 4 * offset++);
      }
    }));
    let packedDetail;
    if (details.length) {
      const cells = new Float32Array(details.reduce((n, d) => n + d.grids.length * d.level.size * (d.level.height ?? d.level.size), 0) * 4);
      for (const { grids, level } of details) grids.forEach((grid, page) => grid.forEach((ids, cell) => {
        const at = (level.offset + page * level.size * (level.height ?? level.size) + cell) * 4;
        cells[at] = offset; cells[at + 1] = ids.length;
        for (const id of ids) {
          // Kind 3: the cell lies wholly inside this fill triangle's polygon.
          if (id < 0) { references.set([-id - 1, 3, 0, 0], 4 * offset++); continue; }
          const p = this.primitives[id];
          references.set([id, p.kind, p.chart === 'longitude-latitude' ? 0 : p.chart === 'north-polar' ? 1 : -1, primitiveAnchor(p)], 4 * offset++);
        }
      }));
      packedDetail = { cells, levels: details.map(d => d.level) };
    }
    return { records, cells, references, pages: grids.length, detail: packedDetail };
  }

  /** Jacobian columns are the change in degrees for a one-CSS-pixel step. */
  pick(position: BodyFixedPosition, dx: GeographicXY, dy: GeographicXY, minRadiusPx = 4): GeographicFeatureRef | null {
    let best: { feature: number; rank: number; distance: number } | undefined;
    for (const id of this.cells[geographicCell(position.lonDeg, position.latDeg)]) {
      const p = this.primitives[id];
      // Invisible parts are not pick targets; a larger mark or wider stroke is easier to hit.
      if (p.opacity <= 0) continue;
      const radiusPx = Math.max(minRadiusPx, p.size + 0.5);
      const q = projectGeographic(position, p.chart, primitiveAnchor(p));
      const x = projectGeographic({ lonDeg: position.lonDeg + dx[0], latDeg: position.latDeg + dx[1] }, p.chart, q[0]);
      const y = projectGeographic({ lonDeg: position.lonDeg + dy[0], latDeg: position.latDeg + dy[1] }, p.chart, q[0]);
      const jx = [x[0] - q[0], x[1] - q[1]], jy = [y[0] - q[0], y[1] - q[1]];
      if (p.kind !== 2 && [0, 1].some(i => Math.max(4.5, radiusPx) * (Math.abs(jx[i]) + Math.abs(jy[i])) > VECTOR_PADDING_DEG)) continue;
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
