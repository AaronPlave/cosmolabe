import { describe, it, expect, vi } from 'vitest';
import { parseGeographicGeoJson, type BodyFixedPosition, type GeographicLayer } from '@cosmolabe/core';
import type { UniverseRenderer } from '@cosmolabe/three';
import { layoutGeographicLabels, areaContains, featureSamples, type LabelLayer, type LabelView } from '../geographic-label-layout';
import { createDrawnSurfaceProjector, type DrawnScreenPosition } from '../drawn-surface';

/** A layer of named points at lon = index / 100°, so a position says which feature it is. */
function points(n: number, id = 'sites'): GeographicLayer {
  const features = Array.from({ length: n }, (_, i) => ({
    type: 'Feature', id: `p${i}`, properties: { name: `site ${i}` }, geometry: { type: 'Point', coordinates: [i / 100, 0] },
  }));
  return parseGeographicGeoJson(JSON.stringify({ type: 'FeatureCollection', features }), {
    id, name: id, body: 'Mars', source: `${id}.geojson`,
    coordinates: { latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '-180..180', referenceShape: { kind: 'sphere', radiusKm: 3389.5 } },
  }, { kind: 'catalog', identity: `https://x/${id}.geojson`, catalog: 'https://x/scene.json' });
}
const indexOf = (p: BodyFixedPosition) => Math.round(p.lonDeg * 100);

/** Feature i projects to a spread grid; those outside `inView` fall off the canvas. */
function view(inView: (i: number) => boolean, overrides: Partial<LabelView> = {}): LabelView & { projected: number[]; placed: number[] } {
  const projected: number[] = [], placed: number[] = [];
  const at = (i: number): DrawnScreenPosition => inView(i)
    ? { x: 20 + (i % 10) * 150, y: 40 + Math.floor((i % 400) / 10) * 30, facing: true, inFront: true }
    : { x: -500, y: -500, facing: true, inFront: true };
  return {
    width: 1600, height: 1300, projected, placed,
    horizon: () => null,
    project: (_l, ps) => { projected.push(...ps.map(indexOf)); return ps.map((p) => at(indexOf(p))); },
    place: (_l, ps) => { placed.push(...ps.map(indexOf)); return ps.map((p) => { const q = at(indexOf(p)); return { ...q, y: q.y + 3 }; }); },
    ...overrides,
  };
}
const style = (maxLabels = 40): LabelLayer['labels'] => ({ field: null, maxLabels });

describe('layoutGeographicLabels', () => {
  it('labels late-index features when only they are in view (5,000 features)', () => {
    const layer = points(5000);
    const v = view((i) => i >= 4000 && i < 4040);
    const labels = layoutGeographicLabels([{ layer, labels: style(), filter: null }], v, new Set());
    expect(labels).toHaveLength(40);
    expect(labels.every((l) => indexOf(l.anchor) >= 4000)).toBe(true);
    // Only candidates on screen reach the drawn-surface projection.
    expect(v.placed.every((i) => i >= 4000 && i < 4040)).toBe(true);
  });

  it('places labels at their drawn-surface position, not the datum', () => {
    const layer = points(3);
    const [first] = layoutGeographicLabels([{ layer, labels: style(), filter: null }], view(() => true), new Set());
    expect(first).toMatchObject({ text: 'site 0', x: 20, y: 43 });
  });

  it('never projects features past the horizon or hidden by the scene filter', () => {
    const layer = points(1800); // lon 0..17.99
    const v = view(() => true, { horizon: () => ({ direction: [1, 0, 0], angle: 10.005 * Math.PI / 180 }) });
    layoutGeographicLabels([{ layer, labels: style(1000), filter: new Set(layer.features.filter((_, i) => i % 2 === 0).map((f) => f.id)) }], v, new Set());
    expect(v.projected.length).toBe(501); // even indices with lon ≤ 10°
    expect(Math.max(...v.projected)).toBe(1000);
    expect(v.projected.every((i) => i % 2 === 0)).toBe(true);
  });

  it('caps at maxLabels, keeping labels shown last time first', () => {
    const layer = points(100);
    const v = view(() => true);
    const labels = layoutGeographicLabels([{ layer, labels: style(5), filter: null }], v, new Set(['sites/string:p70', 'sites/string:p90']));
    expect(labels.map((l) => indexOf(l.anchor))).toEqual([70, 90, 0, 1, 2]);
    // One batch with spares, not the whole layer.
    expect(v.placed.length).toBe(15);
  });

  it('leaves the skipped (selected) feature unlabelled', () => {
    const labels = layoutGeographicLabels([{ layer: points(3), labels: style(), filter: null, skip: 'string:p1' }], view(() => true), new Set());
    expect(labels.map((l) => l.text)).toEqual(['site 0', 'site 2']);
  });

  it('drops labels that overlap one already placed', () => {
    const layer = points(4);
    const v = view(() => true, { project: (_l, ps) => ps.map(() => ({ x: 100, y: 100, facing: true, inFront: true })), place: (_l, ps) => ps.map(() => ({ x: 100, y: 100, facing: true, inFront: true })) });
    expect(layoutGeographicLabels([{ layer, labels: style(), filter: null }], v, new Set())).toHaveLength(1);
  });
});

