import { describe, it, expect } from 'vitest';
import { createGeographicEditLayer, type GeographicEditFeature, type GeoPosition } from '@cosmolabe/core';
import {
  featureHandles, budgetHandles, vertexCount, needsFineDetail, EDIT_HANDLE_LIMIT, EDIT_VERTEX_LIMIT, HANDLE_SPACING_PX, MID_EDGE_MIN_PX,
  type Handle, type Screen,
} from '../edit-handles';

const layer = createGeographicEditLayer({
  id: 'notes', name: 'notes', body: 'Mars',
  coordinates: { latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '-180..180', referenceShape: { kind: 'sphere', radiusKm: 3389.5 } },
});

/** A closed ring of `n` vertices round (lon, lat). */
function ring(lon: number, lat: number, r: number, n: number): GeoPosition[] {
  const out: GeoPosition[] = [];
  for (let i = 0; i < n; i++) out.push([lon + r * Math.cos(2 * Math.PI * i / n), lat + r * Math.sin(2 * Math.PI * i / n)]);
  return [...out, out[0]];
}
const polygon = (rings: GeoPosition[][]): GeographicEditFeature => ({ id: 'f', properties: {}, geometry: { type: 'Polygon', coordinates: rings } });
const multi = (polys: GeoPosition[][][]): GeographicEditFeature => ({ id: 'f', properties: {}, geometry: { type: 'MultiPolygon', coordinates: polys } });

/** A plain camera: 100 px per degree, centred on (0, 0), with everything outside ±6° off screen. */
const view = { width: 1200, height: 1200 };
const flat = (scale = 100) => (hs: Handle[]): Screen[] => hs.map((h) => {
  const x = 600 + h.position[0] * scale, y = 600 - h.position[1] * scale;
  return { x, y, visible: x >= 0 && y >= 0 && x <= 1200 && y <= 1200 };
});
const counting = (inner: (hs: Handle[]) => Screen[]) => {
  const seen = { calls: 0, projected: 0 };
  return { seen, project: (hs: Handle[]) => { seen.calls++; seen.projected += hs.length; return inner(hs); } };
};

describe('feature handles', () => {
  it('gives each ring of each part its own vertices and midpoints, holes included', () => {
    const f = multi([[ring(0, 0, 2, 6), ring(0, 0, 1, 4)], [ring(4, 0, 1, 5)]]);
    expect(vertexCount(f)).toBe(15);
    const hs = featureHandles(layer, f);
    expect(hs.filter((h) => h.kind === 'vertex').map((h) => h.part.join('.'))).toEqual([...Array(6).fill('0.0'), ...Array(4).fill('0.1'), ...Array(5).fill('1.0')]);
    expect(hs.filter((h) => h.kind === 'mid')).toHaveLength(15);
    // A hole's closing edge joins its last vertex to its first.
    expect(hs.find((h) => h.key === 'm0.1:3')?.ends).toEqual(['v0.1:3', 'v0.1:0']);
    expect(hs.at(-1)?.kind).toBe('move');
  });

  it('puts a midpoint across the antimeridian on the short way round', () => {
    const f = polygon([[[179, 0], [-179, 0], [-179, 1], [179, 0]]]);
    expect(featureHandles(layer, f).find((h) => h.key === 'm0:0')?.position).toEqual([180, 0]);
  });

  it('leaves out per-vertex handles of a very large feature until its points are asked for', () => {
    const f = polygon([ring(0, 0, 5, EDIT_VERTEX_LIMIT + 1)]);
    expect(needsFineDetail(f)).toBe(true);
    expect(featureHandles(layer, f, false).map((h) => h.kind)).toEqual(['move']);
    expect(needsFineDetail(polygon([ring(0, 0, 5, EDIT_VERTEX_LIMIT)]))).toBe(false);
  });
});

