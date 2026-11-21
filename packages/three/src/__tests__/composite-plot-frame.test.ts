import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHeritageSpice } from '@cosmolabe/frames';
import * as THREE from 'three';
import { Universe, CompositeTrajectory, type Body, type Vec3 } from '@cosmolabe/core';
import { UniverseRenderer } from '../UniverseRenderer.js';
import { TrajectoryLine } from '../TrajectoryLine.js';
import { TrajectoryPlotFrame } from '../TrajectoryPlotFrame.js';
import { EventMarkers } from '../EventMarkers.js';

function fixture(frame: string, plot?: { frame: string }) {
  const u = new Universe();
  u.frames.register({ name: 'IAU_PARENT', kind: 'body-fixed', isStatic: false, toICRF: t => {
    const c = Math.cos(.3 + t / 10000), s = Math.sin(.3 + t / 10000);
    return [c, 0, s, 0, 1, 0, -s, 0, c];
  } });
  u.loadCatalog({ items: [{ name: 'Parent', trajectory: { type: 'FixedPoint', position: [10, 20, 30] },
    items: [{ name: 'Probe', trajectoryFrame: frame, trajectoryPlot: plot, arcs: [{ startTime: '2028-12-15T10:00:00Z',
      endTime: '2028-12-15T10:01:00Z', trajectoryFrame: frame,
      trajectory: { type: 'FixedPoint', position: [1, 2, 3] } }] }] }] });
  const lines = new Map<string, TrajectoryLine>(), frames = new WeakMap<TrajectoryLine, TrajectoryPlotFrame>();
  const renderer = Object.assign(Object.create(UniverseRenderer.prototype), {
    universe: u, trajectoryLines: lines, trajectoryPlotFrames: frames, scene: new THREE.Scene(),
  }) as { buildCompositeTrajectoryLines(body: Body, trajectory: CompositeTrajectory): void };
  const body = u.getBody('Probe')!;
  renderer.buildCompositeTrajectoryLines(body, body.trajectory as CompositeTrajectory);
  return { u, body, line: [...lines.values()][0], frames };
}

