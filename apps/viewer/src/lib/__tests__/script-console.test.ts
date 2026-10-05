import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewerControl } from '@cosmolabe/control';
import { ScriptRunner, formatDuration, type RunnerState } from '../script-console';

/**
 * Just enough host for these tests. `wait` is deliberately absent from the
 * log: the runner must use its own timer, never the host's.
 */
function fakeHost(objects: string[] = ['Moon', 'Earth']) {
  const calls: string[] = [];
  const loadListeners = new Set<() => void>();
  let recording = false;
  const host = {
    listObjects: () => objects,
    listViewpoints: () => [],
    gotoObject: (name: string) => { calls.push(`gotoObject ${name}`); return objects.includes(name); },
    deselect: () => { calls.push('deselect'); },
    wait: () => { calls.push('HOST WAIT'); return new Promise<void>(() => {}); },
    record: (on: boolean) => { calls.push(`record ${on}`); recording = on; return true; },
    on: (event: string, cb: () => void) => {
      if (event !== 'load') return () => {};
      loadListeners.add(cb);
      return () => loadListeners.delete(cb);
    },
  } as unknown as ViewerControl;
  return {
    host, calls, loadListeners,
    get recording() { return recording; },
    load: () => { for (const cb of [...loadListeners]) cb(); },
  };
}

function runner() {
  const states: RunnerState[] = [];
  const r = new ScriptRunner((s) => states.push(s));
  return { r, states };
}

