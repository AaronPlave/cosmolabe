import type { BodyFixedCartesian, TerrainDatum, TerrainSourceMetadata } from '../TerrainSampler.js';
import type { SurfaceVector } from './PhysicalSurface.js';

/** Static map registration, independent of geometry layout/depth. No general CRS engine implied. */
export interface MapImageLayer {
  kind: 'map';
  source: TerrainSourceMetadata;
  bodyId: string;
  targetFrame: string;
  registration: {
    /** Named, versioned planetary CRS including body, longitude direction and latitude convention. */
    crsId: string;
    coordinateUnits: 'degrees' | 'metres' | 'kilometres';
    longitudePositive: 'east' | 'west';
    longitudeDomain: '-180..180' | '0..360';
    latitudeConvention: 'planetocentric' | 'planetographic';
    datum: TerrainDatum;
    /** Pixel corner origin; [x0, dx/column, dx/row, y0, dy/column, dy/row]. */
    pixelToSource: readonly [number, number, number, number, number, number];
    width: number;
    height: number;
    noData?: number;
    /** Source-coordinate footprint; wrap/cutline interpretation belongs to the CRS adapter. */
    footprint: readonly (readonly [number, number])[];
    registrationErrorKm: number | null;
  };
  resampling: 'nearest' | 'bilinear';
  lod: { maxScreenTexelError: number; minLevel: number; maxLevel: number };
  budget: { decodedBytes: number; gpuBytes: number; concurrentRequests: number };
}

/** Transient camera observation. Pose is frozen at acquisition, not the playback camera/time. */
export interface ObservationImageProjection {
  kind: 'observation';
  source: TerrainSourceMetadata;
  bodyId: string;
  targetFrame: string;
  /** SPICE ET: TDB seconds past J2000 at reception by the instrument. */
  acquisitionEt: number;
  observerId: string;
  cameraFrame: string;
  calibration: {
    id: string;
    version: string;
    width: number;
    height: number;
    /** Pixels; image coordinates +x right, +y down, pixel centers at i+0.5,j+0.5. */
    focalPixels: readonly [number, number];
    principalPointPixels: readonly [number, number];
    /** Versioned calibration adapter resolves distortion; absence never means unknown is zero. */
    distortion: { kind: 'none' } | { kind: 'calibrated'; modelId: string; coefficients: readonly number[] };
  };
  geometry: {
    /** Proof supports NONE only. Corrected rays need a per-ray SPICE geometry resolver. */
    aberration: 'NONE' | 'LT' | 'LT+S' | 'CN' | 'CN+S';
    /** Camera origin in target frame at the declared target epoch; km. */
    cameraPosition: BodyFixedCartesian;
    /** Quaternion xyzw, camera (+x right,+y down,+z forward) → target frame. */
    cameraToTarget: readonly [number, number, number, number];
    targetEt: number;
    /** Kernel/frame/calibration provenance needed to reproduce geometry. */
    geometryVersion: string;
  };
  projection: {
    occlusion: 'nearest-surface-hit';
    /** Reject triangles pointing away from the instrument. */
    backFaces: 'reject';
    noHit: 'transparent';
    maxMeshErrorKm: number;
    maxIncidenceAngleRad: number;
  };
  /** Transient resources have a separate lifecycle from permanent source imagery. */
  budget: { gpuBytes: number; maxResidentImages: number };
}

/** A calibration/geometry adapter emits a geometric body-fixed ray per pixel. */
export interface ObservationRayResolver {
  rayForPixel(observation: ObservationImageProjection, column: number, row: number): {
    origin: BodyFixedCartesian; direction: SurfaceVector; targetEt: number;
  };
}
