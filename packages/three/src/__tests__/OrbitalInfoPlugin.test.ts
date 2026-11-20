import { describe, expect, it } from 'vitest';
import { Body, FixedPointTrajectory, InterpolatedStatesTrajectory, Universe } from '@cosmolabe/core';
import { OrbitalInfoPlugin, conicElements } from '../plugins/stock/OrbitalInfoPlugin.js';
import type { RendererContext } from '../plugins/RendererContext.js';
import type { InfoRow } from '../plugins/PluginUI.js';

const MU = 398600.44;
const R = 6778;
const V = Math.sqrt(MU / R);

/** A circular LEO sampled every 10 s, with telemetry missing from 100 s to 400 s. */
function leoWithOutage() {
  const universe = new Universe();
  universe.addBody(new Body({ name: 'Earth', trajectory: new FixedPointTrajectory([0, 0, 0]) }));
  const n = V / R;
  const records = Array.from({ length: 61 }, (_, i) => {
    const et = i * 10;
    return {
      et,
      position: [R * Math.cos(n * et), R * Math.sin(n * et), 0] as [number, number, number],
      velocity: [-V * Math.sin(n * et), V * Math.cos(n * et), 0] as [number, number, number],
    };
  });
  const trajectory = new InterpolatedStatesTrajectory(records, { coverage: [{ start: 0, end: 100 }, { start: 400, end: 600 }] });
  universe.addBody(new Body({ name: 'SC', parentName: 'Earth', trajectory }));
  const ctx = { universe } as unknown as RendererContext;
  const section = new OrbitalInfoPlugin().ui.infoSections![0];
  // The plugin only ever returns structured rows.
  const render = (et: number) => section.render(universe.getBody('SC')!, et, ctx) as { rows: InfoRow[] } | null;
  return { universe, render };
}

describe('OrbitalInfoPlugin', () => {
  it('shows elements while the state is covered, and nothing inside a telemetry gap', () => {
    const { render } = leoWithOutage();
    const covered = render(50);
    expect(covered?.rows.find(r => r.label === 'Eccentricity')?.value).toBe('0.0000');
    expect(covered?.rows.map(r => r.value).join(' ')).not.toMatch(/NaN|Infinity/);
    expect(render(250)).toBeNull();
    expect(render(-50)).toBeNull();
    expect(render(700)).toBeNull();
  });

  it('shows nothing when a body it is placed relative to has no state', () => {
    const { universe, render } = leoWithOutage();
    universe.addBody(new Body({ name: 'Earth', trajectory: new FixedPointTrajectory([NaN, NaN, NaN]) }));
    expect(render(50)).toBeNull();
  });
});

describe('conicElements', () => {
  it('refuses a non-finite, motionless or rectilinear state', () => {
    expect(conicElements([NaN, 0, 0], [0, V, 0], MU, 'Earth')).toBeNull();
    expect(conicElements([R, 0, 0], [0, 0, 0], MU, 'Earth')).toBeNull();
    expect(conicElements([R, 0, 0], [3, 0, 0], MU, 'Earth')).toBeNull();
  });

  it('keeps periapsis finite through a parabola, where there is no semi-major axis or period', () => {
    const e = conicElements([R, 0, 0], [0, Math.sqrt(2 * MU / R), 0], MU, 'Earth')!;
    expect(e.a).toBeNull();
    expect(e.period).toBeNull();
    expect(e.apoapsis).toBeNull();
    expect(e.periapsis).toBeCloseTo(R, 3);
  });

  it('gives a hyperbola a negative semi-major axis and no apoapsis or period', () => {
    const e = conicElements([R, 0, 0], [0, 1.2 * Math.sqrt(2 * MU / R), 0], MU, 'Earth')!;
    expect(e.ecc).toBeGreaterThan(1);
    expect(e.a!).toBeLessThan(0);
    expect(e.apoapsis).toBeNull();
    expect(e.period).toBeNull();
    expect(e.periapsis).toBeCloseTo(R, 3);
  });
});
