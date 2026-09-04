/**
 * A catalog viewpoint that names a moment must render at that moment.
 *
 * `ViewpointDefinition` had no `time` field, so `"time": "2004-07-01T02:48:00Z"`
 * on `cassini-soi.json` was read off the JSON and thrown away. That catalog's
 * viewpoints name epochs months apart — `Titan T-A Flyby (2004-10-26)`,
 * `Huygens Landing (2005-01-14)` — and every one of them rendered at
 * `defaultTime` instead, so the label was simply a lie about the picture. The
 * scene still looked plausible, which is why it survived: Titan is at Saturn in
 * July and in January alike.
 *
 * Two halves are covered here because the defect could return in either:
 *
 *   1. core resolves `time` to an ephemeris epoch — against SPICE `str2et`, not
 *      against our own second implementation of the same parse.
 *   2. `applyNamedViewpoint` seeks the clock to that epoch, and — the other
 *      half of the contract, and the easier one to break by accident — does
 *      NOT touch the clock for a viewpoint that named no time.
 *
 * The first half runs on the real shipped `cassini-soi.json` rather than a
 * fixture, since a field silently dropped from the shipped catalog is the whole
 * bug; a fixture would have passed while the catalog stayed broken.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { Spice, type SpiceInstance } from '@cosmolabe/spice';
import { Universe, type CatalogJson, type ViewpointDefinition } from '@cosmolabe/core';
import { applyNamedViewpoint, type ViewpointHost } from '../applyNamedViewpoint.js';
import type { CameraViewpoint } from '../CameraController.js';
import type { BodyMesh } from '../../BodyMesh.js';

const LSK = fileURLToPath(new URL('../../../../spice/test-kernels/naif0012.tls', import.meta.url));
const CASSINI = fileURLToPath(new URL('../../../../../apps/viewer/test-catalogs/cassini-soi.json', import.meta.url));

/** What the shipped catalog claims, and what those claims must resolve to. */
const CASSINI_EPOCHS: Record<string, string> = {
  'SOI (2004-07-01)': '2004-07-01T02:48:00Z',
  'Titan T-A Flyby (2004-10-26)': '2004-10-26T15:30:00Z',
  'Huygens Release (2004-12-25)': '2004-12-25T02:00:00Z',
  'Huygens Landing (2005-01-14)': '2005-01-14T11:30:00Z',
  'Enceladus E-2 Flyby (2005-07-14)': '2005-07-14T19:55:00Z',
};

/** Viewpoints in that catalog that deliberately name no moment. */
const CASSINI_TIMELESS = ['Saturn System Wide', 'Ring Plane View', 'Track Cassini', 'North Pole'];

