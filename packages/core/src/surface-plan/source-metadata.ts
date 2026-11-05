import type { SurfaceFeatureCollection, SurfaceSourceDescriptor } from './model.js';

/** Upstream provenance only. These fields never describe published output or a build selection. */
export interface SurfaceSourceMetadata {
  evidenceUrl: string;
  labelUrl?: string;
  confidence: 'archive' | 'label' | 'verified-mask' | 'unknown';
  unknowns: string[];
  /** Source raster grid interval; distinct from native acquisition resolution and requested output GSD. */
  rasterGsdM: number | null;
  dataType: string | null;
  bands: string[] | null;
  acquisitionUtc: string | null;
  observationId: string | null;
  sourceProjection: string | null;
  sourceCoordinates: string | null;
  sourceDatum: string | null;
  registration: { group: string; evidenceUrl: string; accuracyM: number | null } | null;
  illumination: { incidenceDeg: number | null; emissionDeg: number | null; phaseDeg: number | null; photometry: string | null } | null;
  stereoProductIds: string[];
  assets: { url: string; role: 'raster' | 'label' | 'quality'; bytes: number | null; sizeEvidence: string | null }[];
  reuse: { status: 'allowed' | 'restricted' | 'unknown'; evidenceUrl: string | null };
  /** Independently evidenced pixels, not a bounding rectangle or nodata enum. Holes are preserved. */
  validData?: {
    geometry: SurfaceFeatureCollection;
    evidenceUrl: string;
    method: string;
    /** A complete mask also establishes invalid pixels inside the source footprint. */
    extent: 'complete-mask' | 'known-valid-subset';
  };
  /** Optional upstream XYZ/WMTS provider metadata. Unknowns stay null; never implies native detail. */
  tiled?: {
    scheme: 'xyz' | 'wmts'; urlTemplate: string; grid: string; projection: string;
    coordinates: string; ellipsoid: string | null; tileWidth: number; tileHeight: number;
    origin: string; order: string; minZoom: number; maxZoom: number;
    nodata: string | null; nativeResolution: string | null; identity: string | null;
    cors: string | null; access: string | null; usage: string | null;
  };
}

/** A raster URL/version is retrieved once even if several channel descriptors reference it. */
export function surfaceSourceDownloadCost(sources: readonly SurfaceSourceDescriptor[]): { knownBytes: number; unknownSizeIds: string[] } {
  const assets = new Map<string, { bytes: number; unknown: string[] }>();
  for (const s of sources) {
    const key = JSON.stringify([s.asset.url ?? s.id, s.asset.version ?? null]);
    const entry = assets.get(key) ?? { bytes: 0, unknown: [] };
    entry.bytes = Math.max(entry.bytes, s.asset.bytes ?? 0);
    if (s.asset.bytes === undefined) entry.unknown.push(s.id);
    assets.set(key, entry);
  }
  return { knownBytes: [...assets.values()].reduce((n, a) => n + a.bytes, 0),
    unknownSizeIds: [...assets.values()].flatMap(a => a.unknown).sort() };
}
