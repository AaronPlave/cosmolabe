// Gaps in a trajectory's data stay gaps in everything drawn along it: the
// trail, its sample caches, the future lead and the runs annotations retrace.
// Breaks come from availability (unavailable samples, coverage windows, a
// source's evaluable runs), never from a distance or time-jump threshold.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  Body, HostDataAdapter, MissionStateManager, SpiceTrajectory, Universe,
  type CatalogJson, type MissionStateSink, type PositionBatch, type PositionConvention,
  type SpiceInstance, type Trajectory,
} from '@cosmolabe/core';
import { TrajectoryLine } from '../TrajectoryLine.js';
import { TrajectoryCache } from '../TrajectoryCache.js';
import type { DrawnTrail } from '../TrajectoryLine.js';

const MU = 398600.4418;
const R = 6778; // ~400 km LEO
const W = Math.sqrt(MU / R ** 3); // period ~92 min
const leo = (t: number): [number, number, number] => [R * Math.cos(W * t), R * Math.sin(W * t), 0];

/** No segment of any run, or of any drawn line strip, spans the open interval (a, b). */
function expectNoBridge(line: TrajectoryLine, a: number, b: number): void {
  for (const run of line.drawnPath()) {
    for (let i = 0; i < run.count; i++) {
      const t = run.times[i];
      expect(t > a && t < b, `vertex at ${t} lies inside the gap`).toBe(false);
      if (i > 0) expect(run.times[i - 1] <= a && t >= b, `segment ${run.times[i - 1]}→${t} bridges the gap`).toBe(false);
    }
  }
  // The geometry the GPU draws: one line strip per group, never across a gap.
  for (const object of line.children) {
    if (!(object instanceof THREE.Line) || object.name === 'lead') continue;
    const times = line.drawnTrail().times;
    const drawn = object.geometry.drawRange.count;
    expect(object.geometry.groups.reduce((n: number, g: { start: number; count: number }) => n + Math.min(g.count, drawn - g.start), 0)).toBe(drawn);
    for (const g of object.geometry.groups) {
      for (let i = g.start + 1; i < Math.min(g.start + g.count, drawn); i++) {
        expect(times[i - 1] <= a && times[i] >= b, `strip ${times[i - 1]}→${times[i]} bridges the gap`).toBe(false);
      }
    }
  }
}

/** The trail's runs in `drawnPath` (the lead's follow them). */
function trailRunsOnly(line: TrajectoryLine): DrawnTrail[] {
  const trail = line.drawnTrail();
  return line.drawnPath().filter((run) => run.positions.buffer === trail.positions.buffer);
}

// ── live telemetry ──

const POS: PositionConvention = {
  timeScale: 'TDB', frame: 'J2000', center: 'Earth', positionUnits: 'km', velocityUnits: 'km/s', maxSampleSpacing: 60,
};
const adapter = new HostDataAdapter('test-host');
const prov = { id: 'telemetry', kind: 'trajectory' as const, classification: 'authoritative' as const };

function batch(start: number, end: number, step = 10): PositionBatch {
  const samples = [];
  for (let t = start; t <= end; t += step) {
    const p = leo(t);
    samples.push({ t, position: p, velocity: [-R * W * Math.sin(W * t), R * W * Math.cos(W * t), 0] });
  }
  return { window: { start, end }, samples };
}

