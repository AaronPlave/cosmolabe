import type { BodyFixedPosition, TerrainDatum } from './coordinates.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type GeoPosition = [number, number] | [number, number, number];
export type GeographicGeometry<P> =
  | { type: 'Point'; coordinates: P }
  | { type: 'MultiPoint' | 'LineString'; coordinates: P[] }
  | { type: 'MultiLineString' | 'Polygon'; coordinates: P[][] }
  | { type: 'MultiPolygon'; coordinates: P[][][] };

/** Planetary extension to GeoJSON: angles are degrees; tuple order is longitude, latitude, Z. */
export interface GeographicCoordinates {
  latitude: 'planetocentric' | 'planetographic';
  longitudeDirection: 'east' | 'west';
  longitudeDomain: '-180..180' | '0..360';
  referenceShape: TerrainDatum['referenceShape'];
  /** Required for any Z. Absent Z remains a two-dimensional surface location. */
  height?: {
    unit: 'm' | 'km';
    datum: 'ellipsoid' | 'reference-sphere';
    convention: 'radial' | 'geodetic-normal';
  };
}

export interface GeographicLayerDefinition {
  id: string;
  name: string;
  body: string;
  source: string;
  /** Falls back only to the containing catalog's geographicCoordinates. */
  coordinates?: GeographicCoordinates;
  display?: { visible?: boolean; color?: string; opacity?: number };
  provenance?: { [key: string]: JsonValue };
}

export interface GeographicSource {
  kind: 'catalog' | 'local-file';
  /** Absolute URL for hosted sources; file path/name for local sources. */
  identity: string;
  catalog?: string;
  revision?: string;
}

export interface GeographicFeature {
  /** Unique within the layer: typed source ID, or source-order index when absent. */
  id: string;
  sourceId?: string | number;
  sourceIndex: number;
  properties: { [key: string]: JsonValue } | null;
  /** Full original feature, including foreign members and unmodified coordinates. */
  original: { [key: string]: JsonValue };
  /** Degrees north/east [-180,180), geodetic on datum; optional absolute height in km. */
  geometry: GeographicGeometry<BodyFixedPosition>;
}

export interface GeographicDiagnostic {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  featureIndex?: number;
}

export interface GeographicLayer {
  id: string;
  name: string;
  body: string;
  frame: string;
  /** No editing ownership is implied by importing a file. Authored edits need a separate overlay. */
  ownership: 'catalog' | 'transient';
  definition: GeographicLayerDefinition;
  source: GeographicSource;
  coordinates: GeographicCoordinates;
  datum: TerrainDatum;
  features: GeographicFeature[];
  skippedFeatures: number;
  diagnostics: GeographicDiagnostic[];
}

export interface GeographicLayerLoad {
  id: string;
  source: GeographicSource;
  status: 'ready' | 'error';
  layer?: GeographicLayer;
  diagnostics: GeographicDiagnostic[];
}

export interface GeographicLimits {
  maxBytes: number;
  maxFeatures: number;
  maxVertices: number;
  maxTopologyChecks: number;
  maxDepth: number;
}

/** Hard ceilings, also used before download/JSON decoding. Smaller caller budgets are allowed. */
export const GEOGRAPHIC_LIMITS: Readonly<GeographicLimits> = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxFeatures: 5000,
  maxVertices: 50000,
  maxTopologyChecks: 1_000_000,
  maxDepth: 32,
});
