// Per-arc rotation models (Cosmographia `arcs[].rotationModel`): a body's
// attitude model can change by time window — a lander turns with its
// mothership until separation, then follows its own attitude.

import { describe, expect, it } from 'vitest';
import {
  CompositeRotation,
  FixedRotation,
  FrameRegistry,
  Universe,
  rotateVecByQuat,
  type CatalogJson,
  type Quaternion,
} from '../index.js';
import { mat3Vec } from '../frames/mat3.js';

const h = Math.SQRT1_2;
const Z90: Quaternion = [h, 0, 0, h];
const ID: Quaternion = [1, 0, 0, 0];

/** Re-express a source-frame vector in the body frame. A source→body
 *  quaternion is mat3ToQuat of the pxform-style matrix, so it applies directly. */
const toBody = (q: Quaternion, v: [number, number, number]) => rotateVecByQuat(v, q);

describe('CompositeRotation', () => {
  const frames = new FrameRegistry();

  it('uses the arc covering et, the fallback outside every arc', () => {
    const r = new CompositeRotation(
      [{ rotation: new FixedRotation(Z90, 'ECLIPJ2000'), startTime: 0, endTime: 100 }],
      new FixedRotation(ID, 'ECLIPJ2000'),
      frames,
    );
    expect(r.rotationAt(50)).toEqual(Z90);
    expect(r.rotationAt(-1)).toEqual(ID);
    expect(r.rotationAt(101)).toEqual(ID);
  });

  it('holds the nearest arc when there is no fallback', () => {
    const r = new CompositeRotation(
      [
        { rotation: new FixedRotation(ID, 'ECLIPJ2000'), startTime: 0, endTime: 10 },
        { rotation: new FixedRotation(Z90, 'ECLIPJ2000'), startTime: 10, endTime: 20 },
      ],
      undefined,
      frames,
    );
    expect(r.sourceFrame).toBe('ECLIPJ2000');
    expect(r.rotationAt(-5)).toEqual(ID);
    expect(r.rotationAt(25)).toEqual(Z90);
  });

  it('re-expresses an arc stated in another inertial frame into its own source frame', () => {
    // The arc is stated from EME2000; the composite answers from ECLIPJ2000.
    const arc = new FixedRotation(Z90, 'EME2000');
    const r = new CompositeRotation(
      [{ rotation: arc, startTime: 0, endTime: 100 }],
      new FixedRotation(ID, 'ECLIPJ2000'),
      frames,
    );
    expect(r.sourceFrame).toBe('ECLIPJ2000');
    const vEcl: [number, number, number] = [0.3, -0.4, 0.866];
    // Expected: ECLIPJ2000 → EME2000 (the obliquity), then the arc's rotation.
    const vEme = mat3Vec(frames.rotation('ECLIPJ2000', 'EME2000', 50)!, vEcl);
    const expected = toBody(Z90, vEme);
    const got = toBody(r.rotationAt(50), vEcl);
    for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(expected[i]!, 12);
    // And it is not the unconverted rotation: the obliquity is in there.
    const naive = toBody(Z90, vEcl);
    expect(Math.hypot(got[0] - naive[0], got[1] - naive[1], got[2] - naive[2])).toBeGreaterThan(0.1);
  });
});

describe('arcs[].rotationModel in a catalog', () => {
  it('switches a lander from its mothership\'s attitude to its own at separation', () => {
    const u = new Universe();
    u.loadCatalog({
      name: 't',
      items: [
        { name: 'Sun', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
        {
          name: 'Lander',
          center: 'Sun',
          rotationModel: { type: 'Fixed', quaternion: [1, 0, 0, 0], inertialFrame: 'ECLIPJ2000' },
          arcs: [
            {
              startTime: '2014-01-01T00:00:00Z',
              endTime: '2014-11-12T08:35:00Z',
              trajectory: { type: 'FixedPoint', position: [1e6, 0, 0] },
              rotationModel: { type: 'Fixed', quaternion: [h, 0, 0, h], inertialFrame: 'ECLIPJ2000' },
            },
            {
              startTime: '2014-11-12T08:35:00Z',
              endTime: '2014-11-13T00:00:00Z',
              trajectory: { type: 'FixedPoint', position: [1e6, 10, 0] },
            },
          ],
        },
      ],
    } as unknown as CatalogJson);
    const lander = u.getBody('Lander')!;
    expect(lander.rotation).toBeInstanceOf(CompositeRotation);
    const sep = (lander.rotation as CompositeRotation).arcs[0]!.endTime;
    const before = lander.rotationAt(sep - 3600)!;
    const after = lander.rotationAt(sep + 3600)!;
    for (let i = 0; i < 4; i++) expect(before[i]).toBeCloseTo(Z90[i]!, 12);
    // The second arc has no rotationModel of its own: the item-level one applies.
    for (let i = 0; i < 4; i++) expect(after[i]).toBeCloseTo(ID[i]!, 12);
  });

  it('leaves an item whose arcs carry no rotationModel exactly as before', () => {
    const u = new Universe();
    u.loadCatalog({
      name: 't',
      items: [{
        name: 'Craft',
        rotationModel: { type: 'Fixed', quaternion: [1, 0, 0, 0] },
        arcs: [{ startTime: '2014-01-01T00:00:00Z', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } }],
      }],
    } as unknown as CatalogJson);
    expect(u.getBody('Craft')!.rotation).toBeInstanceOf(FixedRotation);
  });
});

describe('arcs[].trajectoryPlot', () => {
  it('parses per-arc trail settings for the renderer to lay over the body\'s', () => {
    const u = new Universe();
    u.loadCatalog({
      name: 't',
      items: [{
        name: 'Probe',
        trajectoryPlot: { color: '#ffffff', duration: '30d' },
        arcs: [
          { startTime: '2004-03-02T00:00:00Z', endTime: '2014-05-01T00:00:00Z', trajectory: { type: 'FixedPoint', position: [1, 0, 0] },
            trajectoryPlot: { duration: '10y', fade: 0.25 } },
          { startTime: '2014-05-01T00:00:00Z', trajectory: { type: 'FixedPoint', position: [2, 0, 0] } },
        ],
      }],
    } as unknown as CatalogJson);
    const body = u.getBody('Probe')!;
    const [cruise, orbit] = (body.trajectory as unknown as { arcs: { plot?: Record<string, unknown> }[] }).arcs;
    expect(cruise!.plot).toEqual({ duration: 10 * 365.25 * 86400, fade: 0.25 });
    expect(orbit!.plot).toBeUndefined();
    // Only the keys the arc names: the body's colour still applies to both.
    expect({ ...body.trajectoryPlot, ...cruise!.plot }.color).toBe('#ffffff');
  });
});
