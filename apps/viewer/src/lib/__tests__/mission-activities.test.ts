import { describe, expect, it } from 'vitest';
import { parseMissionActivities, adjacentActivity } from '@cosmolabe/core';
import { readFileSync } from 'node:fs';
import { eventCalloutLines, eventSceneAnnotationLines } from '../event-query';
import { activityEvent, activitySeries, activityLayout, visibleActivityMarks } from '../mission-activities';
const catalog = (name: string) => JSON.parse(readFileSync(new URL(`../../../test-catalogs/${name}.json`, import.meta.url), 'utf8'));

describe('mission activities independent of trajectory storage', () => {
  it('imports all 72 flights with original event epochs, including flights with zero published speed', () => {
    const records = parseMissionActivities(catalog('ingenuity-jezero').activities);
    const index = JSON.parse(readFileSync(new URL('../../../test-catalogs/data/ingenuity/flights_index.json', import.meta.url), 'utf8'));
    expect(records).toHaveLength(72);
    records.forEach((a,i) => {
      expect([a.start,a.end]).toEqual([index[i].etStart,index[i].etEnd]);
      expect(a.provenance.authority).toBe('estimated');
    });
  });
  it('uses authored MoonFall semantic labels, not arbitrary waypoint segments', () => {
    const records = parseMissionActivities(catalog('moonfall-shackleton').activities);
    expect(records.filter(a=>a.kind==='hop')).toHaveLength(12);
    expect(records.filter(a=>a.kind==='landing')).toHaveLength(12);
    expect(new Set(records.map(a=>a.vehicle)).size).toBe(4);
    expect(records.find(a=>a.name==='PSR floor sample run')?.provenance.authority).toBe('authored');
    const landing = records.find(a=>a.kind==='landing')!;
    expect(activityEvent(landing)).toMatchObject({temporality:'instant',et:landing.start});
  });
  it('labels actual Curiosity drive reports as bounded date windows with unknown duration', () => {
    const records = parseMissionActivities(catalog('msl-dingo-gap').activities);
    expect(records).toHaveLength(2);
    const event = activityEvent(records[0]);
    expect(eventCalloutLines(event, { utc: String }).join(' ')).toContain('duration unknown');
    expect(eventSceneAnnotationLines(event).join(' ')).toContain('duration unknown');
    expect(records.every(a=>a.provenance.timing==='bounded' && a.provenance.limitations.includes('duration are unknown'))).toBe(true);
  });
  it('groups simultaneous flight/drive and a manual descent without a trajectory or object', () => {
    const fixture = catalog('fixtures/mission-activities');
    const records = parseMissionActivities(fixture.activities);
    expect(activitySeries(records).map(s=>s.label)).toEqual(['flight','drive','descent','landing']);
    expect(records.filter(a=>a.start<=672089550 && a.end>=672089550)).toHaveLength(3);
    expect(fixture.items.some((b: {name: string})=>b.name===records[2].vehicle)).toBe(false);
  });
  it('bounds visible density and exact navigation for long overlapping missions', () => {
    const source = parseMissionActivities(catalog('fixtures/mission-activities').activities)[0];
    const records = Array.from({length:10000},(_,i)=>({...source,id:`a${String(i).padStart(5,'0')}`,start:i*2,end:i*2+30}));
    const before = performance.now();
    const layout = activityLayout(records);
    const marks = visibleActivityMarks(layout,0,20000);
    for(let i=0;i<10000;i++) expect(adjacentActivity(records,i,1)).toBeDefined();
    const elapsed = performance.now()-before;
    expect(marks.length).toBeLessThanOrEqual(200);
    expect(marks.reduce((n,m)=>n+m.count,0)).toBe(10000);
    expect(Math.max(...layout.map(m=>m.row))).toBe(3);
    console.info(`Activity benchmark: 10000 records, layout+density+10000 binary seeks ${elapsed.toFixed(1)} ms`);
  });
});
