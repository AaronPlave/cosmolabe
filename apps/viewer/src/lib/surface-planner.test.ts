/**
 * Surface planner store (#250) without a scene: lock export follows the source
 * choice shown, fidelity is per region, and build feedback decides built vs new.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  addSurfacePlanRegion, createSurfacePlanDraft, parseGeographicGeoJson, resolveSurfacePlan, type GeographicCoordinates,
} from '@cosmolabe/core';
import {
  channelFinding, chooseAlternative, clearSources, findSources, handoffReadiness, importPlannerText, inLongitudeDomain, lockPreparationGaps, lockText, planner, regionAlternatives, regionBuildStatus, run, selectedSourceIds, selectionChanged,
} from './surface-planner.svelte';

const read = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
const MARS: GeographicCoordinates = { latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '0..360',
  referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] } };

/** Two synthetic Jezero ROIs as an exportable desired plan, imagery only. */
function jezeroPlan(): string {
  const layer = parseGeographicGeoJson(read('docs/examples/surface-plans/jezero.geojson'), { id: 'jezero', name: 'Jezero', body: 'Mars',
    source: 'jezero.geojson', coordinates: MARS }, { kind: 'local-file', identity: 'jezero.geojson' });
  let plan = createSurfacePlanDraft('Mars', MARS);
  // approach and landing: their alternatives include versioned, lockable products.
  for (const f of layer.features.slice(0, 2)) plan = addSurfacePlanRegion(plan, layer, f, { intent: 'imagery', preset: 'descent' }).plan;
  return JSON.stringify(resolveSurfacePlan(plan).desired);
}

/** Two lockable synthetic imagery products over the Jezero fixture ROIs (from the synthetic DEM descriptor). */
function syntheticInventory(): string {
  const [dem] = JSON.parse(read('docs/examples/surface-plans/jezero.sources.json'));
  return JSON.stringify(([['img-a', 0.5], ['img-b', 1]] as const).map(([id, nativeGsdM]) => ({
    kind: 'orthoimage', evidence: { url: 'https://example.test/synthetic', footprint: 'raster-envelope' },
    descriptor: { ...dem, id, productId: id.toUpperCase(), channel: 'imagery', nativeGsdM, accuracyM: null },
  })));
}

