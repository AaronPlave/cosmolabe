import { surfaceSourceDownloadCost } from './source-metadata.js';
import type { MultiPolygon } from 'polygon-clipping';
import type { DesiredSurfacePlan, EstimateRange, SurfaceChannel, SurfaceFidelity, SurfacePlanDiagnostic, SurfaceSourceDescriptor } from './model.js';
import { resolveSurfacePlan, parseSurfaceSourceFootprint, serializeSurfacePlan, validateSurfaceSources } from './validation.js';
import { intersectGeometry, subtractGeometry, surfaceAreaM2, surfaceFeatureGeometry, unionGeometry } from './geometry.js';
import { geographicDatum } from '../geographic/import.js';

/** Evidence is distinct from a buildable source descriptor. An envelope is NOT a valid-pixel mask. */
export interface SurfaceDiscoveryRecord {
  descriptor: SurfaceSourceDescriptor;
  kind: 'controlled-mosaic' | 'observation-image' | 'orthoimage' | 'stereo-dtm' | 'gridded-elevation';
  evidence: {
    url: string;
    footprint: 'raster-envelope' | 'archive-footprint' | 'verified-valid-data' | 'unknown';
    footprintUrl?: string;
    acquisitionUtc?: string;
    illumination?: string;
    registration?: string;
    caveats?: string[];
  };
}
export type SurfaceDiscoveryPolicy = 'consistent' | 'finest-imagery' | 'physical-accuracy';
export interface SurfaceDiscoveryCandidate {
  sourceId: string;
  productId: string;
  kind: SurfaceDiscoveryRecord['kind'];
  nativeGsdM: number | null;
  rasterGsdM: number | null;
  accuracyM: number | null;
  footprintFraction: number | null;
  verifiedValidFraction: number | null;
  meetsTarget: boolean | null;
  reasons: string[];
  evidenceUrl: string;
}
export interface SurfaceDiscoveryCoverage {
  status: 'verified-complete' | 'verified-partial' | 'unknown' | 'verified-empty';
  verifiedFraction: number;
  /** Potential coverage without pixel-validity evidence. */
  unknownFraction: number;
  /** Proven absent from these selected products; never an archive-wide absence claim. */
  gapFraction: number;
  targetVerifiedFraction: number;
  verifiedGeometry: MultiPolygon;
  unknownGeometry: MultiPolygon;
  gapGeometry: MultiPolygon;
}
export interface SurfaceRegionDiscovery {
  regionId: string;
  channel: SurfaceChannel;
  requestedGsdM: number;
  requestedAccuracyM: number | null;
  candidates: SurfaceDiscoveryCandidate[];
  status: 'verified-complete' | 'verified-partial' | 'unverified-candidates' | 'no-matching-candidate';
  fallbacks: { finerOrEqualSourceIds: string[]; coarserSourceIds: string[]; unknownSamplingSourceIds: string[] };
}
export interface SurfaceSourceCombination {
  id: string;
  regionId: string;
  sourceIds: string[];
  channels: Partial<Record<SurfaceChannel, {
    sourceIds: string[];
    requestedGsdM: number;
    coverage: SurfaceDiscoveryCoverage;
    finerSourceIds: string[];
    coarserSourceIds: string[];
    unknownGsdSourceIds: string[];
  }>>;
  compatibility: 'evidenced' | 'unverified';
  /** All recommendations remain exploratory; a build lock always requires separate validation. */
  stage: 'discovery-only';
  cost: {
    downloadBytes: EstimateRange;
    unknownSizeIds: string[];
    /** Uncompressed requested base grids, no pyramid/gutters/compression; a work proxy, not a measured build. */
    requestedBaseGridBytes: number | null;
    sourceCount: number;
  };
  reasons: string[];
  warnings: string[];
  evidence: { sourceId: string; url: string }[];
}
export interface SurfaceDiscoveryReport {
  version: 1;
  policy: SurfaceDiscoveryPolicy;
  recommendations: SurfaceRegionDiscovery[];
  combinations: { regionId: string; alternatives: SurfaceSourceCombination[] }[];
  /** Top alternative per region only, de-duplicated. This is not a locked selection. */
  recommendedSourceIds: string[];
  diagnostics: SurfacePlanDiagnostic[];
}
const CHANNELS: readonly SurfaceChannel[] = ['imagery', 'elevation'];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const same = (a: unknown, b: unknown) => serializeSurfacePlan(a) === serializeSurfacePlan(b);
const EPS = 1e-8;
interface Source {
  record: SurfaceDiscoveryRecord;
  geometry: MultiPolygon | null;
  valid: MultiPolygon | null;
  compatible: boolean;
}
interface Ranked { source: Source; candidate: SurfaceDiscoveryCandidate; score: number; }
function geometryOf(s: SurfaceSourceDescriptor): MultiPolygon | null {
  const f = parseSurfaceSourceFootprint(s);
  return f ? unionGeometry(f.features.map(v => surfaceFeatureGeometry(v, s.coordinates))) : null;
}
function targetFit(s: SurfaceSourceDescriptor, t: SurfaceFidelity): boolean | null {
  const gsd = s.nativeGsdM === null ? null : s.nativeGsdM <= t.gsdM;
  const accuracy = t.accuracyM === undefined ? true : s.accuracyM === null ? null : s.accuracyM <= t.accuracyM;
  return gsd === false || accuracy === false ? false : gsd === null || accuracy === null ? null : true;
}
/** A shared reference shape is necessary; registration evidence is also required to union two products. */
function canUnion(a: Source, b: Source): boolean {
  const x = a.record.descriptor, y = b.record.descriptor;
  return same(x.datum, y.datum) && x.datum.verticalDatum !== 'unknown'
    && !!x.metadata?.registration && x.metadata.registration.group === y.metadata?.registration?.group;
}
function coverage(roi: MultiPolygon, sources: Source[], plan: DesiredSurfacePlan, target: SurfaceFidelity): SurfaceDiscoveryCoverage {
  const area = surfaceAreaM2(roi, plan.coordinates);
  const clipped = (gs: MultiPolygon[]) => intersectGeometry(roi, unionGeometry(gs));
  const valid = clipped(sources.flatMap(s => s.valid === null ? [] : [s.valid]));
  const possible = clipped(sources.map(s => s.record.descriptor.metadata?.validData?.extent === 'complete-mask'
    ? s.valid! : s.geometry ?? roi));
  const unknown = subtractGeometry(possible, valid), gaps = subtractGeometry(roi, unionGeometry([possible, valid]));
  const adequate = clipped(sources.filter(s => targetFit(s.record.descriptor, target) === true
    && !!s.record.descriptor.metadata?.registration
    && same(s.record.descriptor.datum, geographicDatum(plan.coordinates))).flatMap(s => s.valid === null ? [] : [s.valid]));
  const fraction = (g: MultiPolygon) => Math.max(0, Math.min(1, surfaceAreaM2(g, plan.coordinates) / area));
  const verifiedFraction = fraction(valid), unknownFraction = fraction(unknown), gapFraction = fraction(gaps);
  return { status: verifiedFraction >= 1 - EPS ? 'verified-complete' : verifiedFraction > EPS ? 'verified-partial'
    : unknownFraction > EPS ? 'unknown' : 'verified-empty', verifiedFraction, unknownFraction, gapFraction,
    targetVerifiedFraction: fraction(adequate), verifiedGeometry: valid, unknownGeometry: unknown, gapGeometry: gaps };
}
function pairWarnings(sources: Source[]): string[] {
  const warnings = new Set<string>();
  for (const s of sources) {
    const d = s.record.descriptor, m = d.metadata;
    if (!m?.registration) warnings.add('Registration unverified: ' + d.id);
    if (d.datum.verticalDatum === 'unknown') warnings.add('Datum unknown: ' + d.id);
    if (m?.confidence === 'unknown') warnings.add('Low-trust source metadata: ' + d.id);
    if (m?.reuse.status !== 'allowed') warnings.add('Reuse terms require review: ' + d.id);
    if (!m?.illumination?.photometry && d.channel === 'imagery') warnings.add('Photometry unknown: ' + d.id);
  }
  for (let i = 0; i < sources.length; i++) for (let j = i + 1; j < sources.length; j++) {
    const a = sources[i].record.descriptor, b = sources[j].record.descriptor;
    if (!same(a.datum, b.datum)) warnings.add('Datum mismatch; explicit transform required: ' + a.id + ', ' + b.id);
    if (a.projection !== b.projection) warnings.add('Source projections differ; explicit reprojection required: ' + a.id + ', ' + b.id);
    if (!canUnion(sources[i], sources[j])) warnings.add('Joint registration unverified: ' + a.id + ', ' + b.id);
    if (a.channel === 'imagery' && b.channel === 'imagery') {
      const x = a.metadata, y = b.metadata;
      if (!x?.observationId || x.observationId !== y?.observationId) warnings.add('Different/unknown observations; no automatic image fusion');
      const angleA = x?.illumination?.incidenceDeg, angleB = y?.illumination?.incidenceDeg;
      if (angleA != null && angleB != null && Math.abs(angleA - angleB) > 10) warnings.add('Illumination mismatch exceeds 10 degrees incidence');
    }
  }
  return [...warnings].sort(compare);
}
/** Pure, bounded, renderer-free discovery using the same planetary polygon/area model as #248. */
export function recommendSurfaceSources(
  plan: DesiredSurfacePlan, records: readonly SurfaceDiscoveryRecord[],
  options: { policy?: SurfaceDiscoveryPolicy; references?: ReadonlyMap<string, string>; maxCandidates?: number } = {},
): SurfaceDiscoveryReport {
  const policy = options.policy ?? 'consistent', limit = options.maxCandidates ?? 3;
  if (!['consistent', 'finest-imagery', 'physical-accuracy'].includes(policy)) throw new Error('Unsupported surface discovery policy');
  if (!Number.isInteger(limit) || limit < 1 || limit > 3 || records.length > 32)
    throw new Error('Discovery limits: at most 32 sources and 1-3 recommendations per region');
  validateSurfaceSources(records.map(r => r.descriptor));
  const resolved = resolveSurfacePlan(plan, options.references), diagnostics = [...resolved.diagnostics];
  const diagnostic = (code: string, path: string, message: string) => diagnostics.push({ severity: 'warning', code, path, message });
  const sources: Source[] = [...records].sort((a, b) => compare(a.descriptor.id, b.descriptor.id)).map(record => {
    const s = record.descriptor;
    if (!['controlled-mosaic', 'observation-image', 'orthoimage', 'stereo-dtm', 'gridded-elevation'].includes(record.kind)) throw new Error('Unknown source kind: ' + s.id);
    if ((record.kind === 'stereo-dtm' || record.kind === 'gridded-elevation') !== (s.channel === 'elevation')) throw new Error('Source kind/channel mismatch: ' + s.id);
    if (!/^https:\/\//.test(record.evidence.url)) throw new Error('Evidence URL must be HTTPS: ' + s.id);
    const compatible = s.body === plan.body && s.frame === plan.frame && same(s.coordinates, plan.coordinates);
    if (!compatible) diagnostic('discovery-transform-unavailable', s.id, 'Source coordinates differ; no implicit coverage transform');
    const geometry = geometryOf(s), mask = s.metadata?.validData;
    if (record.evidence.footprint === 'unknown' && geometry) throw new Error('Footprint provenance is unknown: ' + s.id);
    if (record.evidence.footprint === 'verified-valid-data' && !mask)
      throw new Error('Verified-valid-data requires independent mask geometry, evidence URL and method; nodata=none is insufficient: ' + s.id);
    const valid = mask ? geometryOf({ ...s, footprint: mask.geometry }) : null;
    if (!same(s.datum, geographicDatum(plan.coordinates))) diagnostic('discovery-datum-unresolved', s.id,
      'Source datum is unknown or differs from target; no identity-only build or validated physical fidelity assumed');
    if (s.metadata?.sourceProjection === null || /unconfirmed|unknown/i.test(s.projection)) diagnostic('discovery-projection-unverified', s.id, 'Source projection needs label verification');
    return { record, geometry, valid, compatible };
  });
  const recommendations: SurfaceRegionDiscovery[] = [], combinations: SurfaceDiscoveryReport['combinations'] = [];
  for (const region of plan.regions) {
    const layer = resolved.layers.find(l => l.id === region.feature.layerId)!;
    const feature = layer.features.find(f => f.id === region.feature.featureId)!;
    const roi = surfaceFeatureGeometry(feature, plan.coordinates), area = surfaceAreaM2(roi, plan.coordinates);
    if (area <= 1e-8) throw new Error('ROI is below surface-area precision: ' + region.id);
    const channelOptions: Partial<Record<SurfaceChannel, Ranked[][]>> = {};
    for (const channel of CHANNELS) {
      const target = region[channel]; if (!target) continue;
      const ranked: Ranked[] = [];
      for (const source of sources) {
        const { descriptor: s, evidence, kind } = source.record;
        if (!source.compatible || s.channel !== channel) continue;
        const fraction = source.geometry === null ? null : surfaceAreaM2(intersectGeometry(roi, source.geometry), plan.coordinates) / area;
        if (fraction !== null && fraction <= EPS) continue;
        const valid = source.valid === null ? null : surfaceAreaM2(intersectGeometry(roi, source.valid), plan.coordinates) / area;
        const meetsTarget = targetFit(s, target);
        const reasons = [fraction === null ? 'Geographic extent unknown' : 'Product footprint overlaps ROI; footprint alone is not pixel validity',
          valid === null ? 'Valid-pixel coverage unverified' : 'Verified pixel fraction ' + valid.toFixed(6)];
        if (meetsTarget === false) reasons.push('Source is coarser or less accurate than requested; upsampling cannot repair fidelity');
        if (s.nativeGsdM === null) reasons.push('Native acquisition GSD unknown; raster grid is reported separately');
        if (target.accuracyM !== undefined && s.accuracyM === null) reasons.push('Physical accuracy unknown; pixel interval is not accuracy');
        if (!source.record.descriptor.metadata?.registration) reasons.push('Registration unverified');
        reasons.push(...(evidence.caveats ?? []));
        let score = (meetsTarget === true ? 80 : meetsTarget === null ? 30 : 0) + 100 * (valid ?? 0) + 15 * (fraction ?? 0);
        if (s.nativeGsdM !== null) score += Math.min(15, 3 * Math.log2(1 + target.gsdM / s.nativeGsdM));
        if (policy === 'consistent') score += kind === 'controlled-mosaic' ? 45 : kind === 'orthoimage' ? 12 : 0;
        if (policy === 'finest-imagery' && channel === 'imagery' && s.nativeGsdM !== null) score += 50 / (1 + s.nativeGsdM);
        if (policy === 'physical-accuracy' && channel === 'elevation' && s.accuracyM !== null) score += 60 / (1 + s.accuracyM);
        if (s.metadata?.reuse.status === 'restricted') score -= 100;
        if (s.metadata?.confidence === 'unknown') score -= 25;
        if (s.asset.bytes !== undefined) score -= Math.min(8, Math.log2(1 + s.asset.bytes / 1e8));
        ranked.push({ source, score, candidate: { sourceId: s.id, productId: s.productId, kind, nativeGsdM: s.nativeGsdM,
          rasterGsdM: s.metadata?.rasterGsdM ?? null, accuracyM: s.accuracyM, footprintFraction: fraction,
          verifiedValidFraction: valid, meetsTarget, reasons, evidenceUrl: evidence.url } });
      }
      ranked.sort((a, b) => b.score - a.score || compare(a.candidate.sourceId, b.candidate.sourceId));
      const selected = ranked.slice(0, limit).map(r => r.candidate);
      const complete = ranked.slice(0, limit).some(r => r.candidate.meetsTarget === true && r.candidate.verifiedValidFraction !== null
        && r.candidate.verifiedValidFraction >= 1 - EPS && !!r.source.record.descriptor.metadata?.registration
        && same(r.source.record.descriptor.datum, geographicDatum(plan.coordinates)));
      const partial = selected.some(c => c.verifiedValidFraction !== null && c.verifiedValidFraction > EPS);
      const status: SurfaceRegionDiscovery['status'] = complete ? 'verified-complete' : partial ? 'verified-partial'
        : selected.length ? 'unverified-candidates' : 'no-matching-candidate';
      if (!complete) diagnostic(partial ? 'discovery-coverage-partial' : 'discovery-coverage-unverified', region.id + '.' + channel,
        'No single source proves complete target fidelity; uncovered/unknown ROI remains explicit in combination coverage');
      recommendations.push({ regionId: region.id, channel, requestedGsdM: target.gsdM,
        requestedAccuracyM: target.accuracyM ?? null, candidates: selected, status,
        fallbacks: { finerOrEqualSourceIds: ranked.filter(r => r.candidate.nativeGsdM !== null && r.candidate.nativeGsdM <= target.gsdM).slice(0, limit).map(r => r.candidate.sourceId),
          coarserSourceIds: ranked.filter(r => r.candidate.nativeGsdM !== null && r.candidate.nativeGsdM > target.gsdM).slice(0, limit).map(r => r.candidate.sourceId),
          unknownSamplingSourceIds: ranked.filter(r => r.candidate.nativeGsdM === null).slice(0, limit).map(r => r.candidate.sourceId) } });
      const allowed = ranked.filter(r => r.source.record.descriptor.metadata?.reuse.status !== 'restricted'
        && (r.candidate.meetsTarget !== false || region.fallback === 'allow-coarser'));
      // Include independent alternatives and bounded compatible sets. A set grows only for actual incremental valid coverage.
      const sets: Ranked[][] = allowed.map(r => [r]);
      for (const seed of allowed) {
        const set = [seed]; let covered = seed.source.valid ?? [];
        for (const next of allowed) {
          if (set.length === 3) break;
          if (set.includes(next) || !next.source.valid || !set.every(s => canUnion(s.source, next.source))) continue;
          const gain = surfaceAreaM2(intersectGeometry(roi, subtractGeometry(next.source.valid, covered)), plan.coordinates);
          if (gain > area * EPS) { set.push(next); covered = unionGeometry([covered, next.source.valid]); }
        }
        if (set.length > 1) sets.push(set);
      }
      channelOptions[channel] = sets.length ? sets : [[]];
      if (channel === 'imagery') for (const r of ranked.filter(r => r.source.record.kind === 'observation-image')) {
        const dtms = sources.filter(s => s.record.kind === 'stereo-dtm' && (r.source.record.descriptor.metadata?.stereoProductIds ?? []).includes(s.record.descriptor.productId));
        if (!dtms.length) diagnostic('discovery-no-released-stereo-dtm', r.candidate.sourceId, 'Image has no evidenced matching released DTM in this inventory; stereo availability is unknown');
      }
    }
    const alternatives: Array<SurfaceSourceCombination & { score: number }> = [], seen = new Set<string>();
    for (const images of channelOptions.imagery ?? [[]]) for (const heights of channelOptions.elevation ?? [[]]) {
      const members = [...images, ...heights], chosen = members.map(r => r.source), ids = members.map(r => r.candidate.sourceId).sort(compare);
      const key = JSON.stringify(ids); if (seen.has(key)) continue; seen.add(key);
      const channels: SurfaceSourceCombination['channels'] = {};
      let score = 0, gridBytes = 0;
      for (const channel of CHANNELS) {
        const target = region[channel]; if (!target) continue;
        const list = channel === 'imagery' ? images : heights;
        const cov = coverage(roi, list.map(r => r.source), plan, target);
        channels[channel] = { sourceIds: list.map(r => r.candidate.sourceId).sort(compare), requestedGsdM: target.gsdM, coverage: cov,
          finerSourceIds: list.filter(r => r.candidate.nativeGsdM !== null && r.candidate.nativeGsdM <= target.gsdM).map(r => r.candidate.sourceId),
          coarserSourceIds: list.filter(r => r.candidate.nativeGsdM !== null && r.candidate.nativeGsdM > target.gsdM).map(r => r.candidate.sourceId),
          unknownGsdSourceIds: list.filter(r => r.candidate.nativeGsdM === null).map(r => r.candidate.sourceId) };
        score += (list[0]?.score ?? -100) + cov.verifiedFraction * 100 + cov.targetVerifiedFraction * 150 - cov.gapFraction * 15;
        gridBytes += area / target.gsdM ** 2 * (channel === 'imagery' ? 3 : 4);
      }
      const warnings = pairWarnings(chosen);
      const { knownBytes: bytes, unknownSizeIds } = surfaceSourceDownloadCost(chosen.map(s => s.record.descriptor));
      const evidenced = chosen.length > 0 && chosen.every(s => s.record.descriptor.datum.verticalDatum !== 'unknown' && !!s.record.descriptor.metadata?.registration)
        && chosen.every((s, i) => chosen.slice(i + 1).every(t => canUnion(s, t)));
      if (!evidenced) score -= 10;
      score -= members.length * 2;
      alternatives.push({ id: region.id + ':' + key, regionId: region.id, sourceIds: ids, channels,
        compatibility: evidenced ? 'evidenced' : 'unverified', stage: 'discovery-only',
        cost: { downloadBytes: { min: bytes, max: unknownSizeIds.length ? null : bytes }, unknownSizeIds,
          requestedBaseGridBytes: Number.isSafeInteger(Math.ceil(gridBytes)) ? Math.ceil(gridBytes) : null, sourceCount: chosen.length },
        reasons: ['Policy: ' + policy, ...members.map(r => r.source.record.descriptor.channel + ': ' + r.candidate.productId
          + ', source sampling ' + (r.candidate.nativeGsdM === null ? 'unknown' : r.candidate.nativeGsdM + ' m')
          + ', target ' + (r.candidate.meetsTarget === true ? 'met by source metadata' : r.candidate.meetsTarget === false ? 'not met' : 'unverified')),
          ...CHANNELS.flatMap(channel => channels[channel] ? [channel + ' ROI: ' + (channels[channel]!.coverage.verifiedFraction * 100).toFixed(2)
            + '% verified pixels, ' + (channels[channel]!.coverage.unknownFraction * 100).toFixed(2) + '% unknown, '
            + (channels[channel]!.coverage.gapFraction * 100).toFixed(2) + '% gap in selected products'] : []),
          'Coverage union includes only compatible evidenced masks; unknowns and gaps are separate',
          'Download cost includes these products only; requested-grid work proxy excludes pyramid, tiling and reprojection'],
        warnings, evidence: members.map(r => ({ sourceId: r.candidate.sourceId, url: r.candidate.evidenceUrl })).sort((a, b) => compare(a.sourceId, b.sourceId)), score });
    }
    alternatives.sort((a, b) => b.score - a.score || a.cost.downloadBytes.min - b.cost.downloadBytes.min || compare(a.id, b.id));
    combinations.push({ regionId: region.id, alternatives: alternatives.slice(0, limit).map(({ score: _score, ...v }) => v) });
  }
  const recommendedSourceIds = [...new Set(combinations.flatMap(c => c.alternatives[0]?.sourceIds ?? []))].sort(compare);
  return { version: 1, policy, recommendations, combinations, recommendedSourceIds, diagnostics };
}

/** Preserve upstream identity and uncertainty; only the report's top alternatives enter #248's cost estimate. */
export function discoveryEstimatorSources(report: SurfaceDiscoveryReport, records: readonly SurfaceDiscoveryRecord[]): SurfaceSourceDescriptor[] {
  return records.filter(r => report.recommendedSourceIds.includes(r.descriptor.id)).map(r => {
    const d = r.descriptor;
    // Legacy descriptors with a naked nodata=none cannot upgrade discovery uncertainty in the estimator.
    return d.nodata === 'none' && !d.metadata?.validData ? { ...d, nodata: 'unknown' as const } : d;
  }).sort((a, b) => compare(a.id, b.id));
}
