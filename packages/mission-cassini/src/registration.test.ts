import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { Universe, type CatalogJson } from '@cosmolabe/core';
import { installMissionPlugins, type RendererContext } from '@cosmolabe/three';
import registration from './registration.js';
import { CassiniMissionPlugin } from './plugin.js';

const catalog = (name: string): CatalogJson =>
  JSON.parse(readFileSync(new URL(`../../../apps/viewer/test-catalogs/${name}`, import.meta.url), 'utf8'));

/** The demo's observations, with the Cassini sensors they name, loaded offline (no SPICE). */
function demo(): Universe {
  const obs = catalog('cassini-observations.json') as unknown as { items: unknown[] };
  const universe = new Universe();
  universe.loadCatalog({
    items: [
      { name: 'Saturn', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
      { name: 'Titan', center: 'Saturn', trajectory: { type: 'FixedPoint', position: [1e6, 0, 0] } },
      {
        name: 'Cassini', center: 'Saturn', trajectory: { type: 'FixedPoint', position: [2e6, 0, 0] },
        items: ['ISS NAC', 'ISS WAC'].map((name) => ({
          name, center: 'Cassini', trajectory: { type: 'FixedPoint', position: [0, 0, 0] }, geometry: { type: 'Sensor' },
        })),
      },
      ...obs.items,
    ],
  } as never);
  return universe;
}

describe('Cassini mission plugin registration', () => {
  it('applies to the Cassini observations demo and installs one plugin', () => {
    const used: unknown[] = [];
    expect(installMissionPlugins({ use: (p) => used.push(p) }, demo(), [registration])).toEqual(['cassini-observations']);
    expect(used).toHaveLength(1);
  });

  it('does not apply to a Cassini scene without observations', () => {
    const universe = new Universe();
    universe.loadCatalog({ items: [{ name: 'Cassini', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } }] } as never);
    expect(registration.appliesTo(universe)).toBe(false);
  });

  it('groups the demo into its 22 archive campaigns, labels raw, and ticks every frame', () => {
    const plugin = new CassiniMissionPlugin();
    const ctx = { universe: demo() } as unknown as RendererContext;
    const [campaigns, frames] = plugin.ui.timelineTracks!;
    const spans = campaigns!.getIntervals(-Infinity, Infinity, ctx);
    expect(spans).toHaveLength(22);
    expect(spans.some((s) => s.label?.startsWith('ISS_000RI_SOISPTURN183_SP · '))).toBe(true);
    expect(frames!.getIntervals(-Infinity, Infinity, ctx)).toHaveLength(514);
  });

  it('creates an independent plugin for each scene', () => {
    expect(registration.create()).not.toBe(registration.create());
  });
});
