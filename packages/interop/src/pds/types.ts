// The record every planetary-archive adapter maps onto (issue #28, Phase 2).
//
// One shape for every archive, in the archive's own terms: times are the
// strings it wrote, with the time system it declared, and nothing here has
// been near SPICE. Converting to ET, and to cosmolabe's `Observation`, is
// core's job (`observations/ArchiveAdapter.ts`), mirroring how a parsed OEM
// reaches `OemAdapter`.
//
// What varies by archive is which coverage it hands back — ODE gives a
// footprint polygon, OPUS gives disk geometry and a boresight box — and that
// is carried as-is. Mission-specific columns are not decoded: `campaign` is
// an opaque grouping key (OPUS `CASSINIobsname`, an ODE orbit number), and
// decoding it belongs to a per-mission plugin, not here.

import type { LonLat, WktPolygon } from './wkt.js';

/** Disk geometry for a target, as the archive computed it. */
export interface ArchiveDiskGeometry {
  /** Planetocentric latitude of the sub-observer point, degrees. */
  readonly subObsLatDeg: number;
  /** Sub-observer longitude, degrees **east** (adapters convert from west). */
  readonly subObsLonDeg: number;
  /** Observer to target-centre distance, km. */
  readonly distanceKm: number;
  /** Boresight right ascension / declination (J2000, degrees), when given. */
  readonly boresightRaDecDeg?: readonly [number, number];
}

export interface ArchiveIllumination {
  readonly phaseDeg?: number;
  readonly incidenceDeg?: number;
  readonly emissionDeg?: number;
}

/** One archived observation (an image, a frame, a product). */
export interface ArchiveObservation {
  /** Which archive answered, e.g. `"OPUS"`, `"ODE"`. */
  readonly archive: string;
  /** The archive's own identifier (OPUS ID, PDS product ID). */
  readonly id: string;
  readonly instrument?: string;
  readonly target?: string;
  /** Start time as the archive wrote it. */
  readonly startTime: string;
  /** Stop time as the archive wrote it, when it gives one. */
  readonly stopTime?: string;
  /** The time system `startTime`/`stopTime` are in. Both archives here are UTC. */
  readonly timeSystem: string;
  /** Opaque grouping key from the archive; never decoded here. */
  readonly campaign?: string;
  /** Footprint polygons (exterior ring first, then holes), lon east / lat, degrees. */
  readonly footprint?: readonly WktPolygon[];
  readonly disk?: ArchiveDiskGeometry;
  readonly illumination?: ArchiveIllumination;
  /** Ground resolution, km per pixel. */
  readonly resolutionKm?: number;
}

/** The `fetch` an adapter needs: injectable, so tests and Node scripts run without a network. */
export type FetchLike = (url: string) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

/** An archive that can be searched for observations. */
export interface ObservationArchive<Query> {
  readonly name: string;
  /** The request URL for a query, so a caller can log or cache it. */
  url(query: Query): string;
  /** Map an already-fetched response body onto archive observations. */
  parse(body: unknown, query: Query): ArchiveObservation[];
  /** `url` → fetch → `parse`. */
  search(query: Query, fetchFn?: FetchLike): Promise<ArchiveObservation[]>;
}

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export type { LonLat, WktPolygon };
