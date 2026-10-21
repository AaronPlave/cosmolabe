import { Vector3 } from 'three';
import { placeAnchor } from '@cosmolabe/three';
import type { Place } from '@cosmolabe/core';
import { getRenderer, vs } from './viewer-state.svelte';
import { openTool } from './shell.svelte';

export function selectPlace(place: Place | null): void {
  vs.selectedPlaceRef = place?.ref ?? null;
  const renderer = getRenderer();
  if (renderer) renderer.placeNames.selectedRef = vs.selectedPlaceRef;
  if (place) openTool('places');
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

/** Same controller and mesh-frame coordinate contract as region navigation.
 * The source diameter guides a view; it never becomes a drawn boundary. */
export function navigateToPlace(place: Place, action: 'fly' | 'jump'): boolean {
  const renderer = getRenderer();
  const body = renderer?.getBodyMesh(place.layer.body);
  if (!renderer || !body || !body.visible) return false;
  renderer.refreshBodyPose(body.body.name);
  const anchor = placeAnchor(place, body);
  if (!anchor || place.feature.geometry.type !== 'Point') return false;
  const position = place.feature.geometry.coordinates;
  const lat = position.latDeg * Math.PI / 180, lon = position.lonDeg * Math.PI / 180;
  const normal = new Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
  const north = new Vector3(-Math.sin(lat) * Math.cos(lon), Math.cos(lat), Math.sin(lat) * Math.sin(lon));
  const clearance = Math.max(5, Math.min(body.displayRadius, (place.diameterKm ?? 20) * 1.5));
  const targetOffset = anchor.offsetKm.multiplyScalar(renderer.scaleFactor);
  const offset = targetOffset.clone().addScaledVector(normal, clearance * renderer.scaleFactor);
  const cc = renderer.cameraController;
  cc.resetToFreeOrbit();
  const options = { offset, targetOffset, up: north, scaleFactor: renderer.scaleFactor, duration: 1.5 };
  if (action === 'fly') cc.flyTo(body, options); else cc.frame(body, options);
  vs.trackedBodyName = body.body.name;
  selectPlace(place);
  return true;
}

export function placeCoordinates(place: Place): string {
  if (place.feature.geometry.type !== 'Point') return '';
  const { latDeg, lonDeg } = place.feature.geometry.coordinates;
  return `${place.name} — ${place.layer.body}\n${latDeg.toFixed(5)}° N, ${lonDeg.toFixed(5)}° E (geodetic, ${place.layer.frame})\nReference: ${JSON.stringify(place.layer.datum.referenceShape)}\nSource point anchor; elevation/extent not implied\n${place.layer.definition.provenance?.attribution ?? place.layer.source.identity}`;
}
