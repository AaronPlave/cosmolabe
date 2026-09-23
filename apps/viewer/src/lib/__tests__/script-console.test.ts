import { describe, expect, it } from 'vitest';
import type { ViewerControl } from '@cosmolabe/control';
import { runWithTranscript, startScriptRun, type TranscriptEntry } from '../script-console';

/** Just enough host for the verbs these tests use. */
function host(objects: string[], calls: string[] = []): ViewerControl {
  return {
    listObjects: () => objects,
    listViewpoints: () => [],
    gotoObject: (name: string) => { calls.push(`gotoObject ${name}`); return objects.includes(name); },
    deselect: () => { calls.push('deselect'); },
    wait: async () => { calls.push('wait'); },
    on: () => () => {},
  } as unknown as ViewerControl;
}

async function run(source: string, h: ViewerControl) {
  const snapshots: (readonly TranscriptEntry[])[] = [];
  const result = await runWithTranscript(source, h, (e) => snapshots.push(e));
  return { result, snapshots, final: snapshots.at(-1)! };
}

describe('runWithTranscript', () => {
  it('streams one entry per statement, each running before it is ok', async () => {
    const { result, snapshots, final } = await run('gotoObject Titan\n\n# settle\nwait 0\n', host(['Titan']));
    expect(result).toMatchObject({ ok: true, ran: 2 });
    expect(final.map((e) => [e.line, e.status])).toEqual([[1, 'ok'], [4, 'ok']]);
    // The second statement was announced while the first had already settled.
    expect(snapshots.some((s) => s.length === 2 && s[0].status === 'ok' && s[1].status === 'running')).toBe(true);
  });

  it('marks the failing line with its message and runs nothing after it', async () => {
    const calls: string[] = [];
    const { result, final } = await run('deselect\ngotoObject Titam\ndeselect', host(['Titan'], calls));
    expect(result).toMatchObject({ ok: false, ran: 1 });
    expect(final.map((e) => [e.line, e.status])).toEqual([[1, 'ok'], [2, 'error']]);
    expect(final[1].message).toBe('gotoObject: no object named "Titam" (did you mean "Titan"?)');
    expect(calls).toEqual(['deselect', 'gotoObject Titam']);
  });

  it('reports every syntax problem and runs nothing', async () => {
    const calls: string[] = [];
    const { result, final } = await run('gotoobject Titan\ndeselect\nsetFov wide', host(['Titan'], calls));
    expect(result).toMatchObject({ ok: false, ran: 0 });
    expect(final.map((e) => e.line)).toEqual([1, 3]);
    expect(final.every((e) => e.status === 'error')).toBe(true);
    expect(final[0].message).toContain('did you mean "gotoObject"?');
    expect(calls).toEqual([]);
  });

  it('reports a verb the host cannot perform at its line', async () => {
    const { final } = await run('deselect\nscreenshot', host([]));
    expect(final.at(-1)).toMatchObject({ line: 2, status: 'error', message: 'screenshot is not supported by this viewer' });
  });
});

/**
 * A host whose `wait` blocks until the test releases it, and whose `load`
 * event the test can fire — the two ways a run's scene goes away mid-`wait`.
 */
function pausingHost(objects: string[]) {
  const calls: string[] = [];
  const loadListeners = new Set<() => void>();
  let release: () => void = () => {};
  let waiting: () => void = () => {};
  const inWait = new Promise<void>((r) => { waiting = r; });
  const h = {
    ...host(objects, calls),
    wait: () => {
      calls.push('wait');
      waiting();
      return new Promise<void>((r) => { release = r; });
    },
    on: (event: string, cb: () => void) => {
      if (event !== 'load') return () => {};
      loadListeners.add(cb);
      return () => loadListeners.delete(cb);
    },
  } as unknown as ViewerControl;
  return {
    host: h, calls, inWait, loadListeners,
    release: () => release(),
    load: () => { for (const cb of [...loadListeners]) cb(); },
  };
}

describe('startScriptRun cancellation', () => {
  const SOURCE = 'deselect\nwait 5\ngotoObject Moon\ndeselect';

  it('ends the run while the wait is still pending when the console closes', async () => {
    const h = pausingHost(['Moon']);
    let final: readonly TranscriptEntry[] = [];
    const run = startScriptRun(SOURCE, h.host, (e) => { final = e; });
    await h.inWait;
    run.cancel('the console closed');
    // The wait is never released.
    const result = await run.done;

    expect(result).toMatchObject({ ok: false, cancelled: true, ran: 1 });
    expect(h.calls).toEqual(['deselect', 'wait']);
    expect(final.map((e) => [e.line, e.status])).toEqual([[1, 'ok'], [2, 'cancelled']]);
    expect(final[1].message).toContain('the console closed');
  });

  it('stops a script-started recording at once, without waiting out the wait', async () => {
    const h = pausingHost([]);
    let recording = false;
    const records: boolean[] = [];
    (h.host as unknown as { record: (on: boolean) => boolean }).record = (on) => {
      records.push(on);
      recording = on;
      return true;
    };
    const run = startScriptRun('record on\nwait 3600\nrecord off', h.host, () => {});
    await h.inWait;
    expect(recording).toBe(true);
    run.cancel('the console closed');
    await run.done;
    expect(recording).toBe(false);
    expect(records).toEqual([true, false]);
  });

  it('stops when a new catalog loads mid-wait, and lets go of the load event', async () => {
    const h = pausingHost(['Moon']);
    let final: readonly TranscriptEntry[] = [];
    const run = startScriptRun(SOURCE, h.host, (e) => { final = e; });
    await h.inWait;
    expect(h.loadListeners.size).toBe(1);
    h.load();
    const result = await run.done;

    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(h.calls).not.toContain('gotoObject Moon');
    expect(final.at(-1)).toMatchObject({ line: 2, status: 'cancelled' });
    expect(final.at(-1)?.message).toContain('a new scene loaded');
    expect(h.loadListeners.size).toBe(0);
    // The abandoned wait finishing later changes nothing.
    h.release();
    await Promise.resolve();
    expect(h.calls).not.toContain('gotoObject Moon');
  });

  it('lets go of the load event after a run that finishes normally', async () => {
    const h = pausingHost(['Moon']);
    const run = startScriptRun(SOURCE, h.host, () => {});
    await h.inWait;
    h.release();
    expect(await run.done).toMatchObject({ ok: true, ran: 4 });
    expect(h.loadListeners.size).toBe(0);
    // A load after the run is over cancels nothing and throws nothing.
    h.load();
  });
});
