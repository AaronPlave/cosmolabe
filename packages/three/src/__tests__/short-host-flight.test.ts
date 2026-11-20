// A minutes-long surface hop whose state a host supplies after the scene is
// built (a planning tool's simulation): the body-fixed plot frame has no
// state at scene construction, the data arrive later and may be replaced.
// The trail and its future lead must still draw the supplied path — the
// whole planned arc ahead of the playhead — and follow a replacement.
import { describe, expect, it } from 'vitest';
import {
  HostDataAdapter, MissionStateManager, Universe,
  type CatalogJson, type MissionStateSource, type PositionConvention, type Vec3,
} from '@cosmolabe/core';
import { TrajectoryLine } from '../TrajectoryLine.js';
import { TrajectoryPlotFrame } from '../TrajectoryPlotFrame.js';

const R = 1737.4;
const POS: PositionConvention = {
  timeScale: 'TDB', frame: 'IAU_TEST', center: 'Moon', positionUnits: 'km', velocityUnits: 'km/s', maxSampleSpacing: 2000,
};
const adapter = new HostDataAdapter('test-host');

/** Parked at the pole until `t0`, a `dur`-second ballistic-looking hop of `rangeKm` along +X, parked after. */
function hop(t0: number, dur: number, rangeKm: number) {
  return (t: number): Vec3 => {
    const u = Math.min(1, Math.max(0, (t - t0) / dur));
    const s = (1 - Math.cos(Math.PI * u)) / 2; // at rest at lift-off and touchdown
    return [rangeKm * s, 0, -R - 1.2 * Math.sin(Math.PI * s)];
  };
}
function source(path: (t: number) => Vec3, t0: number, dur: number): MissionStateSource {
  // Samples at the parked ends and every second in flight, as a simulation profile gives them.
  const times = [0, t0 - 0.001, ...Array.from({ length: dur + 1 }, (_, i) => t0 + i), t0 + dur + 0.001, 1000];
  const samples = times.map((t) => {
    const a = path(t - 0.01), b = path(t + 0.01);
    return { t, position: path(t), velocity: a.map((v, i) => (b[i] - v) / 0.02) };
  });
  const window = { start: 0, end: 1000 };
  return {
    id: 'hopper', position: POS, coverage: { position: window },
    request: async () => adapter.supply({ window, samples }, { id: 'sim', kind: 'trajectory', classification: 'planned' }),
  };
}

function scene() {
  const m = new MissionStateManager();
  const u = new Universe(undefined, { trajectoryFactories: m.trajectoryFactories, rotationFactories: m.rotationFactories });
  u.frames.register({ name: 'IAU_TEST', kind: 'body-fixed', isStatic: false, toICRF: (t) => {
    const c = Math.cos(t / 1e4), s = Math.sin(t / 1e4);
    return [c, -s, 0, s, c, 0, 0, 0, 1];
  } });
  u.loadCatalog({ name: 'short-host-flight', items: [
    { name: 'Moon', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
    { name: 'Hopper', center: 'Moon', class: 'spacecraft', trajectory: { type: 'MissionState', source: 'hopper' } },
  ] } as unknown as CatalogJson);
  m.bind(u);
  const body = u.getBody('Hopper')!;
  // As UniverseRenderer builds it: at scene load, before any source exists.
  // The body declares no trajectory frame: the source's convention names it, once the source exists.
  const plot = new TrajectoryPlotFrame(u, () => body.frame, 'IAU_TEST', 'Moon', (t) => body.stateAt(t).position, 0);
  const line = new TrajectoryLine(body, { fixedResolver: plot.resolve, trailDuration: 1200, leadDuration: 600, cacheResampleInterval: 2, fadeFraction: 0 });
  u.events.on('body:trajectoryChanged', ({ body: b }) => { if (b === body) line.invalidate(); });
  const load = async (s: MissionStateSource, et: number) => {
    if (m.sourceIds().includes(s.id)) m.replaceSource(s); else m.addSource(s);
    m.focus(et);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { plot, line, load };
}

/** Largest distance (km) between drawn vertices and the path they claim to show. */
function drawnError(run: { positions: Float32Array; times: Float64Array; count: number }, plot: TrajectoryPlotFrame, path: (t: number) => Vec3) {
  let worst = 0;
  for (let i = 0; i < run.count; i++) {
    const p = path(run.times[i]);
    worst = Math.max(worst, Math.hypot(...[0, 1, 2].map((k) => run.positions[3 * i + k] + plot.anchor[k] - p[k])));
  }
  return worst;
}

describe('a short host-supplied flight in a body-fixed plot frame', () => {
  it('draws the planned arc ahead once the source arrives, and follows a replacement', async () => {
    const { plot, line, load } = scene();
    line.update(50, 1);
    expect(line.drawnLead().count).toBe(0);

    const first = hop(100, 150, 2);
    await load(source(first, 100, 150), 50);
    line.update(50, 1);
    const lead = line.drawnLead();
    // The whole hop (100–250 s) is ahead of the playhead and drawn, through to landing.
    expect(lead.times[0]).toBeLessThanOrEqual(100);
    expect(lead.times[lead.count - 1]).toBeGreaterThanOrEqual(250);
    expect(drawnError(lead, plot, first)).toBeLessThan(1e-3);

    // Mid-flight: flown part as trail, the rest as lead, both on the path.
    line.update(180, 1);
    expect(line.drawnTrail().count).toBeGreaterThan(2);
    expect(drawnError(line.drawnTrail(), plot, first)).toBeLessThan(1e-3);
    expect(drawnError(line.drawnLead(), plot, first)).toBeLessThan(1e-3);

    // A new simulation flies elsewhere: no trace of the old path remains.
    const second = hop(100, 200, -3);
    await load(source(second, 100, 200), 180);
    line.update(180, 1);
    expect(drawnError(line.drawnTrail(), plot, second)).toBeLessThan(1e-3);
    expect(drawnError(line.drawnLead(), plot, second)).toBeLessThan(1e-3);
    line.dispose();
  });

  it('resamples a short trail at the declared interval rather than chording across a minute of flight', async () => {
    const { plot, line, load } = scene();
    const path = hop(100, 150, 2);
    await load(source(path, 100, 150), 120);
    line.update(120, 1);
    line.update(140, 1);
    const trail = line.drawnTrail();
    // Consecutive trail vertices up to the head are never more than a few seconds apart.
    for (let i = 1; i < trail.count; i++) {
      if (trail.times[i - 1] >= 100) expect(trail.times[i] - trail.times[i - 1]).toBeLessThanOrEqual(2.5);
    }
    expect(drawnError(trail, plot, path)).toBeLessThan(1e-3);
    line.dispose();
  });
});
