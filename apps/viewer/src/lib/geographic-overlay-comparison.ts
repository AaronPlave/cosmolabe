/** Development-only comparison bridge. Uses the existing imported layer and
 * upstream rasterizer; does not add a catalog backend or another importer. */
import {normalizeGeographicPosition, type GeoPosition, type GeographicLayer, type Universe} from '@cosmolabe/core';
import type { UniverseRenderer } from '@cosmolabe/three';
import { GeoJSONOverlay, ImageOverlayPlugin } from '3d-tiles-renderer/three/plugins';
import type { TilesRenderer } from '3d-tiles-renderer/three';
import type { Texture } from 'three';

export function overlayGeoJSON(layer: GeographicLayer, preserveSourceCuts = true) {
  const coordinates = (value: unknown): unknown => {
    if (Array.isArray(value) && typeof value[0] === 'number') {
      const raw = value as GeoPosition;
      const p = normalizeGeographicPosition(raw, layer.definition.coordinates!);
      if (p.heightKm !== undefined) throw new Error('Comparison supports draped 2D geometry only');
      // Preserve the two sides of a planar ±180 cut. Normalizing both to
      // -180 would turn a short source edge into a line across the map.
      const east = raw[0] * (layer.definition.coordinates!.longitudeDirection === 'east' ? 1 : -1);
      return [p.lonDeg === -180 && east > 0 ? 180 : p.lonDeg, p.latDeg];
    }
    if (Array.isArray(value)) return value.map(coordinates);
    const p = value as {lonDeg: number; latDeg: number; heightKm?: number};
    if (p.heightKm !== undefined) throw new Error('Comparison supports draped 2D geometry only');
    return [p.lonDeg,p.latDeg];
  };
  return {type: 'FeatureCollection', features: layer.features.map(f => ({
    type: 'Feature', id: f.id, properties: f.properties ?? {},
    geometry: {type: f.geometry.type, coordinates: coordinates(preserveSourceCuts ? (f.original.geometry as {coordinates: unknown}).coordinates : f.geometry.coordinates)},
  }))};
}

// This dev-only experiment deliberately isolates access to version-specific
// internals. A production backend needs a supported terrain-extension API.
interface ComparisonTerrain {
  tiles: TilesRenderer;
  overlayPlugin: ImageOverlayPlugin | null;
  imageryOnly: boolean;
}
interface RasterInternals {
  imageSource: {cache: Record<string, {result: Texture | Promise<Texture> | null}>; active: number; features: unknown[]; getStyle: (feature: {id?: string}) => {fill: string; stroke: string; strokeWidth: number; radius: number}};
  _redrawQueue: {running: boolean};
  redraw(): void;
  init(): Promise<void>;
}

export async function attachGeographicComparison(renderer: UniverseRenderer, universe: Universe) {
  const params = new URLSearchParams(location.search);
  const backend = params.get('geographic-comparison');
  const layer = universe.geographicLayers.layers[0];
  if (!layer) throw new Error('Comparison needs an already imported geographic layer');
  const body = renderer.getBodyMesh(layer.body);
  const terrain = (body as unknown as {terrainManager: ComparisonTerrain | null})?.terrainManager;
  if (!terrain) throw new Error('Comparison catalog must enable the normal streamed surface infrastructure');
  const resolution = Math.min(2048, Math.max(128, Number(params.get('overlayResolution') ?? 256)));
  const split = params.get('overlaySplit') !== '0';
  const preserveSourceCuts = params.get('overlayCoordinates') !== 'normalized';
  if (!terrain.overlayPlugin) {
    terrain.overlayPlugin = new ImageOverlayPlugin({renderer: renderer.renderer, overlays: [], enableTileSplitting: split, resolution});
    terrain.tiles.registerPlugin(terrain.overlayPlugin);
  }
  (terrain.overlayPlugin as ImageOverlayPlugin & {enableTileSplitting: boolean}).enableTileSplitting = split;
  let overlay: (GeoJSONOverlay & RasterInternals) | null = null;
  let rasterCpuMs = 0, rasters = 0;
  if (backend === 'none') renderer.geographicVectors.setVisible(layer.id, false);
  if (backend === 'raster') {
    renderer.geographicVectors.setVisible(layer.id, false);
    overlay = new GeoJSONOverlay({geojson: overlayGeoJSON(layer,preserveSourceCuts), resolution, strokeStyle: '#59c5dd', strokeWidth: 2, fillStyle: 'rgba(89,197,221,0.14)'}) as GeoJSONOverlay & RasterInternals;
    // Instrument actual upstream canvas generation, outside steady-state GPU draws.
    const source = overlay.imageSource as unknown as {fetchItem(...args: unknown[]): Promise<Texture>};
    const fetchItem = source.fetchItem.bind(source);
    source.fetchItem = (...args) => {const start = performance.now(); const result = fetchItem(...args); rasterCpuMs += performance.now() - start; rasters++; return result;};
    terrain.overlayPlugin.addOverlay(overlay);
    await overlay.init();
  }
  const api = {
    backend, layerId: layer.id, bodyName: layer.body, resolution, split,
    setVisible(visible: boolean) {
      if (overlay) overlay.opacity = visible ? 1 : 0;
      else renderer.geographicVectors.setVisible(layer.id, backend === 'vector' && visible);
    },
    highlight(name: string | null) {
      const feature = name ? layer.features.find(f => f.properties?.NAME === name) : undefined;
      const start = performance.now();
      if (overlay) {
        overlay.imageSource.getStyle = f => ({fill: f.id === feature?.id ? 'rgba(255,199,71,0.14)' : 'rgba(89,197,221,0.14)', stroke: f.id === feature?.id ? '#ffc747' : '#59c5dd', strokeWidth: f.id === feature?.id ? 3.5 : 2, radius: 3.5});
        overlay.redraw();
      } else renderer.geographicVectors.setSelected(feature ? {layerId: layer.id, featureId: feature.id, bodyName: layer.body} : null);
      return {featureId: feature?.id ?? null, cpuMs: performance.now() - start};
    },
    metrics() {
      const textures = overlay ? Object.values(overlay.imageSource.cache).map(e => e.result).filter((t): t is Texture => !!t && 'isTexture' in t) : [];
      return {backend, coordinateRepresentation: preserveSourceCuts ? 'source-cuts' : 'normalized-globe', imported: layer.features.length, rasterFeatures: overlay?.imageSource.features.length ?? 0, overlayResolution: resolution, split, rasters, rasterCpuMs,
        rasterTextures: textures.length, rasterTextureBytes: textures.reduce((n,t) => n + Number((t.image as {width?: number})?.width ?? 0)*Number((t.image as {height?: number})?.height ?? 0)*4,0),
        pendingRasters: overlay?.imageSource.active ?? 0, pendingRedraws: overlay?._redrawQueue.running ?? false, vector: renderer.geographicVectors.metrics, terrain: body?.terrainMetrics};
    },
  };
  (window as unknown as {geographicComparison: typeof api}).geographicComparison = api;
  renderer.use({name: 'geographic-overlay-comparison', dispose() {if (overlay) terrain.overlayPlugin?.deleteOverlay(overlay);}});
  return api;
}
