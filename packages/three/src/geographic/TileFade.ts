import type * as THREE from 'three';

/**
 * The LOD cross-fade 3d-tiles-renderer's TilesFadePlugin is applying to a tile
 * material, or null when it is not fading. While a tile fades, it and its
 * parent or children all draw, each discarding complementary pixels of a
 * Bayer pattern; an overlay drawn on copies of those tiles has to discard the
 * same pixels, or it is blended twice wherever both draw.
 *
 * The plugin (wrapFadeMaterial, 3d-tiles-renderer 0.4) keeps its uniforms on
 * the material under a module-private `Symbol('FADE_PARAMS')` and switches the
 * dither on with `defines.FEATURE_FADE`. Batched tiles (BatchedTilesPlugin)
 * keep fades in a texture instead; this renderer does not batch tiles.
 */
export function tileFade(material: THREE.Material | THREE.Material[] | undefined): { fadeIn: number; fadeOut: number } | null {
  const m = Array.isArray(material) ? material[0] : material;
  if (!m || (m as THREE.Material & { defines?: Record<string, unknown> }).defines?.FEATURE_FADE !== 1) return null;
  const key = Object.getOwnPropertySymbols(m).find((s) => s.description === 'FADE_PARAMS');
  const params = key ? (m as unknown as Record<symbol, { fadeIn?: { value: number }; fadeOut?: { value: number } }>)[key] : undefined;
  if (!params?.fadeIn || !params.fadeOut) return null;
  return { fadeIn: params.fadeIn.value, fadeOut: params.fadeOut.value };
}