describe('composite trajectory plot frame defaults', () => {
  it('registers every actual DE421 MoonFall sortie and its moving marker in the same current-epoch frame', async () => {
    const spice = await createHeritageSpice();
    for (const name of ['naif0012.tls', 'pck00011.tpc', 'de440s.bsp', 'lro/moon_080317.tf', 'lro/moon_pa_de421_1900_2050.bpc']) {
      const url = new URL(`../../../../apps/viewer/test-catalogs/kernels/${name}`, import.meta.url);
      let bytes: Buffer;
      try { bytes = readFileSync(url); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        bytes = gunzipSync(readFileSync(new URL(`${url.href}.gz`)));
      }
      await spice.furnish({ type: 'buffer', data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, filename: name.split('/').pop()! });
    }
    const u = new Universe(spice);
    u.loadCatalog(JSON.parse(readFileSync(new URL('../../../../apps/viewer/test-catalogs/moonfall-shackleton.json', import.meta.url), 'utf8')));
    const lines = new Map<string, TrajectoryLine>(), frames = new WeakMap<TrajectoryLine, TrajectoryPlotFrame>();
    const renderer = Object.assign(Object.create(UniverseRenderer.prototype), {
      universe: u, trajectoryLines: lines, trajectoryPlotFrames: frames, scene: new THREE.Scene(),
    }) as { buildCompositeTrajectoryLines(body: Body, trajectory: CompositeTrajectory): void };
    for (const name of ['Polaris-A', 'Polaris-B', 'Polaris-C', 'Polaris-D']) {
      const body = u.getBody(name)!, composite = body.trajectory as CompositeTrajectory;
      renderer.buildCompositeTrajectoryLines(body, composite);
      for (const index of [0, 2, 4]) {
        const line = lines.get(`${name}__arc${index}`)!, plot = frames.get(line)!, arc = composite.arcs[index];
        expect(plot.frame).toBe('MOON_ME_DE421');
        for (const fraction of [.02, .5, .98]) {
          const sampleEt = arc.startTime + fraction * (arc.endTime - arc.startTime);
          const raw = arc.trajectory.stateAt(sampleEt).position;
          for (const et of [sampleEt, sampleEt + 10 * 86400]) {
            const center: Vec3 = [-40, 50, -90], scale = 1e-3;
            plot.place(line, center, scale, et);
            const actual = new THREE.Vector3(...line.positionAt(sampleEt)).multiplyScalar(scale).applyMatrix4(line.matrixWorld);
            const expected = u.toWorldFrame(raw, 'BodyFixed', 'Moon', et).map((v, i) => (v + center[i]) * scale);
            expect(actual.distanceTo(new THREE.Vector3(...expected))).toBeLessThan(1e-12);
          }
          // Also use Universe's full parent chain to check the marker pipeline.
          const marker = u.absolutePositionOf(name, sampleEt), moon = u.absolutePositionOf('Moon', sampleEt);
          const world = u.toWorldFrame(raw, 'BodyFixed', 'Moon', sampleEt);
          expect(Math.hypot(...world.map((v, i) => v - (marker[i] - moon[i])))).toBeLessThan(1e-6);
          line.update(sampleEt, 1); expect(line.drawnTrail().count).toBeGreaterThan(10);
        }
        // Exercise #301's fail-closed gate on #302's actual cached, anchored
        // flights, including lead requests and event glyph/span placement.
        const et = (arc.startTime + arc.trajectory.endTime!) / 2;
        expect(u.frames.isResolvable('IAU_MOON', et)).toBe(true);
        expect(u.frames.isResolvable('MOON_ME_DE421', et)).toBe(true);
        expect(line).toHaveProperty('cache.count', expect.any(Number));
        const events = new EventMarkers(body, { path: () => line.drawnPath(), sampleAvailable: t => line.sampleAvailableAt(t) });
        events.setMarkers([{ id: 'integration', queryId: 'integration', temporality: 'interval', kind: 'test', startEt: et - 20, endEt: et - 5, selected: true }]);
        line.setLeadRequest('integration', { target: { start: et + 5, end: et + 20 } });
        const update = () => {
          line.update(et, 1);
          events.update(1, [0,0,0], (_name,t) => line.positionAt(t), line.visibleTimeRange(et));
        };
        update();
        expect(events.anchorAt('integration', 'integration', et - 10)).not.toBeNull();
        const supplied = body.stateAt(et).position;
        body.surfaceTrajectory!.frame = 'IAU_MOON';
        update();
        expect(body.stateAt(et).position).toEqual(supplied);
        expect(u.absolutePositionOf(name, et).every(Number.isNaN)).toBe(true);
        expect(line.visible).toBe(false);
        expect(line.drawnPath()).toEqual([]);
        expect(line.leadWindows()).toEqual([]);
        expect(events.anchorAt('integration', 'integration', et - 10)).toBeNull();
        expect(events.children.every(child => !child.visible)).toBe(true);
        expect(events.spanEmphasis.visible).toBe(false);
        expect(events.spanPreview.visible).toBe(false);
        body.surfaceTrajectory!.frame = 'MOON_ME_DE421';
        update();
        expect(line.visible).toBe(true);
        expect(line.leadWindows().length).toBeGreaterThan(0);
        expect(events.anchorAt('integration', 'integration', et - 10)).not.toBeNull();
        events.dispose(); line.setLeadRequest('integration', null);
        line.update(arc.endTime + .001, 1); expect(line.visible).toBe(false);
      }
    }
    expect(lines.size).toBe(12);
    for (const line of lines.values()) line.dispose();
  });
  it('keeps body-fixed markers and paths coincident across days, rotations, origins and scales', () => {
    const { u, body, line, frames } = fixture('IAU_PARENT');
    const plot = frames.get(line)!;
    expect(plot).toBeDefined();
    for (const et of [0, 3600, 86400 * 10]) for (const center of [[10, 20, 30], [-400, 100, -90]] as Vec3[]) {
      plot.place(line, center, 1e-3, et);
      const local = plot.resolve(body.name, et);
      const drawn = new THREE.Vector3(...local).multiplyScalar(1e-3).applyMatrix4(line.matrixWorld);
      const marker = u.toWorldFrame([1, 2, 3], 'IAU_PARENT', 'Parent', et).map((v, i) => (v + center[i]) * 1e-3);
      expect(drawn.distanceTo(new THREE.Vector3(...marker))).toBeLessThan(1e-12);
    }
    line.dispose();
  });
  it('keeps inertial paths in historical world coordinates', () => {
    const { line, frames } = fixture('J2000');
    expect(frames.has(line)).toBe(false);
    line.dispose();
  });
  it('respects an explicit inertial plot override on a body-fixed source', () => {
    const { line, frames } = fixture('IAU_PARENT', { frame: 'J2000' });
    expect(frames.get(line)?.frame).toBe('EME2000');
    line.dispose();
  });
});
