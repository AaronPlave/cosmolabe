/**
 * Semantic viewpoints (#114): a viewpoint is a relationship resolved at an
 * epoch, not a stored pose.
 *
 * The fixture is a small synthetic system with no SPICE: Mars, given a
 * uniform rotation stated in EquatorJ2000 (so the J2000 obliquity is part of
 * every body-fixed composition), a probe on a Keplerian orbit about it, and a
 * moon. Expectations are computed from the universe's own positions and frame
 * registry, which other suites check against SPICE, so this suite checks the
 * relationships rather than re-deriving the frames.
 */
import { describe, expect, it, vi } from 'vitest';
import { Universe } from '../Universe.js';
import type { CatalogJson } from '../catalog/CatalogLoader.js';
import { bodyFixedOffsetToWorld, type Vec3 } from '../kinematics.js';
import {
  presetViewpoint,
  resolveViewpoint,
  validateViewpoint,
  viewpointBodies,
  viewpointToJson,
  ViewpointError,
  type ViewpointDefinition,
} from '../viewpoint.js';

const ET = 1.0e8;
const HOUR = 3600;

function universe(extraItems: unknown[] = []): Universe {
  const u = new Universe();
  u.loadCatalog({
    name: 'viewpoint-fixture',
    items: [
      { name: 'Sun', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
      {
        name: 'Mars',
        center: 'Sun',
        trajectory: { type: 'FixedPoint', position: [1.0e8, 2.0e7, 0] },
        rotationModel: { type: 'Uniform', period: 1, meridianAngle: 10, ascension: 40, declination: 70 },
      },
      {
        name: 'Probe',
        center: 'Mars',
        trajectory: {
          type: 'Keplerian', semiMajorAxis: 10000, eccentricity: 0, inclination: 30,
          ascendingNode: 20, argOfPeriapsis: 0, meanAnomaly: 45,
        },
      },
      { name: 'Moon', center: 'Mars', trajectory: { type: 'FixedPoint', position: [0, 384000, 1000] } },
      ...extraItems,
    ],
  } as CatalogJson);
  return u;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(...a);
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => a.map((x) => x / len(a)) as Vec3;

function expectVec(actual: Vec3, expected: Vec3, tol = 1e-9) {
  const scale = Math.max(1, len(expected));
  for (let i = 0; i < 3; i++) expect(Math.abs(actual[i] - expected[i]) / scale).toBeLessThan(tol);
}

/** The probe's planet-relative position, and its velocity by a wide central
 *  difference: independent of the resolver's own 1 s step. */
function probeKinematics(u: Universe, et: number) {
  const rel = (t: number) => sub(u.absolutePositionOf('Probe', t), u.absolutePositionOf('Mars', t));
  const h = 5;
  return { r: rel(et), v: sub(rel(et + h), rel(et - h)).map((x) => x / (2 * h)) as Vec3 };
}

describe('resolveViewpoint: the historical catalog fields mean what they always did', () => {
  const u = universe();

  it('places distance + latitude + longitude body-fixed, via the centre attitude at the epoch', () => {
    const vp: ViewpointDefinition = { name: 'Over a crater', center: 'Mars', distance: 5000, latitude: 20, longitude: -35 };
    const planet = u.getBody('Mars')!;
    const r = resolveViewpoint(u, vp, ET);
    expectVec(r.eye, bodyFixedOffsetToWorld(5000, 20, -35, planet.rotationAt(ET)!, planet.rotation!.sourceFrame, undefined, ET, u.frames));
    expect(r.target).toEqual([0, 0, 0]);
    expect(r.up).toEqual([0, 1, 0]);
    expect(r.center).toBe('Mars');
  });

  it('follows the clock when the viewpoint names no time', () => {
    // The point of re-resolving: the view stays over the same surface point
    // as the planet turns, rather than over the inertial direction it faced
    // when the catalog loaded.
    const vp: ViewpointDefinition = { name: 'Over a crater', center: 'Mars', distance: 5000, latitude: 20, longitude: -35 };
    const a = resolveViewpoint(u, vp, ET);
    const b = resolveViewpoint(u, vp, ET + 6 * HOUR);
    expect(len(sub(a.eye, b.eye))).toBeGreaterThan(1000);
    expect(len(b.eye)).toBeCloseTo(5000, 6);
  });

  it('orients a child body by its parent when it has no rotation of its own', () => {
    const vp: ViewpointDefinition = { name: 'Over the moon', center: 'Moon', distance: 100, latitude: 10, longitude: 10 };
    const planet = u.getBody('Mars')!;
    expectVec(resolveViewpoint(u, vp, ET).eye,
      bodyFixedOffsetToWorld(100, 10, 10, planet.rotationAt(ET)!, planet.rotation!.sourceFrame, undefined, ET, u.frames));
  });

  it('passes eye / target / up through in the scene frame, normalizing up', () => {
    const vp: ViewpointDefinition = { name: 'Raw', center: 'Mars', eye: [1, 2, 3], target: [4, 5, 6], up: [0, 0, 2] };
    const r = resolveViewpoint(u, vp, ET);
    expect(r.eye).toEqual([1, 2, 3]);
    expect(r.target).toEqual([4, 5, 6]);
    expect(r.up).toEqual([0, 0, 1]);
  });

  it('keeps the old fallback eye for a viewpoint with no placement', () => {
    expect(resolveViewpoint(u, { name: 'Nothing' }, ET).eye).toEqual([0, 3e8, 5e8]);
  });
});

describe('resolveViewpoint: frames', () => {
  const u = universe();

  it('honours an inertial `frame` for eye, target and up', () => {
    const vp: ViewpointDefinition = { name: 'Equatorial', center: 'Mars', frame: 'EquatorJ2000', eye: [0, 0, 1000], target: [0, 10, 0], up: [0, 0, 1] };
    const r = resolveViewpoint(u, vp, ET);
    expectVec(r.eye, u.frames.transform([0, 0, 1000], 'EquatorJ2000', 'ECLIPJ2000', ET));
    expectVec(r.target, u.frames.transform([0, 10, 0], 'EquatorJ2000', 'ECLIPJ2000', ET));
    expectVec(r.up, u.frames.transform([0, 0, 1], 'EquatorJ2000', 'ECLIPJ2000', ET));
    // Not a no-op: the equatorial pole is 23.44° from the ecliptic one.
    expect(Math.acos(r.up[2]) * 180 / Math.PI).toBeCloseTo(23.44, 1);
  });

  it('honours `frame: BodyFixed` for an explicit eye, matching the lat/lon convention', () => {
    // [x, y, z] body-fixed for lat 0 / lon 90 is +Y.
    const fixed = resolveViewpoint(u, { name: 'BF', center: 'Mars', frame: 'BodyFixed', eye: [0, 7000, 0] }, ET);
    const latlon = resolveViewpoint(u, { name: 'LL', center: 'Mars', distance: 7000, latitude: 0, longitude: 90 }, ET);
    expectVec(fixed.eye, latlon.eye);
  });

  it('refuses a frame it cannot resolve instead of treating it as the scene frame', () => {
    expect(() => resolveViewpoint(u, { name: 'Bad', center: 'Mars', frame: 'NOT_A_FRAME', eye: [1, 0, 0] }, ET))
      .toThrow(ViewpointError);
  });
});

describe('resolveViewpoint: semantic relationships', () => {
  const u = universe();

  it('looks at a body: target is that body relative to the center', () => {
    const r = resolveViewpoint(u, { name: 'Moonrise', center: 'Probe', distance: 2, from: { kind: 'toward', body: 'Moon', negate: true }, lookAt: 'Moon' }, ET);
    const toMoon = sub(u.absolutePositionOf('Moon', ET), u.absolutePositionOf('Probe', ET));
    expectVec(r.target, toMoon);
    // The camera is behind the probe, so the probe sits between it and the moon.
    expectVec(unit(r.eye), unit(toMoon).map((x) => -x) as Vec3);
    expect(len(r.eye)).toBeCloseTo(2, 9);
    expect(r.lookAt).toBe('Moon');
  });

  it('places the camera toward a body', () => {
    const r = resolveViewpoint(u, { name: 'Sun side', center: 'Probe', distance: 3, from: { kind: 'toward', body: 'Sun' } }, ET);
    expectVec(unit(r.eye), unit(sub(u.absolutePositionOf('Sun', ET), u.absolutePositionOf('Probe', ET))));
  });

  it('derives velocity and orbit normal relative to the active parent', () => {
    const { r, v } = probeKinematics(u, ET);
    const vel = resolveViewpoint(u, { name: 'V', center: 'Probe', distance: 1, from: { kind: 'velocity' } }, ET);
    const top = resolveViewpoint(u, { name: 'N', center: 'Probe', distance: 1, from: { kind: 'orbitNormal' } }, ET);
    expectVec(vel.eye, unit(v), 1e-6);
    expectVec(top.eye, unit(cross(r, v)), 1e-6);
    // A circular orbit: velocity is perpendicular to the radius.
    expect(Math.abs(dot(vel.eye, unit(r)))).toBeLessThan(1e-6);
  });

  it('defaults semantic views to ecliptic north and never leaves up parallel to the view axis', () => {
    const r = resolveViewpoint(u, { name: 'Sun side', center: 'Probe', distance: 3, from: { kind: 'toward', body: 'Sun' } }, ET);
    expect(r.up).toEqual([0, 0, 1]);
    const down = resolveViewpoint(u, { name: 'Pole', center: 'Mars', eye: [0, 0, 100], up: [0, 0, 1] }, ET);
    expect(len(cross(down.up, sub(down.target, down.eye)))).toBeGreaterThan(0.5);
  });

  it('resolves axis and vector directions in their own or the viewpoint frame', () => {
    const r = resolveViewpoint(u, { name: 'A', center: 'Mars', distance: 10, from: { kind: 'axis', axis: '+Z', frame: 'EquatorJ2000' }, up: { kind: 'vector', vector: [1, 0, 0] } }, ET);
    expectVec(r.eye, u.frames.transform([0, 0, 10], 'EquatorJ2000', 'ECLIPJ2000', ET));
    expectVec(r.up, [1, 0, 0]);
  });

  it('names the reference it cannot resolve', () => {
    expect(() => resolveViewpoint(u, { name: 'X', center: 'Nope', distance: 1 }, ET)).toThrow(/unknown center body "Nope"/);
    expect(() => resolveViewpoint(u, { name: 'X', center: 'Probe', lookAt: 'Nope', distance: 1 }, ET)).toThrow(/unknown body "Nope"/);
    expect(() => resolveViewpoint(u, { name: 'X', center: 'Probe', from: { kind: 'toward', body: 'Sun' } }, ET)).toThrow(/distance/);
    expect(() => resolveViewpoint(u, { name: 'X', lookAt: 'Moon' }, ET)).toThrow(/center/);
  });
});

describe('presetViewpoint (#15 Top / Sun / Velocity)', () => {
  const u = universe();

  it('expresses the presets as ordinary semantic viewpoints', () => {
    const { r, v } = probeKinematics(u, ET);
    const top = resolveViewpoint(u, presetViewpoint('top', 'Probe', 50), ET);
    const sun = resolveViewpoint(u, presetViewpoint('sun', 'Probe', 50), ET);
    const chase = resolveViewpoint(u, presetViewpoint('velocity', 'Probe', 50), ET);
    expectVec(unit(top.eye), unit(cross(r, v)), 1e-6);
    expectVec(top.up, unit(v), 1e-6);
    expectVec(unit(sun.eye), unit(sub(u.absolutePositionOf('Sun', ET), u.absolutePositionOf('Probe', ET))));
    expectVec(unit(chase.eye), unit(v).map((x) => -x) as Vec3, 1e-6);
    expectVec(chase.up, unit(cross(r, v)), 1e-6);
    for (const p of [top, sun, chase]) expect(len(p.eye)).toBeCloseTo(50, 9);
  });

  it('round-trips through the portable form', () => {
    const p = presetViewpoint('velocity', 'Probe', 50, { relativeTo: 'Sun', name: 'Chase' });
    expect(validateViewpoint(viewpointToJson(p))).toEqual(p);
  });
});

describe('catalog Viewpoint items', () => {
  it('parses the semantic fields and resolves them at their epoch', () => {
    const u = universe([
      {
        name: 'Probe passes the moon', type: 'Viewpoint', center: 'Probe', lookAt: 'Moon', distance: '2 km',
        from: { kind: 'toward', body: 'Moon', negate: true }, up: { kind: 'orbitNormal' }, fov: 30, epoch: ET,
      },
    ]);
    const vp = u.viewpoints.find((v) => v.name === 'Probe passes the moon')!;
    expect(vp).toMatchObject({ center: 'Probe', lookAt: 'Moon', distance: 2, fov: 30, epoch: ET, up: { kind: 'orbitNormal' } });
    expect(viewpointBodies(vp).sort()).toEqual(['Moon', 'Probe']);
    expect(resolveViewpoint(u, vp, vp.epoch!).fov).toBe(30);
  });

  it('reports malformed fields and loads the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const u = universe([
        { name: 'Sloppy', type: 'Viewpoint', center: 'Mars', distance: 900, from: { kind: 'sideways' }, eye: [1, 2], fov: 500 },
      ]);
      const vp = u.viewpoints.find((v) => v.name === 'Sloppy')!;
      expect(vp).toEqual({ name: 'Sloppy', center: 'Mars', distance: 900 });
      const messages = warn.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('Sloppy') && m.includes('from.kind'))).toBe(true);
      expect(messages.some((m) => m.includes('"eye"'))).toBe(true);
      expect(messages.some((m) => m.includes('"fov"'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the portable form', () => {
  it('is a catalog Viewpoint item carrying epoch, and validates back unchanged', () => {
    const vp: ViewpointDefinition = {
      name: 'Behind Rosetta', center: 'Rosetta', lookAt: 'Mars', distance: 0.05, frame: 'EclipticJ2000',
      from: { kind: 'toward', body: 'Mars', negate: true }, up: [0, 0, 1], fov: 40, epoch: 2.3e8, time: '2007-02-25T01:57:59Z',
    };
    const json = viewpointToJson(vp);
    expect(json.type).toBe('Viewpoint');
    expect(json).not.toHaveProperty('time');
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    const { time: _t, ...portable } = vp;
    expect(validateViewpoint(json)).toEqual(portable);
  });

  it('rejects untrusted input strictly', () => {
    expect(() => validateViewpoint(null)).toThrow(ViewpointError);
    expect(() => validateViewpoint({ name: 'x', from: { kind: 'toward' } })).toThrow(/from.body/);
    expect(() => validateViewpoint({ name: 'x', center: 'A', up: [0, 0, 0] })).toThrow(/up/);
    expect(() => validateViewpoint({ name: 'x', time: '2020-01-01' })).toThrow(/epoch/);
    expect(() => validateViewpoint({ name: 'x', lookAt: 'Moon' })).toThrow(/center/);
    // Additive fields are ignored rather than forwarded.
    expect(validateViewpoint({ name: 'x', center: 'A', distance: 1, script: 'alert(1)' })).toEqual({ name: 'x', center: 'A', distance: 1 });
  });
});
