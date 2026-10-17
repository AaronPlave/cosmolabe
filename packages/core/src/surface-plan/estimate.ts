import type { MultiPolygon } from 'polygon-clipping';
import { intersectGeometry, subtractGeometry, surfaceAreaM2, surfaceFeatureGeometry, surfacePerimeterM, unionGeometry } from './geometry.js';
import {
  type DesiredSurfacePlan, type EstimateRange, type SurfaceChannel, type SurfaceDetailBand,
  type SurfaceEstimateAssumptions, type SurfacePlanDiagnostic, type SurfacePlanEstimate, type SurfaceSourceDescriptor,
} from './model.js';
import { parseSurfaceSourceFootprint, planFail, resolveSurfacePlan, serializeSurfacePlan, surfacePlanIdentity, validateSurfaceSources } from './validation.js';
import { geographicDatum } from '../geographic/import.js';

export const SURFACE_ESTIMATOR_VERSION = '1.0.0';
export const DEFAULT_SURFACE_ASSUMPTIONS: Readonly<SurfaceEstimateAssumptions> = Object.freeze({
  tileSize: 256, gutter: 1, imageryBytesPerSample: 3, elevationBytesPerSample: 4,
  imageryCompression: [0.08, 0.5] as [number, number], elevationCompression: [0.25, 0.8] as [number, number],
  workDiskMultiplier: [2, 4] as [number, number], visibleTiles: [16, 64] as [number, number],
});
const CHANNELS = ['imagery', 'elevation'] as const;
const range = (min: number, max: number | null = min): EstimateRange => ({ min, max });
const safe = (n: number): number | null => Number.isFinite(n) && n <= Number.MAX_SAFE_INTEGER && n >= 0 ? Math.ceil(n) : null;
const sumRanges = (rs: EstimateRange[]): EstimateRange => ({
  min: rs.reduce((s, r) => s + r.min, 0),
  max: rs.some(r => r.max === null) ? null : safe(rs.reduce((s, r) => s + r.max!, 0)),
});
const status = (r: EstimateRange, budget: number): 'within' | 'over' | 'uncertain' =>
  r.min > budget ? 'over' : r.max !== null && r.max <= budget ? 'within' : 'uncertain';

function assumptions(input: Partial<SurfaceEstimateAssumptions>): SurfaceEstimateAssumptions {
  const a = { ...DEFAULT_SURFACE_ASSUMPTIONS, ...input };
  for (const key of Object.keys(input)) if (!(key in DEFAULT_SURFACE_ASSUMPTIONS)) planFail('schema', `assumptions.${key}`, 'Unknown assumption');
  for (const key of ['tileSize', 'gutter', 'imageryBytesPerSample', 'elevationBytesPerSample'] as const) {
    if (!Number.isSafeInteger(a[key]) || a[key] < (key === 'gutter' ? 0 : 1)) planFail('units', `assumptions.${key}`, 'Expected nonnegative gutter or positive integer');
  }
  if (a.tileSize < 16 || a.tileSize > 8192 || a.gutter > 64 || a.imageryBytesPerSample > 16 || a.elevationBytesPerSample > 16) planFail('limits', 'assumptions', 'Tile/sample assumptions exceed supported bounds');
  for (const key of ['imageryCompression', 'elevationCompression', 'workDiskMultiplier', 'visibleTiles'] as const) {
    const r = a[key];
    if (!Array.isArray(r) || r.length !== 2 || r.some(n => !Number.isFinite(n) || n <= 0) || r[1] < r[0]) planFail('units', `assumptions.${key}`, 'Expected ordered positive [min,max]');
  }
  if (a.visibleTiles.some(n => !Number.isSafeInteger(n) || n > 4096)) planFail('limits', 'assumptions.visibleTiles', 'Expected integer tile counts up to 4096');
  return JSON.parse(JSON.stringify(a)) as SurfaceEstimateAssumptions;
}

