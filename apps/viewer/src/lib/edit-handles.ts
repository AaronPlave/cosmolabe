/**
 * Edit handles for the selected shape, and the budget that keeps them bounded
 * (#200). An imported or copied feature can have tens of thousands of
 * vertices; a handle per vertex and per edge would mean as many interactive
 * SVG elements, projected every frame, and a screen too cluttered to use.
 *
 * - Handles are built once per edit, not per frame.
 * - Above EDIT_VERTEX_LIMIT vertices only the move handle shows until fine
 *   detail is asked for, so nothing per vertex is projected.
 * - Otherwise vertices are thinned on screen to one per HANDLE_SPACING_PX
 *   cell, so zooming in reveals more; midpoints show only on edges long enough
 *   to grab; and at most EDIT_HANDLE_LIMIT handles show, nearest the centre of
 *   the view first. The chosen vertex always shows.
 *
 * Holes, rings and parts each keep their own handles; a midpoint across the
 * antimeridian sits on the short way round, as the renderer draws the edge.
 */
import {
  geographicFeatureAnchor, normalizeGeographicPosition, geodesicDirect, geographicDatum, geographicPositionInConvention,
  type GeographicEditFeature, type GeographicEditLayer, type GeographicFeature, type GeographicGeometry, type GeoPosition, type BodyFixedPosition,
} from '@cosmolabe/core';

export interface Screen { x: number; y: number; visible: boolean }
export interface Handle {
  key: string;
  kind: 'vertex' | 'mid' | 'move' | 'center' | 'radius';
  part: number[];
  index: number;
  position: GeoPosition;
  /** A midpoint's edge, as the keys of its two vertices. */
  ends?: [string, string];
}

/** Above this many vertices, points need fine detail asked for. */
export const EDIT_VERTEX_LIMIT = 2_000;
/** At most this many handles at once. */
export const EDIT_HANDLE_LIMIT = 400;
/** Vertices closer than this on screen share one handle. */
export const HANDLE_SPACING_PX = 12;
/** Midpoints show on edges at least this long on screen. */
export const MID_EDGE_MIN_PX = 40;

/** The rings, lines or point lists of a geometry, with their part paths. */
function vertexLists(f: GeographicEditFeature): { part: number[]; list: GeoPosition[]; ring: boolean }[] {
  const g = f.geometry;
  switch (g.type) {
    case 'Point': return [{ part: [], list: [g.coordinates], ring: false }];
    case 'MultiPoint': case 'LineString': return [{ part: [], list: g.coordinates, ring: false }];
    case 'MultiLineString': return g.coordinates.map((list, i) => ({ part: [i], list, ring: false }));
    case 'Polygon': return g.coordinates.map((list, i) => ({ part: [i], list, ring: true }));
    case 'MultiPolygon': return g.coordinates.flatMap((poly, p) => poly.map((list, r) => ({ part: [p, r], list, ring: true })));
  }
}

/** Editable vertices (a ring's closing repeat not counted). */
export function vertexCount(f: GeographicEditFeature): number {
  if (f.shape) return 0;
  let n = 0;
  for (const { list, ring } of vertexLists(f)) n += ring ? Math.max(0, list.length - 1) : list.length;
  return n;
}

/** Whether a feature is too large for per-vertex handles without fine detail. */
export const needsFineDetail = (f: GeographicEditFeature): boolean => vertexCount(f) > EDIT_VERTEX_LIMIT;

/** Every handle of a feature; `vertices: false` gives only the move handle (and a shape's own handles). */
export function featureHandles(l: GeographicEditLayer, f: GeographicEditFeature, vertices = true): Handle[] {
  const list: Handle[] = [];
  if (f.shape) {
    const s = f.shape;
    const center = normalizeGeographicPosition(s.center, l.coordinates);
    const end = geodesicDirect(center, s.bearingDeg, s.semiMajorKm, geographicDatum(l.coordinates));
    list.push({ key: 'center', kind: 'center', part: [], index: 0, position: s.center });
    list.push({ key: 'radius', kind: 'radius', part: [], index: 0, position: geographicPositionInConvention(end, l.coordinates) });
    return list;
  }
  const g = f.geometry;
  if (g.type === 'Point') return [{ key: 'v', kind: 'vertex', part: [], index: 0, position: g.coordinates }];
  if (vertices) {
    for (const { part, list: run, ring } of vertexLists(f)) {
      const open = ring ? run.slice(0, -1) : run;
      const key = (i: number) => `v${part.join('.')}:${i}`;
      open.forEach((position, index) => list.push({ key: key(index), kind: 'vertex', part, index, position }));
      if (g.type === 'MultiPoint') continue;
      const edges = ring ? open.length : open.length - 1;
      for (let i = 0; i < edges; i++) {
        const a = open[i], b = open[(i + 1) % open.length];
        let dLon = b[0] - a[0];
        if (dLon > 180) dLon -= 360; else if (dLon < -180) dLon += 360;
        list.push({ key: `m${part.join('.')}:${i}`, kind: 'mid', part, index: i + 1, position: [a[0] + dLon / 2, (a[1] + b[1]) / 2], ends: [key(i), key((i + 1) % open.length)] });
      }
    }
  }
  list.push({ key: 'move', kind: 'move', part: [], index: 0, position: moveAnchor(l, f) });
  return list;
}