describe('handle budget', () => {
  it('shows every handle of an ordinary shape', () => {
    const f = polygon([ring(0, 0, 2, 8)]);
    const { handles, hidden } = budgetHandles(featureHandles(layer, f), flat(), view);
    expect(handles.filter((h) => h.kind === 'vertex')).toHaveLength(8);
    expect(handles.filter((h) => h.kind === 'mid')).toHaveLength(8);
    expect(hidden).toBe(0);
  });

  it('thins a dense multipart feature to one handle per screen cell, and zooming in shows more', () => {
    // 20 parts × (outer 120 + hole 60) = 3,600 vertices, all within ±5°.
    const polys = Array.from({ length: 20 }, (_, i) => [ring(-4 + (i % 5) * 2, -3 + Math.floor(i / 5) * 2, 0.8, 120), ring(-4 + (i % 5) * 2, -3 + Math.floor(i / 5) * 2, 0.3, 60)]);
    const f = multi(polys);
    const all = featureHandles(layer, f, true);
    const far = counting(flat(4));
    const zoomedOut = budgetHandles(all, far.project, view);
    const vertices = zoomedOut.handles.filter((h) => h.kind === 'vertex');
    // No two handles share a cell, and the total stays within the limit.
    const cells = new Set(vertices.map((h) => `${Math.floor(h.x / HANDLE_SPACING_PX)},${Math.floor(h.y / HANDLE_SPACING_PX)}`));
    expect(cells.size).toBe(vertices.length);
    expect(zoomedOut.handles.length).toBeLessThanOrEqual(EDIT_HANDLE_LIMIT);
    expect(zoomedOut.hidden).toBeGreaterThan(3000);
    // Edges this short on screen get no midpoints, and none are projected.
    expect(zoomedOut.handles.filter((h) => h.kind === 'mid')).toHaveLength(0);
    // Every vertex roughly; precisely only the vertices shown and the move handle.
    expect(far.seen.projected).toBe(3600 + vertices.length + 1);

    const zoomedIn = budgetHandles(all, flat(400), view);
    expect(zoomedIn.handles.filter((h) => h.kind === 'vertex').length).toBeGreaterThan(vertices.length);
    expect(zoomedIn.handles.length).toBeLessThanOrEqual(EDIT_HANDLE_LIMIT);
  });

  it('keeps the handles nearest the centre of the view when over the limit', () => {
    // 30 × 30 points 40 px apart, all on screen, so only the limit applies.
    const grid: GeoPosition[] = [];
    for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++) grid.push([-5.8 + 0.4 * i, -5.8 + 0.4 * j]);
    const f: GeographicEditFeature = { id: 'f', properties: {}, geometry: { type: 'MultiPoint', coordinates: grid } };
    const { handles, hidden } = budgetHandles(featureHandles(layer, f), flat(), view);
    const shown = handles.filter((h) => h.kind === 'vertex');
    expect(handles.length).toBe(EDIT_HANDLE_LIMIT);
    expect(handles.some((h) => h.kind === 'move')).toBe(true);
    expect(hidden).toBe(900 - shown.length);
    const d = (p: GeoPosition) => Math.hypot(p[0], p[1]);
    const keys = new Set(shown.map((h) => h.index));
    const farthestShown = Math.max(...shown.map((h) => d(h.position)));
    const nearestHidden = Math.min(...grid.filter((_, i) => !keys.has(i)).map(d));
    expect(farthestShown).toBeLessThanOrEqual(nearestHidden + 1e-9);
  });

  it('always shows the chosen vertex, even in a crowded cell or over the limit', () => {
    const f = polygon([ring(0, 0, 0.5, 400)]);
    const crowded = budgetHandles(featureHandles(layer, f), flat(4), view, { part: [0], index: 237 });
    expect(crowded.handles.some((h) => h.kind === 'vertex' && h.index === 237)).toBe(true);
  });

  it('shows a midpoint only on an edge long enough to grab, with both its ends shown', () => {
    const f = polygon([[[0, 0], [MID_EDGE_MIN_PX / 100 + 0.01, 0], [0, 0.1], [0, 0]]]);
    const mids = budgetHandles(featureHandles(layer, f), flat(), view).handles.filter((h) => h.kind === 'mid');
    expect(mids.map((h) => h.key)).toEqual(['m0:0', 'm0:1']);
  });

  it('projects nothing per vertex for a large feature before its points are asked for', () => {
    const f = polygon([ring(0, 0, 5, 20_000)]);
    const { seen, project } = counting(flat());
    const { handles } = budgetHandles(featureHandles(layer, f, false), project, view);
    expect(handles.map((h) => h.kind)).toEqual(['move']);
    expect(seen.projected).toBe(1);
  });
});