interface SourceGeometry { descriptor: SurfaceSourceDescriptor; geometry: MultiPolygon | null; compatible: boolean; datumKnown: boolean; }
function compileSources(plan: DesiredSurfacePlan, sources: SurfaceSourceDescriptor[], diagnostics: SurfacePlanDiagnostic[]): SourceGeometry[] {
  return sources.map(s => {
    const compatible = s.body === plan.body && s.frame === plan.frame
      && serializeSurfacePlan(s.coordinates) === serializeSurfacePlan(plan.coordinates);
    if (!compatible) diagnostics.push({ severity: 'warning', code: 'unsupported-source-transform', path: `sources.${s.id}`,
      message: 'Source body/frame/coordinates differ; no coverage or download is inferred. Transform metadata in a future lock is required.' });
    const datumKnown = serializeSurfacePlan(s.datum) === serializeSurfacePlan(geographicDatum(plan.coordinates));
    if (!datumKnown) diagnostics.push({ severity: 'warning', code: 'unsupported-source-datum', path: `sources.${s.id}.datum`, message: 'Source datum requires a transform; physical fidelity remains unknown until resolved.' });
    const footprint = parseSurfaceSourceFootprint(s);
    return { descriptor: s, compatible, datumKnown, geometry: footprint === null ? null : unionGeometry(footprint.features.map(f => surfaceFeatureGeometry(f, s.coordinates))) };
  });
}

function estimateBands(plan: DesiredSurfacePlan, geometries: Map<string, MultiPolygon>, sources: SourceGeometry[], a: SurfaceEstimateAssumptions): SurfaceDetailBand[] {
  const result: SurfaceDetailBand[] = [];
  for (const channel of CHANNELS) {
    const regions = plan.regions.filter(r => r[channel]);
    // Split independently along GSD and accuracy thresholds. In an overlap both strictest goals win.
    const gsds = [...new Set(regions.map(r => r[channel]!.gsdM))].sort((x, y) => x - y);
    const accuracies = [...new Set(regions.map(r => r[channel]!.accuracyM ?? Infinity))].sort((x, y) => x - y);
    let finer: MultiPolygon = [];
    for (const gsd of gsds) {
      const atGsd = unionGeometry(regions.filter(r => r[channel]!.gsdM === gsd).map(r => geometries.get(r.id)!));
      const gsdBand = subtractGeometry(atGsd, finer);
      let stricter: MultiPolygon = [];
      for (const accuracy of accuracies) {
        const atAccuracy = unionGeometry(regions.filter(r => (r[channel]!.accuracyM ?? Infinity) === accuracy).map(r => geometries.get(r.id)!));
        const geometry = subtractGeometry(intersectGeometry(gsdBand, atAccuracy), stricter);
        stricter = unionGeometry([stricter, atAccuracy]);
        const area = surfaceAreaM2(geometry, plan.coordinates);
        if (!geometry.length) continue;
        if (area <= 1e-8) planFail('impossible-area', '$.regions', 'A nonempty detail band is below numerical area precision; simplify the ROI/overlap');
        const baseSamples = safe(Math.max(1, area / (gsd * gsd)));
        const levels = baseSamples === null ? null : Math.max(1, Math.ceil(Math.log2(Math.max(1, Math.sqrt(baseSamples) / a.tileSize))) + 1);
        let pyramid = 0, minObjects = 0, maxObjects = 0;
        if (levels !== null) for (let level = 0; level < levels; level++) {
          const samples = area / (gsd * 2 ** level) ** 2;
          pyramid += Math.max(1, Math.ceil(samples));
          const minimum = Math.max(1, Math.ceil(samples / a.tileSize ** 2));
          minObjects += minimum;
          maxObjects += minimum + Math.ceil(2 * surfacePerimeterM(geometry, plan.coordinates) / (a.tileSize * gsd * 2 ** level)) + geometry.length * 4;
        }
        const bytesPerSample = channel === 'imagery' ? a.imageryBytesPerSample : a.elevationBytesPerSample;
        const compression = channel === 'imagery' ? a.imageryCompression : a.elevationCompression;
        const rawTile = (a.tileSize + 2 * a.gutter) ** 2 * bytesPerSample;
        const publishedMax = levels === null ? null : safe(maxObjects * rawTile * compression[1]);
        const publishedMin = levels === null ? 0 : safe(minObjects * rawTile * compression[0]) ?? 0;
        const adequate: MultiPolygon[] = [], unknown: MultiPolygon[] = [];
        const candidates: SurfaceDetailBand['sourceEvidence']['candidates'] = [];
        for (const source of sources) {
          const s = source.descriptor;
          if (!source.compatible || s.channel !== channel) continue;
          const overlap = source.geometry === null ? geometry : intersectGeometry(source.geometry, geometry);
          if (!overlap.length) continue;
          candidates.push({ id: s.id, nativeGsdM: s.nativeGsdM, accuracyM: s.accuracyM });
          const resolutionKnown = s.nativeGsdM !== null && (accuracy === Infinity || s.accuracyM !== null);
          const sufficient = s.nativeGsdM !== null && s.nativeGsdM <= gsd && (accuracy === Infinity || (s.accuracyM !== null && s.accuracyM <= accuracy));
          if (source.geometry === null || !resolutionKnown || s.nodata !== 'none' || !source.datumKnown) unknown.push(overlap);
          else if (sufficient) adequate.push(overlap);
        }
        const adequateGeometry = unionGeometry(adequate);
        const adequateAreaM2 = Math.min(area, surfaceAreaM2(adequateGeometry, plan.coordinates));
        // Missing evidence outside all footprints remains unknown, even in a source-aware estimate.
        const knownInadequate = unionGeometry(sources.filter(s => s.compatible && s.descriptor.channel === channel && s.geometry !== null
          && s.descriptor.nativeGsdM !== null && (accuracy === Infinity || s.descriptor.accuracyM !== null)
          && s.descriptor.nodata === 'none' && s.datumKnown).map(s => s.geometry!));
        const unknownGeometry = subtractGeometry(unionGeometry([subtractGeometry(geometry, knownInadequate), ...unknown]), adequateGeometry);
        const unknownAreaM2 = Math.max(0, Math.min(area - adequateAreaM2, surfaceAreaM2(unknownGeometry, plan.coordinates)));
        const tolerance = Math.max(1e-6, area * 1e-8);
        const evidenceStatus = adequateAreaM2 >= area - tolerance ? 'satisfied' : adequateAreaM2 > tolerance ? 'partial' : unknownAreaM2 > tolerance ? 'unknown' : 'unsatisfied';
        result.push({ channel, gsdM: gsd, accuracyM: accuracy === Infinity ? null : accuracy, areaM2: area,
          baseSamples, pyramidSamples: levels === null ? null : safe(pyramid), levels,
          objects: levels === null ? range(0, null) : range(minObjects, safe(maxObjects)),
          publishedBytes: range(publishedMin, publishedMax),
          sourceEvidence: { status: evidenceStatus, adequateAreaM2, unknownAreaM2, candidates: candidates.sort((x, y) => x.id < y.id ? -1 : x.id > y.id ? 1 : 0) } });
      }
      finer = unionGeometry([finer, atGsd]);
    }
  }
  return result;
}

