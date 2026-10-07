import { describe, expect, it } from 'vitest';
import {
  PICK_PRECEDENCE, coordinateDecimals, pointerResolution, describeDatum, formatHeight, formatLatitude, formatLongitude, resolveSceneHit, resolveSurfaceAltitude,
  surfacePointToText, type HitLayer, type SceneHit, type SurfacePoint,
} from './SceneHit.js';
import * as THREE from 'three';
import { behindBody, probeCalloutLines } from './PointProbe.js';

const AREOID = {
  referenceShape: { kind: 'sphere', radiusKm: 3396.19 },
  verticalDatum: 'areoid',
  heightConvention: 'radial',
  origin: 'terrain',
} as const;

const point: SurfacePoint = {
  bodyName: 'Mars',
  bodyFixedPositionKm: [1000, 3000, 1000],
  source: 'terrain',
  latDeg: 18.4446,
  lonDeg: 77.4509,
  latitudeKind: 'geodetic',
  // Looking straight down, about 1.9 m a pixel: ≈ 3.3e-5° of latitude → 5 decimals.
  resolution: pointerResolution(0.0019, 1, 3317, 18.4446),
  hit: { heightKm: -2.43, datum: AREOID },
  terrainSample: { elevationKm: -2.4312, datum: AREOID, sourceId: 'mars-mola', describesHit: true },
  altitude: { km: -2.4312, from: 'terrain-sample', datum: AREOID },
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

describe('resolveSurfaceAltitude', () => {
  const ELLIPSOID = {
    referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] },
    verticalDatum: 'ellipsoid',
    heightConvention: 'radial',
    origin: 'body-shape',
  } as const;
  const hit = { heightKm: -4.1, datum: AREOID };
  const sample = { elevationKm: -4.47, datum: AREOID, sourceId: 'mars_v14', tileId: '14/1/2' };

  it('promotes the terrain sample when the terrain is what was hit', () => {
    const r = resolveSurfaceAltitude('terrain', hit, sample);
    expect(r.altitude).toEqual({ km: -4.47, from: 'terrain-sample', datum: AREOID });
    expect(r.terrainSample?.describesHit).toBe(true);
  });

  it('keeps an overlay hit on its own height, with the global terrain as a separate record', () => {
    const r = resolveSurfaceAltitude('surface-overlay', hit, sample);
    expect(r.altitude).toEqual({ km: -4.1, from: 'rendered-hit', datum: AREOID });
    expect(r.terrainSample).toMatchObject({ elevationKm: -4.47, sourceId: 'mars_v14', describesHit: false });
  });

  it('does not let a terrain sample stand in for the reference globe', () => {
    const r = resolveSurfaceAltitude('ellipsoid', { heightKm: 0.2, datum: ELLIPSOID }, sample);
    expect(r.altitude.from).toBe('rendered-hit');
    expect(r.altitude.datum).toBe(ELLIPSOID);
  });

  it('uses the hit height when there is no terrain coverage', () => {
    const r = resolveSurfaceAltitude('terrain', hit);
    expect(r.altitude.from).toBe('rendered-hit');
    expect(r.terrainSample).toBeUndefined();
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
    expect(probeCalloutLines(point, 'preview')).toEqual(['Mars · 18.44460° N, 77.45090° E']);
    const pinned = probeCalloutLines(point, 'pinned');
    expect(pinned).toEqual(['Mars', '18.44460° N, 77.45090° E', '−2431.2 m · areoid']);
  });

  it('shows each coordinate to the resolution of one screen pixel at the point', () => {
    const at = (spanKm: number, cos = 1, lat = 0) =>
      coordinateDecimals({ resolution: pointerResolution(spanKm, cos, 3390, lat) });
    expect(at(17)).toEqual({ lat: 1, lon: 1 }); // orbit: ~17 km a pixel
    expect(at(0.0019)).toEqual({ lat: 5, lon: 5 }); // ~2 m a pixel, looking down
    expect(at(0.00002)).toEqual({ lat: 7, lon: 7 }); // ~2 cm a pixel
    expect(at(1e-9)).toEqual({ lat: 8, lon: 8 }); // capped
    expect(at(1e9)).toEqual({ lat: 0, lon: 0 }); // never negative
  });

  it('resolves less where the view grazes the surface', () => {
    const down = pointerResolution(0.002, 1, 3390, 0);
    const grazing = pointerResolution(0.002, Math.cos(85 * Math.PI / 180), 3390, 0);
    expect(grazing.surfaceKm / down.surfaceKm).toBeCloseTo(1 / Math.cos(85 * Math.PI / 180), 6);
    expect(coordinateDecimals({ resolution: grazing }).lat).toBeLessThan(coordinateDecimals({ resolution: down }).lat);
    // At the horizon the stretch is bounded, not infinite.
    expect(Number.isFinite(pointerResolution(0.002, 0, 3390, 0).surfaceKm)).toBe(true);
  });

  it('resolves longitude more coarsely toward the poles', () => {
    const r = pointerResolution(0.002, 1, 3390, 80);
    expect(r.lonDeg / r.latDeg).toBeCloseTo(1 / Math.cos(80 * Math.PI / 180), 6);
    expect(coordinateDecimals({ resolution: r })).toEqual({ lat: 5, lon: 4 });
  });

  it('copies at least six decimals, more when the point was probed finer', () => {
    expect(surfacePointToText({ ...point, resolution: pointerResolution(0.00002, 1, 3317, 18.4446) })).toMatch(/^Mars 18\.4446000, 77\.4509000 /);
  });
});

describe('behindBody', () => {
  const R = 3396;
  const center = new THREE.Vector3();
  const onSurface = (deg: number, heightKm = 0) =>
    new THREE.Vector3(Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180), 0).multiplyScalar(R + heightKm);

  it('hides the far side and shows the near side from orbit', () => {
    const eye = new THREE.Vector3(R + 1000, 0, 0);
    expect(behindBody(onSurface(0), center, eye)).toBe(false);
    expect(behindBody(onSurface(180), center, eye)).toBe(true);
    expect(behindBody(onSurface(90), center, eye)).toBe(true);
  });

  it('shows a ridge past the geometric horizon from a camera down in a crater', () => {
    // Camera 4 km below the datum, a 1 km ridge 60 km away: past the
    // sphere's horizon, but in plain view up the slope.
    const eye = onSurface(0, -4);
    const ridge = onSurface(60 / R * 180 / Math.PI, 1);
    expect(ridge.clone().sub(center).dot(eye.clone().sub(ridge))).toBeLessThan(0);
    expect(behindBody(ridge, center, eye)).toBe(false);
  });
});
