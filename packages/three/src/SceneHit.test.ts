import { describe, expect, it } from 'vitest';
import {
  PICK_PRECEDENCE, describeDatum, formatHeight, formatLatitude, formatLongitude, resolveSceneHit,
  surfacePointToText, type HitLayer, type SceneHit, type SurfacePoint,
} from './SceneHit.js';
import { probeCalloutLines } from './PointProbe.js';

const point: SurfacePoint = {
  bodyName: 'Mars',
  bodyFixedPositionKm: [1000, 3000, 1000],
  source: 'terrain',
  latDeg: 18.4446,
  lonDeg: 77.4509,
  latitudeKind: 'geodetic',
  altitude: {
    km: -2.4312,
    from: 'sampled-terrain',
    datum: {
      referenceShape: { kind: 'sphere', radiusKm: 3396.19 },
      verticalDatum: 'areoid',
      heightConvention: 'radial',
      origin: 'terrain',
    },
  },
  renderedHeightKm: -2.43,
};

const hits: Record<HitLayer, SceneHit> = {
  event: { kind: 'event', eventId: 'e1', queryId: 'q1', et: 0 },
  label: { kind: 'entity', bodyName: 'MRO', via: 'label' },
  body: { kind: 'entity', bodyName: 'Mars', via: 'mesh' },
  surface: { kind: 'surface', point, cameraRangeKm: 12 },
};

/** Discoverers that report whether they were consulted. */
function layers(present: Partial<Record<HitLayer, boolean>>) {
  const calls: HitLayer[] = [];
  const layer = (name: HitLayer) => () => {
    calls.push(name);
    return present[name] ? hits[name] : null;
  };
  const discover = { event: layer('event'), label: layer('label'), body: layer('body'), surface: layer('surface') };
  return { discover, calls };
}

describe('resolveSceneHit', () => {
  it('selection takes an event glyph, then a label, then the body', () => {
    expect(resolveSceneHit('select', layers({ event: true, label: true, body: true }).discover)).toBe(hits.event);
    expect(resolveSceneHit('select', layers({ label: true, body: true }).discover)).toBe(hits.label);
    expect(resolveSceneHit('select', layers({ body: true, surface: true }).discover)).toBe(hits.body);
  });

  it('selection never resolves to a surface point', () => {
    expect(resolveSceneHit('select', layers({ surface: true }).discover)).toBeNull();
  });

  it('the probe consults only the surface, whatever else is under the pointer', () => {
    const { discover, calls } = layers({ event: true, label: true, body: true, surface: true });
    expect(resolveSceneHit('probe', discover)).toBe(hits.surface);
    expect(calls).toEqual(['surface']);
  });

  it('a measurement endpoint prefers a named entity, then a surface point', () => {
    expect(resolveSceneHit('endpoint', layers({ label: true, surface: true }).discover)).toBe(hits.label);
    expect(resolveSceneHit('endpoint', layers({ surface: true, body: true }).discover)).toBe(hits.surface);
    expect(resolveSceneHit('endpoint', layers({ body: true }).discover)).toBe(hits.body);
  });

  it('stops discovering once a layer answers', () => {
    const { discover, calls } = layers({ label: true, body: true });
    resolveSceneHit('select', discover);
    expect(calls).toEqual(['event', 'label']);
  });

  it('every intent has a precedence over known layers', () => {
    for (const order of Object.values(PICK_PRECEDENCE)) {
      expect(order.length).toBeGreaterThan(0);
      for (const layer of order) expect(Object.keys(hits)).toContain(layer);
    }
  });
});

describe('surface point presentation', () => {
  it('formats hemispheres rather than signed degrees', () => {
    expect(formatLatitude(-12.5, 2)).toBe('12.50° S');
    expect(formatLongitude(-0.25, 3)).toBe('0.250° W');
    expect(formatLatitude(18.4446)).toBe('18.4446° N');
  });

  it('formats heights with an explicit sign, in metres below 10 km', () => {
    expect(formatHeight(-2.4312)).toBe('−2431.2 m');
    expect(formatHeight(0.0123)).toBe('+12.3 m');
    expect(formatHeight(21.2296)).toBe('+21.230 km');
  });

  it('names the datum heights are measured from', () => {
    expect(describeDatum(point.altitude.datum)).toBe('areoid');
    expect(describeDatum({ ...point.altitude.datum, verticalDatum: 'reference-sphere' })).toBe('sphere R 3396.2 km');
  });

  it('copies body, coordinates, height and datum in one line', () => {
    expect(surfacePointToText(point)).toBe('Mars 18.444600, 77.450900 (geodetic °N, °E) -2431.2 m above areoid');
  });

  it('previews in one line and pins with coordinates and height, without camera distance', () => {
    expect(probeCalloutLines(point, 'preview')).toEqual(['Mars · 18.44° N, 77.45° E']);
    const pinned = probeCalloutLines(point, 'pinned');
    expect(pinned).toEqual(['Mars', '18.4446° N, 77.4509° E', '−2431.2 m · areoid']);
  });
});
