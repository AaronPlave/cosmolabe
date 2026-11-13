import { bodyFixedToGeodetic, geodeticToBodyFixed, type TerrainDatum } from './TerrainSampler.js';
import type { PhysicalSurface } from './surface/PhysicalSurface.js';
import type { ClipmapSource } from './SolarShadowClipmap.js';

/**
 * The solar-shadow clipmap's source port for any `PhysicalSurface` (#47/#148): a height-field surface answers
 * `sampleElevation`; a mesh (DSK, photogrammetry) is probed by a radial ray dropped from `shellKm` above the
 * datum. The clipmap needs a common query surface, not a heightfield *data* structure, so irregular meshes
 * reuse the same march. A miss or an unavailable answer is `null` (unknown), never lit or shadowed.
 *
 * `shellKm` must clear the tallest terrain. A mesh with overhangs yields its highest surface (a roof, not the
 * floor beneath): a radial height field cannot represent it.
 */
export function clipmapSourceFromSurface(
  surface: PhysicalSurface, datum: TerrainDatum, shellKm = 20, maxMeshErrorKm = 0.001,
): ClipmapSource {
  return {
    datum,
    revision: 0,
    elevationKm(latDeg, lonDeg) {
      if (surface.sampleElevation) return surface.sampleElevation(latDeg, lonDeg)?.elevationKm ?? null;
      const origin = geodeticToBodyFixed({ latDeg, lonDeg, heightKm: shellKm }, datum);
      const ground = geodeticToBodyFixed({ latDeg, lonDeg, heightKm: 0 }, datum);
      const down = [ground.xKm - origin.xKm, ground.yKm - origin.yKm, ground.zKm - origin.zKm] as const;
      const reach = 2 * shellKm; // the shell down to as far below the datum
      const hit = surface.intersectRay({ origin, direction: down, nearKm: 0, farKm: reach }, { maxMeshErrorKm });
      return hit.kind === 'hit' ? bodyFixedToGeodetic(hit.position, datum).heightKm ?? null : null;
    },
  };
}
