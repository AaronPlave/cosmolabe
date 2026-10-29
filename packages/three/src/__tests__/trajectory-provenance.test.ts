import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Body, CompositeTrajectory, FixedPointTrajectory, Universe, type SurfaceTrajectoryProvenance } from '@cosmolabe/core';
import { EventMarkers } from '../EventMarkers.js';
import { TrajectoryCache } from '../TrajectoryCache.js';
import { TrajectoryLine } from '../TrajectoryLine.js';
import { UniverseRenderer, trajectoryLineResolver } from '../UniverseRenderer.js';

function fixture(composite: boolean, plotted: boolean) {
  const universe = new Universe();
  universe.frames.register({ name: 'SURFACE_A', kind: 'body-fixed', isStatic: true, toICRF: () => [1,0,0,0,1,0,0,0,1] });
  universe.frames.register({ name: 'SURFACE_B', kind: 'body-fixed', isStatic: true, toICRF: () => [0,-1,0,1,0,0,0,0,1] });
  const provenance: SurfaceTrajectoryProvenance = { frame: 'SURFACE_A', positionUnits: 'km', purpose: 'supplied',
    datum: { referenceShape: { kind: 'sphere', radiusKm: 1 }, verticalDatum: 'reference-sphere', heightConvention: 'radial' } };
  universe.addBody(new Body({ name: 'Center', trajectory: new FixedPointTrajectory([0,0,0]) }));
  const trajectory = new FixedPointTrajectory([1,2,3], { frame: 'SURFACE_A' });
  const arcs = new CompositeTrajectory([{ trajectory, startTime: 0, endTime: 100, centerName: 'Center' }]);
  const body = new Body({ name: 'Probe', parentName: 'Center', trajectory: composite ? arcs : trajectory,
    trajectoryFrame: 'SURFACE_A', surfaceTrajectory: provenance, trajectoryPlot: plotted ? { frame: 'SURFACE_A', duration: 100 } : { duration: 100 } });
  universe.addBody(body);
  let line: TrajectoryLine;
  if (composite) {
    // Exercise the actual arc-resolver/plot wiring without constructing WebGL.
    const renderer = Object.assign(Object.create(UniverseRenderer.prototype), {
      universe, trajectoryLines: new Map(), trajectoryPlotFrames: new WeakMap(), scene: new THREE.Scene(),
    });
    renderer.buildCompositeTrajectoryLines(body, arcs);
    line = renderer.trajectoryLines.get('Probe__arc0');
  } else {
    line = new TrajectoryLine(body, { trailDuration: 100, minTime: 0, maxTime: 100,
      sampleAvailable: t => universe.trajectoryPlacementAvailable(body, t) });
  }
  return { universe, body, line, provenance };
}

describe('surface provenance on trajectory paths and annotations', () => {
  it.each([
    [false, false, false], [false, false, true], [true, false, false],
    [true, false, true], [true, true, false], [true, true, true],
  ])('withholds and restores live/cached paths (composite=%s, plot=%s, cache=%s)', (composite, plotted, cached) => {
    const { universe, body, line, provenance } = fixture(composite, plotted);
    const resolver = trajectoryLineResolver(universe, line);
    expect(universe.frames.isResolvable('SURFACE_A', 50)).toBe(true);
    expect(universe.frames.isResolvable('SURFACE_B', 50)).toBe(true);
    expect(universe.frames.rotation('SURFACE_A', 'SURFACE_B', 50)).not.toEqual([1,0,0,0,1,0,0,0,1]);
    if (cached) line.setCache(TrajectoryCache.build(t => line.positionAt(t, resolver), 0, 100,
      { coarseInterval: 10, coverageWindows: [{ start: 0, end: 100 }] }));
    line.setLeadRequest('test', { target: { start: 60, end: 95 } });
    const markers = new EventMarkers(body, { path: () => line.drawnPath(), sampleAvailable: t => line.sampleAvailableAt(t) });
    markers.setMarkers([{ id: 'event', queryId: 'query', temporality: 'interval', kind: 'test', startEt: 10, endEt: 40, selected: true }]);
    const update = () => {
      line.update(50, 1, resolver);
      markers.update(1, [0,0,0], (_name,t) => line.positionAt(t, resolver), line.visibleTimeRange(50));
    };
    update();
    expect(line.visible).toBe(true);
    expect(line.drawnTrail().count).toBeGreaterThan(0);
    expect(line.leadWindows().length).toBeGreaterThan(0);
    expect(markers.anchorAt('event', 'query', 25)).not.toBeNull();
    const source = body.stateAt(50).position;
    provenance.frame = 'SURFACE_B'; // Both orientations still resolve; only provenance contradicts.
    update();
    expect(body.stateAt(50).position).toEqual(source);
    expect(universe.absolutePositionOf(body.name, 50).every(Number.isNaN)).toBe(true);
    expect(universe.relativePositionInWorld(body.name, 50).every(Number.isNaN)).toBe(true);
    expect(line.positionAt(25, resolver).every(Number.isNaN)).toBe(true);
    expect(line.visible).toBe(false);
    expect(line.drawnPath()).toEqual([]);
    expect(line.leadWindows()).toEqual([]);
    expect(markers.anchorAt('event', 'query', 25)).toBeNull();
    expect(markers.children.every(child => !child.visible)).toBe(true);
    expect(markers.spanEmphasis.visible).toBe(false);
    expect(markers.spanPreview.visible).toBe(false);
    provenance.frame = 'SURFACE_A';
    update();
    expect(line.visible).toBe(true);
    expect(line.drawnTrail().count).toBeGreaterThan(0);
    expect(markers.anchorAt('event', 'query', 25)).not.toBeNull();
    markers.dispose(); line.dispose();
  });

  it('checks an inactive arc against its own frame, not the active arc frame', () => {
    const { universe, provenance, line } = fixture(true, false);
    line.dispose();
    const arcs = new CompositeTrajectory([
      { trajectory: new FixedPointTrajectory([1,2,3], { frame: 'SURFACE_A' }), startTime: 0, endTime: 50, centerName: 'Center' },
      { trajectory: new FixedPointTrajectory([1,2,3], { frame: 'SURFACE_B' }), startTime: 50, endTime: 100, centerName: 'Center' },
    ]);
    const body = new Body({ name: 'Two arcs', parentName: 'Center', trajectory: arcs, surfaceTrajectory: provenance });
    universe.addBody(body);
    const renderer = Object.assign(Object.create(UniverseRenderer.prototype), {
      universe, trajectoryLines: new Map(), trajectoryPlotFrames: new WeakMap(), scene: new THREE.Scene(),
    });
    renderer.buildCompositeTrajectoryLines(body, arcs);
    const second: TrajectoryLine = renderer.trajectoryLines.get('Two arcs__arc1');
    expect(universe.trajectoryPlacementAvailable(body, 25)).toBe(true); // Active A agrees.
    expect(second.sampleAvailableAt(25)).toBe(false); // Inactive B still contradicts.
    expect(second.positionAt(25).every(Number.isNaN)).toBe(true);
    for (const l of renderer.trajectoryLines.values()) l.dispose();
  });
});