/** A `CameraViewpoint` carrying only what the applier reads. */
function cameraViewpoint(name: string, epoch?: number, trackBody?: string): CameraViewpoint {
  return {
    name,
    position: new THREE.Vector3(1, 2, 3),
    target: new THREE.Vector3(0, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    trackBody,
    epoch,
  };
}

/** A stand-in for UniverseRenderer that records what was asked of it. Lets the
 *  seek rule be checked without a WebGL context. */
function stubHost(viewpoints: CameraViewpoint[]) {
  const byName = new Map(viewpoints.map((v) => [v.name, v]));
  const calls: string[] = [];
  let et = 12345;
  const host: ViewpointHost = {
    cameraController: {
      getViewpoint: (n) => byName.get(n),
      applyViewpoint: (vp) => { calls.push(`apply:${vp.name}`); },
      goToViewpoint: (n) => { calls.push(`goTo:${n}`); return true; },
      track: (bm) => { calls.push(`track:${bm ? 'body' : 'null'}`); },
    },
    timeController: {
      setTime: (t) => { calls.push(`setTime:${t}`); et = t; },
    },
    getBodyMesh: () => ({} as BodyMesh),
  };
  return { host, calls, et: () => et };
}

describe('catalog viewpoint `time` reaches the scene clock', () => {
  let spice: SpiceInstance;
  let universe: Universe;
  let byName: Map<string, ViewpointDefinition>;

  beforeAll(async () => {
    spice = await Spice.init();
    const lsk = readFileSync(LSK);
    await spice.furnish({
      type: 'buffer',
      data: lsk.buffer.slice(lsk.byteOffset, lsk.byteOffset + lsk.byteLength) as ArrayBuffer,
      filename: 'naif0012.tls',
    });

    // Only the LSK is furnished: the trajectories in this catalog need SPK/CK
    // that aren't wanted here, and viewpoint parsing does not depend on them.
    universe = new Universe(spice);
    universe.loadCatalog(JSON.parse(readFileSync(CASSINI, 'utf8')) as CatalogJson);
    byName = new Map(universe.viewpoints.map((v) => [v.name, v]));
  });

  it('finds the shipped cassini-soi viewpoints (guards against a vacuous pass)', () => {
    for (const name of [...Object.keys(CASSINI_EPOCHS), ...CASSINI_TIMELESS]) {
      expect(byName.has(name), `cassini-soi.json no longer defines "${name}"`).toBe(true);
    }
  });

  it('resolves each epoch-bearing viewpoint to the ET SPICE reads for its string', () => {
    for (const [name, iso] of Object.entries(CASSINI_EPOCHS)) {
      const vp = byName.get(name)!;
      expect(vp.time, `${name}: raw time not preserved`).toBe(iso);
      // str2et is the oracle, so this cannot pass by two copies of our own
      // parse agreeing on the same mistake.
      expect(vp.epoch, `${name}: epoch missing or wrong`).toBeCloseTo(spice.str2et(iso), 6);
    }
  });

  it('spreads those epochs months apart, as the viewpoint names promise', () => {
    // The defect's signature was every viewpoint sharing defaultTime's epoch.
    const soi = byName.get('SOI (2004-07-01)')!.epoch!;
    const landing = byName.get('Huygens Landing (2005-01-14)')!.epoch!;
    expect(landing - soi).toBeGreaterThan(180 * 86400);
  });

  it('keeps the two captured cassini-soi goldens at the epoch they were shot at', () => {
    // `scripts/visual-regression.mjs` captures 'SOI (2004-07-01)' then
    // 'Ring Plane View' from this catalog, and the committed goldens were shot
    // with the clock frozen at `defaultTime`. Seeking on viewpoint activation
    // only leaves those two alone while (a) SOI's time IS defaultTime and
    // (b) Ring Plane View names no time and so inherits SOI's epoch. Change
    // either and the goldens quietly stop matching what they are named for,
    // which is worth failing here rather than discovering as pixel drift.
    const catalog = JSON.parse(readFileSync(CASSINI, 'utf8')) as CatalogJson & { defaultTime: string };
    expect(byName.get('SOI (2004-07-01)')!.epoch).toBeCloseTo(spice.str2et(catalog.defaultTime), 6);
    expect(byName.get('Ring Plane View')!.epoch).toBeUndefined();
  });

  it('leaves `epoch` undefined for a viewpoint that names no time', () => {
    for (const name of CASSINI_TIMELESS) {
      const vp = byName.get(name)!;
      expect(vp.time, `${name}`).toBeUndefined();
      expect(vp.epoch, `${name}`).toBeUndefined();
    }
  });

  it('warns and declines to guess when a time cannot be parsed', () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      const u = new Universe(spice);
      u.loadCatalog({
        name: 'bad-time',
        items: [{ name: 'Nonsense', type: 'Viewpoint', center: 'Saturn', distance: 1000, time: 'last Tuesday' } as never],
      } as CatalogJson);
      const vp = u.viewpoints.find((v) => v.name === 'Nonsense')!;
      // Not 0: J2000 is a real epoch, and jumping there would be a wrong
      // answer wearing the costume of a right one.
      expect(vp.epoch).toBeUndefined();
      expect(warnings.some((w) => w.includes('Nonsense') && w.includes('last Tuesday'))).toBe(true);
    } finally {
      console.warn = original;
    }
  });

  it('seeks the clock to the epoch when applying an epoch-bearing viewpoint', () => {
    const epoch = byName.get('Huygens Landing (2005-01-14)')!.epoch!;
    const { host, calls, et } = stubHost([cameraViewpoint('Huygens Landing (2005-01-14)', epoch, 'Titan')]);
    expect(applyNamedViewpoint(host, 'Huygens Landing (2005-01-14)')).toBe(true);
    expect(et()).toBeCloseTo(epoch, 6);
    // Before the camera moves, so the next frame is composed at that epoch.
    expect(calls[0]).toBe(`setTime:${epoch}`);
  });

  it('leaves the clock untouched when applying a viewpoint with no epoch', () => {
    const { host, calls, et } = stubHost([cameraViewpoint('Ring Plane View', undefined, 'Saturn')]);
    expect(applyNamedViewpoint(host, 'Ring Plane View')).toBe(true);
    expect(et()).toBe(12345);
    expect(calls.some((c) => c.startsWith('setTime:'))).toBe(false);
    // ...but it still moved the camera, so the "no seek" is not just a no-op.
    expect(calls).toContain('apply:Ring Plane View');
  });

  it('treats an epoch of exactly J2000 as a real request, not as "absent"', () => {
    // `epoch: 0` is 2000-01-01T11:58:55.816Z. A truthiness check here would
    // silently skip the seek, which is the same class of bug one level down.
    const { host, et } = stubHost([cameraViewpoint('At J2000', 0, 'Saturn')]);
    applyNamedViewpoint(host, 'At J2000');
    expect(et()).toBe(0);
  });
});
