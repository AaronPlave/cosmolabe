import { describe, it, expect } from 'vitest';
import { MissionStateManager, etFromDate } from '@cosmolabe/core';
import { createLiveIssFeed, type LiveIssConfig } from './source.js';
import { ReplayTransport } from './transport.js';
import { parseTle } from './orbit.js';
import { syntheticSession } from './__fixtures__/replay.js';
import { L1, L2 } from './__fixtures__/tle.js';

const TLE = parseTle(`${L1}\n${L2}`, { source: 'test', sourceUrl: 'https://example.test', retrievedAtMs: 0 });
const CONFIG: LiveIssConfig = {
  attitude: { items: ['A', 'B', 'C', 'D'], order: 'scalar-first', convention: { reference: 'LVLH', direction: 'reference-to-body' }, verification: 'unverified' },
};

describe('replayed synthetic session', () => {
  it('yields the expected accepted samples and refusals, deterministically', () => {
    const base = TLE.epochMs + 3_600_000;
    const clock = { ms: base };
    const transport = new ReplayTransport();
    const feed = createLiveIssFeed({ config: CONFIG, transport, now: () => clock.ms, staleAfterMs: 10_000, acceptUnverified: true });
    feed.setOrbit(TLE);
    const manager = new MissionStateManager({ now: () => clock.ms });
    manager.addSource(feed.source);

    const session = syntheticSession(base);
    const states: string[] = [];
    for (const e of session.events) {
      clock.ms = e.at;
      if (e.kind === 'connection') transport.connection(e.state); else transport.item(e.update);
      states.push(feed.status().state);
    }
    const s = feed.status();
    expect(s.counters.attitudeSamples).toBe(session.expect.accepted);
    expect(s.counters.rejected.stale).toBe(session.expect.staleRejected);
    expect(s.counters.rejected['out-of-order']).toBe(session.expect.outOfOrderRejected);
    expect(s.state).toBe('live');
    // It was never `live` while the feed was down or before the first coherent frame.
    expect(states[0]).toBe('unavailable');
    expect(states).toContain('disconnected');
    expect(states.slice(states.indexOf('disconnected'), states.indexOf('disconnected') + 3).every((x) => x !== 'live')).toBe(true);

    // The accepted samples are on MissionState; the dropout between is not bridged.
    const at = (ms: number) => etFromDate(new Date(ms));
    expect(manager.availability('ISS-LIVE', 'attitude', at(base + 2900)).available).toBe(true);
    expect(manager.availability('ISS-LIVE', 'attitude', at(base + 25_000)).available).toBe(false);
    expect(manager.availability('ISS-LIVE', 'attitude', at(base + 30_900)).available).toBe(true);
  });

  it('two runs of the same session give the same status', () => {
    const run = () => {
      const base = TLE.epochMs + 3_600_000;
      const clock = { ms: base };
      const transport = new ReplayTransport();
      const feed = createLiveIssFeed({ config: CONFIG, transport, now: () => clock.ms, acceptUnverified: true });
      feed.setOrbit(TLE);
      new MissionStateManager({ now: () => clock.ms }).addSource(feed.source);
      for (const e of syntheticSession(base).events) { clock.ms = e.at; if (e.kind === 'connection') transport.connection(e.state); else transport.item(e.update); }
      return JSON.stringify(feed.status());
    };
    expect(run()).toBe(run());
  });
});
