/**
 * A predicted ephemeris as a mission-state source: SGP4 from one element set,
 * rotated TEME → J2000, sampled on request over a declared validity window.
 *
 * It is a source of its own, classified `planned`, so a catalog can put it
 * beneath observed telemetry as a `fallback` (see `MissionStateTrajectory`)
 * without either one standing in for the other. Outside its validity it has
 * no state, however well SGP4 would extrapolate.
 */
import type { MissionStateSource } from './mission-state.js';
import type { DataProvenance, HostDataAdapter } from './plugins/PluginData.js';
import { TLETrajectory } from './trajectories/TLETrajectory.js';
import { j2000ToTeme } from './frames/earthOrientation.js';
import { mat3Transpose, mat3Vec } from './frames/mat3.js';
import { etFromCalendarString } from './time.js';
import type { Vec3 } from './spice-injection.js';

export interface TlePredictionOptions {
  readonly id: string;
  readonly line1: string;
  readonly line2: string;
  /** The interval the prediction is issued for, ISO 8601 UTC. Required: no prediction is good forever. */
  readonly validFrom: string;
  readonly validTo: string;
  /** Sample spacing, seconds. Default 30. */
  readonly step?: number;
  /** The host vouches for the elements; its adapter issues the batches. */
  readonly adapter: HostDataAdapter;
  /** Where the elements came from, for every display of a predicted position. */
  readonly source?: string;
}

/** The source, plus direct evaluation, so a host can compare an observation with the prediction. */
export interface TlePredictionSource extends MissionStateSource {
  /** J2000 km, km/s at `et`; null outside the validity or where SGP4 fails. */
  stateAt(et: number): { position: Vec3; velocity: Vec3 } | null;
}

export function tlePredictionSource(o: TlePredictionOptions): TlePredictionSource {
  const tle = new TLETrajectory({ line1: o.line1, line2: o.line2 }, { windowDays: Infinity });
  const start = etFromCalendarString(o.validFrom), end = etFromCalendarString(o.validTo);
  if (!(end > start)) throw new Error(`prediction "${o.id}": validTo must follow validFrom`);
  const step = o.step ?? 30;
  if (!(step > 0)) throw new Error(`prediction "${o.id}": step must be positive`);
  const provenance: DataProvenance = {
    id: `${o.id}-tle`, kind: 'trajectory', classification: 'planned',
    source: o.source ?? `SGP4 from a two-line element set (epoch ET ${tle.epochEt.toFixed(0)})`,
    validity: { startEt: start, endEt: end },
  };
  return {
    id: o.id,
    stateAt: (et) => (et >= start && et <= end ? predictedState(tle, et) : null),
    position: { timeScale: 'TDB', frame: 'J2000', center: 'Earth', positionUnits: 'km', velocityUnits: 'km/s', maxSampleSpacing: step * 2 },
    coverage: { position: { start, end } },
    // Cheap to compute: keep an orbit or two either side for trails.
    prefetch: { behind: 4 * 3600, ahead: 2 * 3600 },
    async request(_channel, window) {
      const from = Math.max(window.start, start), to = Math.min(window.end, end);
      const samples = [];
      for (let k = Math.ceil(from / step); k * step <= to; k++) {
        const s = predictedState(tle, k * step);
        if (s) samples.push({ t: k * step, ...s });
      }
      return o.adapter.supply({ window: { start: window.start, end: window.end }, samples }, provenance);
    },
  };
}

/** J2000 state at `et`, or null where SGP4 fails (it reports failure as a zero vector). */
function predictedState(tle: TLETrajectory, et: number): { position: Vec3; velocity: Vec3 } | null {
  const teme = tle.stateAt(et);
  if (!teme.position.some((x) => x !== 0) || !teme.position.every(Number.isFinite)) return null;
  // TEME → J2000 is the transpose of J2000 → TEME; its rotation rate (precession) is negligible for velocity.
  const m = mat3Transpose(j2000ToTeme(et));
  return { position: mat3Vec(m, teme.position as Vec3), velocity: mat3Vec(m, teme.velocity as Vec3) };
}
