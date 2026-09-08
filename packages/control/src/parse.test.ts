import { describe, expect, it } from 'vitest';
import { parse } from './parse.js';
import { ScriptSyntaxError } from './errors.js';
import type { ScriptTime, ScriptVec3 } from './contracts.js';

/** The thrown error, or a failure if `source` parsed clean. */
function problems(source: string, forbid?: readonly string[]) {
  try {
    parse(source, forbid ? { forbid } : undefined);
  } catch (err) {
    if (err instanceof ScriptSyntaxError) return err;
    throw err;
  }
  throw new Error(`expected ${JSON.stringify(source)} to fail parsing, but it did not`);
}

describe('line numbers', () => {
  // The anti-regression for packages/interop/src/oem.ts, whose
  // filter-then-iterate destroyed the physical line index before the loop that
  // had to report against it. Here lines are walked by index and skipped in
  // place, so a blank line and a comment cost a number just like a statement.
  it('survive blank lines and comments', () => {
    const program = parse(['# a comment', '', 'setPlaying off', '   ', '  # indented', 'runTo 60'].join('\n'));
    expect(program.statements.map((s) => [s.line, s.verb])).toEqual([
      [3, 'setPlaying'],
      [6, 'runTo'],
    ]);
  });

  it('are 1-based in errors, past skipped lines', () => {
    const err = problems(['# header', '', 'gotoobject Titan'].join('\n'));
    expect(err.message).toBe('line 3: unknown verb "gotoobject" (did you mean "gotoObject"?)');
  });
});

describe('tokens', () => {
  it('reads a quoted name with spaces as one argument', () => {
    const program = parse('viewpoint "SOI (2004-07-01)"');
    expect(program.statements[0].args).toEqual(['SOI (2004-07-01)']);
  });

  it('honours \\" and \\\\ escapes', () => {
    const program = parse('displayNote "a \\"quoted\\" path C:\\\\tmp"');
    expect(program.statements[0].args[0]).toBe('a "quoted" path C:\\tmp');
  });

  it('treats # outside quotes as a comment and inside quotes as text', () => {
    const program = parse(['setFov 40 # the wide one', 'displayNote "pass #3"'].join('\n'));
    expect(program.statements[0].args).toEqual([40]);
    expect(program.statements[1].args).toEqual(['pass #3', undefined]);
  });

  it('reads a vector with or without inner spaces', () => {
    for (const src of ['setCamera [0, 0, 0.01]', 'setCamera [0,0,0.01]', 'setCamera [0 0 0.01]']) {
      const [statement] = parse(src).statements;
      expect(statement.args[0] as ScriptVec3, src).toEqual([0, 0, 0.01]);
    }
  });

  it('rejects a 2- or 4-element vector, naming the line', () => {
    expect(problems('setFov 40\nsetCamera [0, 1]').message).toBe(
      'line 2: a vector needs exactly 3 components, got 2 in "[0, 1]"',
    );
    expect(problems('setCamera [0, 1, 2, 3]').message).toBe(
      'line 1: a vector needs exactly 3 components, got 4 in "[0, 1, 2, 3]"',
    );
  });

  it('rejects an unterminated string or vector', () => {
    expect(problems('displayNote "open').problems[0].kind).toBe('syntax');
    expect(problems('setCamera [0, 1, 2').problems[0].kind).toBe('syntax');
  });

  it('accepts decimal numbers only', () => {
    expect(parse('setTimeRate -2.5').statements[0].args).toEqual([-2.5]);
    expect(parse('setTimeRate 1e3').statements[0].args).toEqual([1000]);
    // 0x10 and 1_000 are not numbers, so they arrive at a number parameter as
    // text and are rejected there — which names the parameter, not just "bad
    // number". 1e999 does look like a number, and is caught for not being one.
    expect(problems('setFov 0x10').message).toContain('expected a number, got "0x10"');
    expect(problems('setFov 1_000').message).toContain('expected a number, got "1_000"');
    expect(problems('setFov 1e999').message).toBe('line 1: "1e999" is not a finite number');
  });

  it('accepts on|off|true|false as booleans', () => {
    const program = parse(
      ['setPlaying on', 'setPlaying off', 'setPlaying true', 'setPlaying false'].join('\n'),
    );
    expect(program.statements.map((s) => s.args[0])).toEqual([true, false, true, false]);
    expect(problems('setPlaying yes').message).toContain('expected on|off|true|false');
  });
});