/**
 * Where the move handle sits: the feature's anchor, from its coordinates
 * alone. Converting the whole layer would validate its topology, which is
 * quadratic in the vertices and refuses very large features outright.
 */
function moveAnchor(l: GeographicEditLayer, f: GeographicEditFeature): GeoPosition {
  const n = (p: GeoPosition) => normalizeGeographicPosition(p, l.coordinates);
  const g = f.geometry;
  let geometry: GeographicGeometry<BodyFixedPosition>;
  switch (g.type) {
    case 'Point': geometry = { type: 'Point', coordinates: n(g.coordinates) }; break;
    case 'MultiPoint': geometry = { type: 'MultiPoint', coordinates: g.coordinates.map(n) }; break;
    case 'LineString': geometry = { type: 'LineString', coordinates: g.coordinates.map(n) }; break;
    case 'MultiLineString': geometry = { type: 'MultiLineString', coordinates: g.coordinates.map((r) => r.map(n)) }; break;
    case 'Polygon': geometry = { type: 'Polygon', coordinates: g.coordinates.map((r) => r.map(n)) }; break;
    case 'MultiPolygon': geometry = { type: 'MultiPolygon', coordinates: g.coordinates.map((p) => p.map((r) => r.map(n))) }; break;
  }
  return geographicPositionInConvention(geographicFeatureAnchor({ id: f.id, geometry, properties: f.properties } as GeographicFeature), l.coordinates);
}

export interface HandleBudget {
  handles: (Handle & Screen)[];
  /** Vertices on screen that have no handle (thinned or over the limit). */
  hidden: number;
}

/**
 * The handles to show. `project` places a batch of handles on screen: roughly
 * (`precise` false: on the reference surface, no terrain sampled) to choose
 * vertices, then precisely (on the drawn surface) only for the handles shown.
 * Midpoints of thinned or short edges are never projected.
 */
export function budgetHandles(all: Handle[], project: (h: Handle[], precise: boolean) => Screen[], view: { width: number; height: number },
  selected?: { part: number[]; index: number } | null): HandleBudget {
  const isSelected = (h: Handle) => !!selected && h.kind === 'vertex' && h.index === selected.index && h.part.join() === selected.part.join();
  const fixed = all.filter((h) => h.kind !== 'vertex' && h.kind !== 'mid');
  const vertices = all.filter((h) => h.kind === 'vertex');
  const mids = all.filter((h) => h.kind === 'mid');
  const vScreen = project(vertices, false);
  const at = new Map<string, Screen>();
  vertices.forEach((h, i) => at.set(h.key, vScreen[i]));

  // One vertex per screen cell; the chosen vertex claims its cell first.
  const cells = new Set<string>();
  const kept: (Handle & Screen)[] = [];
  let onScreen = 0;
  const order = vertices.map((_, i) => i);
  const chosen = order.findIndex((i) => isSelected(vertices[i]));
  if (chosen > 0) order.unshift(order.splice(chosen, 1)[0]);
  for (const i of order) {
    const s = vScreen[i];
    if (!s?.visible) continue;
    onScreen++;
    const cell = `${Math.floor(s.x / HANDLE_SPACING_PX)},${Math.floor(s.y / HANDLE_SPACING_PX)}`;
    if (cells.has(cell) && !isSelected(vertices[i])) continue;
    cells.add(cell);
    kept.push({ ...vertices[i], ...s });
  }
  // Over the limit: nearest the centre of the view first, the chosen vertex always.
  const cx = view.width / 2, cy = view.height / 2;
  const room = EDIT_HANDLE_LIMIT - fixed.length;
  let shown = kept;
  if (kept.length > room) {
    shown = [...kept].sort((a, b) => Number(isSelected(b)) - Number(isSelected(a)) || ((a.x - cx) ** 2 + (a.y - cy) ** 2) - ((b.x - cx) ** 2 + (b.y - cy) ** 2)).slice(0, room);
  }
  // Where the shown vertices really draw.
  const placed = project(shown, true);
  shown = shown.map((h, i) => ({ ...h, ...placed[i] })).filter((h) => h.visible);
  const shownKeys = new Set(shown.map((h) => h.key));
  // Midpoints on long edges whose ends both have handles, while there is room.
  const candidates = mids.filter((m) => {
    if (!m.ends || !shownKeys.has(m.ends[0]) || !shownKeys.has(m.ends[1])) return false;
    const a = at.get(m.ends[0])!, b = at.get(m.ends[1])!;
    return Math.hypot(a.x - b.x, a.y - b.y) >= MID_EDGE_MIN_PX;
  }).slice(0, Math.max(0, room - shown.length));
  const mScreen = project(candidates, true);
  const midHandles = candidates.map((h, i) => ({ ...h, ...mScreen[i] })).filter((h) => h.visible);
  const fScreen = project(fixed, true);
  const fixedHandles = fixed.map((h, i) => ({ ...h, ...fScreen[i] })).filter((h) => h.visible);
  return { handles: [...shown, ...midHandles, ...fixedHandles], hidden: Math.max(0, onScreen - shown.length) };
}
