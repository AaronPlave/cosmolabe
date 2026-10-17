import type { GeographicCoordinates, GeographicGeometry, GeographicLayerDefinition, GeoPosition, JsonValue } from '../geographic/model.js';
import type { TerrainDatum } from '../geographic/coordinates.js';

/** The same planetary GeoJSON tuples and geometry used by geographic layers (#196). */
export interface SurfaceFeatureCollection {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    id: string | number;
    properties: { [key: string]: JsonValue } | null;
    geometry: GeographicGeometry<GeoPosition>;
  }[];
}

export interface SurfacePlanLayer extends GeographicLayerDefinition {
  /** Omit to resolve `source` from a caller-supplied local text map. No fetch occurs. */
  geojson?: SurfaceFeatureCollection;
}
export type SurfaceChannel = 'imagery' | 'elevation';
export interface SurfaceFidelity {
  /** Requested physical ground sampling distance, in meters. Smaller is finer. */
  gsdM: number;
  /** Optional maximum physical source uncertainty, in meters; not mesh error. */
  accuracyM?: number;
}
export interface SurfacePlanRegion {
  id: string;
  /** Typed feature ID from #196, e.g. string:touchdown or number:7. */
  feature: { layerId: string; featureId: string };
  imagery?: SurfaceFidelity;
  elevation?: SurfaceFidelity;
  /** Larger values protect this region in budget comparisons. Default 0. */
  priority?: number;
  fallback?: 'require-target' | 'allow-coarser' | 'leave-unavailable';
}
export interface DesiredSurfacePlan {
  version: 1;
  kind: 'desired-surface-plan';
  body: string;
  frame: string;
  coordinates: GeographicCoordinates;
  layers: SurfacePlanLayer[];
  regions: SurfacePlanRegion[];
  /** Published output budget, bytes (not GB or source download bytes). */
  budget?: { publishedBytes: number };
}

/** Local metadata seam for discovery. A footprint is evidence, never inferred from a URL. */
export interface SurfaceSourceDescriptor {
  id: string;
  productId: string;
  channel: SurfaceChannel;
  body: string;
  frame: string;
  coordinates: GeographicCoordinates;
  footprint?: SurfaceFeatureCollection;
  nodata: 'none' | 'unknown' | { maskUrl: string };
  nativeGsdM: number | null;
  accuracyM: number | null;
  projection: string;
  datum: TerrainDatum;
  asset: {
    url?: string;
    retrieval?: string;
    version?: string;
    checksum?: { algorithm: 'sha256'; value: string };
    bytes?: number;
  };
  license: { name: string; attribution: string; url?: string };
}

/** Explicit, content-addressed build inputs. Estimation never produces this implicitly. */
export interface LockedSurfacePlan {
  version: 1;
  kind: 'locked-surface-plan';
  identity: string;
  desiredIdentity: string;
  /** Snapshot with all referenced GeoJSON embedded. */
  desired: DesiredSurfacePlan;
  sources: SurfaceSourceDescriptor[];
  selections: {
    regionId: string;
    channel: SurfaceChannel;
    sourceIds: string[];
    outputGsdM: number;
    resampling: 'nearest' | 'bilinear' | 'cubic';
    /** Documented transforms, including an explicit identity transform if none is needed. */
    transformations: string[];
  }[];
  processing: {
    generator: { name: string; version: string };
    fusion: string;
    parameters: { [key: string]: JsonValue };
  };
  output: {
    representation: 'tiled-raster-pyramid';
    formatVersion: string;
    tileSize: number;
    gutter: number;
    imageryEncoding: string;
    elevationEncoding: string;
  };
}

export interface SurfacePlanDiagnostic {
  severity: 'warning' | 'error';
  code: string;
  path: string;
  message: string;
}
export class SurfacePlanError extends Error {
  constructor(public readonly diagnostics: SurfacePlanDiagnostic[]) {
    super(diagnostics.map(d => `${d.path}: ${d.message}`).join('\n'));
    this.name = 'SurfacePlanError';
  }
}

export interface EstimateRange { min: number; max: number | null; }
export interface SurfaceEstimateAssumptions {
  tileSize: number;
  gutter: number;
  imageryBytesPerSample: number;
  elevationBytesPerSample: number;
  /** Compressed / uncompressed bytes. These are scenario bounds, not statistical confidence. */
  imageryCompression: [number, number];
  elevationCompression: [number, number];
  workDiskMultiplier: [number, number];
  visibleTiles: [number, number];
}
export interface SurfaceDetailBand {
  channel: SurfaceChannel;
  gsdM: number;
  accuracyM: number | null;
  areaM2: number;
  baseSamples: number | null;
  pyramidSamples: number | null;
  levels: number | null;
  objects: EstimateRange;
  publishedBytes: EstimateRange;
  sourceEvidence: {
    status: 'unknown' | 'satisfied' | 'partial' | 'unsatisfied';
    adequateAreaM2: number;
    unknownAreaM2: number;
    candidates: { id: string; nativeGsdM: number | null; accuracyM: number | null }[];
  };
}
export interface SurfacePlanEstimate {
  version: 1;
  estimatorVersion: string;
  desiredIdentity: string;
  stage: 'geometry-only' | 'source-aware';
  sourceMetadataIdentity: string | null;
  assumptions: SurfaceEstimateAssumptions;
  diagnostics: SurfacePlanDiagnostic[];
  bands: SurfaceDetailBand[];
  totals: {
    imagery: { areaM2: number; baseSamples: number | null; publishedBytes: EstimateRange; objects: EstimateRange };
    elevation: { areaM2: number; baseSamples: number | null; publishedBytes: EstimateRange; objects: EstimateRange };
    publishedBytes: EstimateRange;
    publishedObjects: EstimateRange;
    rawSourceDownloadBytes: EstimateRange;
    outputWorkDiskBytes: EstimateRange;
    peakWorkDiskBytes: EstimateRange;
  };
  sourceDownload: { candidateIds: string[]; unknownSizeIds: string[] };
  browser: {
    decodedTileBytes: { imagery: number; elevation: number };
    visibleDecodedBytes: EstimateRange;
    visibleNetworkBytes: EstimateRange;
    visibleRequests: EstimateRange;
  };
  budget: null | {
    publishedBytes: number;
    status: 'within' | 'over' | 'uncertain';
    comparisons: {
      regionIds: string[];
      gsdMultiplier: number;
      publishedBytes: EstimateRange;
      status: 'within' | 'over' | 'uncertain';
    }[];
  };
}
