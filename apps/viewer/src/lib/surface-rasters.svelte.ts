import type { SurfacePoint, SurfaceRasterDefinition } from '@cosmolabe/core';
import type { PolarRasterManifest, SouthPolarRaster } from '@cosmolabe/three';
import { getRenderer } from './viewer-state.svelte';
import { getUniverse } from './loader';
import { parseGeographicInWorker } from './geographic-loading';
import { featureRef, selectFeature } from './geographic-layers.svelte';

export const science = $state({ revision: 0 });
const outlineOwner = 'scientific-raster-selection';
let outlineRequest = 0;

export function rasterDefinitions() {
  void science.revision;
  return getUniverse()?.surfaceRasters ?? [];
}

export function rasterProduct(id: string): SouthPolarRaster | undefined {
  void science.revision;
  return getRenderer()?.surfaceRasters.products.get(id);
}

export async function toggleRaster(definition: SurfaceRasterDefinition) {
  const renderer = getRenderer();
  if (!renderer) return;
  const universe = getUniverse();
  if (!universe) return;
  const layer = renderer.surfaceRasters;
  const existing = layer.products.get(definition.id);
  if (existing) {
    layer.hide(definition.id);
    if (existing.manifest?.features) {
      renderer.geographicVectors.setOutlineOnly(outlineOwner, false);
      universe.geographicLayers.removeCatalog(outlineOwner);
      universe.events.emit('geographic:changed', {});
    }
    science.revision++;
    if (existing.status !== 'error') return;
  }
  const pending = layer.show(definition);
  science.revision++;
  try { await pending; } finally { science.revision++; }
}

interface ScienceReading {
  product: SouthPolarRaster;
  value: number | null;
  feature: NonNullable<PolarRasterManifest['features']>[string] | undefined;
  error: string;
}

export async function rasterSamples(point: Pick<SurfacePoint, 'bodyName' | 'frame' | 'bodyFixedPositionKm'>): Promise<ScienceReading[]> {
  const renderer = getRenderer();
  const products = [...(renderer?.surfaceRasters.products.values() ?? [])]
    .filter(p => p.status === 'ready' && p.definition.body === point.bodyName);
  return Promise.all(products.map(async product => {
    try {
      const value = await product.sample(point);
      const feature = value === null ? undefined : product.manifest?.features?.[value];
      return { product, value, feature, error: '' };
    } catch {
      return { product, value: null, feature: undefined, error: 'Sample unavailable' };
    }
  }));
}

export async function outlineShadowRegion(id: string, gid: number): Promise<void> {
  const renderer = getRenderer();
  const p = renderer?.surfaceRasters.products.get(id);
  const universe = getUniverse();
  if (!renderer || !universe || !p?.manifest?.features?.[gid]) return;
  const request = ++outlineRequest;
  const text = await p.featureText(gid);
  const identity = new URL(`features/${gid}.geojson.gz`, p.url).href;
  const source = { kind: 'catalog' as const, identity };
  const layer = await parseGeographicInWorker([text, {
    id: outlineOwner,
    name: 'LOLA permanently shadowed region',
    body: p.definition.body,
    source: identity,
    coordinates: {
      frame: p.manifest.frame,
      latitude: 'planetocentric',
      longitudeDirection: 'east',
      longitudeDomain: '-180..180',
      referenceShape: { kind: 'sphere', radiusKm: p.manifest.radiusKm },
    },
    display: { visible: true, color: '#6ccbd8', opacity: 0.82, fillOpacity: 0 },
    provenance: {
      attribution: p.manifest.source.reference,
      sourceUrl: p.manifest.source.url,
      sourceProduct: p.manifest.source.product,
    },
  }, source], p.controller.signal);
  if (request !== outlineRequest || getRenderer() !== renderer || renderer.surfaceRasters.products.get(id) !== p) return;
  const feature = layer.features[0];
  if (!feature) throw new Error('The exact source polygon could not be rendered');
  renderer.geographicVectors.setOutlineOnly(outlineOwner, true);
  universe.geographicLayers.replaceCatalog(outlineOwner, [
    { id: layer.id, layer, source, diagnostics: layer.diagnostics, status: 'ready' },
  ]);
  universe.events.emit('geographic:changed', {});
  selectFeature(featureRef(layer, feature), { reveal: true });
}