describe('createDrawnSurfaceProjector', () => {
  function fakeRenderer() {
    const raycast = vi.fn((_b: string, ps: BodyFixedPosition[]) => ps.map((p) => (p.lonDeg > 0 ? -0.3 : null)));
    const project = vi.fn((_b: string, ps: BodyFixedPosition[], _d: unknown, opts?: { sampleTerrain?: boolean }) =>
      ps.map((p) => ({ x: p.lonDeg, y: p.heightKm ?? 0, facing: true, inFront: !!opts })));
    const surface = { key: 'tiles-a' };
    return { renderer: { renderedSurfaceHeightsKm: raycast, projectGeographicPositions: project, drawnSurfaceKey: () => surface.key } as unknown as UniverseRenderer,
      raycast, project, surface };
  }
  const datum = { kind: 'ellipsoid' } as never;

  it('samples again as soon as the drawn surface changes (terrain refined), not a second later', () => {
    const t = 0;
    const projector = createDrawnSurfaceProjector(() => t);
    const { renderer, raycast, surface } = fakeRenderer();
    const ps = [{ latDeg: 0, lonDeg: 1 }];
    projector.project(renderer, 'Mars', ps, datum);
    projector.project(renderer, 'Mars', ps, datum);
    expect(raycast).toHaveBeenCalledTimes(1);
    surface.key = 'tiles-b'; // a child tile replaced its parent
    projector.project(renderer, 'Mars', ps, datum);
    expect(raycast).toHaveBeenCalledTimes(2);
  });

  it('keeps heights for different datums apart', () => {
    const projector = createDrawnSurfaceProjector(() => 0);
    const { renderer, raycast } = fakeRenderer();
    const ps = [{ latDeg: 0, lonDeg: 1 }];
    const sphere = { referenceShape: { kind: 'sphere', radiusKm: 3389.5 } } as never;
    const ellipsoid = { referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] } } as never;
    projector.project(renderer, 'Mars', ps, sphere);
    projector.project(renderer, 'Mars', ps, ellipsoid);
    projector.project(renderer, 'Mars', ps, sphere);
    expect(raycast).toHaveBeenCalledTimes(2);
  });

  it('projects onto the rendered height, raycasting each position once while cached', () => {
    let t = 0;
    const surface = createDrawnSurfaceProjector(() => t);
    const { renderer, raycast, project } = fakeRenderer();
    const ps = [{ latDeg: 0, lonDeg: 1 }, { latDeg: 0, lonDeg: 2 }];
    expect(surface.project(renderer, 'Mars', ps, datum)!.map((p) => p.y)).toEqual([-0.3, -0.3]);
    surface.project(renderer, 'Mars', ps, datum);
    t = 500;
    surface.project(renderer, 'Mars', [...ps, { latDeg: 0, lonDeg: 3 }], datum);
    expect(raycast.mock.calls.map((c) => c[1].length)).toEqual([2, 1]);
    expect(project.mock.calls[0][3]).toEqual({ occlusion: undefined });
    t = 1600; // stale: heights follow a change in the drawn level of detail
    surface.project(renderer, 'Mars', ps, datum);
    expect(raycast).toHaveBeenCalledTimes(3);
  });

  it('does not show a position with no drawn surface under it, rather than float it on the datum', () => {
    const surface = createDrawnSurfaceProjector(() => 0);
    const { renderer, project } = fakeRenderer();
    const [none, drawn] = surface.project(renderer, 'Mars', [{ latDeg: 0, lonDeg: -1 }, { latDeg: 0, lonDeg: 1 }], datum, { occlusion: true })!;
    expect(project.mock.calls[0][1]).toEqual([{ latDeg: 0, lonDeg: -1 }, { latDeg: 0, lonDeg: 1, heightKm: -0.3 }]);
    expect(project.mock.calls[0][3]).toEqual({ occlusion: true });
    expect(none.facing).toBe(false);
    expect(drawn.facing).toBe(true);
  });
});