/** A spacecraft fed by a live telemetry stream; `push` delivers a window of samples. */
function telemetry() {
  const m = new MissionStateManager();
  const u = new Universe(undefined, { trajectoryFactories: m.trajectoryFactories, rotationFactories: m.rotationFactories });
  u.loadCatalog({
    name: 'telemetry-gap',
    items: [
      { name: 'Earth', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
      { name: 'SC', center: 'Earth', class: 'spacecraft', trajectory: { type: 'MissionState', source: 'sc' } },
    ],
  } as unknown as CatalogJson);
  m.bind(u);
  let sink!: MissionStateSink;
  m.addSource({ id: 'sc', position: POS, subscribe: (s) => { sink = s; return () => {}; } });
  const body = u.getBody('SC')!;
  return { body, push: (start: number, end: number) => sink.push('position', adapter.supply(batch(start, end), prov)) };
}

describe('trail gaps from a live telemetry outage', () => {
  // A 3-minute outage in a LEO pass: before the fix, one chord from the last
  // sample before it to the first after it cut across the orbit.
  const OUT_START = 3000;
  const OUT_END = 3180;

  it('draws the runs either side of the outage separately', () => {
    const { body, push } = telemetry();
    push(0, OUT_START);
    push(OUT_END, 5400);
    const line = new TrajectoryLine(body, { trailDuration: 5400, fadeFraction: 0 });
    line.update(5400, 1);
    const runs = trailRunsOnly(line);
    expect(runs).toHaveLength(2);
    expect(runs[0].times[runs[0].count - 1]).toBeLessThanOrEqual(OUT_START);
    expect(runs[1].times[0]).toBeGreaterThanOrEqual(OUT_END);
    expectNoBridge(line, OUT_START, OUT_END);
    line.dispose();
  });

  it('breaks at an outage narrower than the sample spacing, from the source\'s evaluable runs', () => {
    const { body, push } = telemetry();
    push(0, OUT_START);
    push(OUT_END, 5400);
    // Ten coarse samples ~600 s apart, no refinement: none lands in the outage.
    const line = new TrajectoryLine(body, { trailDuration: 5400, numKeySamples: 10, subdivisionPixels: 0 });
    line.update(5400, 1);
    expect(trailRunsOnly(line)).toHaveLength(2);
    expectNoBridge(line, OUT_START, OUT_END);
    line.dispose();
  });

  it('keeps the gap through incremental live updates, reused samples and a later backfill', () => {
    const { body, push } = telemetry();
    const line = new TrajectoryLine(body, { trailDuration: 5400, fadeFraction: 0 });
    push(0, OUT_START);
    line.update(OUT_START, 1);
    expect(trailRunsOnly(line)).toHaveLength(1);

    // The feed goes quiet: the playhead moves into the outage. Nothing is drawn past the last sample.
    for (const et of [3050, 3100, 3150]) {
      line.update(et, 1);
      const runs = trailRunsOnly(line);
      expect(runs).toHaveLength(1);
      expect(runs[0].times[runs[0].count - 1]).toBeLessThanOrEqual(OUT_START);
    }

    // Telemetry resumes. Frames between resamples reuse the sampled trail and
    // only move the head; resamples rebuild it. Neither joins the gap.
    let end = OUT_END;
    for (let et = OUT_END + 15; et <= 4200; et += 15) {
      if (et > end) { push(end, end + 120); end += 120; }
      line.update(et, 1);
      expectNoBridge(line, OUT_START, OUT_END);
      const runs = trailRunsOnly(line);
      expect(runs).toHaveLength(2);
      expect(runs[1].times[runs[1].count - 1]).toBe(et);
    }
    line.update(4200, 1); // same epoch again: the cached samples alone
    expectNoBridge(line, OUT_START, OUT_END);

    // The ground system backfills the outage. The renderer invalidates the
    // line on `body:trajectoryChanged`; the trail is then whole again.
    push(OUT_START, OUT_END);
    line.invalidate();
    line.update(4200, 1);
    expect(trailRunsOnly(line)).toHaveLength(1);
    line.dispose();
  });

  it('starts or ends at the outage when the trail window does', () => {
    const { body, push } = telemetry();
    push(0, OUT_START);
    push(OUT_END, 9000);
    const line = new TrajectoryLine(body, { trailDuration: 3000, fadeFraction: 0 });
    // Window [3100, 6100]: begins inside the outage.
    line.update(6100, 1);
    const runs = trailRunsOnly(line);
    expect(runs).toHaveLength(1);
    expect(runs[0].times[0]).toBeGreaterThanOrEqual(OUT_END);
    // Playhead inside the outage: the trail ends at the last sample before it.
    line.update(3100, 1);
    const ending = trailRunsOnly(line);
    expect(ending).toHaveLength(1);
    expect(ending[0].times[ending[0].count - 1]).toBeLessThanOrEqual(OUT_START);
    line.dispose();
  });
});

// ── discontinuous SPICE coverage ──

/** Two SPK coverage windows with a hole between: [0, 4000] and [5000, 9000]. */
const WINDOWS = [{ start: 0, end: 4000 }, { start: 5000, end: 9000 }];
const HOLE: [number, number] = [4000, 5000];
const inCoverage = (t: number) => WINDOWS.some((w) => t >= w.start && t <= w.end);

function spiceWithHole(): SpiceInstance {
  return {
    bodn2c: () => -999,
    spkcov: () => WINDOWS.map((w) => ({ ...w })),
    spkezr: (_target: string, et: number) => {
      if (!inCoverage(et)) throw new Error('SPKINSUFFDATA');
      const [x, y, z] = leo(et);
      return { state: [x, y, z, 0, 0, 0], lt: 0 };
    },
  } as unknown as SpiceInstance;
}

describe('trail gaps from discontinuous SPICE coverage', () => {
  it('reports the hole between SPK windows as unavailable', () => {
    const traj = new SpiceTrajectory(spiceWithHole(), 'SC', 'EARTH', 'J2000');
    expect(traj.availabilityAt(1000)).toMatchObject({ available: true });
    expect(traj.availabilityAt(4500)).toMatchObject({ available: false, reason: 'gap' });
    expect(traj.availabilityAt(-1)).toMatchObject({ available: false, reason: 'before-coverage' });
  });

  it('records the hole as a break in the trajectory cache, through simplification', () => {
    const resolve = (t: number) => (inCoverage(t) ? leo(t) : [NaN, NaN, NaN] as [number, number, number]);
    for (const maxPoints of [100_000, 40]) {
      const cache = TrajectoryCache.build(resolve, 0, 9000, { coverageWindows: WINDOWS, coarseInterval: 300, maxPoints });
      const breaks = [...cache.breaks.keys()].filter((i) => i > 0 && !cache.connects(i));
      expect(breaks).toHaveLength(1);
      const i = breaks[0];
      expect(cache.times[i - 1]).toBe(4000);
      expect(cache.times[i]).toBe(5000);
      // A worker round trip keeps it.
      const copy = TrajectoryCache.fromArrays(cache.times, cache.positions, cache.count, cache.breaks);
      expect(copy.connects(i)).toBe(false);
    }
  });

  it('breaks a cache built without coverage windows where the sampler found no data', () => {
    const resolve = (t: number) => (inCoverage(t) ? leo(t) : [NaN, NaN, NaN] as [number, number, number]);
    const cache = TrajectoryCache.build(resolve, 0, 9000, {
      coverageWindows: [{ start: 0, end: 9000 }], coarseInterval: 300,
    });
    for (let i = 1; i < cache.count; i++) {
      if (cache.times[i - 1] <= HOLE[0] && cache.times[i] >= HOLE[1]) expect(cache.connects(i)).toBe(false);
    }
  });

  it('keeps cached trail, live-sampled trail, lead and annotation runs apart across the hole', () => {
    const traj = new SpiceTrajectory(spiceWithHole(), 'SC', 'EARTH', 'J2000');
    const body = new Body({ name: 'SC', trajectory: traj });
    const resolve = (t: number) => traj.stateAt(t).position as [number, number, number];
    const cache = TrajectoryCache.build(resolve, 0, 9000, { coverageWindows: WINDOWS, coarseInterval: 300 });

    // Cached trail across the hole.
    const cached = new TrajectoryLine(body, { trailDuration: 9000, cache, fadeFraction: 0 });
    cached.update(9000, 1);
    expect(trailRunsOnly(cached)).toHaveLength(2);
    expectNoBridge(cached, ...HOLE);
    cached.dispose();

    // Live sampling coarse enough to step over the hole entirely.
    const live = new TrajectoryLine(body, { trailDuration: 9000, numKeySamples: 4, subdivisionPixels: 0 });
    live.update(9000, 1);
    expect(trailRunsOnly(live)).toHaveLength(2);
    expectNoBridge(live, ...HOLE);
    live.dispose();

    // A lead from before the hole to past it: cached and live both.
    for (const options of [{ cache }, { numKeySamples: 4, subdivisionPixels: 0 }]) {
      const line = new TrajectoryLine(body, { trailDuration: 3000, leadDuration: 5000, ...options });
      line.update(3000, 1);
      const lead = line.drawnPath().filter((run) => !trailRunsOnly(line).includes(run));
      expect(lead.length).toBeGreaterThanOrEqual(2);
      // drawnPath is what annotations (event strokes, picking, occlusion) retrace.
      expectNoBridge(line, ...HOLE);
      const segments = line.drawnLead();
      for (let k = 0; k + 1 < segments.count; k += 2) {
        expect(segments.times[k] <= HOLE[0] && segments.times[k + 1] >= HOLE[1]).toBe(false);
      }
      line.dispose();
    }
  });
});

describe('single-sample runs', () => {
  it('draws an isolated available sample as its own run, joined to nothing', () => {
    // Data on [0, 1000] and [2000, 3000], plus one instant at 1500 that a grid sample lands on.
    const ok = (t: number) => (t >= 0 && t <= 1000) || t === 1500 || (t >= 2000 && t <= 3000);
    const traj: Trajectory = {
      startTime: 0, endTime: 3000,
      stateAt: (t) => ({ position: ok(t) ? leo(t) : [NaN, NaN, NaN], velocity: [0, 0, 0] }),
    };
    const line = new TrajectoryLine(new Body({ name: 'SC', trajectory: traj }), {
      trailDuration: 3000, numKeySamples: 31, subdivisionPixels: 0,
    });
    line.update(3000, 1);
    const runs = trailRunsOnly(line);
    expect(runs.map((r) => r.count === 1 ? r.times[0] : null).filter((t) => t !== null)).toEqual([1500]);
    expectNoBridge(line, 1000, 1500);
    expectNoBridge(line, 1500, 2000);
    line.dispose();
  });
});
