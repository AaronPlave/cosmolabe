import type { MultiPolygon } from 'polygon-clipping';
import type { DesiredSurfacePlan, SurfaceChannel, SurfacePlanDiagnostic, SurfaceSourceDescriptor } from './model.js';
import { resolveSurfacePlan, parseSurfaceSourceFootprint, serializeSurfacePlan, validateSurfaceSources } from './validation.js';
import { intersectGeometry, surfaceAreaM2, surfaceFeatureGeometry, unionGeometry } from './geometry.js';

/** Evidence is distinct from a buildable source descriptor. A raster envelope is NOT a valid-pixel mask. */
export interface SurfaceDiscoveryRecord {
  descriptor: SurfaceSourceDescriptor;
  kind: 'controlled-mosaic' | 'observation-image' | 'orthoimage' | 'stereo-dtm' | 'gridded-elevation';
  evidence: {
    url: string;
    footprint: 'raster-envelope' | 'verified-valid-data' | 'unknown';
    /** Explicit source for the footprint coordinates; never inferred from an observation center. */
    footprintUrl?: string;
    acquisitionUtc?: string;
    illumination?: string;
    registration?: string;
    /** Uncertainty/caveats from the source catalogue, not fabricated measured accuracy. */
    caveats?: string[];
  };
}
export type SurfaceDiscoveryPolicy = 'consistent' | 'finest-imagery' | 'physical-accuracy';
export interface SurfaceDiscoveryCandidate {
  sourceId: string;
  productId: string;
  kind: SurfaceDiscoveryRecord['kind'];
  nativeGsdM: number | null;
  accuracyM: number | null;
  /** Null means extent unknown; a numeric fraction describes the bounding footprint, NOT valid pixels. */
  footprintFraction: number | null;
  /** Null means valid-pixel fraction unverified. Zero is only returned for proven no overlap. */
  verifiedValidFraction: number | null;
  meetsTarget: boolean | null;
  reasons: string[];
  evidenceUrl: string;
}
export interface SurfaceRegionDiscovery {
  regionId: string;
  channel: SurfaceChannel;
  requestedGsdM: number;
  requestedAccuracyM: number | null;
  candidates: SurfaceDiscoveryCandidate[];
  /** Not a claim of archive completeness. Unknown portions must never be treated as unavailable. */
  status: 'verified-candidate' | 'unverified-candidates' | 'no-matching-candidate';
}
export interface SurfaceDiscoveryReport {
  version: 1;
  policy: SurfaceDiscoveryPolicy;
  recommendations: SurfaceRegionDiscovery[];
  diagnostics: SurfacePlanDiagnostic[];
}

const CHANNELS: readonly SurfaceChannel[] = ['imagery', 'elevation'];

/**
 * Pure, bounded source discovery for an offline/locked inventory. No raster access or API calls.
 * Uses #196/#248 planetary geometry, including polygon holes and longitude seams.
 * The output is intentionally separate from a buildable locked plan.
 */
