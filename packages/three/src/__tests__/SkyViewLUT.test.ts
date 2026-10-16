import { describe, expect, it } from 'vitest';
import { extinctionAt, normalizeAtmosphere } from '../AtmosphereModel.js';
import { getAtmospherePreset } from '../AtmosphereMesh.js';

const radius = 6378.1;
const model = normalizeAtmosphere(getAtmospherePreset('Earth')!);
const shell = radius + model.heightKm;
const cap = radius - model.planetCapBias * shell;
const rows = 108;

// CPU reference for the shell shader's midpoint extinction integral. Unlike
// transmittanceToSpace, this stops at the inset analytic cap, not the planet.
function direct(altitude: number, theta: number, steps: number): number {
  const eye = radius + altitude;
  const mu = Math.cos(theta);
  const shellRoot = Math.sqrt((eye * mu) ** 2 - (eye ** 2 - shell ** 2));
  const enter = Math.max(0, -eye * mu - shellRoot);
  const exit = -eye * mu + shellRoot;
  const capDisc = (eye * mu) ** 2 - (eye ** 2 - cap ** 2);
  const capHit = capDisc > 0 ? -eye * mu - Math.sqrt(capDisc) : Infinity;
  const end = capHit > enter ? Math.min(exit, capHit) : exit;
  const step = (end - enter) / steps;
  const depth = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const distance = enter + (i + 0.5) * step;
    const height = Math.max(0, Math.sqrt(eye ** 2 + distance ** 2 + 2 * eye * mu * distance) - radius);
    const extinction = extinctionAt(model, height);
    for (let channel = 0; channel < 3; channel++) depth[channel] += extinction[channel] * step;
  }
  return depth.reduce((sum, value) => sum + Math.exp(-value) / 3, 0);
}

function horizon(altitude: number): number {
  return Math.PI - Math.asin(cap / (radius + altitude));
}

function rowTheta(row: number, tangent: number): number {
  const v = (row + 0.5) / rows;
  if (v < 0.5) return tangent * (1 - (1 - 2 * v) ** 2);
  return tangent + (Math.PI - tangent) * (2 * v - 1) ** 2;
}

function filtered(altitude: number, theta: number): number {
  const tangent = horizon(altitude);
  const sky = theta < tangent;
  const v = sky
    ? (1 - Math.sqrt(Math.max(0, 1 - theta / tangent))) / 2
    : (1 + Math.sqrt(Math.max(0, (theta - tangent) / (Math.PI - tangent)))) / 2;
  const minRow = sky ? 0 : rows / 2;
  const maxRow = sky ? rows / 2 - 1 : rows - 1;
  const position = Math.max(minRow, Math.min(maxRow, v * rows - 0.5));
  const lower = Math.floor(position);
  const upper = Math.min(maxRow, lower + 1);
  const blend = position - lower;
  return direct(altitude, rowTheta(lower, tangent), 16) * (1 - blend) +
    direct(altitude, rowTheta(upper, tangent), 16) * blend;
}

describe('sky-view horizon sampling', () => {
  it('tracks direct extinction on both sides of the cap tangent at multiple altitudes', () => {
    for (const altitude of [0, 50, 99.99]) {
      for (const offsetDegrees of [-0.5, -0.05, -0.005, 0.005, 0.05, 0.5]) {
        const theta = horizon(altitude) + offsetDegrees * Math.PI / 180;
        const actual = filtered(altitude, theta);
        const reference = direct(altitude, theta, 16);
        expect(Math.abs(actual - reference), `${altitude} km, ${offsetDegrees}°`).toBeLessThan(0.025);
      }
    }
  });

  it('remains close to the orbital path through the shell boundary', () => {
    for (const offsetDegrees of [-0.5, -0.05, 0.05, 0.5]) {
      const theta = horizon(100) + offsetDegrees * Math.PI / 180;
      const inside = filtered(99.99, theta);
      const outside = direct(100.01, theta, 8);
      expect(Math.abs(inside - outside), `${offsetDegrees}°`).toBeLessThan(0.025);
    }
  });
});
