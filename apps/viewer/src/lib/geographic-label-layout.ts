/**
 * Where feature labels go (#199), as a pure function of the layers, the view
 * and two projections, so it can be tested without a renderer.
 *
 * Candidates are chosen by where they are, never by source order: features
 * wholly past the horizon are dropped before anything is projected, the rest
 * are projected on the datum (cheap), and only those on screen are considered.
 * Of those, labels shown last time go first, then source order, so a resting or
 * slowly moving view does not reshuffle. Only as many as could be placed are
 * then positioned on the drawn surface and decluttered greedily.
 *
 * A label sits at its feature's anchor when that is in view. Close to a large
 * area or a long line the anchor is often off screen or over the horizon while
 * much of the feature is in view; the label then goes on a visible part of it:
 * the point it used last time if that is still visible, else the surface under
 * the view's probe points that falls inside the area (or near the line), else
 * one of the feature's own interior or along-line samples, nearest the centre
 * of the view.
 */
import {
  geographicFeatureAnchor, geographicFeatureName,
  type BodyFixedPosition, type GeographicFeature, type GeographicLabelStyle, type GeographicLayer,
} from '@cosmolabe/core';
import type { DrawnScreenPosition } from './drawn-surface';

export interface PlacedLabel {
  key: string;
  layer: GeographicLayer;
  anchor: BodyFixedPosition;
  text: string;
  sizePx: number;
  halo: boolean;
  x: number;
  y: number;
}

export interface LabelLayer {
  layer: GeographicLayer;
  labels: GeographicLabelStyle;
  /** The scene filter, when one hides features. */
  filter: ReadonlySet<string> | null;
  /** A feature to leave unlabelled (the selection, which its callout names). */
  skip?: string | null;
}

export interface LabelView {
  width: number;
  height: number;
  /** Unit vector from the body's centre toward the camera, in body-fixed axes, and the horizon's angle from it. Null: no culling. */
  horizon: (layer: GeographicLayer) => { direction: readonly [number, number, number]; angle: number } | null;
  /** Cheap projection (the datum, or sampled terrain height), for choosing candidates. */
  project: (layer: GeographicLayer, positions: BodyFixedPosition[]) => DrawnScreenPosition[];
  /** Projection on the drawn surface, for the labels actually placed (with occlusion by it). */
  place: (layer: GeographicLayer, positions: BodyFixedPosition[]) => DrawnScreenPosition[];
  /** Surface points under a few screen positions, nearest the centre first: where a large area is in view. */
  probes?: (layer: GeographicLayer) => BodyFixedPosition[];
}

/** Each refinement round places up to this many times the remaining label budget, so declutter has spares. */
const SPARE = 3;

type Vec3 = [number, number, number];
/** Per feature: its anchor, the anchor's unit normal, and the angle (radians) from it to the farthest vertex. */
interface Anchors { positions: BodyFixedPosition[]; normals: Vec3[]; reach: number[] }
const anchorCache = new WeakMap<GeographicLayer, Anchors>();
const unit = (p: BodyFixedPosition): Vec3 => {
  const lat = p.latDeg * Math.PI / 180, lon = p.lonDeg * Math.PI / 180;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
};
const angle = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
function anchorsOf(layer: GeographicLayer): Anchors {
  let a = anchorCache.get(layer);
  if (!a) {
    const positions = layer.features.map(geographicFeatureAnchor);
    const normals = positions.map(unit);
    const reach = layer.features.map((f, i) => {
      let r = 0;
      for (const p of geometryPositions(f.geometry)) r = Math.max(r, angle(normals[i], unit(p)));
      return r;
    });
    a = { positions, normals, reach };
    anchorCache.set(layer, a);
  }
  return a;
}

type Geometry = GeographicFeature['geometry'];
function geometryPositions(g: Geometry): BodyFixedPosition[] {
  switch (g.type) {
    case 'Point': return [g.coordinates];
    case 'MultiPoint': case 'LineString': return g.coordinates;
    case 'MultiLineString': case 'Polygon': return g.coordinates.flat();
    case 'MultiPolygon': return g.coordinates.flat(2);
  }
}
function lineParts(g: Geometry): BodyFixedPosition[][] {
  switch (g.type) {
    case 'LineString': return [g.coordinates];
    case 'MultiLineString': return g.coordinates;
    default: return [];
  }
}
/** Longitude difference b − a the short way round. */
const dLon = (a: number, b: number) => ((b - a + 540) % 360) - 180;

