/** Serializable numerical-analysis contract shared by hosts and the engine. */
export type TrajectoryHeightMetric = 'radialHeightAboveReferenceSphere' | 'heightAboveReferenceEllipsoid' | 'heightAbovePhysicalTerrain';
export interface TrajectoryExtremaQuery {
  objects: readonly string[];
  body: string;
  frame: string;
  metric: TrajectoryHeightMetric;
  extremum: 'maximum' | 'minimum';
  /** Explicit datum. Never inferred from display geometry. */
  reference: {
    kind: 'sphere';
    radiusKm: number;
  } | {
    kind: 'ellipsoid';
    radiiKm: readonly [
      number,
      number,
      number
    ];
  };
  scope: {
    kind: 'activities';
    ids?: readonly string[];
    activityKind?: string;
    window?: {
      start: number;
      end: number;
    };
  } | {
    kind: 'windows';
    windows: readonly {
      start: number;
      end: number;
    }[];
  };
  stepSeconds: number;
  timeToleranceSeconds: number;
  maxEvaluations?: number;
  terrain?: {
    id: string;
    revision: string;
  };
}
export interface TrajectoryAnalysisSource {
  id: string | null;
  revision: string | null;
  classification: 'synthetic' | 'source-observed' | 'unknown';
}
export interface TrajectoryExtremum {
  id: string;
  object: string;
  activityId: string | null;
  activityName: string | null;
  body: string;
  frame: string;
  metric: TrajectoryHeightMetric;
  extremum: 'maximum' | 'minimum';
  value: number;
  units: 'km';
  et: number;
  utc: string;
  location: {
    positionKm: readonly [
      number,
      number,
      number
    ];
    latitudeDeg: number;
    longitudeDeg: number;
    convention: 'planetocentric';
  };
  datum: TrajectoryExtremaQuery['reference'];
  heightConvention: 'radial' | 'geodetic-normal';
  window: {
    start: number;
    end: number;
  };
  source: TrajectoryAnalysisSource;
  terrain: {
    id: string;
    revision: string;
    sourceUncertaintyKm: number | null;
  } | null;
  coverage: 'sampled-complete' | 'partial';
  method: {
    guarantee: 'sampled-and-locally-refined';
    stepSeconds: number;
    timeToleranceSeconds: number;
    evaluations: number;
    /** No derivative/terrain regularity bound: cannot certify a global height error. */
    heightErrorBoundKm: null;
    limits: string;
  };
}
export interface TrajectoryAnalysisFault {
  code: 'invalid-query' | 'unavailable' | 'budget' | 'cancelled' | 'stale';
  object?: string;
  activityId?: string;
  window?: {
    start: number;
    end: number;
  };
  message: string;
}
export interface TrajectoryExtremaResponse {
  status: 'complete' | 'partial' | 'unavailable' | 'cancelled' | 'stale';
  results: TrajectoryExtremum[];
  faults: TrajectoryAnalysisFault[];
}
export interface TrajectoryAnalysisOptions {
  /** Structural cancellation port works in the browser and deterministic hosts. */
  signal?: {
    readonly aborted: boolean;
    addEventListener?(type: 'abort', listener: () => void): void;
    removeEventListener?(type: 'abort', listener: () => void): void;
  };
  onProgress?: (fraction: number) => void;
}
