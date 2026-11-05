import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { Universe, Body, SpiceTrajectory, FixedPointTrajectory, SpiceRotation, findTrajectoryExtrema, universeTrajectoryAnalysisProvider, bodyFixedToGeodetic } from '../packages/core/dist/index.js';
import { terrainSource } from './lib/moonfall-clearance.mjs';
import { lunarTestSpice } from './lib/lunar-test-spice.mjs';

const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const catalog = read('../apps/viewer/test-catalogs/moonfall-shackleton.json');
const fixture = read('./data/moonfall-clearance.json');
const grid = new URL('../apps/viewer/test-catalogs/data/moon-terrain-cube/cpu-grids.json', import.meta.url);

describe('MoonFall shared runtime height analysis against pinned physical grids', () => {
  it.skipIf(!process.env.MOONFALL_GRIDS && !existsSync(grid))('computes all twelve sorties and Polaris-C separately, and keeps radial height independent', async () => {
    const universe = new Universe(await lunarTestSpice()); universe.loadCatalog(catalog);
    const source = await terrainSource(process.env.MOONFALL_GRIDS ?? grid.pathname, fixture.revision);
    const provider = universeTrajectoryAnalysisProvider(universe, () => 1);
    provider.terrain = async (p,q) => {
      if (q.frame !== 'MOON_ME_DE421' || JSON.stringify(q.reference) !== JSON.stringify(source.manifest.datum.referenceShape) || q.terrain.revision !== source.manifest.source.version) return null;
      const { latDeg,lonDeg } = bodyFixedToGeodetic({ xKm:p[0],yKm:p[1],zKm:p[2] }, source.manifest.datum);
      await source.request(latDeg,lonDeg);
      if (source.coverage(latDeg,lonDeg).state !== 'finest') return null;
      const sample=source.sampleResident(latDeg,lonDeg);
      return sample ? { heightKm:sample.elevationKm,sourceUncertaintyKm:sample.source.uncertaintyKm ?? null } : null;
    };
    const query = { objects:['Polaris-A','Polaris-B','Polaris-C','Polaris-D'],body:'Moon',frame:'MOON_ME_DE421',metric:'heightAbovePhysicalTerrain',extremum:'maximum',reference:{ kind:'sphere',radiusKm:1737.4 },scope:{ kind:'activities',activityKind:'hop' },stepSeconds:.1,timeToleranceSeconds:.005,terrain:{ id:source.manifest.source.id,revision:fixture.revision } };
    const all = await findTrajectoryExtrema(query,provider);
    expect(all.status,JSON.stringify(all.faults)).toBe('complete');
    expect(all.results).toHaveLength(12);
    expect(all.results[0]).toMatchObject({ object:'Polaris-D',activityName:'Long traverse to Sverdrup',source:{ classification:'synthetic' } });
    expect(all.results[0].value*1000).toBeCloseTo(310.91,0);
    const c=await findTrajectoryExtrema({ ...query,objects:['Polaris-C'] },provider);
    expect(c.status,JSON.stringify(c.faults)).toBe('complete'); expect(c.results).toHaveLength(3);
    expect(c.results[0].activityName).toBe('Crater inner-wall transect');
    expect(c.results[0].value*1000).toBeCloseTo(184.24,0);
    const radial=await findTrajectoryExtrema({ ...query,metric:'radialHeightAboveReferenceSphere',terrain:undefined },provider);
    expect(radial.status).toBe('complete'); expect(radial.results).toHaveLength(12);
    expect(radial.results[0].value).not.toBeCloseTo(all.results[0].value,2);
    // The old report is an independent fixture, never the numerical input.
    for (const r of all.results) {
      const expected=fixture.flights.find(f => f.hopper===r.object && f.label===r.activityName);
      expect(Math.abs(r.value*1000-expected.after.maxClearanceM)).toBeLessThan(.5);
      expect(r.method.heightErrorBoundKm).toBeNull();
      expect(r.terrain.revision).toBe(fixture.revision);
    }
    expect(await findTrajectoryExtrema({ ...query,frame:'IAU_MOON' },provider)).toMatchObject({ status:'unavailable',results:[] });
  },120000);
});


describe('SPICE-backed numerical height analysis',()=>{
  it('evaluates the authoritative ephemeris and real body-fixed frame and refines the monthly peak',async()=>{
    const spice=await lunarTestSpice();
    const universe=new Universe(spice);
    universe.addBody(new Body({name:'Earth',trajectory:new FixedPointTrajectory([0,0,0]),rotation:new SpiceRotation(spice,'IAU_EARTH'),radii:[6378.137,6378.137,6356.752]}));
    universe.addBody(new Body({name:'Moon ephemeris',parentName:'Earth',trajectory:new SpiceTrajectory(spice,'301','399','ECLIPJ2000')}));
    const start=spice.str2et('2028-12-01T00:00:00Z'),end=spice.str2et('2029-01-01T00:00:00Z');
    const found=await findTrajectoryExtrema({objects:['Moon ephemeris'],body:'Earth',frame:'IAU_EARTH',metric:'radialHeightAboveReferenceSphere',extremum:'maximum',reference:{kind:'sphere',radiusKm:6378.137},scope:{kind:'windows',windows:[{start,end}]},stepSeconds:3600,timeToleranceSeconds:.1},universeTrajectoryAnalysisProvider(universe,()=>1));
    expect(found.status,JSON.stringify(found.faults)).toBe('complete');
    const peak=found.results[0];
    const direct=spice.spkpos('301',peak.et,'IAU_EARTH','NONE','399').position;
    expect(peak.value).toBeCloseTo(Math.hypot(...direct)-6378.137,6);
    for(let t=start;t<=end;t+=3600) expect(peak.value+1e-6).toBeGreaterThanOrEqual(Math.hypot(...spice.spkpos('301',t,'IAU_EARTH','NONE','399').position)-6378.137);
    expect(peak.terrain).toBeNull();
  },30000);
});
