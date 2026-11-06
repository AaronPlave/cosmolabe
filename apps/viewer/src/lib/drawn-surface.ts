/**
 * Canvas positions on the surface actually drawn: globe facets or resident
 * terrain tiles; with `occlusion`, hidden where that surface is in the way.
 * Geographic vectors drape on those triangles, so an overlay placed this way
 * (a label, the selected-feature callout, an edit handle) sits on the drawn
 * feature, even where a coarse reference globe lies hundreds of
 * metres below the ideal ellipsoid. The renderer finds each height by a ray
 * down the geodetic normal. Heights are cached by datum and position for as
 * long as the drawn surface stays the same (`drawnSurfaceKey`: which globe and
 * terrain tile meshes are visible) and at most a second: when terrain refines,
 * the next call samples the new triangles the vectors are drawn on. Following
 * the scene every frame otherwise costs a projection, not a raycast.
 */
import type { BodyFixedPosition, TerrainDatum } from '@cosmolabe/core';
import type { UniverseRenderer } from '@cosmolabe/three';

export interface DrawnScreenPosition { x: number; y: number; facing: boolean; inFront: boolean }

/** Heights are refreshed this often, and the cache is bounded. */
const HEIGHT_TTL_MS = 1000;
const HEIGHT_CACHE_LIMIT = 4000;

export function createDrawnSurfaceProjector(now: () => number = () => performance.now()) {
  const heights = new Map<string, number | null>();
  /** The drawn surface each body's cached heights were sampled on. */
  const surfaces = new Map<string, string | null>();
  const datums = new WeakMap<TerrainDatum, string>();
  let clearedAt = now();
  const datumKey = (d: TerrainDatum) => { let k = datums.get(d); if (!k) { k = JSON.stringify(d.referenceShape); datums.set(d, k); } return k; };
  const key = (body: string, d: TerrainDatum, p: BodyFixedPosition) => `${body}|${datumKey(d)}|${p.lonDeg}|${p.latDeg}`;

  /** Rendered-surface heights for these positions, raycasting only those not cached. */
  function heightsOf(renderer: UniverseRenderer, body: string, positions: readonly BodyFixedPosition[], datum: TerrainDatum): (number | null)[] {
    const surface = renderer.drawnSurfaceKey(body);
    const changed = surfaces.has(body) && surfaces.get(body) !== surface;
    surfaces.set(body, surface);
    if (changed || now() - clearedAt > HEIGHT_TTL_MS || heights.size > HEIGHT_CACHE_LIMIT) { heights.clear(); clearedAt = now(); }
    const missing = positions.filter((p) => !heights.has(key(body, datum, p)));
    if (missing.length) {
      const found = renderer.renderedSurfaceHeightsKm(body, missing, datum);
      missing.forEach((p, i) => heights.set(key(body, datum, p), found[i]));
    }
    return positions.map((p) => heights.get(key(body, datum, p)) ?? null);
  }

  /**
   * Project 2D positions onto the drawn surface. A position with no drawn
   * surface under it (its tiles culled outside the view, or not loaded) has
   * no visible ground: it is reported not facing rather than placed on the
   * datum, which can lie kilometres off the real ground (4.5 km above Gale's
   * floor) and would float an overlay into view. Null for a body not drawn.
   */
  function project(renderer: UniverseRenderer, body: string, positions: readonly BodyFixedPosition[], datum: TerrainDatum,
    options: { occlusion?: boolean } = {}): DrawnScreenPosition[] | null {
    const h = heightsOf(renderer, body, positions, datum);
    const projected = renderer.projectGeographicPositions(body, positions.map((p, i) => h[i] === null ? p : { ...p, heightKm: h[i]! }), datum,
      { occlusion: options.occlusion });
    return projected && projected.map((p, i) => h[i] === null ? { ...p, facing: false } : p);
  }

  return { project, heightsOf, clear: () => heights.clear() };
}

/** The viewer's one projector, shared by labels, the callout and edit overlays. */
export const drawnSurface = createDrawnSurfaceProjector();
