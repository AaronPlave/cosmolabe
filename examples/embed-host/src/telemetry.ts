/**
 * The host side of external mission state: where samples come from, and the
 * adapter that hands them to Cosmolabe.
 *
 * `TelemetryArchive` is the seam a real ground-system client fills. A Yamcs
 * adapter would implement `fetch` with its parameter-archive API (and `live`
 * with its WebSocket subscription), converting generation times and
 * engineering values into these raw records — nothing below it changes. Here
 * it is backed by the closed-form fixtures, with configurable latency and an
 * option to ignore cancellation, so the viewer's handling of slow, late and
 * abandoned requests can be exercised deterministically.
 */
import {
  HostDataAdapter, type AttitudeBatch, type AttitudeConvention, type PositionBatch, type MissionStateSink, type MissionStateSource, type PositionConvention, type SampleTime,
} from '@cosmolabe/viewer';
import { COVERAGE, T0, T0_UTC, sc1Attitude, sc1State, sc2BodyToReference, sc2State } from './fixtures';

export type StreamId = 'sc1/position' | 'sc1/attitude' | 'sc2/position' | 'sc2/attitude';
/** A backend record: a time tag in the stream's own scale, and its values. */
export interface RawSample { t: SampleTime; values: number[] }

export interface TelemetryArchive {
  fetch(stream: StreamId, start: number, end: number, signal: AbortSignal): Promise<RawSample[]>;
}

const utcOf = (et: number) => new Date(Date.parse(T0_UTC) + (et - T0) * 1000).toISOString().replace(/\.(\d{3})Z$/, (_, ms) => (ms === '000' ? 'Z' : `.${ms}Z`));

/** Fixture-backed archive. Counters let the acceptance test see what the viewer asked for. */
export class FixtureArchive implements TelemetryArchive {
  latencyMs = 40;
  /** Misbehave like a backend that ignores cancellation: answer aborted requests anyway. */
  ignoreAbort = false;
  /** Shift applied to SC-2 positions (metres, ECLIPJ2000): a "corrected" ephemeris for replacement tests. */
  sc2OffsetM: [number, number, number] = [0, 0, 0];
  readonly log: { stream: StreamId; start: number; end: number; outcome: 'pending' | 'answered' | 'aborted' }[] = [];

  fetch(stream: StreamId, start: number, end: number, signal: AbortSignal): Promise<RawSample[]> {
    const entry = { stream, start, end, outcome: 'pending' as 'pending' | 'answered' | 'aborted' };
    this.log.push(entry);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.outcome = signal.aborted ? 'aborted' : 'answered';
        resolve(this.samples(stream, start, end));
      }, this.latencyMs);
      signal.addEventListener('abort', () => {
        if (this.ignoreAbort) return;
        clearTimeout(timer);
        entry.outcome = 'aborted';
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }

  samples(stream: StreamId, start: number, end: number): RawSample[] {
    const c = stream.startsWith('sc1') ? COVERAGE.sc1 : COVERAGE.sc2;
    const step = stream === 'sc1/position' || stream === 'sc1/attitude' ? COVERAGE.sc1.step
      : stream === 'sc2/position' ? COVERAGE.sc2.positionStep : COVERAGE.sc2.attitudeStep;
    const last = stream === 'sc2/attitude' ? COVERAGE.sc2.attitudeEnd : c.end;
    const gap = stream === 'sc1/position' ? COVERAGE.sc1.positionGap : stream === 'sc1/attitude' ? COVERAGE.sc1.attitudeGap : null;
    const out: RawSample[] = [];
    for (let s = Math.ceil((start - T0) / step) * step; T0 + s <= end; s += step) {
      if (s < c.start || s > last || (gap && s > gap[0] && s < gap[1])) continue;
      out.push(this.record(stream, T0 + s));
    }
    return out;
  }

  record(stream: StreamId, et: number): RawSample {
    switch (stream) {
      case 'sc1/position': { const s = sc1State(et); return { t: utcOf(et), values: [...s.position, ...s.velocity] }; }
      case 'sc1/attitude': return { t: utcOf(et), values: sc1Attitude(et) };
      case 'sc2/position': {
        const s = sc2State(et);
        return { t: et, values: [...s.position.map((x, k) => x * 1000 + this.sc2OffsetM[k]), ...s.velocity.map((v) => v * 1000)] };
      }
      case 'sc2/attitude': {
        const [w, x, y, z] = sc2BodyToReference(et);
        return { t: et, values: [x, y, z, w] }; // scalar-last
      }
    }
  }
}

