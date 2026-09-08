import { describe, expect, it } from 'vitest';
import { TerrainSampler, bodyFixedToGeodetic, geodeticToBodyFixed, type TerrainDatum } from '../TerrainSampler.js';

const datum: TerrainDatum = {
  referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] },
  verticalDatum: 'ellipsoid',
  heightConvention: 'geodetic-normal',
};

describe('TerrainSampler', () => {
  it('bilinearly interpolates decoded CPU height tiles without renderer geometry', () => {
    const sampler = new TerrainSampler(datum, { id: 'test', kind: 'height-grid' });
    sampler.addTile({ id: 'grid', westDeg: 0, eastDeg: 10, southDeg: 0, northDeg: 10, width: 2, height: 2, elevationsKm: new Float32Array([0, 10, 20, 30]) });
    expect(sampler.sample(5, 5)?.elevationKm).toBeCloseTo(15);
    expect(sampler.diagnostics.tileCount).toBe(1);
  });

  it('wraps longitude at the antimeridian and handles polar samples', () => {
    const sampler = new TerrainSampler(datum, { id: 'polar', kind: 'height-grid' });
    sampler.addTile({ id: 'polar', westDeg: 170, eastDeg: -170, southDeg: 80, northDeg: 90, width: 2, height: 2, elevationsKm: new Float32Array([1, 2, 3, 4]) });
    expect(sampler.sample(85, 180)?.elevationKm).toBeCloseTo(2.5);
    expect(sampler.sample(85, -180)?.elevationKm).toBeCloseTo(2.5);
  });

  it('round-trips ellipsoid geodetic and body-fixed coordinates', () => {
    const original = { latDeg: 88.5, lonDeg: -135.25, heightKm: 0.123 };
    const recovered = bodyFixedToGeodetic(geodeticToBodyFixed(original, datum), datum);
    expect(recovered.latDeg).toBeCloseTo(original.latDeg, 9);
    expect(recovered.lonDeg).toBeCloseTo(original.lonDeg, 9);
    expect(recovered.heightKm).toBeCloseTo(original.heightKm, 9);
  });

  it('reports unloaded state and preserves tile provenance', () => {
    const sampler = new TerrainSampler(datum, { id: 'default', kind: 'height-grid' }, 2);
    expect(sampler.sample(0, 0)).toBeNull();
    expect(sampler.diagnostics.state).toBe('unloaded');
    sampler.addTile({
      id: 'source-tile', westDeg: 0, eastDeg: 1, southDeg: 0, northDeg: 1,
      width: 2, height: 2, elevationsKm: new Float32Array([1, 1, 1, 1]),
      source: { id: 'regional-dem', kind: 'height-grid', uncertaintyKm: 0.002 },
    });
    const sample = sampler.sample(0.5, 0.5);
    expect(sample?.source.id).toBe('regional-dem');
    expect(sample?.uncertaintyKm).toBe(0.002);
    expect(sampler.diagnostics.state).toBe('ready');
  });

  it('evicts the least recently inserted tile at the configured bound', () => {
    const sampler = new TerrainSampler(datum, { id: 'test', kind: 'height-grid' }, 1);
    const tile = (id: string, elevation: number) => ({
      id, westDeg: 0, eastDeg: 1, southDeg: 0, northDeg: 1,
      width: 2, height: 2, elevationsKm: new Float32Array([elevation, elevation, elevation, elevation]),
    });
    sampler.addTile(tile('first', 1));
    sampler.addTile(tile('second', 2));
    expect(sampler.sample(0.5, 0.5)?.elevationKm).toBe(2);
    expect(sampler.diagnostics.tileCount).toBe(1);
  });

  it('derives a normalized terrain normal from a height slope', () => {
    const sampler = new TerrainSampler({
      referenceShape: { kind: 'sphere', radiusKm: 1 },
      verticalDatum: 'ellipsoid',
      heightConvention: 'radial',
    }, { id: 'test', kind: 'height-grid' });
    sampler.addTile({
      id: 'slope', westDeg: 0, eastDeg: 10, southDeg: 0, northDeg: 10,
      width: 3, height: 3, elevationsKm: new Float32Array([0, 1, 2, 0, 1, 2, 0, 1, 2]),
    });
    const normal = sampler.sample(5, 5, true)?.normal;
    expect(normal).toBeDefined();
    expect(Math.hypot(...normal!)).toBeCloseTo(1, 6);
    expect(normal![0]).toBeLessThan(0);
  });
});
