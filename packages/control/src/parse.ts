/**
 * The `verb arg…` language: one statement per line, no eval.
 *
 * Statement ≡ line is what makes a reported line number exact *by
 * construction* rather than by bookkeeping. Lines are iterated **by index and
 * skipped in place** — never filtered — which is the explicit inverse of
 * `packages/interop/src/oem.ts`, where a filter-then-iterate destroys the
 * physical index before the loop that has to report errors against it.
 *
 * Deliberately absent: variables, expressions, control flow, user-defined
 * verbs, `include`, a `run <program>` verb (that is recursion, and the no-eval
 * line is drawn there), and any `eval`. A host that wants a loop writes
 * JavaScript against the `ViewerControl` instance — the same division of labour
 * Cosmographia makes with Python, where the loops, variables and arithmetic
 * come from the *user's* language rather than from Cosmographia.
 *
 * `parse` collects **every** problem and throws one aggregate: a pass that
 * stopped at the first error would make fixing a twenty-line script a
 * twenty-run job.
 */
import type {
  ParseOptions,
  Program,
  ScriptTime,
  ScriptVec3,
  Statement,
  VerbValue,
} from './contracts.js';
import { ScriptSyntaxError, type ScriptProblem } from './errors.js';
import { suggestionSuffix } from './suggest.js';
import { VERBS, VERB_NAMES, verbUsage, type VerbParam, type VerbSpec } from './verbs.js';

/**
 * Decimal numbers only.
 *
 * `0x10`, `1_000` and `Infinity` do not match, so they stay string tokens and
 * are rejected by whichever parameter wanted a number — naming the line and the
 * parameter, which is more use than "invalid number". `1e999` *does* match and
 * is caught separately, below: it looks like a number and is not one.
 */
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A bare 4-digit integer is a calendar year, not an ephemeris time. */
const BARE_YEAR = /^\d{4}$/;

type Token =
  | { kind: 'string'; value: string; quoted: boolean; text: string }
  | { kind: 'number'; value: number; text: string }
  | { kind: 'vector'; value: ScriptVec3; text: string };

function describe(token: Token): string {
  return JSON.stringify(token.text);
}

/**
 * Split one line into tokens with a quote-aware character walk.
 *
 * Returns null when the line cannot be tokenized at all; problems are pushed
 * either way, so a broken line still contributes its diagnosis to the
 * aggregate.
 */
function tokenizeLine(text: string, line: number, problems: ScriptProblem[]): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  let failed = false;

  const fail = (message: string) => {
    problems.push({ kind: 'syntax', line, message, text });
    failed = true;
  };

  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    // A comment runs to end of line. Only outside quotes, and only at a token
    // boundary is irrelevant here — we are always at one.
    if (c === '#') break;

    if (c === '"') {
      const start = i;
      i++;
      let value = '';
      let closed = false;
      while (i < text.length) {
        const ch = text[i];
        if (ch === '\\') {
          const next = text[i + 1];
          if (next === '"' || next === '\\') {
            value += next;
            i += 2;
            continue;
          }
          // A lone backslash is a literal backslash. Escaping only what needs
          // escaping keeps a Windows path in a note from becoming unreadable.
          value += ch;
          i++;
          continue;
        }
        if (ch === '"') {
          closed = true;
          i++;
          break;
        }
        value += ch;
        i++;
      }
      if (!closed) {
        fail(`unterminated string starting at column ${start + 1}`);
        return null;
      }
      tokens.push({ kind: 'string', value, quoted: true, text: value });
      continue;
    }

    if (c === '[') {
      const start = i;
      i++;
      let body = '';
      let closed = false;
      while (i < text.length) {
        if (text[i] === ']') {
          closed = true;
          i++;
          break;
        }
        body += text[i];
        i++;
      }
      const raw = text.slice(start, i);
      if (!closed) {
        fail(`unterminated vector starting at column ${start + 1}`);
        return null;
      }
      const parts = body.split(/[\s,]+/).filter((p) => p.length > 0);
      if (parts.length !== 3) {
        fail(`a vector needs exactly 3 components, got ${parts.length} in ${JSON.stringify(raw)}`);
        continue;
      }
      const nums: number[] = [];
      let bad = false;
      for (const part of parts) {
        if (!NUMBER.test(part) || !Number.isFinite(Number(part))) {
          fail(`${JSON.stringify(part)} is not a decimal number, in ${JSON.stringify(raw)}`);
          bad = true;
          break;
        }
        nums.push(Number(part));
      }
      if (bad) continue;
      tokens.push({
        kind: 'vector',
        value: [nums[0], nums[1], nums[2]] as ScriptVec3,
        text: raw,
      });
      continue;
    }

    let word = '';
    while (i < text.length && text[i] !== ' ' && text[i] !== '\t' && text[i] !== '#') {
      word += text[i];
      i++;
    }
    if (NUMBER.test(word)) {
      const value = Number(word);
      if (!Number.isFinite(value)) {
        fail(`${JSON.stringify(word)} is not a finite number`);
        continue;
      }
      tokens.push({ kind: 'number', value, text: word });
    } else {
      tokens.push({ kind: 'string', value: word, quoted: false, text: word });
    }
  }

  return failed ? null : tokens;
}