/** One named area: a square ±`r`° about (lon, lat), optionally with a square hole ±`hole`°. */
function area(lon: number, lat: number, r: number, hole = 0): GeographicLayer {
  const w = (x: number) => ((x + 540) % 360) - 180;
  const sq = (h: number) => [[w(lon - h), lat - h], [w(lon + h), lat - h], [w(lon + h), lat + h], [w(lon - h), lat + h], [w(lon - h), lat - h]];
  const rings = hole ? [sq(r), sq(hole).reverse()] : [sq(r)];
  return parseGeographicGeoJson(JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', id: 'a', properties: { name: 'Crater floor' }, geometry: { type: 'Polygon', coordinates: rings } }] }), {
    id: 'areas', name: 'areas', body: 'Mars', source: 'areas.geojson',
    coordinates: { latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '-180..180', referenceShape: { kind: 'sphere', radiusKm: 3389.5 } },
  }, { kind: 'catalog', identity: 'https://x/areas.geojson', catalog: 'https://x/scene.json' });
}
/** A close view: 1 px per 0.001°, centred on (cx, cy) lon/lat, 1000 × 800. */
function closeView(cx: number, cy: number, overrides: Partial<LabelView> = {}): LabelView {
  const at = (p: BodyFixedPosition): DrawnScreenPosition => ({ x: 500 + (p.lonDeg - cx) * 1000, y: 400 - (p.latDeg - cy) * 1000, facing: true, inFront: true });
  return { width: 1000, height: 800, horizon: () => null, project: (_l, ps) => ps.map(at), place: (_l, ps) => ps.map(at), ...overrides };
}

describe('labels on a visible part of large features', () => {
  it('tests containment with holes and across the 180° seam', () => {
    const g = area(10, 0, 2, 1).features[0].geometry;
    expect(areaContains(g, { lonDeg: 11.5, latDeg: 0 })).toBe(true);
    expect(areaContains(g, { lonDeg: 10, latDeg: 0 })).toBe(false); // in the hole
    expect(areaContains(g, { lonDeg: 13, latDeg: 0 })).toBe(false);
    const seam = area(180, 0, 1).features[0].geometry;
    expect(areaContains(seam, { lonDeg: -179.5, latDeg: 0.5 })).toBe(true);
    expect(areaContains(seam, { lonDeg: 179.5, latDeg: -0.5 })).toBe(true);
    expect(areaContains(seam, { lonDeg: 178, latDeg: 0 })).toBe(false);
    // Samples of an area are inside it, never in its hole.
    expect(featureSamples(area(10, 0, 2, 1).features[0]).every((p) => areaContains(g, p))).toBe(true);
  });

  it('labels an area whose anchor is off screen at a visible interior sample', () => {
    // 4° square centred at (10, 0); the view (±0.5°, ±0.4°) sits inside its eastern part, off the anchor.
    const layer = area(10, 0, 2);
    const [label] = layoutGeographicLabels([{ layer, labels: style(), filter: null }], closeView(11.6, 0.3), new Set());
    expect(label).toBeDefined();
    expect(label.x).toBeGreaterThanOrEqual(0); expect(label.x).toBeLessThanOrEqual(1000);
    expect(areaContains(layer.features[0].geometry, label.anchor)).toBe(true);
  });

  it('closer than any sample, uses the surface under the view that is inside the area, not one in its hole', () => {
    const layer = area(10, 0, 2, 1);
    // A view 0.02° wide inside the area, between samples; probe points in order of preference.
    const v = closeView(11.5, 0.1, {
      project: (_l, ps) => ps.map((p) => ({ x: 500 + (p.lonDeg - 11.5) * 50000, y: 400 - (p.latDeg - 0.1) * 50000, facing: true, inFront: true })),
      place: (_l, ps) => ps.map((p) => ({ x: 500 + (p.lonDeg - 11.5) * 50000, y: 400 - (p.latDeg - 0.1) * 50000, facing: true, inFront: true })),
      probes: () => [{ lonDeg: 10.5, latDeg: 0.1 }, { lonDeg: 11.5, latDeg: 0.1 }],
    });
    const [label] = layoutGeographicLabels([{ layer, labels: style(), filter: null }], v, new Set());
    expect(label.anchor).toEqual({ lonDeg: 11.5, latDeg: 0.1 });
  });

  it('keeps the point it used last time while that is still in view', () => {
    const layer = area(10, 0, 2);
    const last = { lonDeg: 11.3, latDeg: 0.2 };
    const [label] = layoutGeographicLabels([{ layer, labels: style(), filter: null }], closeView(11.6, 0.3), new Set(['areas/string:a']), new Map([['areas/string:a', last]]));
    expect(label.anchor).toEqual(last);
  });

  it('does not drop an area whose anchor is past the horizon while its edge is in view', () => {
    const layer = area(10, 0, 2);
    // Horizon 1.5° from lon 12: the anchor (lon 10) is past it, the eastern edge (lon 12) is not.
    const v = closeView(11.8, 0, { horizon: () => ({ direction: [Math.cos(12 * Math.PI / 180), Math.sin(12 * Math.PI / 180), 0], angle: 1.5 * Math.PI / 180 }) });
    expect(layoutGeographicLabels([{ layer, labels: style(), filter: null }], v, new Set())).toHaveLength(1);
  });
});
