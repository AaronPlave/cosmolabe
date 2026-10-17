import { Color, ShapeUtils, Vector2 } from 'three';
import { geographicProjection, projectGeographic, projectGeographicRings, wrapLon,
  type BodyFixedPosition, type GeographicFeature, type GeographicLayer, type GeographicProjection, type GeographicXY } from '@cosmolabe/core';

export interface GeographicFeatureRef { layerId: string; featureId: string; bodyName: string; }
export interface GeographicRenderDiagnostic { layerId: string; featureId?: string; code: string; message: string; }
export const VECTOR_GRID = [64, 32] as const;
export const VECTOR_CELL_LIMIT = 256;
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
const primitiveAnchor = (p: VectorPrimitive) => (Math.min(p.a[0], p.b[0], p.c[0]) + Math.max(p.a[0], p.b[0], p.c[0])) / 2;

export function geographicCell(lon: number, lat: number): number {
  const x = Math.floor((wrapLon(lon) + 180) / 360 * VECTOR_GRID[0]);
  const y = Math.min(VECTOR_GRID[1] - 1, Math.max(0, Math.floor((lat + 90) / 180 * VECTOR_GRID[1])));
  return y * VECTOR_GRID[0] + x;
}

function primitiveCells(p: VectorPrimitive): number[] {
  const vertices = p.kind === 0 ? [p.a] : p.kind === 1 ? [p.a, p.b] : [p.a, p.b, p.c];
  let west = -180, east = 180, south = -90, north = 90;
  if (p.chart === 'longitude-latitude') {
    west = Math.min(...vertices.map(p => p[0])) - VECTOR_PADDING_DEG;
    east = Math.max(...vertices.map(p => p[0])) + VECTOR_PADDING_DEG;
    south = Math.min(...vertices.map(p => p[1])) - VECTOR_PADDING_DEG;
    north = Math.max(...vertices.map(p => p[1])) + VECTOR_PADDING_DEG;
  } else {
    // Conservative cap bound also covers an interior pole. Projection has no seam.
    const radius = Math.max(...vertices.map(p => Math.hypot(...p))) + VECTOR_PADDING_DEG;
    if (p.chart === 'north-polar') south = 90 - radius;
    else north = -90 + radius;
  }
  const cells = new Set<number>();
  const y0 = Math.max(0, Math.floor((south + 90) / 180 * VECTOR_GRID[1]));
  const y1 = Math.min(VECTOR_GRID[1] - 1, Math.floor((north + 90) / 180 * VECTOR_GRID[1]));
  const x0 = Math.floor((west + 180) / 360 * VECTOR_GRID[0]);
  const x1 = Math.min(x0 + VECTOR_GRID[0] - 1, Math.floor((east + 180) / 360 * VECTOR_GRID[0]));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    cells.add(y * VECTOR_GRID[0] + ((x % VECTOR_GRID[0]) + VECTOR_GRID[0]) % VECTOR_GRID[0]);
  }
  return [...cells];
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
      const occupancy = new Map<number, number>();
      const bins: number[][] = [];
      let references = 0;
      for (const primitive of staged) {
        const bin = primitiveCells(primitive);
        for (const cell of bin) {
          const count = (occupancy.get(cell) ?? 0) + 1;
          occupancy.set(cell, count);
          if (this.cells[cell].length + count > VECTOR_CELL_LIMIT) throw new Error('spatial cell budget exceeded; split or simplify this dataset');
          if (this.references + ++references > VECTOR_REFERENCE_LIMIT) throw new Error('spatial reference budget exceeded');
        }
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

  /** Four RGBA texels per primitive; integer IDs remain exact in float32. */
  pack(): { records: Float32Array; cells: Float32Array; references: Float32Array } {
    const records = new Float32Array(this.primitives.length * 16);
    this.primitives.forEach((p, i) => records.set([
      ...p.a, ...p.b, ...p.c, p.kind, p.chart === 'longitude-latitude' ? 0 : p.chart === 'north-polar' ? 1 : -1,
      ...p.color, p.opacity, p.feature, primitiveAnchor(p), 0, 0,
    ], i * 16));
    const cells = new Float32Array(this.cells.length * 4);
    const references = new Float32Array(this.references * 4);
    let offset = 0;
    this.cells.forEach((ids, cell) => {
      cells.set([offset, ids.length, 0, 0], cell * 4);
      for (const id of ids) {
        const p = this.primitives[id];
        references.set([id, p.kind, p.chart === 'longitude-latitude' ? 0 : p.chart === 'north-polar' ? 1 : -1, primitiveAnchor(p)], 4 * offset++);
      }
    });
    return { records, cells, references };
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
