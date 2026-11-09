/**
 * Operation contracts (#345): every registered operation declares what it
 * changes and how its result is observed, and "completed" is only ever said
 * with evidence. These fail when a new operation is registered without a
 * contract, when a write's domains are left unclassified, or when a host that
 * returns success without changing anything is reported as done.
 */
import { describe, expect, it } from 'vitest';
import { FakeViewer } from './__tests__/fake-host.js';
import { agentDefinitions } from './agent.js';
import { createCapabilityTools } from './capabilities.js';
import { capabilityCoverage } from './capability-coverage.js';
import { parsePredicate, STATE_DOMAINS } from './outcome.js';
import { registerVerb, VERBS, type VerbSpec } from './verbs.js';
import type { ViewerControl } from './contracts.js';

/** Input for a representative call of each write, chosen to differ from the fake's starting state. */
const CALLS: Record<string, Record<string, unknown>> = {
  select: { object: 'Titan' }, track: { object: 'Titan' }, frameObject: { object: 'Titan' }, jumpTo: { object: 'Titan' },
  setPlaying: { on: true }, setTime: { when: 1234 }, setTimeRate: { rate: 77 }, setFov: { degrees: 33 },
  setObjectVisible: { object: 'Titan', visible: false },
  upsertMeasurement: { json: JSON.stringify({ id: 'm1', kind: 'distance', source: { kind: 'entity', bodyName: 'Titan' }, target: { kind: 'entity', bodyName: 'Saturn' }, vertex: null, visible: true }) },
  composeView: { anchor: 'Saturn', target: 'Titan' },
  showTrajectory: { object: 'Titan', visible: false }, showLabel: { object: 'Titan', visible: false }, setLayer: { layer: 'grid', on: true },
  setFrame: { mode: 'body-fixed', object: 'Titan' }, setGridOpacity: { opacity: 0.4 }, displayNote: { text: 'hello' },
  setTimelineWindow: { start: 100, end: 900 },
};
/** Writes the fake's reads can observe: an honest host completes them. */
const OBSERVED_BY_FAKE = ['select', 'track', 'frameObject', 'jumpTo', 'setPlaying', 'setTime', 'setTimeRate', 'setObjectVisible', 'upsertMeasurement',
  'showTrajectory', 'showLabel', 'setLayer', 'setFrame', 'setGridOpacity', 'displayNote', 'setTimelineWindow'];

/** A host that says yes to every write and changes nothing: its writes land on a throwaway copy. */
function lyingHost(): FakeViewer {
  const real = new FakeViewer(), shadow = new FakeViewer();
  const writes = new Set<string>([...VERBS.values()].map(v => v.method).filter(m => m !== 'getViewComposition'));
  return new Proxy(real, { get: (target, key, receiver) => typeof key === 'string' && writes.has(key) && typeof (shadow as unknown as Record<string, unknown>)[key] === 'function'
    ? (...args: unknown[]) => (shadow as unknown as Record<string, (...a: unknown[]) => unknown>)[key](...args) : Reflect.get(target, key, receiver) });
}

async function run(host: ViewerControl, name: string, input: Record<string, unknown>) {
  const tools = createCapabilityTools(host, { allowAuthoring: true, confirmAuthoring: async () => true });
  try { return await tools.begin().call(name, input); } finally { tools.dispose(); }
}

describe('operation contracts', () => {
  it('every registered operation has a contract; every write classifies the state it changes and how it is observed', () => {
    for (const def of agentDefinitions()) {
      const c = def.contract;
      expect(c, def.name).toBeDefined();
      expect(c.namespace, def.name).toMatch(/^[a-z]+$/);
      for (const d of c.writes) expect(STATE_DOMAINS, `${def.name} writes ${d}`).toContain(d);
      const spec = VERBS.get(def.name);
      // A mutation is classified: only sequencing (waits) changes nothing it keeps.
      if (spec) expect(c.writes.length > 0 || spec.category === 'Sequencing', `${def.name} declares no written domain`).toBe(true);
      if (c.writes.length) expect(!!c.expect !== !!c.unobservable || (!!c.expect && !!c.unobservable), `${def.name} must say how its result is observed, or why it cannot be`).toBe(true);
      // An unobservable write derives no predicate: nothing could ever call it verified.
      if (c.unobservable && !c.observes?.length) expect(c.expect?.({}, new FakeViewer()) ?? [], def.name).toEqual([]);
    }
  });

  it('derived postconditions are well-formed predicates over registered reads', () => {
    const host = new FakeViewer();
    const reads = new Set(agentDefinitions().flatMap(d => [...(d.contract.writes.length === 0 && d.method ? [d.method] : []), ...(d.contract.observes ?? [])]));
    for (const [name, input] of Object.entries(CALLS)) {
      for (const p of VERBS.get(name)!.contract.expect!(input, host)) {
        expect(() => parsePredicate(p), name).not.toThrow();
        if (p.p === 'state') expect(reads.has(p.read as keyof ViewerControl), `${name} reads ${p.read}`).toBe(true);
      }
    }
  });

  it('an honest host completes what its reads can observe', async () => {
    for (const name of OBSERVED_BY_FAKE) {
      const host = new FakeViewer();
      const r = await run(host, name, CALLS[name]);
      expect(r, name).toMatchObject({ ok: true, outcome: { report: { status: 'met' } }, receipt: { status: 'completed', verification: 'observed' } });
    }
  });

  it('a host that returns success without changing state is never reported completed', async () => {
    for (const [name, input] of Object.entries(CALLS)) {
      const r = await run(lyingHost(), name, input);
      expect(r.ok && r.receipt?.status === 'completed', `${name}: ${JSON.stringify(r.ok ? r.outcome?.report : r.error)}`).toBe(false);
    }
  });

  it('an operation with no read is reported partial with its reason, never completed', async () => {
    const r = await run(new FakeViewer(), 'gotoCoordinates', { object: 'Titan', latitude: 10, longitude: 20 });
    expect(r).toMatchObject({ ok: true, outcome: { expected: [], unobservable: 'a surface coordinate view has no projection read' }, receipt: { status: 'partial', warnings: ['Not observable: a surface coordinate view has no projection read.'] } });
  });

  it('the inventory states its evidence; the writes with none are a known, reviewed set', () => {
    const blind = capabilityCoverage().filter(r => r.status === 'registered' && 'evidence' in r && String(r.evidence).startsWith('unobservable')).map(r => r.operation);
    expect(blind.sort()).toEqual(['activities.navigateActivity', 'bookmarks.restoreViewState', 'camera.circleCenterDown', 'camera.circleCenterLeft', 'camera.circleCenterRight', 'camera.circleCenterUp',
      'camera.crane', 'camera.dolly', 'camera.setCamera', 'capture.record', 'capture.screenshot', 'events.cancelEventQuery', 'events.openEventQuery',
      'geographic.gotoGeographicFeature', 'places.gotoCoordinates', 'time.runTo']);
  });

  it('registering an operation without a contract is refused', () => {
    expect(() => registerVerb({ name: 'noContract', params: [], category: 'Display', help: 'x', method: 'displayNote', invoke: () => undefined } as unknown as VerbSpec)).toThrow(/contract/);
    expect(VERBS.has('noContract')).toBe(false);
  });
});