/** Whether a position lies inside an area (even–odd over every ring, so holes are outside), edges straight in lon/lat. */
export function areaContains(g: Geometry, p: BodyFixedPosition): boolean {
  const polygons = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  for (const rings of polygons) {
    let inside = false;
    for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      // Longitudes relative to the point, so a ring across the seam is tested whole.
      const xi = dLon(p.lonDeg, ring[i].lonDeg), yi = ring[i].latDeg, xj = dLon(p.lonDeg, ring[j].lonDeg), yj = ring[j].latDeg;
      if ((yi > p.latDeg) !== (yj > p.latDeg) && 0 < xi + (p.latDeg - yi) * (xj - xi) / (yj - yi)) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

/** Up to this many fallback samples per feature, inside an area or along a line. */
const SAMPLES = 64;
const sampleCache = new WeakMap<GeographicFeature, BodyFixedPosition[]>();
/** Positions spread over an area's inside, or along a line, for when its anchor is out of view. */
export function featureSamples(f: GeographicFeature): BodyFixedPosition[] {
  let samples = sampleCache.get(f);
  if (samples) return samples;
  const g = f.geometry;
  samples = [];
  if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
    const all = geometryPositions(g);
    const lon0 = all[0].lonDeg;
    let west = 0, east = 0, south = Infinity, north = -Infinity;
    for (const p of all) { const x = dLon(lon0, p.lonDeg); west = Math.min(west, x); east = Math.max(east, x); south = Math.min(south, p.latDeg); north = Math.max(north, p.latDeg); }
    // An even grid over the box, kept whole: n² ≤ SAMPLES, so no part of the area is left out.
    const n = Math.floor(Math.sqrt(SAMPLES));
    for (let i = 0; i < n && samples.length < SAMPLES; i++) for (let j = 0; j < n && samples.length < SAMPLES; j++) {
      const p = { lonDeg: lon0 + west + (east - west) * (i + 0.5) / n, latDeg: south + (north - south) * (j + 0.5) / n };
      if (areaContains(g, p)) samples.push({ ...p, lonDeg: ((p.lonDeg + 540) % 360) - 180 });
    }
  } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
    const lines = lineParts(g);
    const segments = lines.flatMap((l) => l.slice(1).map((b, i) => [l[i], b] as const));
    const per = Math.max(1, Math.floor(SAMPLES / Math.max(1, segments.length)));
    for (const [a, b] of segments) for (let k = 0; k < per && samples.length < SAMPLES; k++) {
      const t = (k + 0.5) / per;
      samples.push({ lonDeg: ((a.lonDeg + dLon(a.lonDeg, b.lonDeg) * t + 540) % 360) - 180, latDeg: a.latDeg + (b.latDeg - a.latDeg) * t });
    }
  }
  sampleCache.set(f, samples);
  return samples;
}

/** Whether a probe hit lies on a line, within `toleranceDeg`. */
function nearLine(g: Geometry, p: BodyFixedPosition, toleranceDeg: number): boolean {
  const lines = lineParts(g);
  const cos = Math.cos(p.latDeg * Math.PI / 180);
  for (const l of lines) for (let i = 1; i < l.length; i++) {
    const ax = dLon(p.lonDeg, l[i - 1].lonDeg) * cos, ay = l[i - 1].latDeg - p.latDeg;
    const bx = dLon(p.lonDeg, l[i].lonDeg) * cos, by = l[i].latDeg - p.latDeg;
    const vx = bx - ax, vy = by - ay, t = Math.max(0, Math.min(1, -(ax * vx + ay * vy) / (vx * vx + vy * vy || 1)));
    if (Math.hypot(ax + t * vx, ay + t * vy) <= toleranceDeg) return true;
  }
  return false;
}

export function geographicLabelText(feature: GeographicFeature, field: string | null): string | null {
  if (!field) return geographicFeatureName(feature);
  const value = feature.properties?.[field];
  if (value === undefined || value === null || typeof value === 'object') return null;
  const text = String(value).trim();
  return text ? text.slice(0, 60) : null;
}

const onScreen = (p: DrawnScreenPosition | undefined, view: LabelView): p is DrawnScreenPosition =>
  !!p && p.facing && p.inFront && p.x >= 0 && p.y >= 0 && p.x <= view.width && p.y <= view.height;