describe('times', () => {
  const when = (src: string) => parse(src).statements[0].args[0] as ScriptTime;

  it('reads a bare 4-digit integer as a calendar year', () => {
    expect(when('setTime 2004')).toEqual({ kind: 'calendar', text: '2004' });
  });

  it('reads any other numeric token as an ephemeris time', () => {
    expect(when('setTime 1.5e8')).toEqual({ kind: 'et', et: 1.5e8 });
    expect(when('setTime 0')).toEqual({ kind: 'et', et: 0 });
    expect(when('setTime -1000')).toEqual({ kind: 'et', et: -1000 });
  });

  it('hands anything else to the host as a calendar string', () => {
    expect(when('setTime 2004-10-26T15:30:00Z')).toEqual({
      kind: 'calendar',
      text: '2004-10-26T15:30:00Z',
    });
    expect(when('setTime "2004 OCT 26 15:30"')).toEqual({
      kind: 'calendar',
      text: '2004 OCT 26 15:30',
    });
  });
});

describe('verbs and arguments', () => {
  it('is case-sensitive, and says so usefully', () => {
    expect(problems('SetPlaying on').message).toBe(
      'line 1: unknown verb "SetPlaying" (did you mean "setPlaying"?)',
    );
  });

  it('checks arity against the table', () => {
    expect(problems('gotoObject').message).toContain(
      'gotoObject takes 1–2 arguments, got 0 — usage: gotoObject <object> [seconds]',
    );
    expect(problems('untrack Titan').message).toContain('untrack takes 0 arguments, got 1');
  });

  it('checks enum arguments and suggests', () => {
    expect(problems('setFrame bodyfixed').message).toBe(
      'line 1: setFrame: <mode> unknown mode "bodyfixed" (did you mean "body-fixed"?)',
    );
    expect(problems('setLayer trajectory off').message).toContain(
      'unknown layer "trajectory" (did you mean "trajectories"?)',
    );
  });

  it('collects every problem, not just the first', () => {
    const err = problems(['gotoobject Titan', 'setFov abc', 'setLayer nope on'].join('\n'));
    expect(err.problems.map((p) => p.line)).toEqual([1, 2, 3]);
    expect(err.problems.map((p) => p.kind)).toEqual(['unknown-verb', 'arguments', 'arguments']);
  });

  it('keeps the source line for echo', () => {
    const err = problems('  gotoobject Titan  ');
    expect(err.problems[0].text).toBe('  gotoobject Titan  ');
  });
});

describe('forbidden verbs', () => {
  // A golden that depends on wall-clock is a coin flip: at Saturn orbit
  // insertion Cassini covers 29.8 km/s, so a 6 s settle moves the scene ~180 km.
  it('rejects `wait` when the caller forbids it, naming the line', () => {
    const err = problems(['gotoObject Titan', 'wait 2', 'runTo 60'].join('\n'), ['wait']);
    expect(err.problems).toHaveLength(1);
    expect(err.problems[0].line).toBe(2);
    expect(err.problems[0].kind).toBe('forbidden');
    expect(err.message).toContain('wait is not allowed here');
  });

  it('leaves `wait` alone otherwise', () => {
    expect(parse('wait 2').statements[0].args).toEqual([2]);
  });
});

describe('optional arguments', () => {
  it('are undefined when omitted, and keep later positions aligned', () => {
    expect(parse('gotoObject Titan').statements[0].args).toEqual(['Titan', undefined]);
    expect(parse('gotoObject Titan 2').statements[0].args).toEqual(['Titan', 2]);
    expect(parse('screenshot').statements[0].args).toEqual([undefined]);
  });
});
