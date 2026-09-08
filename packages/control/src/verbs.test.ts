import { describe, expect, it } from 'vitest';
import { VERBS, VERB_LIST, VERB_NAMES, verbUsage } from './verbs.js';
import { parse } from './parse.js';
import { FakeViewer } from './__tests__/fake-host.js';

describe('the table', () => {
  // Dispatch is table-driven precisely so a verb cannot name a method that does
  // not exist. The fake host implements the whole interface, which is what makes
  // this a real check rather than a check of the subset the tests happen to use.
  it('names a real ViewerControl method for every verb', () => {
    const host = new FakeViewer() as unknown as Record<string, unknown>;
    for (const spec of VERB_LIST) {
      expect(typeof host[spec.method], `${spec.name} → ${String(spec.method)}`).toBe('function');
    }
  });

  it('has no duplicate names', () => {
    expect(VERB_NAMES.length).toBe(new Set(VERB_NAMES).size);
    expect(VERBS.size).toBe(VERB_LIST.length);
  });

  it('gives every verb a category and a help line', () => {
    for (const spec of VERB_LIST) {
      expect(spec.help.length, spec.name).toBeGreaterThan(0);
      expect(spec.category, spec.name).toBeTruthy();
    }
  });

  it('puts optional parameters last, so positions stay stable', () => {
    for (const spec of VERB_LIST) {
      const firstOptional = spec.params.findIndex((p) => p.optional);
      if (firstOptional < 0) continue;
      expect(
        spec.params.slice(firstOptional).every((p) => p.optional),
        `${spec.name}: a required parameter follows an optional one`,
      ).toBe(true);
    }
  });

  it('gives every enum parameter its values', () => {
    for (const spec of VERB_LIST) {
      for (const param of spec.params) {
        if (param.type !== 'enum') continue;
        expect(param.values?.length, `${spec.name}.${param.name}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('presets', () => {
  // Guard against a vacuous pass: a preset that does not parse is a palette
  // entry that throws the moment someone clicks it.
  it('parse as their own verb, and produce exactly one statement', () => {
    for (const spec of VERB_LIST) {
      for (const preset of spec.presets ?? []) {
        const source = `${spec.name} ${preset.args}`.trim();
        const program = parse(source);
        expect(program.statements, source).toHaveLength(1);
        expect(program.statements[0].verb, source).toBe(spec.name);
      }
    }
  });

  it('have unique ids across the whole table', () => {
    const ids = VERB_LIST.flatMap((spec) => (spec.presets ?? []).map((p) => p.id));
    expect(ids.length).toBe(new Set(ids).size);
  });
});

describe('verbUsage', () => {
  it('brackets the optional parameters', () => {
    expect(verbUsage(VERBS.get('gotoObject')!)).toBe('gotoObject <object> [seconds]');
    expect(verbUsage(VERBS.get('untrack')!)).toBe('untrack');
    expect(verbUsage(VERBS.get('setLayer')!)).toBe('setLayer <layer> <on>');
  });
});