/** Let promise chains settle without moving the clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('ScriptRunner', () => {
  it('runs to completion, counting statements rather than lines', async () => {
    const h = fakeHost();
    const { r } = runner();
    const done = r.run('deselect\n\n# comment\ngotoObject Moon\n', h.host);
    const final = await done;
    expect(final).toMatchObject({ phase: 'done', total: 2, completed: 2, activeLine: null, lines: { 1: 'done', 4: 'done' } });
    expect(r.current.phase).toBe('done');
    expect(h.calls).toEqual(['deselect', 'gotoObject Moon']);
  });

  it('reports every syntax problem, marks their lines, and runs nothing', async () => {
    const h = fakeHost();
    const { r } = runner();
    const final = await r.run('gotoobject Moon\ndeselect\nsetFov wide', h.host);
    expect(final.phase).toBe('failed');
    expect(final.lines).toEqual({ 1: 'error', 3: 'error' });
    expect(final.problems.map((p) => p.line)).toEqual([1, 3]);
    expect(h.calls).toEqual([]);
  });

  it('marks a runtime failure on its line and stops there', async () => {
    const h = fakeHost();
    const { r } = runner();
    const final = await r.run('deselect\ngotoObject Mooon\ndeselect', h.host);
    expect(final).toMatchObject({ phase: 'failed', completed: 1, lines: { 1: 'done', 2: 'error' } });
    expect(final.problems[0].message).toContain('did you mean "Moon"?');
    expect(h.calls).toEqual(['deselect', 'gotoObject Mooon']);
  });

  it('uses its own timer for wait, and counts it down', async () => {
    const h = fakeHost();
    const { r, states } = runner();
    const done = r.run('wait 3\ndeselect', h.host);
    await vi.advanceTimersByTimeAsync(1200);
    expect(r.current).toMatchObject({ phase: 'running', activeLine: 1 });
    expect(r.current.wait?.remaining).toBeCloseTo(1.8, 5);
    await vi.advanceTimersByTimeAsync(1800);
    expect((await done).phase).toBe('done');
    expect(h.calls).toEqual(['deselect']);
    expect(states.some((s) => s.wait?.total === 3)).toBe(true);
  });

  describe('pause', () => {
    it('finishes the current statement, then holds before the next', async () => {
      const h = fakeHost();
      const { r } = runner();
      // gotoObject resolves synchronously here, so pause lands at the gate after it.
      const done = r.run('deselect\ngotoObject Moon\ndeselect', h.host);
      r.pause();
      await flush();
      expect(r.current.phase).toBe('paused');
      const heldAt = r.current.activeLine;
      const callsWhenPaused = [...h.calls];
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.calls).toEqual(callsWhenPaused);
      expect(r.current.activeLine).toBe(heldAt);
      r.resume();
      expect((await done).phase).toBe('done');
    });

    it('freezes a wait at once, and resumes it with the time it had left', async () => {
      const h = fakeHost();
      const { r } = runner();
      const done = r.run('wait 10\ndeselect', h.host);
      await vi.advanceTimersByTimeAsync(4000);
      r.pause();
      expect(r.current.phase).toBe('paused');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(r.current.wait?.remaining).toBeCloseTo(6, 5);
      expect(h.calls).toEqual([]);
      r.resume();
      await vi.advanceTimersByTimeAsync(5999);
      expect(h.calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect((await done).phase).toBe('done');
    });

    it('excludes paused time from elapsed', async () => {
      const h = fakeHost();
      const { r } = runner();
      const done = r.run('wait 2', h.host);
      await vi.advanceTimersByTimeAsync(1000);
      r.pause();
      await vi.advanceTimersByTimeAsync(30_000);
      r.resume();
      await vi.advanceTimersByTimeAsync(1000);
      expect((await done).elapsedMs).toBe(2000);
    });
  });

  describe('step', () => {
    it('runs exactly one statement, then pauses again', async () => {
      const h = fakeHost();
      const { r } = runner();
      const done = r.run('deselect\ngotoObject Moon\ngotoObject Earth\ndeselect', h.host);
      r.pause();
      await flush();
      const before = h.calls.length;
      r.step();
      await flush();
      expect(r.current.phase).toBe('paused');
      expect(h.calls.length).toBe(before + 1);
      r.step();
      await flush();
      expect(h.calls.length).toBe(before + 2);
      r.resume();
      expect((await done).phase).toBe('done');
    });

    it('through a held wait finishes the wait and pauses before the next statement', async () => {
      const h = fakeHost();
      const { r } = runner();
      const done = r.run('wait 5\ndeselect\ndeselect', h.host);
      await vi.advanceTimersByTimeAsync(1000);
      r.pause();
      r.step();
      await vi.advanceTimersByTimeAsync(4000);
      // Held before line 2: the rail is on what runs next, not the finished wait.
      expect(r.current).toMatchObject({ phase: 'paused', activeLine: 2, completed: 1, wait: null, lines: { 1: 'done', 2: 'active' } });
      expect(h.calls).toEqual([]);
      r.step();
      await flush();
      expect(h.calls).toEqual(['deselect']);
      r.stop();
      await done;
    });
  });

  describe('stop', () => {
    it('ends a run mid-wait without the wait finishing, and stops its recording at once', async () => {
      const h = fakeHost();
      const { r } = runner();
      const done = r.run('record on\nwait 3600\nrecord off', h.host);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.recording).toBe(true);
      r.stop('the console closed');
      const final = await done;
      expect(final).toMatchObject({ phase: 'cancelled', stopReason: 'the console closed', lines: { 1: 'done', 2: 'cancelled' } });
      expect(h.recording).toBe(false);
      expect(h.calls).toEqual(['record true', 'record false']);
    });

    it('ends a paused run', async () => {
      const h = fakeHost();
      const { r } = runner();
      const done = r.run('deselect\ndeselect\ndeselect', h.host);
      r.pause();
      await flush();
      r.stop();
      const final = await done;
      expect(final.phase).toBe('cancelled');
      expect(h.calls.length).toBeLessThan(3);
    });

    it('happens by itself when a new catalog loads, and releases the load event', async () => {
      const h = fakeHost();
      const { r } = runner();
      const done = r.run('wait 60\ngotoObject Moon', h.host);
      await flush();
      expect(h.loadListeners.size).toBe(1);
      h.load();
      const final = await done;
      expect(final).toMatchObject({ phase: 'cancelled', stopReason: 'a new scene loaded' });
      expect(h.calls).not.toContain('gotoObject Moon');
      expect(h.loadListeners.size).toBe(0);
    });
  });

  it('ignores run while busy, and runs again once finished', async () => {
    const h = fakeHost();
    const { r } = runner();
    const first = r.run('wait 1', h.host);
    await flush();
    await r.run('deselect', h.host);
    expect(h.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    await first;
    expect((await r.run('deselect', h.host)).phase).toBe('done');
  });
});

describe('formatDuration', () => {
  it('reads as seconds, then minutes', () => {
    expect(formatDuration(26_400)).toBe('26.4s');
    expect(formatDuration(65_000)).toBe('1m 05s');
  });
});
