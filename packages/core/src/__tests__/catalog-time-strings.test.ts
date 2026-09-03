/**
 * No shipped catalog may state a time that means different things on different
 * machines.
 *
 * ES parses an ISO date-time carrying no offset as LOCAL time. Every epoch path
 * that cannot reach SPICE therefore used to resolve such a string against the
 * reader's timezone: `solar-system.json`'s Ceres element epoch was the one
 * offending value in the whole catalog set, and in a SPICE-free Universe it put
 * Ceres 435,204 km from where a UTC machine put it. `core/time.ts` now reads a
 * naive string as UTC so the *code* is machine-independent — but the data
 * should still say what it means, and the next hand-authored catalog should not
 * be able to reintroduce the ambiguity silently.
 *
 * This walks every string in every catalog rather than checking a list of known
 * field names, so a time under a key nobody has thought of yet is still caught.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CATALOG_ROOTS = [join(__dirname, '../../../../apps/viewer/test-catalogs')];

/** An ISO-8601 date-time: the form ES reads as local when it carries no offset.
 *  A date-only value ('2010-07-23') is UTC by spec and deliberately allowed. */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?/;
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function jsonFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.json')) out.push(full);
    }
  };
  try {
    walk(dir);
  } catch {
    /* a catalog root that isn't checked out is not a failure here */
  }
  return out.sort();
}

/** Every `[jsonPath, value]` string leaf in a parsed document. */
function stringLeaves(node: unknown, path = '$'): [string, string][] {
  if (typeof node === 'string') return [[path, node]];
  if (Array.isArray(node)) return node.flatMap((v, i) => stringLeaves(v, `${path}[${i}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => stringLeaves(v, `${path}.${k}`));
  }
  return [];
}

describe('catalog time strings are unambiguous', () => {
  const files = CATALOG_ROOTS.flatMap(jsonFilesUnder);

  it('finds catalogs to check (guards against a vacuous pass)', () => {
    // Without this the suite would report green on an empty file list — the
    // exact failure mode this repo has been bitten by twice.
    expect(files.length).toBeGreaterThan(10);
  });

  it('never states an ISO date-time without a UTC designator or offset', () => {
    const offenders: string[] = [];
    for (const file of files) {
      let doc: unknown;
      try {
        doc = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue; // malformed JSON is another test's problem
      }
      for (const [path, value] of stringLeaves(doc)) {
        if (ISO_DATETIME.test(value) && !HAS_OFFSET.test(value.trim())) {
          offenders.push(`${file.split('/test-catalogs/')[1]} at ${path}: ${JSON.stringify(value)}`);
        }
      }
    }
    expect(
      offenders,
      `These times are read as LOCAL time by any path that cannot reach SPICE str2et, so they\n` +
        `resolve differently on every machine. Append "Z" (or use a date-only value):\n  ` +
        offenders.join('\n  '),
    ).toEqual([]);
  });

  it('stays sensitive to the pattern it guards', () => {
    // The check is only worth having if it would actually fire.
    expect(ISO_DATETIME.test('2010-07-23T00:00:00')).toBe(true);
    expect(HAS_OFFSET.test('2010-07-23T00:00:00')).toBe(false);
    // ...and does not fire on the forms that are already unambiguous.
    expect(HAS_OFFSET.test('2010-07-23T00:00:00Z')).toBe(true);
    expect(HAS_OFFSET.test('2010-07-23T00:00:00+02:00')).toBe(true);
    expect(ISO_DATETIME.test('2010-07-23')).toBe(false);
  });
});
