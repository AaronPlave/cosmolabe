/** Model-visible metadata is a projection, never a serialization of a local resource. */
import type { ScriptImagery, ScriptImageryLayer, ScriptPlace, ScriptSurfaceData, ScriptSurfaceProduct, ScriptGeographicLayer, ScriptGeographicFeature } from './contracts.js';

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
    frame: text(p.frame), datum: p.datum ? { verticalDatum: text(p.datum.verticalDatum), heightConvention: text(p.datum.heightConvention) } : null,
    resolutionMeters: p.resolutionMeters, crsId: text(p.crsId),
    lod: p.lod ? { minLevel: p.lod.minLevel, maxLevel: p.lod.maxLevel } : null,
    runtime: { ready: p.runtime.ready, loaded: p.runtime.loaded, manifestFailed: p.runtime.manifestFailed ?? null,
      failedRequests: p.runtime.failedRequests, drawn: p.runtime.drawn, coversView: p.runtime.coversView,
      coversDrawnTiles: p.runtime.coversDrawnTiles ?? null },
  } : null;
  const surface = (s: ScriptSurfaceData) => ({
    body: s.body, bodyFrame: text(s.bodyFrame), surface: s.surface,
    terrain: product(s.terrain), cubeImagery: product(s.cubeImagery), textures: s.textures.map(p => product(p)),
    imageryProducts: s.imageryProducts.map(p => product(p)), overlays: s.overlays.map(layer),
  });
  const geographicLayer = (l: ScriptGeographicLayer) => ({
    id: l.id, name: text(l.name)?.slice(0, 512) ?? null, body: l.body, frame: text(l.frame), features: l.features,
    status: l.status, visible: l.visible, editable: l.editable, navigable: l.navigationUnavailable === null,
    diagnosticsTotal: l.diagnostics.length,
    diagnostics: l.diagnostics.slice(0, 16).map(d => ({ code: text(d.code)?.slice(0, 160) ?? null, severity: d.severity === 'warning' || d.severity === 'error' ? d.severity : 'unknown' })),
  });
  const geographicFeature = (f: ScriptGeographicFeature) => ({
    id: f.id, name: text(f.name)?.slice(0, 512) ?? null,
    type: ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection'].includes(f.type) ? f.type : 'unknown',
    sourceId: typeof f.sourceId === 'number' ? f.sourceId : text(f.sourceId),
    // No object spread: imported properties, provenance and annotation payloads stay local.
  });
  return { text, place, imagery, surface, geographicLayer, geographicFeature };
}
