/**
 * Canvas positions on the surface actually drawn: globe facets or resident
 * terrain tiles. Geographic vectors drape on those triangles, so an overlay
 * placed this way (a label, the selected-feature callout, an edit handle) sits
 * on the drawn feature, even where a coarse reference globe lies hundreds of
 * metres below the ideal ellipsoid. The renderer finds each height by a ray
 * down the geodetic normal; heights are cached briefly, since they change only
 * with the drawn level of detail, so following the scene every frame costs a
 * projection, not a raycast.
 */
import type { BodyFixedPosition, TerrainDatum } from '@cosmolabe/core';
import type { UniverseRenderer } from '@cosmolabe/three';

export interface DrawnScreenPosition { x: number; y: number; facing: boolean; inFront: boolean }

/** Heights are refreshed this often, and the cache is bounded. */
const HEIGHT_TTL_MS = 1000;
const HEIGHT_CACHE_LIMIT = 4000;

export function createDrawnSurfaceProjector(now: () => number = () => performance.now()) {
  const heights = new Map<string, number | null>();
  let clearedAt = now();
  const key = (body: string, p: BodyFixedPosition) => `${body}|${p.lonDeg}|${p.latDeg}`;

  /** Rendered-surface heights for these positions, raycasting only those not cached. */
  function heightsOf(renderer: UniverseRenderer, body: string, positions: readonly BodyFixedPosition[], datum: TerrainDatum): (number | null)[] {
    if (now() - clearedAt > HEIGHT_TTL_MS || heights.size > HEIGHT_CACHE_LIMIT) { heights.clear(); clearedAt = now(); }
    const missing = positions.filter((p) => !heights.has(key(body, p)));
    if (missing.length) {
      const found = renderer.renderedSurfaceHeightsKm(body, missing, datum);
      missing.forEach((p, i) => heights.set(key(body, p), found[i]));
    }
    return positions.map((p) => heights.get(key(body, p)) ?? null);
  }

  /**
   * Project 2D positions onto the drawn surface; where nothing drawn is hit,
   * onto resident terrain, else the datum. Null for a body that is not drawn.
   */
  function project(renderer: UniverseRenderer, body: string, positions: readonly BodyFixedPosition[], datum: TerrainDatum): DrawnScreenPosition[] | null {
    const h = heightsOf(renderer, body, positions, datum);
    const missing = h.some((x) => x === null);
    return renderer.projectGeographicPositions(body, positions.map((p, i) => h[i] === null ? p : { ...p, heightKm: h[i]! }), datum,
      { sampleTerrain: missing });
  }

  return { project, heightsOf, clear: () => heights.clear() };
}

/** The viewer's one projector, shared by labels, the callout and edit overlays. */
export const drawnSurface = createDrawnSurfaceProjector();
