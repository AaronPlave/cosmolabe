/** Model-visible metadata is a projection, never a serialization of a local resource. */
import type { ScriptImagery, ScriptImageryLayer, ScriptPlace, ScriptSurfaceData, ScriptSurfaceProduct } from './contracts.js';
import type { TrajectoryExtremum } from '@cosmolabe/interop';

export interface AgentMetadataPolicy {
  /** Trusted host approval of an exact public provenance value. Default: withhold. */
  publicValue?(value: string): boolean;
  /** Trusted host approval of a complete public attribute pair. Default: withhold. */
  publicPlaceField?(key: string, value: string | number | boolean): boolean;
}

// Closed scientific vocabulary; this does not approve arbitrary catalog text.
const PUBLIC_TERMS = new Set(['estimated', 'reconstructed', 'observed', 'planned', 'unknown', 'exact',
  'ellipsoid', 'areoid', 'reference-sphere', 'height-grid', 'radial', 'geodetic-normal', 'planetocentric', 'IAU_MARS', 'IAU_MOON', 'MOON_ME_DE421', 'MOON_PA_DE421']);

export function agentMetadata(policy: AgentMetadataPolicy = {}) {
  const text = (value: string | null | undefined) => value != null && (PUBLIC_TERMS.has(value) || policy.publicValue?.(value) === true) ? value : null;
  const shape = (value: import('@cosmolabe/interop').TrajectoryExtremaQuery['reference'] | null | undefined) => {
    if (value?.kind === 'sphere' && Number.isFinite(value.radiusKm) && value.radiusKm > 0) return {kind:'sphere',radiusKm:value.radiusKm};
    if (value?.kind === 'ellipsoid' && value.radiiKm.length === 3 && value.radiiKm.every(radius => Number.isFinite(radius) && radius > 0)) return {kind:'ellipsoid',radiiKm:value.radiiKm.slice(0,3)};
    return null;
  };
  const place = (p: ScriptPlace) => {
    const fields = Object.fromEntries(Object.entries(p.fields ?? {}).filter(([key, value]) => policy.publicPlaceField?.(key, value) === true));
    return {
      ref: p.ref, name: p.name, body: p.body, kind: p.kind, origin: p.origin, latitude: p.latitude, longitude: p.longitude,
      ...(p.diameterKm !== undefined ? { diameterKm: p.diameterKm } : {}),
      ...(Object.keys(fields).length ? { fields } : {}),
      layer: { name: p.layer.name },
      source: { kind: p.source.kind, identity: text(p.source.identity), revision: text(p.source.revision) },
      unavailable: p.unavailable ? 'Place navigation is unavailable; consult the local record for details.' : null,
    };
  };
  const layer = (l: ScriptImageryLayer) => ({
    id: l.id, name: l.name, role: l.role, optional: l.optional, visible: l.visible, opacity: l.opacity,
    bounds: l.bounds, resolutionMeters: l.resolutionMeters, status: l.status,
    attribution: text(l.attribution), description: text(l.description),
    // Endpoints and service resource identifiers are never sent, even if approved.
    view: l.view ? { inCoverage: l.view.inCoverage, zoomLevel: l.view.zoomLevel, minZoom: l.view.minZoom,
      missingTiles: l.view.missingTiles, degradedTiles: l.view.degradedTiles, cacheFull: l.view.cacheFull } : null,
  });
  const imagery = (i: ScriptImagery) => ({ body: i.body, surface: i.surface, imageryOnly: i.imageryOnly, layers: i.layers.map(layer) });
  const product = (p: ScriptSurfaceProduct | null) => p ? {
    kind: p.kind, configured: p.configured,
    source: { id: text(p.source.id), revision: text(p.source.revision), kind: text(p.source.kind), attribution: text(p.source.attribution) },
    frame: text(p.frame), datum: p.datum ? { verticalDatum: text(p.datum.verticalDatum), heightConvention: text(p.datum.heightConvention), ...(p.datum.referenceShape ? {referenceShape:shape(p.datum.referenceShape)} : {}) } : null,
    resolutionMeters: p.resolutionMeters, crsId: text(p.crsId),
    lod: p.lod ? { minLevel: p.lod.minLevel, maxLevel: p.lod.maxLevel } : null,
    runtime: { ready: p.runtime.ready, loaded: p.runtime.loaded, manifestFailed: p.runtime.manifestFailed ?? null,
      failedRequests: p.runtime.failedRequests, drawn: p.runtime.drawn, coversView: p.runtime.coversView,
      coversDrawnTiles: p.runtime.coversDrawnTiles ?? null },
  } : null;
  const surface = (s: ScriptSurfaceData) => ({
    ...(s.referenceShape ? {referenceShape:shape(s.referenceShape)} : {}),
    body: s.body, bodyFrame: text(s.bodyFrame), surface: s.surface,
    terrain: product(s.terrain), cubeImagery: product(s.cubeImagery), textures: s.textures.map(p => product(p)),
    imageryProducts: s.imageryProducts.map(p => product(p)), overlays: s.overlays.map(layer),
  });
  const trajectoryExtremum = (r: TrajectoryExtremum) => ({
    id:r.id,object:r.object,activityId:r.activityId,activityName:r.activityName,body:r.body,frame:text(r.frame),
    metric:r.metric,extremum:r.extremum,value:r.value,units:r.units,et:r.et,utc:r.utc,
    location:{positionKm:r.location.positionKm.slice(0,3),latitudeDeg:r.location.latitudeDeg,longitudeDeg:r.location.longitudeDeg,convention:r.location.convention},
    datum:r.datum.kind === 'sphere' ? {kind:'sphere',radiusKm:r.datum.radiusKm} : {kind:'ellipsoid',radiiKm:r.datum.radiiKm.slice(0,3)},
    heightConvention:r.heightConvention,
    window:{start:r.window.start,end:r.window.end},coverage:r.coverage,
    source:{id:text(r.source.id),revision:text(r.source.revision),classification:r.source.classification},
    terrain:r.terrain ? {id:text(r.terrain.id),revision:text(r.terrain.revision),sourceUncertaintyKm:r.terrain.sourceUncertaintyKm} : null,
    method:{guarantee:r.method.guarantee,stepSeconds:r.method.stepSeconds,timeToleranceSeconds:r.method.timeToleranceSeconds,evaluations:r.method.evaluations,heightErrorBoundKm:r.method.heightErrorBoundKm,
      limits:'Sampled and locally refined; no certified global height error. Source accuracy is separate.'},
  });
  return { text, place, imagery, surface, trajectoryExtremum };
}
