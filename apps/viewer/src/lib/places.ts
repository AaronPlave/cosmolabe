import { geodeticToBodyFixed, type Place } from '@cosmolabe/core';
import { formatLatitude, formatLongitude } from '@cosmolabe/three';
import { getRenderer, goToCoordinates, vs } from './viewer-state.svelte';
import { openTool } from './shell.svelte';

export function selectPlace(place: Place | null): void {
  vs.selectedPlaceRef = place?.ref ?? null;
  const renderer = getRenderer();
  if (renderer) renderer.placeNames.selectedRef = vs.selectedPlaceRef ?? vs.surfaceTarget?.place?.ref ?? null;
  if (place) { vs.navigateMode = 'places'; openTool('navigate'); }
}

export function showPlaceBody(body: string, visible: boolean): void {
  vs.placeBodies = [...vs.placeBodies.filter(b => b !== body), ...(visible ? [body] : [])];
  getRenderer()?.placeNames.setBodyVisible(body, visible);
}

export function showPlaceDataset(layerId: string, visible: boolean): void {
  vs.hiddenPlaceLayers = [...vs.hiddenPlaceLayers.filter(id => id !== layerId), ...(!visible ? [layerId] : [])];
  const labels = getRenderer()?.placeNames;
  if (visible) labels?.hiddenLayers.delete(layerId); else labels?.hiddenLayers.add(layerId);
}

/** Places use exactly the coordinate panel's resolution, physical terrain
 * refinement, surface pivot and arc-flight path. Extent only guides framing. */
export function navigateToPlace(place: Place, action: 'fly' | 'jump'): boolean {
  if (place.feature.geometry.type !== 'Point') return false;
  const { latDeg, lonDeg } = place.feature.geometry.coordinates;
  const result = goToCoordinates({ bodyName: place.layer.body, latDeg, lonDeg,
    latitude: 'planetographic', longitudeDirection: 'east' }, {
    place: { ref: place.ref, name: place.name },
    preset: 'overhead', animate: action === 'fly', seconds: 1.5,
    rangeKm: Math.max(5, (place.diameterKm ?? 20) * 1.5),
  });
  if (!result.ok) return false;
  selectPlace(place);
  return true;
}

/** Match Navigate and shared surface-point copying: planetocentric latitude,
 * explicit hemispheres for order/direction-independent pasting. */
export function placeCoordinates(place: Place): string {
  if (place.feature.geometry.type !== 'Point') return '';
  const pos = place.feature.geometry.coordinates;
  const p = geodeticToBodyFixed(pos, place.layer.datum);
  const latCentric = Math.atan2(p.zKm, Math.hypot(p.xKm,p.yKm)) * 180 / Math.PI;
  return `${formatLatitude(latCentric,8)}, ${formatLongitude(pos.lonDeg,8)}`;
}
