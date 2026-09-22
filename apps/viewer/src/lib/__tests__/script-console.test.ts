import { describe, expect, it } from 'vitest';
import type { ViewerControl } from '@cosmolabe/control';
import { runWithTranscript, type TranscriptEntry } from '../script-console';

/** Just enough host for the verbs these tests use. */
function host(objects: string[], calls: string[] = []): ViewerControl {
  return {
    listObjects: () => objects,
    listViewpoints: () => [],
    gotoObject: (name: string) => { calls.push(`gotoObject ${name}`); return objects.includes(name); },
    deselect: () => { calls.push('deselect'); },
    wait: async () => { calls.push('wait'); },
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
