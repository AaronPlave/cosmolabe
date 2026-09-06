import { describe, expect, it } from 'vitest';
import { parse } from './parse.js';
import { execute } from './execute.js';
import { ScriptRuntimeError } from './errors.js';
import { FakeViewer } from './__tests__/fake-host.js';
import type { ViewerControl } from './contracts.js';

async function run(host: ViewerControl, source: string) {
  return execute(parse(source), host);
}

async function failure(host: ViewerControl, source: string): Promise<ScriptRuntimeError> {
  try {
    await run(host, source);
  } catch (err) {
    if (err instanceof ScriptRuntimeError) return err;
    throw err;
  }
  throw new Error(`expected ${JSON.stringify(source)} to fail at runtime, but it did not`);
}

describe('ordering', () => {
  // Every call is awaited, so an async host cannot let a later statement
  // overtake an earlier one — which for a scripted capture would mean
  // photographing the camera before it arrived.
  it('lands calls in source order even when the host is async', async () => {
    const host = new FakeViewer({ async: true });
    await run(host, ['gotoObject Titan', 'setFrame body-fixed Titan', 'screenshot done'].join('\n'));
    expect(host.calls).toEqual([
      'gotoObject("Titan", undefined)',
      'setFrame("body-fixed", "Titan")',
      'screenshot("done")',
    ]);
  });

  it('reports how many statements ran and collects captured frames', async () => {
    const host = new FakeViewer();
    const report = await run(host, ['screenshot a', 'runTo 60', 'screenshot b'].join('\n'));
    expect(report.ran).toBe(3);
    expect(report.images.map((i) => i.label)).toEqual(['a', 'b']);
  });
});

describe('a host that returns false', () => {
  it('becomes an error naming line, verb and a suggestion', async () => {
    const host = new FakeViewer();
    const err = await failure(host, ['setPlaying off', 'gotoObject Titam'].join('\n'));
    expect(err.message).toBe('line 2: gotoObject: no object named "Titam" (did you mean "Titan"?)');
    expect(err.problems[0].kind).toBe('unknown-target');
  });

  it('suggests from the viewpoint list for a viewpoint verb', async () => {
    const host = new FakeViewer();
    const err = await failure(host, 'viewpoint "Ring Plane view"');
    expect(err.message).toContain('no viewpoint named "Ring Plane view"');
    expect(err.message).toContain('did you mean "Ring Plane View"');
  });

  it('stops the run there, leaving later statements unapplied', async () => {
    const host = new FakeViewer();
    const err = await failure(
      host,
      ['setFov 30', 'gotoObject Nowhere', 'setFov 90'].join('\n'),
    );
    expect(err.ran).toBe(1);
    expect(host.camera.fov).toBe(30);
    expect(host.calls).toEqual(['setFov(30)', 'gotoObject("Nowhere", undefined)']);
  });
});

describe('capabilities', () => {
  // The fail-loudly pin. A host without `screenshot` must not skip the
  // statement: the script would "succeed" with no picture to show for it.
  it('raises at the statement whose method the host does not implement', async () => {
    // A host that declares no `screenshot` capability, built by shadowing the
    // fake's own so every other method still works.
    const host: ViewerControl = Object.create(new FakeViewer());
    (host as { screenshot?: unknown }).screenshot = undefined;
    const err = await failure(host, ['runTo 10', 'screenshot', 'runTo 10'].join('\n'));
    expect(err.problems[0].kind).toBe('unsupported');
    expect(err.message).toBe('line 2: screenshot is not supported by this viewer');
    expect(err.ran).toBe(1);
  });
});

describe('a host that throws', () => {
  it('becomes a located error carrying the host message', async () => {
    const host = new FakeViewer();
    host.setFov = () => {
      throw new Error('no camera');
    };
    const err = await failure(host, 'setFov 40');
    expect(err.message).toBe('line 1: setFov: no camera');
    expect(err.problems[0].kind).toBe('failed');
  });
});

describe('recording', () => {
  // A recording that outlives the script that started it keeps filming whatever
  // the user does next and saves it under the script's name.
  it('is stopped when a later statement fails', async () => {
    const host = new FakeViewer();
    await failure(host, ['record on', 'gotoObject Nowhere'].join('\n'));
    expect(host.recording).toBe(false);
    expect(host.calls).toEqual([
      'record(true)',
      'gotoObject("Nowhere", undefined)',
      'record(false)',
    ]);
  });

  it('is left alone when the script stopped it itself', async () => {
    const host = new FakeViewer();
    await failure(host, ['record on', 'record off', 'gotoObject Nowhere'].join('\n'));
    expect(host.calls.filter((c) => c.startsWith('record'))).toEqual([
      'record(true)',
      'record(false)',
    ]);
  });
});

describe('the transcript hook', () => {
  it('sees every statement before it runs', async () => {
    const host = new FakeViewer();
    const seen: number[] = [];
    await execute(parse(['setFov 30', '', '# skip', 'setFov 40'].join('\n')), host, {
      onStatement: (s) => seen.push(s.line),
    });
    expect(seen).toEqual([1, 4]);
  });
});
