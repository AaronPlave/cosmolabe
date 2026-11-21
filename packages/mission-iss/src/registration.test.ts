import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { Universe, type CatalogJson } from '@cosmolabe/core';
import { installMissionPlugins } from '@cosmolabe/three';
import registration from './registration.js';

const catalog = (name: string): CatalogJson => JSON.parse(readFileSync(new URL(`../../../apps/viewer/test-catalogs/${name}`, import.meta.url), 'utf8'));
const load = (json: CatalogJson) => { const u = new Universe(); u.loadCatalog(json as never); return u; };

describe('ISS mission plugin registration', () => {
  it('applies to the public Earth from Orbit catalog (offline, no SPICE) and installs one plugin', () => {
    const universe = load(catalog('iss.json'));
    expect(registration.appliesTo(universe)).toBe(true);
    const used: unknown[] = [];
    expect(installMissionPlugins({ use: (p) => used.push(p) }, universe, [registration])).toEqual(['iss-articulation']);
    expect(used).toHaveLength(1);
  });

  it('does not apply to an unrelated catalog, so it never inherits the plugin', () => {
    const universe = load({
      name: 'Unrelated',
      items: [{ name: 'Probe', class: 'spacecraft', trajectory: { type: 'FixedPoint', position: [7000, 0, 0] }, geometry: { type: 'Mesh', source: 'models/Cassini.glb', size: 0.01 } }],
    } as never);
    expect(registration.appliesTo(universe)).toBe(false);
    const used: unknown[] = [];
    expect(installMissionPlugins({ use: (p) => used.push(p) }, universe, [registration])).toEqual([]);
    expect(used).toEqual([]);
  });

  it('creates an independent plugin for each scene', () => {
    expect(registration.create()).not.toBe(registration.create());
  });
});
