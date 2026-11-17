import { geodeticToBodyFixed, isSupportedGeodeticDatum, resolveSpatialRelationship, type Universe, type Place } from '@cosmolabe/core';
import type { ScriptPlaceDistance } from '@cosmolabe/control';

/** Places' mapped point anchors use the ordinary semantic measurement resolver. */
export function placeDistance(universe: Universe, object: string, place: Place, et: number): ScriptPlaceDistance {
  const { layer, feature } = place;
  const result: ScriptPlaceDistance = { status: 'unavailable', object, place: place.ref, placeName: place.name, body: layer.body, et,
    frame: layer.frame, datum: layer.datum, distanceKm: null, coverage: 'unavailable', accuracyKm: null,
    reason: null, sourceClassification: 'unknown',
    limitations: ['Straight-line distance to the mapped reference point, not distance to the crater rim or terrain clearance.',
      'Absent mapped height is evaluated at zero height on the declared reference shape, not on physical terrain.',
      'Source registration and position accuracy are not established; displayed digits are not an accuracy estimate.',
      'Current-epoch read only. A closest-time search to a geographic point is not supported by Event Finder; no time minimum is established.'] };
  const fail = (reason: string) => ({ ...result, reason });
  if (!Number.isFinite(et) || !universe.getBody(object) || !universe.getBody(layer.body)) return fail('missing-entity');
  if (feature.geometry.type !== 'Point') return fail('missing-point-anchor');
  if (!isSupportedGeodeticDatum(layer.datum)) return fail('unsupported-datum');
  if (!universe.frames.sameFrame(layer.frame, universe.frames.bodyFixedFrameFor(layer.body))) return fail('incompatible-body-fixed-frame');
  try {
    // The resolver alone is not a coverage certificate. Require the actual
    // relative state, in the source frame, before reading the shared geometry.
    const state = universe.stateIn(object, et, { frame: layer.frame, center: layer.body });
    result.sourceClassification = state.availability.position.classification ?? 'unknown';
    if (!state.availability.position.available || !state.position?.every(Number.isFinite)) return fail('position-unavailable');
    const p = geodeticToBodyFixed(feature.geometry.coordinates, layer.datum);
    const resolved = resolveSpatialRelationship(universe, { id: 'place-distance', kind: 'distance',
      source: { kind: 'entity', bodyName: object },
      target: { kind: 'body-fixed', bodyName: layer.body, positionKm: [p.xKm, p.yKm, p.zKm] } }, et);
    if (!resolved || !Number.isFinite(resolved.distanceKm)) return fail('spatial-resolution-unavailable');
    return { ...result, status: 'available', coverage: 'available-at-epoch', distanceKm: resolved.distanceKm };
  } catch { return fail('position-or-frame-unavailable'); }
}
