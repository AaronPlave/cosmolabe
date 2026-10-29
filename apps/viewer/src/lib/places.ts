import { geodeticToBodyFixed, type Place, type PlaceIndex } from '@cosmolabe/core';
import { formatLatitude, formatLongitude } from '@cosmolabe/three';
import { getRenderer, goToCoordinates, vs, releaseSurfaceTarget } from './viewer-state.svelte';
import { navigationView, navigationRange } from './navigation-view.svelte';
import { openTool } from './shell.svelte';

export function isPlaceAvailable(place: Place): boolean {
  return !vs.excludedPlaceLayers.includes(place.layer.id) && vs.places?.byRef.has(place.ref) === true;
}

/** Both search surfaces use the same inclusion policy; label visibility is independent. */
export function searchPlaces(query: string, options: Parameters<PlaceIndex['search']>[1] = {}): Place[] {
  return vs.places?.search(query, { ...options, excludedLayerIds: vs.excludedPlaceLayers }) ?? [];
}

/** Inclusion controls search; body/layer visibility controls only labels. */
export function placeSourceStatus(): string {
  const places = vs.places?.places ?? [];
  const included = places.filter(isPlaceAvailable);
  if (places.length && !included.length) return 'No name sources included';
  if (included.length && !included.some(place => vs.placeBodies.includes(place.layer.body) && !vs.hiddenPlaceLayers.includes(place.layer.id))) {
    return 'Geographic labels hidden; names remain searchable';
  }
  return '';
}

export function setPlaceSourceEnabled(layerIds: readonly string[], enabled: boolean): void {
  const ids = new Set(layerIds);
  vs.excludedPlaceLayers = enabled ? vs.excludedPlaceLayers.filter(id => !ids.has(id)) : [...new Set([...vs.excludedPlaceLayers, ...ids])];
  const labels = getRenderer()?.placeNames;
  for (const id of ids) {
    getRenderer()?.geographicVectors?.setSourceEnabled(id, enabled);
    if (!enabled || vs.hiddenPlaceLayers.includes(id)) labels?.hiddenLayers.add(id);
    else labels?.hiddenLayers.delete(id);
  }
  const target = vs.surfaceTarget?.place;
  if (target) { const place = vs.places?.byRef.get(target.ref); if (!place || !isPlaceAvailable(place)) releaseSurfaceTarget(); }
  const selected = vs.selectedPlaceRef && vs.places?.byRef.get(vs.selectedPlaceRef);
  if (selected && !isPlaceAvailable(selected)) selectPlace(null);
}

/**
 * The Gazetteer name (#191) a geographic feature is, when Places can show it.
 * A viewport click or double-click on one is Places' (Navigate shows it, Fly
 * goes through it); on any other feature, mission and user sites included,
 * it is Surface layers'. One click never selects in both.
 */
export function viewportPlace(ref: { layerId: string; featureId: string; bodyName: string }): Place | undefined {
  const place = vs.places?.places.find(p => p.layer.id === ref.layerId && p.feature.id === ref.featureId && p.layer.body === ref.bodyName);
  return place?.origin === 'nomenclature' && isPlaceAvailable(place) ? place : undefined;
}

export function selectPlace(place: Place | null): void {
  if (place && !isPlaceAvailable(place)) return;
  vs.selectedPlaceRef = place?.ref ?? null;
  const renderer = getRenderer();
  if (renderer) renderer.placeNames.selectedRef = vs.selectedPlaceRef ?? vs.surfaceTarget?.place?.ref ?? null;
  // The place is the one selection: Surface layers lets go of its own.
  if (place) { renderer?.geographicVectors?.setSelected(null); vs.navigateMode = 'places'; openTool('navigate'); }
}

export function showPlaceBody(body: string, visible: boolean): void {
  vs.placeBodies = [...vs.placeBodies.filter(b => b !== body), ...(visible ? [body] : [])];
  getRenderer()?.placeNames.setBodyVisible(body, visible);
}

export function showPlaceDataset(layerId: string, visible: boolean): void {
  vs.hiddenPlaceLayers = [...vs.hiddenPlaceLayers.filter(id => id !== layerId), ...(!visible ? [layerId] : [])];
  const labels = getRenderer()?.placeNames;
  if (visible && !vs.excludedPlaceLayers.includes(layerId)) labels?.hiddenLayers.delete(layerId); else labels?.hiddenLayers.add(layerId);
}

/** Places use exactly the coordinate panel's resolution, physical terrain
 * refinement, surface pivot and arc-flight path. Extent only guides framing. */
export function navigateToPlace(place: Place, action: 'fly' | 'jump', options: { source?: 'viewport-dblclick' } = {}): boolean {
  if (!isPlaceAvailable(place) || place.feature.geometry.type !== 'Point') return false;
  // A scene gesture has predictable framing; it must not inherit invalid or
  // unrelated form settings, nor overwrite the user's retained form choices.
  const viewport = options.source === 'viewport-dblclick';
  const range = viewport ? { ok: true as const, km: undefined } : navigationRange(place.diameterKm);
  if (!range.ok) return false;
  const { latDeg, lonDeg } = placeNavigationCoordinates(place);
  const result = goToCoordinates({ bodyName: place.layer.body, latDeg, lonDeg,
    latitude: 'planetocentric', longitudeDirection: 'east' }, {
    place: { ref: place.ref, name: place.name },
    preset: viewport ? 'overhead' : navigationView.preset, animate: action === 'fly', rangeKm: range.km,
  });
  if (!result.ok) return false;
  selectPlace(place);
  return true;
}

/** Match Navigate and shared surface-point copying: planetocentric latitude,
 * explicit hemispheres for order/direction-independent pasting. */
export function placeNavigationCoordinates(place: Place): { latDeg: number; lonDeg: number } {
  if (place.feature.geometry.type !== 'Point') throw new Error('A place must have a point anchor');
  const pos = place.feature.geometry.coordinates;
  const p = geodeticToBodyFixed(pos, place.layer.datum);
  return { latDeg: Math.atan2(p.zKm, Math.hypot(p.xKm, p.yKm)) * 180 / Math.PI, lonDeg: pos.lonDeg };
}

export function placeCoordinates(place: Place, decimals = 8): string {
  if (place.feature.geometry.type !== 'Point') return '';
  const pos = placeNavigationCoordinates(place);
  return `${formatLatitude(pos.latDeg, decimals)}, ${formatLongitude(pos.lonDeg, decimals)}`;
}

/** Human-facing category; original Gazetteer taxonomy remains in details. */
export function placeCategory(place: Place): string {
  if (place.origin !== 'nomenclature') return 'Mission / user site';
  const kind = place.kind.toLowerCase();
  if (/vallis|valles/.test(kind)) return 'Valley';
  if (/colles/.test(kind)) return 'Hills';
  if (/mons|montes/.test(kind)) return 'Mountain';
  if (/planitia/.test(kind)) return 'Plain';
  if (/planum/.test(kind)) return 'Plateau';
  return place.kind.split(',')[0];
}

const diameterFormat = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 });
/** Source-reported indicative extent, never a generated feature boundary. */
export function placeDiameter(place: Place): string {
  if (place.diameterKm === undefined) return 'Diameter unknown';
  return place.diameterKm < 1
    ? `≈ ${diameterFormat.format(place.diameterKm * 1000)} m across`
    : `≈ ${diameterFormat.format(place.diameterKm)} km across`;
}