/** `previousAnchors`: where each label shown last time sat, kept while still visible so labels do not hop. */
export function layoutGeographicLabels(layers: readonly LabelLayer[], view: LabelView, previous: ReadonlySet<string>,
  previousAnchors: ReadonlyMap<string, BodyFixedPosition> = new Map()): PlacedLabel[] {
  const accepted: PlacedLabel[] = [];
  const boxes: [number, number, number, number][] = [];
  const cx = view.width / 2, cy = view.height / 2;
  for (const { layer, labels, filter, skip } of layers) {
    const { positions: anchors, normals, reach } = anchorsOf(layer);
    const horizon = view.horizon(layer);
    // Spatial selection first: in the scene filter, and not wholly past the horizon.
    const near: number[] = [];
    for (let i = 0; i < layer.features.length; i++) {
      if (filter && !filter.has(layer.features[i].id)) continue;
      if (skip && layer.features[i].id === skip) continue;
      if (horizon && angle(normals[i], horizon.direction as Vec3) - reach[i] > horizon.angle) continue;
      near.push(i);
    }
    const keyOf = (i: number) => `${layer.id}/${layer.features[i].id}`;
    // Each candidate's label point: last time's if still in view, else its anchor.
    const positions = new Map<number, BodyFixedPosition>(near.map((i) => [i, previousAnchors.get(keyOf(i)) ?? anchors[i]]));
    const projected = near.length ? view.project(layer, near.map((i) => positions.get(i)!)) : [];
    // Labels shown last time are judged where they are drawn: on low, oblique
    // views the datum can be kilometres above the drawn floor (Gale), so its
    // projection leaves the screen while the label is plainly in view, and the
    // label would hop to a fallback point every layout. Few, so the cost is small.
    const kept = near.flatMap((i, j) => (previousAnchors.has(keyOf(i)) ? [j] : []));
    if (kept.length) view.place(layer, kept.map((j) => positions.get(near[j])!)).forEach((p, k) => { projected[kept[k]] = p; });
    const visible = near.filter((_, j) => onScreen(projected[j], view));
    // Extended features whose point is out of view: a visible part instead.
    const missing = near.filter((i, j) => !onScreen(projected[j], view) && reach[i] > 0);
    if (missing.length) {
      const probes = view.probes?.(layer) ?? [];
      const width = (i: number) => Math.max(reach[i] * 180 / Math.PI * 0.02, 1e-4);
      for (const i of missing) {
        const g = layer.features[i].geometry;
        const hit = probes.find((p) => g.type === 'Polygon' || g.type === 'MultiPolygon' ? areaContains(g, p) : nearLine(g, p, width(i)));
        let best: BodyFixedPosition | null = hit ?? null;
        if (!best) {
          const samples = featureSamples(layer.features[i]);
          const at = samples.length ? view.project(layer, samples) : [];
          let d = Infinity;
          samples.forEach((p, k) => {
            if (!onScreen(at[k], view)) return;
            const e = (at[k].x - cx) ** 2 + (at[k].y - cy) ** 2;
            if (e < d) { d = e; best = p; }
          });
        }
        if (best) { positions.set(i, best); visible.push(i); }
      }
    }
    // Stable: labels shown last time first, then source order.
    visible.sort((a, b) => Number(previous.has(keyOf(b))) - Number(previous.has(keyOf(a))) || a - b);
    const max = labels.maxLabels ?? 40, sizePx = labels.sizePx ?? 11;
    let shown = 0, next = 0;
    while (shown < max && next < visible.length) {
      // Place a batch on the drawn surface, with spares for labels the declutter drops.
      const batch = visible.slice(next, next + (max - shown) * SPARE);
      next += batch.length;
      const placed = view.place(layer, batch.map((i) => positions.get(i)!));
      batch.forEach((i, j) => {
        if (shown >= max) return;
        const p = placed[j];
        if (!onScreen(p, view)) return;
        const text = geographicLabelText(layer.features[i], labels.field);
        if (!text) return;
        const w = text.length * sizePx * 0.58 + 8, h = sizePx + 6;
        const box: [number, number, number, number] = [p.x - w / 2, p.y - h - 6, p.x + w / 2, p.y - 6];
        if (boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) return;
        boxes.push(box);
        accepted.push({ key: keyOf(i), layer, anchor: positions.get(i)!, text, sizePx, halo: labels.halo ?? true, x: p.x, y: p.y });
        shown++;
      });
    }
  }
  return accepted;
}
