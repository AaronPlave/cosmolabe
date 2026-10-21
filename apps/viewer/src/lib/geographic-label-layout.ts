/**
 * Where feature labels go (#199), as a pure function of the layers, the view
 * and two projections, so it can be tested without a renderer.
 *
 * Candidates are chosen by where they are, never by source order: anchors past
 * the horizon are dropped before anything is projected, the rest are projected
 * on the datum (cheap), and only those on screen are considered. Of those,
 * labels shown last time go first, then source order, so a resting or slowly
 * moving view does not reshuffle. Only as many as could be placed are then
 * positioned on the drawn surface and decluttered greedily.
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
  /** Cheap projection on the datum, for choosing candidates. */
  project: (layer: GeographicLayer, positions: BodyFixedPosition[]) => DrawnScreenPosition[];
  /** Projection on the drawn surface, for the labels actually placed. */
  place: (layer: GeographicLayer, positions: BodyFixedPosition[]) => DrawnScreenPosition[];
}

/** Each refinement round places up to this many times the remaining label budget, so declutter has spares. */
const SPARE = 3;

type Vec3 = [number, number, number];
interface Anchors { positions: BodyFixedPosition[]; normals: Vec3[] }
const anchorCache = new WeakMap<GeographicLayer, Anchors>();
function anchorsOf(layer: GeographicLayer): Anchors {
  let a = anchorCache.get(layer);
  if (!a) {
    const positions = layer.features.map(geographicFeatureAnchor);
    const normals = positions.map((p): Vec3 => {
      const lat = p.latDeg * Math.PI / 180, lon = p.lonDeg * Math.PI / 180;
      return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    });
    a = { positions, normals };
    anchorCache.set(layer, a);
  }
  return a;
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

export function layoutGeographicLabels(layers: readonly LabelLayer[], view: LabelView, previous: ReadonlySet<string>): PlacedLabel[] {
  const accepted: PlacedLabel[] = [];
  const boxes: [number, number, number, number][] = [];
  for (const { layer, labels, filter, skip } of layers) {
    const { positions, normals } = anchorsOf(layer);
    const horizon = view.horizon(layer);
    // Spatial selection first: in the scene filter, and not past the horizon.
    const near: number[] = [];
    for (let i = 0; i < layer.features.length; i++) {
      if (filter && !filter.has(layer.features[i].id)) continue;
      if (skip && layer.features[i].id === skip) continue;
      if (horizon) {
        const n = normals[i], d = horizon.direction;
        if (Math.acos(Math.max(-1, Math.min(1, n[0] * d[0] + n[1] * d[1] + n[2] * d[2]))) > horizon.angle) continue;
      }
      near.push(i);
    }
    const projected = near.length ? view.project(layer, near.map((i) => positions[i])) : [];
    const keyOf = (i: number) => `${layer.id}/${layer.features[i].id}`;
    const visible = near.filter((_, j) => onScreen(projected[j], view));
    // Stable: labels shown last time first, then source order.
    visible.sort((a, b) => Number(previous.has(keyOf(b))) - Number(previous.has(keyOf(a))) || a - b);
    const max = labels.maxLabels ?? 40, sizePx = labels.sizePx ?? 11;
    let shown = 0, next = 0;
    while (shown < max && next < visible.length) {
      // Place a batch on the drawn surface, with spares for labels the declutter drops.
      const batch = visible.slice(next, next + (max - shown) * SPARE);
      next += batch.length;
      const placed = view.place(layer, batch.map((i) => positions[i]));
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
        accepted.push({ key: keyOf(i), layer, anchor: positions[i], text, sizePx, halo: labels.halo ?? true, x: p.x, y: p.y });
        shown++;
      });
    }
  }
  return accepted;
}
