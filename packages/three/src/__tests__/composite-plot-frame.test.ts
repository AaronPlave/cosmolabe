import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { Universe, CompositeTrajectory, type Body, type Vec3 } from '@cosmolabe/core';
import { UniverseRenderer } from '../UniverseRenderer.js';
import { TrajectoryLine } from '../TrajectoryLine.js';
import { TrajectoryPlotFrame } from '../TrajectoryPlotFrame.js';

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
  it('registers every actual MoonFall sortie and its moving marker in the same current-epoch frame', () => {
    const u = new Universe();
    u.loadCatalog(JSON.parse(readFileSync(new URL('../../../../apps/viewer/test-catalogs/moonfall-shackleton.json', import.meta.url), 'utf8')));
    u.frames.register({ name: 'IAU_MOON', kind: 'body-fixed', isStatic: false, toICRF: t => {
      const c = Math.cos(t / 50000), s = Math.sin(t / 50000);
      return [c, 0, s, 0, 1, 0, -s, 0, c];
    } });
    const lines = new Map<string, TrajectoryLine>(), frames = new WeakMap<TrajectoryLine, TrajectoryPlotFrame>();
    const renderer = Object.assign(Object.create(UniverseRenderer.prototype), {
      universe: u, trajectoryLines: lines, trajectoryPlotFrames: frames, scene: new THREE.Scene(),
    }) as { buildCompositeTrajectoryLines(body: Body, trajectory: CompositeTrajectory): void };
    for (const name of ['Polaris-A', 'Polaris-B', 'Polaris-C', 'Polaris-D']) {
      const body = u.getBody(name)!, composite = body.trajectory as CompositeTrajectory;
      renderer.buildCompositeTrajectoryLines(body, composite);
      for (const index of [0, 2, 4]) {
        const line = lines.get(`${name}__arc${index}`)!, plot = frames.get(line)!, arc = composite.arcs[index];
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
