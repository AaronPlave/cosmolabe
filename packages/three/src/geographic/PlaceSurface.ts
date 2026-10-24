import { geodeticToBodyFixed, isSupportedGeodeticDatum, type Place } from '@cosmolabe/core';
import { Vector3 } from 'three';
import type { BodyMesh } from '../BodyMesh.js';

export interface PlaceAnchor {
  offsetKm: Vector3;
  source: 'source-height' | 'terrain-sample' | 'rendered-surface' | 'reference-shape';
}

/** Physical km in globe mesh axes; never visual terrain exaggeration. */
export function placeAnchor(place: Place, body: BodyMesh): PlaceAnchor | null {
  if (place.feature.geometry.type !== 'Point' || body.body.name !== place.layer.body) return null;
  const position = place.feature.geometry.coordinates;
  let p = geodeticToBodyFixed(position, place.layer.datum);
  let source: 'source-height' | 'terrain-sample' | 'reference-shape' = position.heightKm === undefined ? 'reference-shape' : 'source-height';
  if (position.heightKm === undefined) {
    const sample = body.sampleTerrainBodyFixed(p);
    const geo = body.terrainBodyFixedToGeodetic(p);
    if (sample && geo && isSupportedGeodeticDatum(sample.datum)) {
      p = geodeticToBodyFixed({ ...geo, heightKm: sample.elevationKm }, sample.datum);
      source = 'terrain-sample';
    }
  }
  return { offsetKm: new Vector3(p.xKm, p.zKm, -p.yKm), source };
}