describe('surface planner store', () => {
  it('re-exports an imported lock unchanged, with build status from feedback', async () => {
    const text = read('docs/examples/surface-plans/jezero-build.lock.json');
    expect(await importPlannerText(text, 'jezero-build.lock.json')).toBe(true);
    expect(JSON.parse(await lockText()).identity).toBe(JSON.parse(text).identity);
    expect(selectionChanged()).toBe(false);
    expect(selectedSourceIds('pilot', 'imagery')).toEqual(['hirise-ortho']);
    expect(regionBuildStatus('pilot', 'imagery')?.status).toBe('unknown');
    expect(await importPlannerText(read('docs/releases/surface-build-jezero/production-planner-feedback.json'), 'feedback.json')).toBe(true);
    expect(regionBuildStatus('pilot', 'imagery')?.status).toBe('published');
    expect(regionBuildStatus('pilot', 'elevation')?.status).toBe('published-unproven');
    // The prepared Jezero lock carries executor parameters.
    expect(lockPreparationGaps(JSON.parse(text))).toEqual([]);
    // Per-region fidelity is assessed from the lock's own selections.
    await run();
    expect(Object.keys(planner.selectedFidelity ?? {}).sort()).toEqual(['context', 'pilot']);
  });

  it('drops a held lock when the source choice changes, and locks what is shown', async () => {
    const inventory = syntheticInventory();
    expect(await importPlannerText(jezeroPlan(), 'jezero.plan.json')).toBe(true);
    expect(await importPlannerText(inventory, 'inventory.json')).toBe(true);
    await run();
    const only = (r: string, id: string) => regionAlternatives(r).findIndex(a => JSON.stringify(a.channels.imagery?.sourceIds) === JSON.stringify([id]));
    expect(only('approach', 'img-a')).toBeGreaterThanOrEqual(0);
    expect(only('approach', 'img-b')).toBeGreaterThanOrEqual(0);
    chooseAlternative('approach', only('approach', 'img-a'));
    chooseAlternative('landing', only('landing', 'img-a'));
    await run();
    expect(selectionChanged()).toBe(true);
    // Footprint-only evidence: unknown, not proven, and the handoff is ready.
    expect(channelFinding('approach', 'imagery')).toMatchObject({ verdict: 'unknown', nativeM: 0.5, sourceIds: ['img-a'] });
    expect(handoffReadiness()).toEqual({ ready: true, reason: '' });
    const first = JSON.parse(await lockText());

    // Re-open that lock: it is held and re-exported as-is.
    expect(await importPlannerText(JSON.stringify(first), 'jezero.lock.json')).toBe(true);
    expect(planner.importedLock).not.toBeNull();
    expect(selectionChanged()).toBe(false);
    expect(JSON.parse(await lockText()).identity).toBe(first.identity);

    // Loading the inventory again replaces the shown sources: the held lock no longer applies.
    expect(await importPlannerText(inventory, 'inventory.json')).toBe(true);
    expect(planner.importedLock).toBeNull();
    await run();
    chooseAlternative('landing', only('landing', 'img-a'));
    chooseAlternative('approach', only('approach', 'img-b'));
    await run();
    expect(selectionChanged()).toBe(true);
    const second = JSON.parse(await lockText());
    // A planner-authored lock is a handoff: the executor's parameters and source map are still missing.
    expect(lockPreparationGaps(second)).toEqual(expect.arrayContaining(['processing.parameters.terrain', 'processing.parameters.imagery', 'processing.parameters.gates',
      'a spherical, planetocentric, east-positive source map']));
    expect(second.identity).not.toBe(first.identity);
    const pick = (lock: { selections: { regionId: string; channel: string; sourceIds: string[] }[] }, id: string) =>
      lock.selections.find(s => s.regionId === id && s.channel === 'imagery')!.sourceIds;
    expect(pick(first, 'approach')).toEqual(['img-a']);
    expect(pick(second, 'approach')).toEqual(['img-b']);
    // Per region: landing's fidelity is assessed only from landing's own selection.
    expect(Object.keys(planner.selectedFidelity ?? {}).sort()).toEqual(['approach', 'landing']);
  });

  it('states what the chosen sources prove, in order of evidence', async () => {
    expect(await importPlannerText(jezeroPlan(), 'jezero.plan.json')).toBe(true);
    clearSources();
    expect(channelFinding('approach', 'imagery')?.verdict).toBe('not-searched');
    expect(handoffReadiness().reason).toMatch(/Find available/);
    const coverage = { status: 'verified-complete', verifiedFraction: 1, unknownFraction: 0, gapFraction: 0, targetVerifiedFraction: 1 };
    const finding = (patch: object, nativeGsdM: number | null = 0.5, compatibility = 'evidenced') => {
      planner.sources = { kind: 'inventory', label: 't', records: [{ descriptor: { id: 'a', nativeGsdM } }] as never };
      planner.report = { combinations: [{ regionId: 'approach', alternatives: [{ compatibility,
        channels: { imagery: { sourceIds: ['a'], coverage: { ...coverage, ...patch } } } }] }] } as never;
      planner.choice = {};
      return channelFinding('approach', 'imagery')!;
    };
    expect(finding({}).verdict).toBe('proven');
    expect(finding({}, 0.5, 'unverified').verdict).toBe('partial');
    expect(finding({ verifiedFraction: 0.4, unknownFraction: 0.6, targetVerifiedFraction: 0.4 }).summary).toMatch(/40%/);
    expect(finding({ verifiedFraction: 0, unknownFraction: 1, targetVerifiedFraction: 0 }, 100)).toMatchObject({ verdict: 'coarser', nativeM: 100 });
    expect(finding({ verifiedFraction: 0, unknownFraction: 1, targetVerifiedFraction: 0 }, null).summary).toMatch(/valid pixels and some resolutions are not established/);
    planner.report = { combinations: [] } as never;
    expect(channelFinding('approach', 'imagery')?.verdict).toBe('none');
  });

  it('finds sources for Mars from bundled archive metadata without an inventory file', async () => {
    expect(await importPlannerText(jezeroPlan(), 'jezero.plan.json')).toBe(true);
    clearSources();
    await findSources();
    expect(planner.sources.kind).toBe('inventory');
    await run();
    // Real archive footprints over the synthetic ROI: overlap, not proven valid pixels.
    expect(['unknown', 'partial', 'coarser']).toContain(channelFinding('approach', 'imagery')?.verdict);
  });

  it('re-expresses archive footprints in the plan longitude domain only when exact', () => {
    const plan = { body: 'Mars', frame: 'IAU_MARS', coordinates: { ...MARS, longitudeDomain: '-180..180' } } as never;
    const record = (xs: number[]) => ({ kind: 'orthoimage', evidence: { url: 'https://x', footprint: 'archive-footprint' },
      descriptor: { body: 'Mars', frame: 'IAU_MARS', coordinates: MARS, footprint: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {},
        geometry: { type: 'Polygon', coordinates: [[[xs[0], 0], [xs[1], 0], [xs[1], 1], [xs[0], 0]]] } }] } } }) as never;
    const lons = (r: { descriptor: { footprint: { features: { geometry: { coordinates: number[][][] } }[] } } }) => r.descriptor.footprint.features[0].geometry.coordinates[0].map(p => p[0]);
    const east = inLongitudeDomain(record([77, 78]), plan) as never as { descriptor: { coordinates: { longitudeDomain: string } } };
    expect(east.descriptor.coordinates.longitudeDomain).toBe('-180..180');
    expect(lons(inLongitudeDomain(record([270, 280]), plan) as never)).toEqual([-90, -80, -80, -90]);
    // Straddles the plan's seam: left for discovery to refuse.
    const seam = record([170, 190]);
    expect(inLongitudeDomain(seam, plan)).toBe(seam);
  });
});