export async function estimateSurfacePlan(plan: DesiredSurfacePlan, options: {
  references?: ReadonlyMap<string, string>;
  sources?: SurfaceSourceDescriptor[];
  assumptions?: Partial<SurfaceEstimateAssumptions>;
} = {}): Promise<SurfacePlanEstimate> {
  const resolved = resolveSurfacePlan(plan, options.references);
  const diagnostics = resolved.diagnostics;
  const a = assumptions(options.assumptions ?? {});
  const geometries = new Map(plan.regions.map(r => {
    const layer = resolved.layers.find(l => l.id === r.feature.layerId)!;
    const feature = layer.features.find(f => f.id === r.feature.featureId)!;
    const rings: number[][][] = [];
    const visit = (v: unknown) => {
      if (!Array.isArray(v)) return;
      if (Array.isArray(v[0]) && typeof v[0][0] === 'number') rings.push(v as number[][]);
      else v.forEach(visit);
    };
    visit((feature.original.geometry as { coordinates: unknown }).coordinates);
    const canonicalLon = (x: number) => ((x * (plan.coordinates.longitudeDirection === 'east' ? 1 : -1) + 180) % 360 + 360) % 360 - 180;
    if (rings.some(ring => ring.some((p, i) => i > 0 && Math.abs(canonicalLon(p[0]) - canonicalLon(ring[i - 1][0])) >= 180))) diagnostics.push({ severity: 'warning', code: 'longitude-seam', path: `regions.${r.id}`, message: 'Longitude seam coordinates are unwrapped and split before overlap accounting.' });
    return [r.id, surfaceFeatureGeometry(feature, plan.coordinates)];
  }));
  const sourceDescriptors = validateSurfaceSources(options.sources ?? []);
  const sources = compileSources(plan, sourceDescriptors, diagnostics);
  const bands = estimateBands(plan, geometries, sources, a);
  for (const b of bands) {
    if (b.baseSamples === null || b.publishedBytes.max === null) diagnostics.push({ severity: 'warning', code: 'impossible-estimate', path: `bands.${b.channel}.${b.gsdM}`, message: 'Requested sample/storage count exceeds safe numeric range; upper estimate is unknown.' });
    if (b.sourceEvidence.candidates.some(s => s.nativeGsdM !== null && s.nativeGsdM > b.gsdM)) diagnostics.push({ severity: 'warning', code: 'coarser-native-source', path: `bands.${b.channel}.${b.gsdM}`, message: 'A candidate is coarser than the physical target. Upsampling increases output density, not source fidelity.' });
  }
  const totalsFor = (channel: SurfaceChannel) => {
    const selected = bands.filter(b => b.channel === channel);
    return { areaM2: selected.reduce((s, b) => s + b.areaM2, 0),
      baseSamples: selected.some(b => b.baseSamples === null) ? null : safe(selected.reduce((s, b) => s + b.baseSamples!, 0)),
      publishedBytes: sumRanges(selected.map(b => b.publishedBytes)), objects: sumRanges(selected.map(b => b.objects)) };
  };
  const imagery = totalsFor('imagery'), elevation = totalsFor('elevation');
  const publishedBytes = sumRanges([imagery.publishedBytes, elevation.publishedBytes]);
  const candidateIds = [...new Set(bands.flatMap(b => b.sourceEvidence.candidates.map(s => s.id)))].sort();
  const candidates = sources.filter(s => candidateIds.includes(s.descriptor.id)).map(s => s.descriptor);
  const unknownSizeIds = candidates.filter(s => s.asset.bytes === undefined).map(s => s.id).sort();
  const knownDownload = candidates.reduce((n, s) => n + (s.asset.bytes ?? 0), 0);
  const allCoverageKnown = bands.every(b => b.sourceEvidence.unknownAreaM2 <= Math.max(1e-6, b.areaM2 * 1e-8));
  const rawSourceDownloadBytes = range(knownDownload, unknownSizeIds.length || !allCoverageKnown ? null : safe(knownDownload));
  const workingSamples = bands.some(b => b.pyramidSamples === null) ? null : bands.reduce((n, b) => n + b.pyramidSamples! * (b.channel === 'imagery' ? a.imageryBytesPerSample : a.elevationBytesPerSample), 0);
  // Source decode/scratch size is unknown without raster metadata or sample builds.
  const workingMin = workingSamples === null ? 0 : safe(workingSamples * a.workDiskMultiplier[0]) ?? 0;
  const outputWorkDiskBytes = range(workingMin, workingSamples === null ? null : safe(workingSamples * a.workDiskMultiplier[1]));
  const peakWorkDiskBytes = range(knownDownload + workingMin, null);
  const decodedTileBytes = {
    imagery: (a.tileSize + 2 * a.gutter) ** 2 * a.imageryBytesPerSample,
    elevation: (a.tileSize + 2 * a.gutter) ** 2 * a.elevationBytesPerSample,
  };
  const activeChannels = CHANNELS.filter(c => bands.some(b => b.channel === c));
  const decodedPerViewTile = activeChannels.reduce((n, c) => n + decodedTileBytes[c], 0);
  const compressedPerViewTile = [0, 1].map(i => activeChannels.reduce((n, c) => n + decodedTileBytes[c] * (c === 'imagery' ? a.imageryCompression[i] : a.elevationCompression[i]), 0));
  let budget: SurfacePlanEstimate['budget'] = null;
  if (plan.budget) {
    const lowestPriority = Math.min(...plan.regions.map(r => r.priority ?? 0));
    const regionIds = plan.regions.filter(r => (r.priority ?? 0) === lowestPriority && (r.fallback ?? 'require-target') === 'allow-coarser').map(r => r.id).sort();
    budget = { publishedBytes: plan.budget.publishedBytes, status: status(publishedBytes, plan.budget.publishedBytes), comparisons: [] };
    if (regionIds.length) for (const multiplier of [2, 4]) {
      const changed: DesiredSurfacePlan = { ...plan, regions: plan.regions.map(r => regionIds.includes(r.id)
        ? { ...r, ...(r.imagery ? { imagery: { ...r.imagery, gsdM: r.imagery.gsdM * multiplier } } : {}),
          ...(r.elevation ? { elevation: { ...r.elevation, gsdM: r.elevation.gsdM * multiplier } } : {}) } : r) };
      if (changed.regions.some(r => CHANNELS.some(c => r[c] && !Number.isFinite(r[c]!.gsdM)))) continue;
      const cost = sumRanges(estimateBands(changed, geometries, [], a).map(b => b.publishedBytes));
      budget.comparisons.push({ regionIds, gsdMultiplier: multiplier, publishedBytes: cost, status: status(cost, plan.budget.publishedBytes) });
    }
  }
  diagnostics.push({ severity: 'warning', code: 'planning-assumptions', path: '$', message: 'Uncalibrated scenario bounds: boundary tile packing, compression, and visible tiles depend on the future generator. Work disk upper bound is unknown without source decode/scratch metadata. No build or download was performed.' });
  return { version: 1, estimatorVersion: SURFACE_ESTIMATOR_VERSION, desiredIdentity: await surfacePlanIdentity(resolved.desired),
    sourceMetadataIdentity: sourceDescriptors.length ? await surfacePlanIdentity(sourceDescriptors) : null,
    stage: sourceDescriptors.length ? 'source-aware' : 'geometry-only', assumptions: a, diagnostics, bands,
    totals: { imagery, elevation, publishedBytes, publishedObjects: sumRanges([imagery.objects, elevation.objects]), rawSourceDownloadBytes, outputWorkDiskBytes, peakWorkDiskBytes },
    sourceDownload: { candidateIds, unknownSizeIds }, browser: { decodedTileBytes,
      visibleDecodedBytes: range(decodedPerViewTile * a.visibleTiles[0], decodedPerViewTile * a.visibleTiles[1]),
      visibleNetworkBytes: range(Math.ceil(compressedPerViewTile[0] * a.visibleTiles[0]), Math.ceil(compressedPerViewTile[1] * a.visibleTiles[1])),
      visibleRequests: range(activeChannels.length * a.visibleTiles[0], activeChannels.length * a.visibleTiles[1]) }, budget };
}

