import type { MeasurementDefinition, SpatialEndpoint, ReferenceVector } from '@cosmolabe/core';
/** Model-visible metadata is a projection, never a serialization of a local resource. */
import type { ScriptImagery, ScriptImageryLayer, ScriptPlace, ScriptSurfaceData, ScriptSurfaceProduct, ScriptGeographicLayer, ScriptGeographicFeature, ScriptSpatialContext, ScriptGroundProjection, ScriptProbePoint, ScriptObjectState } from './contracts.js';
import type { TrajectoryExtremum } from '@cosmolabe/interop';

export interface AgentMetadataPolicy {
  /** Trusted host approval of an exact public provenance value. Default: withhold. */
  publicValue?(value: string): boolean;
  /** Trusted host approval of a complete public attribute pair. Default: withhold. */
  publicPlaceField?(key: string, value: string | number | boolean): boolean;
}

// Closed scientific vocabulary; this does not approve arbitrary catalog text.
const PUBLIC_TERMS = new Set(['estimated', 'reconstructed', 'observed', 'planned', 'unknown', 'exact',
  'ellipsoid', 'areoid', 'reference-sphere', 'height-grid', 'radial', 'geodetic-normal', 'planetocentric', 'ECLIPJ2000', 'J2000', 'IAU_MARS', 'IAU_MOON', 'MOON_ME_DE421', 'MOON_PA_DE421', 'IAU_SATURN', 'IAU_JUPITER', 'IAU_SUN', 'IAU_EARTH', 'IAU_VENUS', 'IAU_MERCURY', 'IAU_URANUS', 'IAU_NEPTUNE', 'IAU_TITAN', 'IAU_MIMAS', 'IAU_ENCELADUS']);

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
    source:{id:text(r.source.id),revision:text(r.source.revision),classification:r.source.classification, estimatedReconstruction: /estimated|reconstruct/i.test(r.source.description ?? '')},
    terrain:r.terrain ? {id:text(r.terrain.id),revision:text(r.terrain.revision),sourceUncertaintyKm:r.terrain.sourceUncertaintyKm} : null,
    method:{guarantee:r.method.guarantee,stepSeconds:r.method.stepSeconds,timeToleranceSeconds:r.method.timeToleranceSeconds,evaluations:r.method.evaluations,heightErrorBoundKm:r.method.heightErrorBoundKm,
      limits:'Sampled and locally refined; no certified global height error. Source accuracy is separate.'},
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
    sourceId: typeof f.sourceId === 'number' || typeof f.sourceId === 'string' && /^user-\d{1,8}$/.test(f.sourceId) && f.id === `string:${f.sourceId}` ? f.sourceId : text(f.sourceId),
    // No object spread: imported properties, provenance and annotation payloads stay local.
  });
  const endpoint = (e: SpatialEndpoint | null | undefined): unknown => {
    if (!e) return null;
    if (e.kind === 'entity') return { kind: e.kind, bodyName: e.bodyName };
    if (e.kind === 'coordinate') return { kind: e.kind, positionKm: e.positionKm.slice(0,3), frame: text(e.frame ?? 'ECLIPJ2000') };
    if (e.kind === 'body-fixed') return { kind: e.kind, bodyName: e.bodyName, positionKm: e.positionKm.slice(0,3) };
    return { kind: e.kind, bodyName: e.point.bodyName, frame: text(e.point.frame), latDeg: e.point.latDeg, lonDeg: e.point.lonDeg,
      latitudeKind: e.point.latitudeKind, source: e.point.source,
      limitations: 'Rendered surface anchor; physical datum/source evidence stays local. No terrain-clearance authority inferred.' };
  };
  const vector = (v: ReferenceVector | null | undefined): unknown => !v ? null : v.kind === 'direction'
    ? { kind: v.kind, source: endpoint(v.source), target: endpoint(v.target) }
    : v.kind === 'velocity' ? { kind: v.kind, object: endpoint(v.object), relativeTo: endpoint(v.relativeTo) }
      : { kind: v.kind, frame: text(v.frame), origin: endpoint(v.origin), axis: v.axis };
  const measurement = (m: MeasurementDefinition) => ({ id: m.id, kind: m.kind, visible: m.visible !== false,
    source: endpoint(m.source), target: endpoint(m.target), vertex: endpoint(m.vertex),
    frame: text(m.frame), first: vector(m.first), second: vector(m.second), showDistance: m.showDistance, fullLength: m.fullLength });
  const availability = (a: ScriptObjectState['positionAvailability']) => ({ available: a.available,
    reason: ['pending','before-coverage','after-coverage','gap','disconnected','stale','unbound','error','dependency'].includes(a.reason ?? '') ? a.reason : null,
    sourceId: text(a.sourceId), classification: text(a.classification) });
  const objectState = (s: ScriptObjectState | null | undefined) => !s ? null : ({ et: s.et, frame: text(s.frame), center: s.center, positionUnit: 'km',
    position: s.position?.slice(0,3) ?? null, attitude: s.attitude?.slice(0,4) ?? null,
    positionAvailability: availability(s.positionAvailability), attitudeAvailability: s.attitudeAvailability ? availability(s.attitudeAvailability) : null });
  const coordinates = (c: ScriptSpatialContext['coordinates']) => !c ? null : ({ frame: text(c.frame), latitude: c.latitude,
    longitudeDirection: c.longitudeDirection, longitudeDomain: c.longitudeDomain,
    referenceShape: c.referenceShape.kind === 'sphere' ? { kind: 'sphere', radiusKm: c.referenceShape.radiusKm } : { kind: 'ellipsoid', radiiKm: c.referenceShape.radiiKm.slice(0,3) },
    ...(c.height ? { height: { unit: c.height.unit, datum: c.height.datum, convention: c.height.convention } } : {}) });
  const annotation = (a: ScriptProbePoint['annotation']) => !a ? null : ({ layer: a.layer, coordinates: coordinates(a.coordinates), position: a.position.slice(0,2) });
  const spatialContext = (c: ScriptSpatialContext) => ({ status: c.status, scene: c.scene, et: c.et, object: c.object, parent: c.parent,
    coordinates: coordinates(c.coordinates), parentCoordinates: coordinates(c.parentCoordinates), state: objectState(c.state),
    selectedFeature: c.selectedFeature, drawing: c.drawing.slice(0,16).map(d => ({ layers: d.layers.slice(0,16), features: d.features, terrainCoverage: 'not-assessed' })),
    editableLayers: c.editableLayers.slice(0,16).map(l => ({ id: l.id, body: l.body, frame: text(l.frame) })) });
  const surfacePoint = (p: ScriptProbePoint['point']) => ({ bodyName: p.bodyName, frame: text(p.frame), positionKm: p.bodyFixedPositionKm.slice(0,3),
    latDeg: p.latDeg, lonDeg: p.lonDeg, latitudeKind: ['geodetic','planetocentric'].includes(p.latitudeKind) ? p.latitudeKind : 'unknown', source: ['terrain','surface-overlay','ellipsoid','mesh','dsk'].includes(p.source) ? p.source : 'unknown',
    datum: p.hit.datum ? { referenceShape: p.hit.datum.referenceShape.kind === 'sphere' ? { kind: 'sphere', radiusKm: p.hit.datum.referenceShape.radiusKm } : { kind: 'ellipsoid', radiiKm: p.hit.datum.referenceShape.radiiKm.slice(0,3) }, verticalDatum: text(p.hit.datum.verticalDatum), heightConvention: text(p.hit.datum.heightConvention), origin: ['terrain','body-shape'].includes(p.hit.datum.origin) ? p.hit.datum.origin : null } : null,
    heightKm: p.hit.heightKm, physicalTerrain: p.terrainSample ? { elevationKm: p.terrainSample.elevationKm, describesHit: p.terrainSample.describesHit, sourceId: text(p.terrainSample.sourceId) } : null,
    limitations: 'A rendered/reference surface anchor is not automatically physical terrain. Display precision is not accuracy. Resource locations and unapproved provenance remain local.' });
  const groundProjection = (p: ScriptGroundProjection) => ({ scene: p.scene, et: p.et, object: p.object, body: p.body, frame: text(p.frame), policy: p.policy,
    status: p.status, reason: p.reason === null || ['scene-changed','scene-changing','invalid-surface-policy','no-scene','missing-entity','missing-parent','unsupported-reference-shape','invalid-body-fixed-position','no-surface-renderer','body-fixed-frame-unavailable','surface-unavailable','physical-terrain-unavailable-use-explicit-reference-alternative','position-or-frame-unavailable','position-pending','position-before-coverage','position-after-coverage','position-gap','position-disconnected','position-stale','position-unbound','position-error','position-dependency'].includes(p.reason) ? p.reason : 'unavailable', referenceOnly: p.referenceOnly, point: p.point ? surfacePoint(p.point) : null, annotation: annotation(p.annotation),
    limitations: 'Body-fixed radial projection from current entity state, not a camera pixel or a flight-site guess. Reference, rendered and physical terrain are distinct. Snapshot pin, not a tracker.' });
  const probePoint = (p: ScriptProbePoint | null) => !p ? null : ({ scene: p.scene, observedEt: p.observedEt, placedEt: p.placedEt, drawn: p.drawn, point: surfacePoint(p.point), annotation: annotation(p.annotation) });
  return { text, place, measurement, objectState, spatialContext, groundProjection, probePoint, imagery, surface, trajectoryExtremum, geographicLayer, geographicFeature };
}