export const SC1_POSITION: PositionConvention = {
  timeScale: 'UTC', frame: 'J2000', center: 'Earth', positionUnits: 'km', velocityUnits: 'km/s', maxSampleSpacing: COVERAGE.sc1.spacing,
};
export const SC1_ATTITUDE: AttitudeConvention = {
  timeScale: 'UTC', quaternionOrder: 'scalar-first', referenceFrame: 'J2000', bodyFrame: 'SC1_BUS', direction: 'reference-to-body', maxSampleSpacing: COVERAGE.sc1.spacing,
};
export const SC2_POSITION: PositionConvention = {
  timeScale: 'TDB', frame: 'ECLIPJ2000', center: 'Earth', positionUnits: 'm', velocityUnits: 'm/s', maxSampleSpacing: COVERAGE.sc2.positionSpacing,
};
export const SC2_ATTITUDE: AttitudeConvention = {
  timeScale: 'TDB', quaternionOrder: 'scalar-last', referenceFrame: 'ECLIPJ2000', bodyFrame: 'SC2_BUS', direction: 'body-to-reference', maxSampleSpacing: COVERAGE.sc2.attitudeSpacing,
};

/** The host's trust boundary (#179): every batch crosses it with provenance. */
const adapter = new HostDataAdapter('embed-host');

/** Window bounds in a stream's own time scale. */
const bound = (scale: 'TDB' | 'UTC', et: number): SampleTime => (scale === 'UTC' ? utcOf(et) : et);

/**
 * A `MissionStateSource` over an archive: Cosmolabe asks for ET windows; the
 * adapter fetches each stream and wraps the samples with their provenance.
 */
export function archiveSource(
  archive: TelemetryArchive,
  spacecraft: 'sc1' | 'sc2',
  opts: { version?: string; live?: LiveFeed; prefetch?: { behind?: number; ahead?: number } } = {},
): MissionStateSource {
  const position = spacecraft === 'sc1' ? SC1_POSITION : SC2_POSITION;
  const attitude = spacecraft === 'sc1' ? SC1_ATTITUDE : SC2_ATTITUDE;
  const c = spacecraft === 'sc1' ? COVERAGE.sc1 : COVERAGE.sc2;
  const attitudeEnd = spacecraft === 'sc1' ? c.end : COVERAGE.sc2.attitudeEnd;
  return {
    id: spacecraft,
    position,
    attitude,
    coverage: {
      position: { start: bound(position.timeScale, T0 + c.start), end: bound(position.timeScale, T0 + c.end) },
      attitude: { start: bound(attitude.timeScale, T0 + c.start), end: bound(attitude.timeScale, T0 + attitudeEnd) },
    },
    prefetch: opts.prefetch ?? { behind: 1800, ahead: 900 },
    maxSamples: 4000,
    staleAfterMs: 3000,
    async request(channel, window, signal) {
      const convention = channel === 'position' ? position : attitude;
      const raw = await archive.fetch(`${spacecraft}/${channel}`, window.start, window.end, signal);
      const range = { start: bound(convention.timeScale, window.start), end: bound(convention.timeScale, window.end) };
      const batch: PositionBatch | AttitudeBatch = channel === 'position'
        ? { window: range, samples: raw.map((r) => ({ t: r.t, position: r.values.slice(0, 3), velocity: r.values.slice(3, 6) })) }
        : { window: range, samples: raw.map((r) => ({ t: r.t, quaternion: r.values })) };
      return adapter.supply(
        batch,
        { id: `${spacecraft}-${channel}-archive`, kind: channel === 'position' ? 'trajectory' : 'attitude', source: 'fixture archive', version: opts.version ?? '1', classification: 'reconstructed' },
      );
    },
    subscribe: opts.live ? (sink) => opts.live!.attach(sink) : undefined,
  };
}

/**
 * A live SC-1 feed that continues past the archive. Pushed explicitly
 * (`advance`) rather than on a timer, so tests are deterministic; the demo
 * page drives it from a button.
 */
export class LiveFeed {
  private sink: MissionStateSink | null = null;
  /** Seconds after T0 of the last live sample. */
  edge = COVERAGE.sc1.end;

  attach(sink: MissionStateSink): () => void {
    this.sink = sink;
    return () => { if (this.sink === sink) this.sink = null; };
  }

  advance(seconds: number, archive: FixtureArchive): void {
    const sink = this.sink;
    if (!sink) return;
    const from = this.edge, to = this.edge + seconds;
    const step = COVERAGE.sc1.step;
    const times: number[] = [];
    for (let s = Math.ceil(from / step) * step; s <= to; s += step) times.push(T0 + s);
    const provenance = { id: 'sc1-live', kind: 'trajectory' as const, source: 'fixture live feed', version: '1', classification: 'reconstructed' as const };
    const window = { start: utcOf(T0 + from), end: utcOf(T0 + to) };
    sink.push('position', adapter.supply({ window, samples: times.map((et) => { const r = archive.record('sc1/position', et); return { t: r.t, position: r.values.slice(0, 3), velocity: r.values.slice(3) }; }) }, provenance));
    sink.push('attitude', adapter.supply({ window, samples: times.map((et) => ({ t: utcOf(et), quaternion: archive.record('sc1/attitude', et).values })) }, { ...provenance, kind: 'attitude' }));
    sink.extendCoverage('position', utcOf(T0 + to));
    sink.extendCoverage('attitude', utcOf(T0 + to));
    this.edge = to;
  }

  setConnected(on: boolean): void {
    this.sink?.setConnection(on ? 'live' : 'disconnected');
  }
}
