import { describe, expect, it } from 'vitest';
import { CatalogLoader, Universe, parseMissionActivities, adjacentActivity, activityWindow, etFromCalendarString, type MissionActivitySpec } from '../index.js';
const spec = (id = 'a', start = 10, end = 20): MissionActivitySpec => ({ version: 1, id, name: id, vehicle: 'Rover', body: 'Mars', kind: 'drive', temporality: 'interval', timeSystem: 'ET', start, end,
  provenance: { source: 'fixture', version: '1', authority: 'authored', timing: 'exact', limitations: 'Synthetic test only' } });

describe('versioned mission activity metadata', () => {
  it('normalizes explicit UTC through the shared clock or injected SPICE conversion', () => {
    const a = { ...spec(), timeSystem: 'UTC', start: '2014-02-06T00:00:00Z', end: '2014-02-07T00:00:00Z' };
    expect(parseMissionActivities([a])[0].start).toBe(etFromCalendarString(a.start));
    expect(parseMissionActivities([a], t => t === a.start ? 123 : 124)[0]).toMatchObject({ start: 123, end: 124 });
  });
  it.each([
    { version: 2 }, { id: '' }, { vehicle: undefined }, { body: '' }, { kind: 'burn' },
    { temporality: 'point' }, { start: NaN }, { end: 9 }, { end: 10 }, { provenance: {} },
    { timeSystem: 'UTC', start: '2014-02-06', end: '2014-02-07' }, { timeSystem: 'TAI' }, { timeSystem: 'UTC', start: '2028-02-30T00:00:00Z', end: '2028-03-02T00:00:00Z' },
    { references: { objects: [1] } }, { provenance: { ...spec().provenance, uncertaintySeconds: -1 } },
  ])('rejects invalid or missing metadata: %j', patch => {
    expect(() => parseMissionActivities([{ ...spec(), ...patch }])).toThrow(/activity/);
  });
  it('validates instant milestones separately and rejects duplicate identity', () => {
    const [a] = parseMissionActivities([{ ...spec('landing', 30, 30), temporality: 'instant', kind: 'landing' }]);
    expect(activityWindow(a)).toEqual([29, 31]);
    expect(() => parseMissionActivities([{ ...spec(), temporality: 'instant' }])).toThrow();
    expect(() => parseMissionActivities([spec(), spec()])).toThrow(/duplicate/);
  });
  it('defines deterministic overlap/tie, edge, reverse and gap navigation', () => {
    const items = parseMissionActivities([spec('c', 30, 40), spec('b'), spec('a'), spec('overlap', 15, 25)]);
    expect(items.map(a => a.id)).toEqual(['a', 'b', 'overlap', 'c']);
    expect(adjacentActivity(items, 10, 1)?.id).toBe('overlap');
    expect(adjacentActivity(items, 10, 1, 'a')?.id).toBe('b');
    expect(adjacentActivity(items, 17, -1, 'c')?.id).toBe('overlap');
    expect(adjacentActivity(items, 27, 1)?.id).toBe('c');
    expect(adjacentActivity(items, 27, -1)?.id).toBe('overlap');
    expect(adjacentActivity(items, 50, 1)).toBeUndefined();
    expect(adjacentActivity(items, 0, -1)).toBeUndefined();
  });
  it('exists without bodies, geometry, samples or a renderer and replaces/disposes by owner', () => {
    const u = new Universe();
    expect(u.activities.available).toBe(false);
    u.loadCatalog({ name: 'base' });
    expect(u.activities.available).toBe(false);
    u.loadCatalog({ name: 'ops', activities: [spec()] });
    expect(u.activities.available).toBe(true);
    expect(u.getAllBodies()).toHaveLength(0);
    expect(u.getTimeRange()).toEqual([10, 20]);
    expect(u.activities.get('a')?.kind).toBe('drive');
    expect(Object.isFrozen(u.activities.get('a')?.provenance)).toBe(true);
    u.loadCatalog({ name: 'other', activities: [spec('other')] });
    expect(() => u.loadCatalog({ name: 'collision', activities: [spec()] })).toThrow(/duplicate/);
    u.loadCatalog({ name: 'ops', activities: [] });
    expect(u.activities.get('a')).toBeUndefined();
    expect(u.activities.list()).toHaveLength(1);
    u.dispose();
    expect(u.activities.list()).toEqual([]);
    expect(new CatalogLoader().load({}).activities).toEqual([]);
    expect(() => new CatalogLoader().load({ activities: null } as never)).toThrow(/array/);
  });
});


it('uses shared UTC fallback if furnished SPICE has no LSK', () => {
  const a = { ...spec(), timeSystem: 'UTC' as const, start: '2014-02-06T00:00:00Z', end: '2014-02-07T00:00:00Z' };
  const loader = new CatalogLoader({ spice: { str2et() { throw new Error('No LSK'); } } as never });
  expect(loader.load({ activities: [a] }).activities[0].start).toBe(etFromCalendarString(a.start));
});