export function recommendSurfaceSources(
  plan: DesiredSurfacePlan,
  records: readonly SurfaceDiscoveryRecord[],
  options: { policy?: SurfaceDiscoveryPolicy; references?: ReadonlyMap<string, string>; maxCandidates?: number } = {},
): SurfaceDiscoveryReport {
  const policy = options.policy ?? 'consistent';
  if (!['consistent', 'finest-imagery', 'physical-accuracy'].includes(policy))
    throw new Error('Unsupported surface discovery policy');
  const limit = options.maxCandidates ?? 3;
  if (!Number.isInteger(limit) || limit < 1 || limit > 3 || records.length > 32)
    throw new Error('Discovery limits: at most 32 sources and 1-3 recommendations per channel/region');
  validateSurfaceSources(records.map(r => r.descriptor));
  const resolved = resolveSurfacePlan(plan, options.references);
  const diagnostics = [...resolved.diagnostics];
  const sources = records.map(record => {
    const s = record.descriptor;
    const compatible = s.body === plan.body && s.frame === plan.frame
      && serializeSurfacePlan(s.coordinates) === serializeSurfacePlan(plan.coordinates);
    if (!compatible) diagnostics.push({ severity: 'warning', code: 'discovery-transform-unavailable', path: s.id,
      message: 'Source coordinate frame differs; no implicit transform or coverage assumed' });
    const footprint = parseSurfaceSourceFootprint(s);
    const geometry = footprint ? unionGeometry(footprint.features.map(f => surfaceFeatureGeometry(f, s.coordinates))) : null;
    if (record.evidence.footprint === 'verified-valid-data' && (!footprint || s.nodata !== 'none'))
      throw new Error('Verified-valid-data requires an explicit validated footprint and nodata=none: ' + s.id);
    if (record.evidence.footprint === 'unknown' && footprint)
      throw new Error('A footprint exists but evidence calls its provenance unknown: ' + s.id);
    if (!/^https:\/\//.test(record.evidence.url)) throw new Error('Evidence URL must be HTTPS: ' + s.id);
    return { record, geometry, compatible };
  });
  const recommendations: SurfaceRegionDiscovery[] = [];
  for (const region of plan.regions) {
    const layer = resolved.layers.find(l => l.id === region.feature.layerId)!;
    const feature = layer.features.find(f => f.id === region.feature.featureId)!;
    const geometry = surfaceFeatureGeometry(feature, plan.coordinates);
    const area = surfaceAreaM2(geometry, plan.coordinates);
    for (const channel of CHANNELS) {
      const target = region[channel];
      if (!target) continue;
      const candidates: Array<SurfaceDiscoveryCandidate & { score: number }> = [];
      for (const source of sources) {
        const s = source.record.descriptor;
        if (!source.compatible || s.channel !== channel) continue;
        const overlap: MultiPolygon | null = source.geometry === null ? null : intersectGeometry(geometry, source.geometry);
        const fraction = overlap === null ? null : Math.min(1, Math.max(0, surfaceAreaM2(overlap, plan.coordinates) / area));
        if (fraction !== null && fraction <= 1e-10) continue;
        const evidence = source.record.evidence;
        const valid = evidence.footprint === 'verified-valid-data' && fraction !== null ? fraction : null;
        const gsdOk = s.nativeGsdM === null ? null : s.nativeGsdM <= target.gsdM;
        const accuracyOk = target.accuracyM === undefined ? true :
          s.accuracyM === null ? null : s.accuracyM <= target.accuracyM;
        const meetsTarget = gsdOk === false || accuracyOk === false ? false :
          gsdOk === null || accuracyOk === null ? null : true;
        const reasons: string[] = [];
        if (fraction === null) reasons.push('Geographic extent unknown');
        else if (valid === null) reasons.push('Envelope overlaps ROI, valid pixel coverage not verified');
        else reasons.push('Verified valid-data coverage fraction ' + valid.toFixed(3));
        if (gsdOk === false) reasons.push('Native source sampling coarser than target; output upsampling cannot fix it');
        if (gsdOk === null) reasons.push('Native GSD unknown');
        if (accuracyOk === false) reasons.push('Physical accuracy does not meet target');
        if (accuracyOk === null) reasons.push('Physical accuracy unknown');
        if (s.datum.verticalDatum === 'unknown') reasons.push('Vertical datum unverified; not yet buildable');
        if (evidence.illumination) reasons.push('Illumination: ' + evidence.illumination);
        if (evidence.registration) reasons.push('Registration: ' + evidence.registration);
        reasons.push(...(evidence.caveats ?? []));
        // Stable ranking, with policy affecting ties but never overriding known insufficiency.
        const kind = source.record.kind;
        let score = (meetsTarget === true ? 100 : meetsTarget === null ? 50 : 0)
          + (valid === null ? 0 : 25 * valid) + (fraction ?? 0) * 12;
        if (s.nativeGsdM !== null) score += Math.min(10, 3 * Math.log2(1 + target.gsdM / s.nativeGsdM));
        if (policy === 'consistent') score += kind === 'controlled-mosaic' ? 15 : kind === 'orthoimage' ? 3 : 0;
        if (policy === 'finest-imagery' && channel === 'imagery' && s.nativeGsdM !== null)
          score += 12 / (1 + s.nativeGsdM);
        if (policy === 'physical-accuracy' && channel === 'elevation' && s.accuracyM !== null)
          score += 12 / (1 + s.accuracyM);
        candidates.push({ sourceId: s.id, productId: s.productId, kind, nativeGsdM: s.nativeGsdM,
          accuracyM: s.accuracyM, footprintFraction: fraction, verifiedValidFraction: valid,
          meetsTarget, reasons, evidenceUrl: evidence.url, score });
      }
      candidates.sort((a, b) => b.score - a.score || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
      const selected = candidates.slice(0, limit).map(c => ({ sourceId: c.sourceId, productId: c.productId,
        kind: c.kind, nativeGsdM: c.nativeGsdM, accuracyM: c.accuracyM,
        footprintFraction: c.footprintFraction, verifiedValidFraction: c.verifiedValidFraction,
        meetsTarget: c.meetsTarget, reasons: c.reasons, evidenceUrl: c.evidenceUrl }));
      const status: SurfaceRegionDiscovery['status'] = selected.some(c => c.meetsTarget === true && c.verifiedValidFraction !== null && c.verifiedValidFraction > 0)
        ? 'verified-candidate' : selected.length ? 'unverified-candidates' : 'no-matching-candidate';
      if (status !== 'verified-candidate') diagnostics.push({ severity: 'warning',
        code: 'discovery-coverage-unverified', path: region.id + '.' + channel,
        message: selected.length ? 'No candidate establishes valid source coverage and target fidelity' : 'No matching catalogued candidates; archive coverage is unknown' });
      recommendations.push({ regionId: region.id, channel, requestedGsdM: target.gsdM,
        requestedAccuracyM: target.accuracyM ?? null, candidates: selected, status });
    }
  }
  return { version: 1, policy, recommendations, diagnostics };
}
