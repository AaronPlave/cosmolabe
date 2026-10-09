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
import { Universe, type CatalogJson, type SpiceInstance } from '@cosmolabe/core';
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

  function scene(observation: Record<string, unknown>) {
    const universe = new Universe(spice);
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
    /** Update at `et` until the per-frame footprint budget has caught up. */
    const at = (et: number) => {
      let last = -1;
      for (let i = 0; i < 50; i++) {
        vis.updateVisual(obj, body, et, [0, 0, 0], ctx);
        const n = vertexCount(meshes[0]) + vertexCount(meshes[1]);
        if (n === last) break;
        last = n;
      }
      return { visible: obj.visible, fill: meshes[0], outline: meshes[1] };
    };
    return { at, body };
  }

  const vertexCount = (m: THREE.Object3D) =>
    ((m as THREE.Mesh).geometry.getAttribute('position')?.count ?? 0);

  const groups = (obsRate: number) => [{ startTime: START, endTime: END, obsRate }];

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

  it('fillInObservations is filled vs outlined, not accumulation', () => {
    const outlined = scene({ sensor: 'ISS NAC', groups: groups(120), sideDivisions: 4 }).at(endEt);
    const filled = scene({ sensor: 'ISS NAC', groups: groups(120), sideDivisions: 4, fillInObservations: true }).at(endEt);
    expect(outlined.fill.visible).toBe(false);
    expect(filled.fill.visible).toBe(true);
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

  it('renders a given footprint through the same item', () => {
    const ring = [[10, 5], [20, 5], [20, 15], [10, 15]];
    const s = scene({ coverage: { kind: 'footprint', polygonLonLat: [ring] }, groups: groups(0) });
    expect(s.at(startEt - 1).visible).toBe(false);
    const { visible, outline } = s.at(startEt);
    expect(visible).toBe(true);
    expect(vertexCount(outline)).toBe(ring.length * 2);
  });
});
