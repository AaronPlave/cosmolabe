/**
 * ObservationsVisualizer, headless: real Cassini ISS NAC pointing (CK + IK)
 * during the SOI Titan mosaic ISS_000TI_2X2WIND101_PRIME, through the runtime
 * engine (@cosmolabe/frames' heritage adapter) — which also proves that
 * engine satisfies core's FootprintGeometryProvider.
 *
 * Pins the Phase-2 behaviours of issue #28 that are about rendering rather
 * than numbers: `obsRate: 0` is a continuous swath and a nonzero rate is
 * discrete footprints; `fillInObservations` is filled vs outlined, not
 * accumulation; footprints accumulate with the clock; and a given (ODE-style)
 * footprint renders through the same item.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { createHeritageSpice } from '@cosmolabe/frames';
import { Universe, observationFromSensorActive, type CatalogJson, type SpiceInstance } from '@cosmolabe/core';
import { ObservationsVisualizer } from '../plugins/ObservationsVisualizer.js';
import type { RendererContext } from '../plugins/RendererContext.js';

const KERNELS = join(__dirname, '../../../spice/test-kernels');
const FILES = [
  'naif0012.tls',
  'pck00010.tpc',
  'cassini/040909R_SCPSE_04183_04185_subset.bsp',
  'cassini/cas_v43.tf',
  'cassini/cas00172.tsc',
  'cassini/cas_iss_v10.ti',
  'cassini/04183_04185ra.bc',
];

// First and last frame of the mosaic (archive IMAGE_MID_TIMEs, UTC).
const START = '2004-184T01:58:32.775';
const END = '2004-184T02:16:07.764';

function catalog(observation: Record<string, unknown>): CatalogJson {
  return {
    items: [
      { name: 'Saturn', center: 'SSB', trajectory: { type: 'Spice', target: 'SATURN', center: 'SSB' } },
      {
        name: 'Titan',
        center: 'Saturn',
        trajectoryFrame: 'J2000',
        trajectory: { type: 'Spice', target: 'TITAN', center: 'SATURN' },
        rotationModel: { type: 'Spice', bodyFrame: 'IAU_TITAN' },
        geometry: { type: 'Globe', radius: 2575 },
      },
      {
        name: 'Cassini',
        center: 'Saturn',
        trajectoryFrame: 'J2000',
        trajectory: { type: 'Spice', target: 'CASSINI', center: 'SATURN' },
        items: [
          {
            name: 'ISS NAC',
            class: 'instrument',
            center: 'Cassini',
            trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
            geometry: { type: 'Sensor', spiceId: -82360, target: 'Titan' },
          },
        ],
      },
      // As Cosmographia writes it: no trajectory, body-fixed on the target.
      {
        name: 'Titan mosaic',
        class: 'observation',
        center: 'Titan',
        trajectoryFrame: { type: 'BodyFixed', body: 'Titan' },
        bodyFrame: { type: 'BodyFixed', body: 'Titan' },
        geometry: { type: 'Observations', ...observation },
      },
    ],
  } as unknown as CatalogJson;
}

describe('ObservationsVisualizer (Cassini ISS NAC, Titan, SOI)', () => {
  let spice: SpiceInstance;
  let startEt: number;
  let endEt: number;

  beforeAll(async () => {
    spice = (await createHeritageSpice()) as unknown as SpiceInstance;
    for (const f of FILES) {
      const buf = readFileSync(join(KERNELS, f));
      const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      await spice.furnish({ type: 'buffer', data, filename: f.split('/').pop()! });
    }
    startEt = spice.str2et(START);
    endEt = spice.str2et(END);
  });

  function scene(observation: Record<string, unknown>, engine: SpiceInstance = spice) {
    const universe = new Universe(engine);
    universe.loadCatalog(catalog(observation));
    const ctx = {
      universe,
      scaleFactor: 1e-6,
      getBodyMesh: (name: string) => (universe.getBody(name) ? { position: new THREE.Vector3() } : undefined),
    } as unknown as RendererContext;
    const body = universe.getBody('Titan mosaic')!;
    const vis = new ObservationsVisualizer();
    const obj = vis.createVisual(body, ctx);
    const meshes = obj.children as [THREE.Mesh, THREE.LineSegments];
    /** Update at `et` for enough frames that the per-frame footprint budget
     *  has caught up. A fixed count, not "until nothing changes": a frame
     *  spent entirely on failed samples changes nothing and is not the end. */
    const at = (et: number) => {
      for (let i = 0; i < 40; i++) vis.updateVisual(obj, body, et, [0, 0, 0], ctx);
      return { visible: obj.visible, fill: meshes[0], outline: meshes[1] };
    };
    return { at, body, vis, obj };
  }

  const vertexCount = (m: THREE.Object3D) =>
    ((m as THREE.Mesh).geometry.getAttribute('position')?.count ?? 0);

  const groups = (obsRate: number) => [{ startTime: START, endTime: END, obsRate }];
  // 50 minutes later the same day during which every NAC footprint is wholly
  // on Titan (scanned at 20 s), so a swath's triangle counts are exact.
  const C0 = 142029600;
  const C1 = 142032600;
  const steady = [{ startTime: C0, endTime: C1, obsRate: 0 }];

  it('loads a Cosmographia observation item that names no trajectory, at its target', () => {
    const { body } = scene({ sensor: 'ISS NAC', groups: groups(0) });
    expect(body.stateAt(startEt).position).toEqual([0, 0, 0]);
  });

  it('draws nothing before the window opens', () => {
    expect(scene({ sensor: 'ISS NAC', groups: groups(60) }).at(startEt - 600).visible).toBe(false);
  });

  it('obsRate > 0 gives discrete footprints; obsRate 0 a continuous swath', () => {
    const discrete = scene({ sensor: 'ISS NAC', groups: groups(120), sideDivisions: 4, fillInObservations: true }).at(endEt);
    const swath = scene({ sensor: 'ISS NAC', groups: groups(0), sideDivisions: 4, alongTrackDivisions: 9, fillInObservations: true }).at(endEt);
    // 4 sides × 4 rays: a whole footprint is 16 outline segments = 32 vertices.
    const discretePrints = vertexCount(discrete.outline) / 32;
    expect(discretePrints).toBeGreaterThanOrEqual(3);
    // Discrete stamps are fans only (16 triangles each, every one laid on the
    // surface as FILL_STEPS² = 36 pieces); a swath adds the strips joining
    // consecutive footprints, so it has more fill than its fans.
    const FAN = 16 * 36 * 3;
    expect(vertexCount(discrete.fill)).toBe(discretePrints * FAN);
    const swathPrints = vertexCount(swath.outline) / 32;
    expect(vertexCount(swath.fill)).toBeGreaterThan(swathPrints * FAN);
  });

  it('fillInObservations is filled or outlined — never both — and not accumulation', () => {
    const outlined = scene({ sensor: 'ISS NAC', groups: groups(120), sideDivisions: 4 }).at(endEt);
    const filled = scene({ sensor: 'ISS NAC', groups: groups(120), sideDivisions: 4, fillInObservations: true }).at(endEt);
    const fillShown = (m: THREE.Mesh) => m.visible && (m.material as THREE.Material).visible;
    expect(fillShown(outlined.fill)).toBe(false);
    expect(outlined.outline.visible).toBe(true);
    expect(fillShown(filled.fill)).toBe(true);
    expect(filled.outline.visible).toBe(false);
    // Same footprints either way.
    expect(vertexCount(outlined.outline)).toBe(vertexCount(filled.outline));
  });

  it('accumulates with the clock', () => {
    const s = scene({ sensor: 'ISS NAC', groups: groups(120), sideDivisions: 4 });
    const early = vertexCount(s.at(startEt + 130).outline);
    const late = vertexCount(s.at(endEt).outline);
    expect(early).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(early);
    // And back: scrubbing before the window clears it.
    expect(s.at(startEt - 1).visible).toBe(false);
  });

  it('is contextual: gone after its window unless focused or shown-all', () => {
    const s = scene({ sensor: 'ISS NAC', groups: groups(120), sideDivisions: 4 });
    expect(s.at(endEt).visible).toBe(true);
    expect(s.at(endEt + 3600).visible).toBe(false);
    s.vis.setFocus(['Titan mosaic']);
    const focused = s.at(endEt + 3600);
    expect(focused.visible).toBe(true);
    expect(vertexCount(focused.outline)).toBeGreaterThan(0);
    s.vis.setFocus([]);
    expect(s.at(endEt + 3600).visible).toBe(false);
    s.vis.setShowAll(true);
    expect(s.at(endEt + 3600).visible).toBe(true);
  });

  it('a click on a footprint hits the observation, ahead of the ground under it', () => {
    const s = scene({ sensor: 'ISS NAC', groups: groups(120), sideDivisions: 4 });
    s.at(endEt);
    const targets = s.vis.pickTargets(s.obj);
    expect(targets).toHaveLength(1);
    // Down onto the first footprint vertex from far outside Titan.
    s.obj.updateMatrixWorld(true);
    const pos = (targets[0] as THREE.Mesh).geometry.getAttribute('position');
    const p = new THREE.Vector3(pos.getX(0), pos.getY(0), pos.getZ(0)).applyMatrix4(s.obj.matrixWorld);
    const ray = new THREE.Raycaster(p.clone().multiplyScalar(3), p.clone().negate().normalize());
    const globe = new THREE.Mesh(new THREE.SphereGeometry(2575e-6, 64, 32));
    const hits = ray.intersectObjects([globe, ...targets], true);
    expect(hits[0]!.object).toBe(targets[0]);
    // Hidden observations are not pickable.
    s.at(startEt - 1);
    expect(s.vis.pickTargets(s.obj)).toEqual([]);
  });

  /** The engine with a CK gap: sincpt fails for `inGap` instants, as it does
   *  with no attitude, and every call is counted. */
  function withGap(inGap: (et: number) => boolean) {
    const calls = { total: 0 };
    const gapped = new Proxy(spice, {
      get(target, key) {
        if (key === 'sincpt') {
          return (...args: unknown[]) => {
            calls.total++;
            if (inGap(args[2] as number)) throw new Error('SPICE(NOFRAMECONNECT): no CK at this instant');
            return (target as unknown as { sincpt: (...a: unknown[]) => unknown }).sincpt(...args);
          };
        }
        const v = (target as unknown as Record<string | symbol, unknown>)[key];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as SpiceInstance;
    return { gapped, calls };
  }

  it('a CK gap before valid coverage does not starve the later footprints', () => {
    // 40 samples; the first 30 — more than one frame's budget — have no CK.
    const step = (C1 - C0) / 39;
    const { gapped, calls } = withGap((et) => et < C0 + 29.5 * step);
    const s = scene({ sensor: 'ISS NAC', groups: steady, alongTrackDivisions: 39, sideDivisions: 4 }, gapped);
    const r = s.at(C1);
    // The 10 samples after the gap, all drawn.
    expect(vertexCount(r.outline)).toBe(10 * 32);
    // With the clock paused at C1 throughout: progress came from frames, not
    // from the clock moving. And failures are remembered: further frames at
    // the same instant call nothing.
    const before = calls.total;
    s.at(C1);
    expect(calls.total).toBe(before);
  });

  it('a swath is not bridged across a gap inside it', () => {
    const step = (C1 - C0) / 9;
    const opts = { sensor: 'ISS NAC', groups: steady, alongTrackDivisions: 9, sideDivisions: 4, fillInObservations: true };
    const whole = scene(opts).at(C1);
    // Every sample whole, so the counts are exact: 16 fan triangles per
    // footprint and 32 strip triangles per adjacent pair, each laid on the
    // surface as 36 pieces.
    expect(vertexCount(whole.outline)).toBe(10 * 32);
    const FAN = 16 * 36 * 3;
    const STRIP = 32 * 36 * 3;
    expect(vertexCount(whole.fill)).toBe(10 * FAN + 9 * STRIP);
    // Samples 4 and 5 fail: 8 footprints, and only the 6 truly adjacent pairs
    // (0-1, 1-2, 2-3, 6-7, 7-8, 8-9) are joined.
    const { gapped } = withGap((et) => et > C0 + 3.5 * step && et < C0 + 5.5 * step);
    const gappy = scene(opts, gapped).at(C1);
    expect(vertexCount(gappy.outline)).toBe(8 * 32);
    expect(vertexCount(gappy.fill)).toBe(8 * FAN + 6 * STRIP);
  });

  it('every drawn vertex, fill included, sits just above Titan — not on a chord under it', () => {
    const { outline, fill } = scene({ sensor: 'ISS NAC', groups: groups(120), sideDivisions: 4, fillInObservations: true }).at(endEt);
    const radius = spice.bodvcd(606, 'RADII')[0]!;
    for (const m of [outline, fill]) {
      const pos = m.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
        expect(r).toBeGreaterThan(radius * 1.001);
        expect(r).toBeLessThan(radius * 1.003);
      }
    }
  });

  it('renders a given footprint through the same item, holes left unfilled', () => {
    const ring = [[10, 5], [20, 5], [20, 15], [10, 15], [10, 5]];
    const hole = [[13, 8], [17, 8], [17, 12], [13, 12], [13, 8]];
    const s = scene({ coverage: { kind: 'footprint', polygonLonLat: [ring], holesLonLat: [[hole]] }, groups: groups(0) });
    expect(s.at(startEt - 1).visible).toBe(false);
    const { visible, outline, fill } = s.at(startEt);
    expect(visible).toBe(true);
    // Both rings outlined (closing vertex dropped): 4 + 4 segments.
    expect(vertexCount(outline)).toBe(8 * 2);
    // No fill triangle lies inside the hole.
    const pos = fill.geometry.getAttribute('position');
    expect(pos.count).toBeGreaterThan(0);
    for (let i = 0; i < pos.count; i += 3) {
      const c = new THREE.Vector3();
      for (let k = 0; k < 3; k++) c.add(new THREE.Vector3(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k)));
      const lon = (Math.atan2(c.y, c.x) * 180) / Math.PI;
      const lat = (Math.atan2(c.z, Math.hypot(c.x, c.y)) * 180) / Math.PI;
      expect(lon > 13.01 && lon < 16.99 && lat > 8.01 && lat < 11.99, `triangle centred at ${lon}, ${lat}`).toBe(false);
    }
  });

  it('draws a sensor `active` window through the same model', () => {
    const universe = new Universe(spice);
    universe.loadCatalog(catalog({ sensor: 'ISS NAC', groups: groups(0) }));
    const ctx = {
      universe, scaleFactor: 1e-6,
      getBodyMesh: (name: string) => (universe.getBody(name) ? { position: new THREE.Vector3() } : undefined),
    } as unknown as RendererContext;
    const obs = observationFromSensorActive('ISS NAC', { target: 'Titan', active: [{ start: START, end: END }] }, (t) => spice.str2et(String(t)))!;
    const vis = new ObservationsVisualizer();
    const obj = vis.createVisualForObservation({ ...obs, sideDivisions: 4, alongTrackDivisions: 9 }, ctx);
    for (let i = 0; i < 5; i++) vis.updateObservation(obj, endEt, ctx);
    expect(obj.visible).toBe(true);
    expect(vertexCount(obj.children[1]!)).toBeGreaterThan(0);
  });
});