/** Stable, deliberately rounded report; JSON retains unrounded geometry and explicit null bounds. */
export function formatSurfacePlanEstimate(e: SurfacePlanEstimate): string {
  const number = (n: number) => n.toLocaleString('en-US', { maximumSignificantDigits: 3 });
  const bytes = (n: number) => n >= 1e9 ? `${number(n / 1e9)} GB` : n >= 1e6 ? `${number(n / 1e6)} MB` : `${number(n)} bytes`;
  const bounds = (r: EstimateRange) => `${bytes(r.min)} .. ${r.max === null ? 'unknown' : bytes(r.max)}`;
  const lines = [`Surface data plan — ${e.stage} (estimator ${e.estimatorVersion})`, `Desired snapshot: ${e.desiredIdentity}`];
  if (e.sourceMetadataIdentity) lines.push(`Source metadata: ${e.sourceMetadataIdentity}`);
  for (const b of e.bands) lines.push(`${b.channel}: ${number(b.areaM2 / 1e6)} km² @ ${number(b.gsdM)} m GSD${b.accuracyM === null ? '' : ` / ${number(b.accuracyM)} m accuracy`}; ${b.baseSamples === null ? 'unknown' : number(b.baseSamples)} base samples; source ${b.sourceEvidence.status}; publish ${bounds(b.publishedBytes)}`);
  lines.push(`Raw source download (all candidates, counted once): ${bounds(e.totals.rawSourceDownloadBytes)}`,
    `Output/intermediate work disk scenario: ${bounds(e.totals.outputWorkDiskBytes)}`,
    `Peak/intermediate work disk: ${bounds(e.totals.peakWorkDiskBytes)}`,
    `Published: ${bounds(e.totals.publishedBytes)}; objects ${number(e.totals.publishedObjects.min)} .. ${e.totals.publishedObjects.max === null ? 'unknown' : number(e.totals.publishedObjects.max)}`,
    `Browser scenario: ${bounds(e.browser.visibleDecodedBytes)} decoded; ${bounds(e.browser.visibleNetworkBytes)} transfer; ${e.browser.visibleRequests.min}..${e.browser.visibleRequests.max} requests`,
    `Assumptions: ${e.assumptions.tileSize}px tiles + ${e.assumptions.gutter}px gutters; imagery ${e.assumptions.imageryBytesPerSample} B/sample, compression ${e.assumptions.imageryCompression.join('..')}; elevation ${e.assumptions.elevationBytesPerSample} B/sample, compression ${e.assumptions.elevationCompression.join('..')}; full 2× pyramid; work multiplier ${e.assumptions.workDiskMultiplier.join('..')}; ${e.assumptions.visibleTiles.join('..')} visible tiles/channel.`);
  if (e.budget) {
    lines.push(`Published budget: ${bytes(e.budget.publishedBytes)} — ${e.budget.status}`);
    for (const c of e.budget.comparisons) lines.push(`Compare only ${c.regionIds.join(', ')} at ${c.gsdMultiplier}× coarser GSD: ${bounds(c.publishedBytes)} — ${c.status}`);
  }
  for (const d of e.diagnostics) lines.push(`${d.severity} [${d.code}] ${d.path}: ${d.message}`);
  return lines.join('\n') + '\n';
}
