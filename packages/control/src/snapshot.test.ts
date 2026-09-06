import { describe, expect, it } from 'vitest';
import { parse } from './parse.js';
import { execute } from './execute.js';
import { snapshotScript, quote } from './snapshot.js';
import { FakeViewer } from './__tests__/fake-host.js';

/** A host driven to a known, non-default state. */
async function posed(): Promise<FakeViewer> {
  const host = new FakeViewer();
  host.viewpoints = ['SOI (2004-07-01)'];
  await execute(
    parse(
      [
        'setTime 2004-10-26T15:30:00.000Z',
        'setTimeRate 60',
        'gotoObject Titan',
        'setFrame body-fixed Titan',
        'setFov 35.5',
        'pointAtObject Enceladus',
        'setCamera [-1234.5, 0.25, 6.0e3] [10, 20, 30] [0, 0, 1]',
        'setLayer labels off',
        'setLayer grid on',
        'select Cassini',
        'displayNote "T-A flyby — Titan body-fixed"',
      ].join('\n'),
    ),
    host,
  );
  return host;
}

describe('snapshot', () => {
  // The test that keeps `snapshot` honest as verbs are added: if a verb starts
  // carrying state the snapshot does not emit, this stops matching.
  it('round-trips through parse and execute onto a fresh host', async () => {
    const original = await posed();
    const script = original.snapshot();

    const replayed = new FakeViewer();
    await execute(parse(script), replayed);

    expect(replayed.snapshotState()).toEqual(original.snapshotState());
  });

  it('round-trips a default, untracked, unselected view too', async () => {
    const original = new FakeViewer();
    const replayed = new FakeViewer();
    // Pose the replay differently first, so the snapshot has to actively clear
    // the tracking and selection rather than passively agree with them.
    await execute(
      parse(['gotoObject Saturn', 'select Saturn', 'pointAtObject Titan'].join('\n')),
      replayed,
    );
    await execute(parse(original.snapshot()), replayed);
    expect(replayed.snapshotState()).toEqual(original.snapshotState());
  });

  // The gap this closes: position and up alone do not say where the camera is
  // *pointing*, and `pointAtObject` state was not emitted at all. A snapshot
  // that lost both reproduced where the camera stood and not what it saw.
  it('carries the camera aim — both the orbit target and the look-at object', async () => {
    const original = await posed();
    const replayed = new FakeViewer();
    await execute(parse(original.snapshot()), replayed);

    expect(replayed.camera.target).toEqual(original.camera.target);
    expect(replayed.camera.up).toEqual(original.camera.up);
    expect(replayed.lookAt).toBe('Enceladus');
  });

  it('clears an aim the snapshotted view did not have', async () => {
    const original = new FakeViewer();
    const replayed = new FakeViewer();
    await execute(parse('pointAtObject Titan'), replayed);
    expect(replayed.lookAt).toBe('Titan');

    await execute(parse(original.snapshot()), replayed);
    expect(replayed.lookAt).toBeNull();
  });

  it('parses clean and emits one statement per line', async () => {
    const host = await posed();
    const program = parse(host.snapshot());
    expect(program.statements.map((s) => s.verb)).toEqual([
      'setPlaying',
      'setTime',
      'setTimeRate',
      'gotoObject',
      'setFrame',
      'pointAtObject',
      'setFov',
      'setCamera',
      'setLayer',
      'setLayer',
      'setLayer',
      'setLayer',
      'setLayer',
      'setLayer',
      'select',
      'displayNote',
    ]);
  });

  it('stops playback first and restores it last', () => {
    const script = snapshotScript({
      time: 0,
      timeText: '2000-01-01T12:00:00.000Z',
      rate: 1,
      playing: true,
      selected: null,
      tracked: null,
      lookAt: null,
      frame: { mode: 'free-orbit' },
      camera: { position: [0, 0, 1], target: [0, 0, 0], up: [0, 1, 0], fov: 60 },
      layers: {},
    });
    const lines = script.trim().split('\n');
    expect(lines[1]).toBe('setPlaying off');
    expect(lines[lines.length - 1]).toBe('setPlaying on');
  });
});

describe('quote', () => {
  it('leaves a plain name bare and wraps anything the parser would mis-read', () => {
    expect(quote('Titan')).toBe('Titan');
    expect(quote('SOI (2004-07-01)')).toBe('"SOI (2004-07-01)"');
    expect(quote('')).toBe('""');
    expect(quote('a "b" c')).toBe('"a \\"b\\" c"');
    expect(quote('C:\\tmp')).toBe('"C:\\\\tmp"');
    expect(quote('pass #3')).toBe('"pass #3"');
  });

  it('produces text the parser reads back unchanged', () => {
    for (const value of ['Titan', 'SOI (2004-07-01)', 'a "b" c', 'C:\\tmp', 'pass #3']) {
      expect(parse(`displayNote ${quote(value)}`).statements[0].args[0], value).toBe(value);
    }
  });
});
