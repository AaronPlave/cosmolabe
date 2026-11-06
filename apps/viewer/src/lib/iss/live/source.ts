/**
 * The live ISS adapter (#371): turns a telemetry transport plus a separately
 * sourced orbit into a `MissionStateSource` for the existing external mission
 * state path (#305), and a joint source for the articulation rig (#370).
 *
 * Authority rules, all enforced here:
 *  - attitude only from a coherent quaternion sample (every component at one
 *    source time, newer than the last, fresh against the local clock);
 *  - position only from a TLE within its validity window of the sample time,
 *    pushed at the same source time as the attitude, so one epoch is shared;
 *  - no extrapolation or hold: when samples stop, MissionState reports the
 *    channel stale or disconnected and the model/rig show it, never an old
 *    pose labelled live;
 *  - nothing is pushed to a historical scene: samples exist only near the
 *    present, so a simulation clock elsewhere reads `before/after-coverage`.
 */
import {
  HostDataAdapter, TLETrajectory, etFromDate,
  type AttitudeConvention, type MissionStateSink, type MissionStateSource, type PositionConvention,
} from '@cosmolabe/core';
import type { IssJointAngles } from '../joints.js';
import type { JointSource } from '../plugin.js';
import { CoherentAssembler, type AssemblerOptions, type ItemUpdate, type RejectReason } from './assembler.js';
import { telemetryToInertialToBody, type Quat, type TelemetryAttitudeConvention } from './frames.js';
import { DEFAULT_ORBIT_MAX_AGE_MS, orbitValidity, type OrbitValidity, type SourcedTle } from './orbit.js';
import type { ConnectionState, LiveTransport } from './transport.js';

export interface JointChannels {
  /** Item name per joint, keyed `truss:S4` / `array:S4_01` (the rig's ids). Joints left out stay unavailable. */
  items: Readonly<Record<string, string>>;
  unit: 'deg' | 'rad';
  /**
   * Telemetry-zero to model-zero offset per joint, radians. NOT confirmed
   * for the NASA model: it is part of the mapping a host must validate.
   */
  offsetsRad?: Readonly<Record<string, number>>;
  /** Components of one joint sample may differ by this much. Default 2000 ms. */
  toleranceMs?: number;
}

export interface LiveIssConfig {
  attitude: {
    /** Item names in component order given by `order`. */
    items: readonly [string, string, string, string];
    order: 'scalar-first' | 'scalar-last';
    convention: TelemetryAttitudeConvention;
    /** Inertial reference frame name for `convention.reference === 'inertial'`. Default 'J2000'. */
    inertialFrame?: string;
    /** Whether the frame/ordering/direction were confirmed against provider documentation. */
    verification: 'unverified' | 'verified';
    toleranceMs?: number;
  };
  joints?: JointChannels;
}

export interface LiveIssOptions {
  id?: string;
  config: LiveIssConfig;
  transport: LiveTransport;
  /** Local clock, ms. */
  now?: () => number;
  /** A connected feed with no new sample for this long is `stale`. Default 10 000 ms. */
  staleAfterMs?: number;
  /** TLE validity either side of its epoch. Default 3 days. */
  maxOrbitAgeMs?: number;
  /** Widest spacing MissionState interpolates across, seconds. Default 5. */
  maxSampleSpacingS?: number;
  /** A joint sample drives the rig only within this many seconds of the simulation time. Default 10. */
  jointValidForS?: number;
}

export type LiveIssState = 'live' | 'stale' | 'disconnected' | 'unavailable';

