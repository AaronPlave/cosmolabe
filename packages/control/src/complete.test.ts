import { describe, expect, it } from 'vitest';
import { completionsAt, cursorContext, signatureAt } from './complete.js';
import { parse } from './parse.js';

/** Context with the cursor at `|`. */
function at(marked: string) {
  const column = marked.indexOf('|');
  return cursorContext(marked.replace('|', ''), column);
}

describe('cursorContext', () => {
  it('is on the verb until the first space', () => {
    expect(at('goto|')).toMatchObject({ argIndex: -1, from: 0, prefix: 'goto', verb: undefined });
    expect(at('|')).toMatchObject({ argIndex: -1, from: 0, prefix: '' });
    expect(at('  goto|')).toMatchObject({ argIndex: -1, from: 2, prefix: 'goto' });
  });

  it('names the argument being typed and its parameter', () => {
    expect(at('setFrame |')).toMatchObject({ argIndex: 0, prefix: '', from: 9 });
    expect(at('setFrame |').param?.name).toBe('mode');
    expect(at('setFrame body-fixed Ti|')).toMatchObject({ argIndex: 1, prefix: 'Ti', from: 20 });
    expect(at('setFrame body-fixed Ti|').param?.name).toBe('object');
  });

  it('counts a quoted argument with spaces as one token, and replaces after its quote', () => {
    const ctx = at('viewpoint "Lunar Or|');
    expect(ctx).toMatchObject({ argIndex: 0, quoted: true, prefix: 'Lunar Or', from: 11 });
    expect(at('displayNote "a b c" |')).toMatchObject({ argIndex: 1 });
  });

  it('is inert in a comment or a vector', () => {
    expect(at('gotoObject Titan # go|').inert).toBe(true);
    expect(at('setCamera [0, 1|').inert).toBe(true);
    expect(at('setCamera [0, 1, 2] |').inert).toBe(false);
  });
});

describe('completionsAt', () => {
  const names = { objects: ['Earth', 'Moon', 'Mars Reconnaissance Orbiter'], viewpoints: ['Lunar Orbit'] };

  it('offers every verb, with its usage, at the start of a line', () => {
    const verbs = completionsAt(at('go|'));
    expect(verbs.find((c) => c.label === 'gotoObject')).toMatchObject({
      kind: 'verb', detail: 'gotoObject <object> [seconds]',
    });
  });

  it('offers the viewer\'s own names, quoting those that need it', () => {
    const objects = completionsAt(at('gotoObject |'), names);
    expect(objects.map((c) => c.insert)).toEqual(['Earth', 'Moon', '"Mars Reconnaissance Orbiter"']);
    // Inside an opened quote, the completion closes it instead.
    expect(completionsAt(at('viewpoint "Lu|'), names).map((c) => c.insert)).toEqual(['Lunar Orbit"']);
  });

  it('offers enum values and booleans from the table', () => {
    expect(completionsAt(at('setFrame |')).map((c) => c.label)).toContain('body-fixed');
    expect(completionsAt(at('setLayer labels |')).map((c) => c.label)).toEqual(['on', 'off']);
  });

  it('offers nothing where nothing fits', () => {
    expect(completionsAt(at('setFov |'))).toEqual([]);
    expect(completionsAt(at('deselect |'))).toEqual([]);
    expect(completionsAt(at('gotoObject Moon # |'), names)).toEqual([]);
  });

  it('inserts text that parses back as the same value', () => {
    const [mro] = completionsAt(at('gotoObject |'), { objects: ['Say "hi" \\ there'] });
    const program = parse(`gotoObject ${mro.insert}`);
    expect(program.statements[0].args[0]).toBe('Say "hi" \\ there');
  });
});

describe('signatureAt', () => {
  it('marks the active parameter', () => {
    const sig = signatureAt(at('setFrame body-fixed |'))!;
    expect(sig.parts.map((p) => (p.active ? `*${p.text}*` : p.text)).join(' '))
      .toBe('setFrame <mode> *[object]*');
  });

  it('has no active parameter past the last one, and no signature without a verb', () => {
    expect(signatureAt(at('deselect |'))?.active).toBe(-1);
    expect(signatureAt(at('nope |'))).toBeNull();
    expect(signatureAt(at('go|'))).toBeNull();
  });
});
