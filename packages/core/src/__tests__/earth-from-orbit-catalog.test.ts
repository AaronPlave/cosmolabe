/**
 * The public `iss` entry (#368): Earth from Orbit. Offline checks of what the
 * catalog promises; `scripts/test-earth-from-orbit.mjs` checks the real service.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { CatalogLoader } from '../catalog/CatalogLoader.js';
import { TLETrajectory } from '../trajectories/TLETrajectory.js';
import { etFromDate } from '../time.js';

const root = new URL('../../../../apps/viewer/test-catalogs/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const iss = read('iss.json');
const earth = iss.items.find((i: { name: string }) => i.name === 'Earth');
const station = earth.items.find((i: { name: string }) => i.name === 'ISS');
const DAY = 86400;
const utcToEt = (iso: string) => etFromDate(new Date(iso));

describe('Earth from Orbit catalog', () => {
  it('keeps its public identity', () => {
    const entry = read('index.json').catalogs.find((e: { id: string }) => e.id === 'iss');
    expect(entry).toMatchObject({ id: 'iss', catalog: './iss.json', group: 'Explore', name: 'Earth from Orbit' });
    expect(iss.defaultViewpoint).toBe('Earth from orbit');
    const viewpoints = iss.items.filter((i: { type?: string }) => i.type === 'Viewpoint').map((i: { name: string }) => i.name);
    expect(viewpoints).toEqual(expect.arrayContaining([iss.defaultViewpoint, 'Track ISS', 'ISS Close-up']));
  });

  it('stacks a static Blue Marble base under one default-on dated VIIRS layer', () => {
    const layers = earth.geometry.imagery;
    expect(layers.map((l: { id: string }) => l.id)).toEqual(['blue-marble', 'viirs-daily']);
    expect(layers[0].temporal).toBeUndefined();
    const viirs = layers[1];
    expect(viirs.visible).not.toBe(false);
    expect(viirs.url).toContain('VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/2026-11-04/');
    expect(viirs.url).toContain('GoogleMapsCompatible_Level9');
    expect(viirs.temporal).toMatchObject({ semantics: 'acquisition', cadence: 'day', policy: 'follow-simulation', start: '2022-01-14', outOfRange: 'hide', illumination: 'baked' });
    expect(viirs.attribution).toMatch(/NASA GIBS/);
    expect(viirs.description).toMatch(/Not captured by the ISS/);
    // Neither the MODIS fixture's duplicate capabilities layer nor a terrain stack is imported here.
    expect(JSON.stringify(earth.geometry)).not.toMatch(/wmts-capabilities|"terrain"/);
  });

  it('draws the ISS only near the epoch of its CelesTrak TLE, never the 2011 element set', () => {
    const { line1, line2 } = station.trajectory;
    expect(line1).not.toContain('11042.40620627');
    const tle = new TLETrajectory({ line1, line2 });
    const epoch = tle.epochEt;
    // `epochEt` reads the TLE's UTC Julian date without leap seconds (about a minute), hence the tolerance.
    expect(Math.abs(epoch - utcToEt('2026-11-05T20:28:37Z'))).toBeLessThan(120);

    const { bodies } = new CatalogLoader().load(iss);
    const body = bodies.find((b) => b.name === 'ISS')!;
    const at = (iso: string) => body.existsAt(utcToEt(iso));
    expect(at(iss.defaultTime)).toBe(true);
    expect(Math.abs(utcToEt(iss.defaultTime) - epoch)).toBeLessThan(2 * DAY);
    expect(at('2026-11-07T20:00:00Z')).toBe(true);
    expect(at('2026-11-09T11:00:00Z')).toBe(false);
    expect(at('2026-11-02T11:00:00Z')).toBe(false);
    expect(at('2011-02-11T09:45:00Z')).toBe(false);
    // The window is the declared 3 days either side of the epoch.
    expect(Math.abs(body.existsFrom! - (epoch - 3 * DAY))).toBeLessThan(120);
    expect(Math.abs(body.existsUntil! - (epoch + 3 * DAY))).toBeLessThan(120);
  });

  it('gives the Moon its texture and IAU rotation, as the base Earth system does', () => {
    const moon = earth.items.find((i: { name: string }) => i.name === 'Moon');
    const reference = read('base/earth-system.json').items[0].items.find((i: { name: string }) => i.name === 'Moon');
    expect(moon.rotationModel).toEqual(reference.rotationModel);
    expect(moon.rotationModel).toEqual({ type: 'Builtin', name: 'IAU Moon' });
    expect(moon.geometry.baseMap).toBe('textures/moon-4k.jpg');
    expect(moon.geometry.radius).toBe(reference.geometry.radius);
    // The 16K normal map and Moon terrain stay out of this entry.
    expect(JSON.stringify(moon.geometry)).not.toMatch(/normalMap|displacement|terrain/);
  });

  it('leaves the MODIS fixture and its historical ISS TLE alone', () => {
    const fixture = read('earth-gibs-daily.json');
    const modis = fixture.items.find((i: { name: string }) => i.name === 'Earth');
    expect(modis.geometry.imagery.map((l: { id: string }) => l.id)).toEqual(['blue-marble', 'modis-daily', 'modis-daily-provider']);
    expect(JSON.stringify(fixture)).toContain('11042.40620627');
    expect(read('dev-index.json').catalogs.some((e: { catalog: string }) => e.catalog.includes('earth-gibs-daily.json'))).toBe(true);
  });
});