export interface LiveIssStatus {
  state: LiveIssState;
  reason?: string;
  /** Local clock minus the newest accepted sample's source time, ms. */
  sourceAgeMs?: number;
  lastSourceTimeMs?: number;
  connection: ConnectionState | 'idle';
  orbit: OrbitValidity;
  attitude: { reference: string; direction: string; verification: 'unverified' | 'verified' };
  joints: { state: 'live' | 'stale' | 'unavailable'; reason?: string; sourceAgeMs?: number };
  counters: {
    attitudeSamples: number;
    jointSamples: number;
    rejected: Record<RejectReason, number>;
    jointRejected: Record<RejectReason, number>;
    orbitUnavailable: number;
    pushErrors: number;
  };
  lastError?: string;
}

export interface LiveIssFeed {
  readonly source: MissionStateSource;
  readonly jointSource: JointSource;
  /** Supply (or clear) the element set; the host fetches it, e.g. with `fetchCelestrakIss`. */
  setOrbit(tle: SourcedTle | undefined): void;
  status(): LiveIssStatus;
  /** Notified after anything that can change `status()`; the host polls for the passage of time. */
  onStatus(listener: (status: LiveIssStatus) => void): () => void;
}

const adapter = new HostDataAdapter('iss-live');
const iso = (ms: number) => new Date(ms).toISOString();