type Coerced = { ok: true; value: VerbValue } | { ok: false; message: string };

function coerce(spec: VerbSpec, param: VerbParam, token: Token): Coerced {
  const where = `${spec.name}: <${param.name}>`;
  switch (param.type) {
    // Object and viewpoint names are passed **verbatim**: `Universe.getBody` is
    // an exact-match lookup on a `Map`, and folding case here would invent a
    // resolver that exists nowhere else in the system.
    case 'object':
    case 'viewpoint':
    case 'text':
      if (token.kind === 'vector') return { ok: false, message: `${where} expected a name, got a vector` };
      return { ok: true, value: token.text };

    case 'enum': {
      const values = param.values ?? [];
      if (token.kind !== 'string' || !values.includes(token.value)) {
        return {
          ok: false,
          message:
            `${where} unknown ${param.name} ${describe(token)}` +
            suggestionSuffix(token.text, values),
        };
      }
      return { ok: true, value: token.value };
    }

    case 'number':
      if (token.kind !== 'number') {
        return { ok: false, message: `${where} expected a number, got ${describe(token)}` };
      }
      return { ok: true, value: token.value };

    case 'boolean': {
      if (token.kind === 'string') {
        if (token.value === 'on' || token.value === 'true') return { ok: true, value: true };
        if (token.value === 'off' || token.value === 'false') return { ok: true, value: false };
      }
      return {
        ok: false,
        message: `${where} expected on|off|true|false, got ${describe(token)}`,
      };
    }

    case 'time': {
      if (token.kind === 'vector') {
        return { ok: false, message: `${where} expected a time, got a vector` };
      }
      // A bare 4-digit integer is a year, any other numeric token is an
      // ephemeris time, and anything else is a calendar string the host
      // resolves. `setTime 2004` meaning "seconds past J2000" would be a
      // 33-minute scene that nobody asked for.
      if (token.kind === 'number' && !BARE_YEAR.test(token.text)) {
        return { ok: true, value: { kind: 'et', et: token.value } satisfies ScriptTime };
      }
      return { ok: true, value: { kind: 'calendar', text: token.text } satisfies ScriptTime };
    }

    case 'vector':
      if (token.kind !== 'vector') {
        return { ok: false, message: `${where} expected a vector like [0, 0, 1], got ${describe(token)}` };
      }
      return { ok: true, value: token.value };
  }
}

/**
 * Parse `source` into a program, or throw a `ScriptSyntaxError` carrying every
 * problem in it.
 */
export function parse(source: string, opts: ParseOptions = {}): Program {
  const lines = source.split(/\r?\n/);
  const problems: ScriptProblem[] = [];
  const statements: Statement[] = [];
  const forbidden = new Set(opts.forbid ?? []);

  for (let index = 0; index < lines.length; index++) {
    const line = index + 1;
    const text = lines[index];
    const tokens = tokenizeLine(text, line, problems);
    if (tokens === null || tokens.length === 0) continue;

    const head = tokens[0];
    if (head.kind !== 'string' || head.quoted) {
      problems.push({
        kind: 'syntax',
        line,
        message: `expected a verb, got ${describe(head)}`,
        text,
      });
      continue;
    }

    const spec = VERBS.get(head.value);
    if (!spec) {
      problems.push({
        kind: 'unknown-verb',
        line,
        verb: head.value,
        message: `unknown verb ${JSON.stringify(head.value)}${suggestionSuffix(head.value, VERB_NAMES)}`,
        text,
      });
      continue;
    }

    if (forbidden.has(spec.name)) {
      problems.push({
        kind: 'forbidden',
        line,
        verb: spec.name,
        message: `${spec.name} is not allowed here — this script must be deterministic, and ${spec.name} depends on wall-clock time`,
        text,
      });
      continue;
    }

    const args = tokens.slice(1);
    const required = spec.params.filter((p) => !p.optional).length;
    if (args.length < required || args.length > spec.params.length) {
      problems.push({
        kind: 'arguments',
        line,
        verb: spec.name,
        message: `${spec.name} takes ${usageArity(spec)}, got ${args.length} — usage: ${verbUsage(spec)}`,
        text,
      });
      continue;
    }

    const values: VerbValue[] = [];
    let bad = false;
    for (let a = 0; a < spec.params.length; a++) {
      const token = args[a];
      if (token === undefined) {
        values.push(undefined);
        continue;
      }
      const result = coerce(spec, spec.params[a], token);
      if (!result.ok) {
        problems.push({ kind: 'arguments', line, verb: spec.name, message: result.message, text });
        bad = true;
        break;
      }
      values.push(result.value);
    }
    if (bad) continue;

    statements.push({ line, verb: spec.name, args: values, text });
  }

  if (problems.length > 0) throw new ScriptSyntaxError(problems);
  return { statements, source };
}

function usageArity(spec: VerbSpec): string {
  const required = spec.params.filter((p) => !p.optional).length;
  const total = spec.params.length;
  if (required === total) return `${required} argument${required === 1 ? '' : 's'}`;
  return `${required}–${total} arguments`;
}