export function createLiveIssFeed(options: LiveIssOptions): LiveIssFeed {
  const { config, transport } = options;
  const id = options.id ?? 'ISS-LIVE';
  const now = options.now ?? (() => Date.now());
  const staleAfterMs = options.staleAfterMs ?? 10_000;
  const maxOrbitAgeMs = options.maxOrbitAgeMs ?? DEFAULT_ORBIT_MAX_AGE_MS;
  const spacingS = options.maxSampleSpacingS ?? 5;
  const jointValidForS = options.jointValidForS ?? 10;
  const inertialFrame = config.attitude.inertialFrame ?? 'J2000';
  const lvlh = config.attitude.convention.reference === 'LVLH';

  const position: PositionConvention = {
    timeScale: 'UTC', frame: 'TEME', center: 'Earth', positionUnits: 'km', velocityUnits: 'km/s', maxSampleSpacing: spacingS,
  };
  const attitude: AttitudeConvention = {
    timeScale: 'UTC', quaternionOrder: 'scalar-first', referenceFrame: lvlh ? 'TEME' : inertialFrame,
    bodyFrame: 'ISS_BODY', direction: 'reference-to-body', maxSampleSpacing: spacingS,
  };

  const attAssembler = new CoherentAssembler(config.attitude.items, { toleranceMs: config.attitude.toleranceMs, maxAgeMs: staleAfterMs, now } satisfies AssemblerOptions);
  const jointItems = config.joints ? Object.entries(config.joints.items) : [];
  const jointAssembler = jointItems.length
    ? new CoherentAssembler(jointItems.map(([, item]) => item), { toleranceMs: config.joints?.toleranceMs ?? 2000, maxAgeMs: staleAfterMs, now })
    : undefined;

  let tle: SourcedTle | undefined;
  let trajectory: TLETrajectory | undefined;
  let connection: ConnectionState | 'idle' = 'idle';
  let sink: MissionStateSink | null = null;
  let lastAcceptedMs: number | undefined;
  let lastAttitude: { ms: number; q: Quat } | undefined;
  let lastPosition: { ms: number; p: [number, number, number]; v: [number, number, number] } | undefined;
  let latestJoints: { ms: number; angles: IssJointAngles } | undefined;
  let orbitUnavailable = 0, pushErrors = 0, jointSamples = 0;
  let lastError: string | undefined;
  const listeners = new Set<(s: LiveIssStatus) => void>();
  // Coverage starts where the feed does: nothing before it is live data, so a
  // historical simulation time reads `before-coverage`, never a held pose.
  const startedAt = iso(now());

  const notify = () => { if (listeners.size) { const s = status(); for (const l of listeners) l(s); } };

  function status(): LiveIssStatus {
    const t = now();
    const at = lastAcceptedMs ?? t;
    const orbit = orbitValidity(tle, at, maxOrbitAgeMs);
    const base = {
      connection, orbit, lastSourceTimeMs: lastAcceptedMs,
      sourceAgeMs: lastAcceptedMs === undefined ? undefined : t - lastAcceptedMs,
      attitude: { reference: config.attitude.convention.reference, direction: config.attitude.convention.direction, verification: config.attitude.verification },
      joints: jointStatus(t),
      counters: { attitudeSamples: attAssembler.emitted, jointSamples, rejected: { ...attAssembler.rejected }, jointRejected: { ...(jointAssembler?.rejected ?? attAssembler.rejected) }, orbitUnavailable, pushErrors },
      lastError,
    };
    const result = (state: LiveIssState, reason?: string): LiveIssStatus => ({ state, reason, ...base });
    if (!sink) return result('unavailable', 'not started');
    if (connection === 'disconnected') return result('disconnected', 'Feed disconnected');
    if (connection !== 'connected') return result('unavailable', 'Connecting to the feed');
    if (orbit.state !== 'current') return result('unavailable', orbit.state === 'missing' ? 'No current orbit element set' : 'Orbit element set is outside its validity window');
    if (lastAcceptedMs === undefined) return result('unavailable', 'Awaiting the first coherent attitude sample');
    if (t - lastAcceptedMs > staleAfterMs) return result('stale', `No new attitude sample for ${Math.round((t - lastAcceptedMs) / 1000)} s`);
    return result('live');
  }

  function jointStatus(t: number): LiveIssStatus['joints'] {
    if (!config.joints || !jointAssembler) return { state: 'unavailable', reason: 'Solar-array channels are not configured' };
    if (!latestJoints) return { state: 'unavailable', reason: 'No coherent joint sample yet' };
    const age = t - latestJoints.ms;
    return age > staleAfterMs ? { state: 'stale', sourceAgeMs: age } : { state: 'live', sourceAgeMs: age };
  }

  function handleAttitude(sourceMs: number, values: Readonly<Record<string, number>>): void {
    const v = config.attitude.items.map((item) => values[item]);
    const telemetry: Quat = config.attitude.order === 'scalar-first' ? [v[0], v[1], v[2], v[3]] : [v[3], v[0], v[1], v[2]];
    const validity = orbitValidity(tle, sourceMs, maxOrbitAgeMs);
    if (validity.state !== 'current' || !tle) { orbitUnavailable++; return; }
    trajectory ??= new TLETrajectory(tle);
    const et = etFromDate(new Date(sourceMs));
    const state = trajectory.stateAt(et);
    const r = Math.hypot(...state.position);
    // TLETrajectory reports a failed propagation as the zero vector.
    if (!(r > 6000 && r < 8000)) { orbitUnavailable++; return; }
    const q = telemetryToInertialToBody(telemetry, config.attitude.convention, { position: state.position, velocity: state.velocity });
    if (!q) { lastError = 'attitude composition failed (degenerate quaternion or orbit state)'; return; }
    if (!sink) return;

    const adjacent = (prevMs?: number) => prevMs !== undefined && sourceMs - prevMs <= spacingS * 1000;
    const attPrev = adjacent(lastAttitude?.ms) ? lastAttitude : undefined;
    const posPrev = adjacent(lastPosition?.ms) ? lastPosition : undefined;
    const tleVersion = iso(tle.epochMs);
    try {
      sink.push('position', adapter.supply({
        window: { start: iso((posPrev ?? { ms: sourceMs }).ms), end: iso(sourceMs) },
        samples: [
          ...(posPrev ? [{ t: iso(posPrev.ms), position: posPrev.p, velocity: posPrev.v }] : []),
          { t: iso(sourceMs), position: state.position, velocity: state.velocity },
        ],
      }, {
        id: 'iss-live-orbit', kind: 'trajectory', source: `${tle.source}, SGP4 (estimated, not observed)`, version: `TLE epoch ${tleVersion}`,
        citation: tle.sourceUrl, classification: 'reconstructed',
      }));
      sink.push('attitude', adapter.supply({
        window: { start: iso((attPrev ?? { ms: sourceMs }).ms), end: iso(sourceMs) },
        samples: [
          ...(attPrev ? [{ t: iso(attPrev.ms), quaternion: attPrev.q }] : []),
          { t: iso(sourceMs), quaternion: q },
        ],
      }, {
        id: 'iss-live-attitude', kind: 'attitude', source: 'NASA ISS Live telemetry (observed)', version: `frame ${config.attitude.convention.reference} ${config.attitude.verification}`,
        classification: 'reconstructed',
      }));
    } catch (error) {
      pushErrors++;
      lastError = error instanceof Error ? error.message : String(error);
      return;
    }
    sink.extendCoverage('position', iso(sourceMs));
    sink.extendCoverage('attitude', iso(sourceMs));
    lastAttitude = { ms: sourceMs, q };
    lastPosition = { ms: sourceMs, p: [...state.position], v: [...state.velocity] };
    lastAcceptedMs = sourceMs;
  }

  function handleJoints(sourceMs: number, values: Readonly<Record<string, number>>): void {
    const joints = config.joints!;
    const toRad = joints.unit === 'deg' ? Math.PI / 180 : 1;
    const angles: { truss: Record<string, number>; arrays: Record<string, number> } = { truss: {}, arrays: {} };
    for (const [key, item] of jointItems) {
      const [kind, name] = key.split(':');
      const angle = values[item] * toRad + (joints.offsetsRad?.[key] ?? 0);
      if (kind === 'truss') angles.truss[name] = angle; else if (kind === 'array') angles.arrays[name] = angle;
    }
    latestJoints = { ms: sourceMs, angles: angles as IssJointAngles };
    jointSamples++;
  }

  function onItem(update: ItemUpdate): void {
    if (config.attitude.items.includes(update.item)) {
      const r = attAssembler.accept(update);
      if (r.kind === 'sample') handleAttitude(r.sample.sourceTimeMs, r.sample.values);
    } else if (jointAssembler && jointItems.some(([, item]) => item === update.item)) {
      const r = jointAssembler.accept(update);
      if (r.kind === 'sample') handleJoints(r.sample.sourceTimeMs, r.sample.values);
    }
    notify();
  }

  const source: MissionStateSource = {
    id, position, attitude,
    coverage: { position: { start: startedAt, end: startedAt }, attitude: { start: startedAt, end: startedAt } },
    staleAfterMs,
    // A short rolling window: a live feed needs no history.
    maxSamples: 600,
    subscribe(s) {
      sink = s;
      connection = 'connecting';
      // MissionState treats a subscribed source as live at once; hold it
      // disconnected until the transport really is.
      s.setConnection('disconnected');
      const stop = transport.start({
        onItem,
        onConnection(state) {
          connection = state;
          if (state === 'connected') s.setConnection('live');
          else {
            s.setConnection('disconnected');
            // A reconnect must not combine pre- and post-gap components.
            attAssembler.reset(); jointAssembler?.reset();
          }
          notify();
        },
      });
      return () => { stop(); if (sink === s) { sink = null; connection = 'idle'; } notify(); };
    },
  };

  const jointSource: JointSource = {
    authority: 'observed',
    label: 'NASA ISS Live telemetry',
    anglesAt(et) {
      if (!latestJoints) return undefined;
      const t = now();
      if (t - latestJoints.ms > staleAfterMs) return undefined;
      // The simulation clock must be at the sample: no live angle on any other epoch.
      if (Math.abs(et - etFromDate(new Date(latestJoints.ms))) > jointValidForS) return undefined;
      if (connection !== 'connected') return undefined;
      return latestJoints.angles;
    },
  };

  return {
    source, jointSource,
    setOrbit(next) { tle = next; trajectory = undefined; notify(); },
    status,
    onStatus(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
