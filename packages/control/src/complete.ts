/**
 * Editor support: what the cursor is on, what could go there, and which
 * signature applies.
 *
 * Pure and DOM-free like the rest of this package, so an editor binding
 * (CodeMirror in the viewer) is a thin adapter and the language knowledge —
 * which parameter a cursor is in, what an `enum` accepts, that a `boolean`
 * is `on|off` — lives next to the verb table it is derived from, and is
 * tested there.
 */
import { VERBS, VERB_LIST, verbUsage, type VerbParam, type VerbSpec } from './verbs.js';

/** Where a cursor sits within one line of script. */
export interface CursorContext {
  /** The verb the line names, when the first word is a known one. */
  readonly verb?: VerbSpec;
  /**
   * `-1` while the cursor is on the verb itself; otherwise the index of the
   * argument being typed. May exceed the verb's parameter count.
   */
  readonly argIndex: number;
  /** The parameter at `argIndex`, when the verb has one there. */
  readonly param?: VerbParam;
  /**
   * Column (0-based) a completion replaces from: the token's start, or just
   * past its opening quote.
   */
  readonly from: number;
  /** Text of that token up to the cursor, without an opening quote. */
  readonly prefix: string;
  /** The token under the cursor opened a `"…"` string. */
  readonly quoted: boolean;
  /** Inside a comment or a vector literal — nowhere a completion belongs. */
  readonly inert: boolean;
}

/**
 * Describe the cursor at `column` in `line`.
 *
 * Lenient where `parse` is strict: an unterminated quote or vector is the
 * normal state of a line being typed, so it is read as "still inside" rather
 * than reported.
 */
export function cursorContext(line: string, column: number): CursorContext {
  const text = line.slice(0, column);
  // Token starts, in order, with whether each opened a quote.
  const starts: { at: number; quoted: boolean }[] = [];
  let i = 0;
  let inert = false;
  let open: 'quote' | 'vector' | null = null;
  let tokenStart = -1;

  while (i < text.length) {
    const c = text[i];
    if (open === 'quote') {
      if (c === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) { i += 2; continue; }
      if (c === '"') { open = null; tokenStart = -1; }
      i++;
      continue;
    }
    if (open === 'vector') {
      if (c === ']') { open = null; tokenStart = -1; }
      i++;
      continue;
    }
    if (c === ' ' || c === '\t') { tokenStart = -1; i++; continue; }
    if (c === '#') { inert = true; break; }
    if (tokenStart < 0) {
      tokenStart = i;
      starts.push({ at: i, quoted: c === '"' });
      if (c === '"') { open = 'quote'; i++; continue; }
      if (c === '[') { open = 'vector'; i++; continue; }
    }
    i++;
  }

  // The cursor is on a token if the last one is still open (no whitespace
  // since it began); otherwise it is at the start of a new, empty one.
  const onToken = tokenStart >= 0 || open !== null;
  const tokenIndex = onToken ? starts.length - 1 : starts.length;
  const current = onToken ? starts[starts.length - 1] : undefined;
  const quoted = current?.quoted ?? false;
  // After the opening quote, so accepting a completion keeps it.
  const from = current ? current.at + (quoted ? 1 : 0) : column;
  const prefix = current ? text.slice(current.at + (quoted ? 1 : 0)) : '';

  const verbName = starts.length > 0 && tokenIndex > 0 ? firstWord(text) : undefined;
  const verb = verbName ? VERBS.get(verbName) : undefined;
  const argIndex = tokenIndex - 1;
  return {
    verb,
    argIndex,
    param: verb && argIndex >= 0 ? verb.params[argIndex] : undefined,
    from,
    prefix,
    quoted,
    inert: inert || open === 'vector',
  };
}

function firstWord(text: string): string {
  const m = /^\s*([^\s#"[]+)/.exec(text);
  return m ? m[1] : '';
}

/** One thing that could be typed at the cursor. */
export interface ScriptCompletion {
  /** What is inserted — quoted already when the value needs it. */
  readonly insert: string;
  /** What the list shows. */
  readonly label: string;
  readonly kind: 'verb' | 'object' | 'viewpoint' | 'value';
  /** The verb's usage line, or the parameter a value is for. */
  readonly detail?: string;
  /** One-line help, for a verb. */
  readonly info?: string;
}

/** Names only the running viewer knows. */
export interface CompletionNames {
  readonly objects?: readonly string[];
  readonly viewpoints?: readonly string[];
}

const BOOLEANS = ['on', 'off'];

/** A value the language can read back as the same single token. */
function asToken(value: string, alreadyQuoted: boolean): string {
  if (alreadyQuoted) return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  return /[\s"#[\]]/.test(value) || value === ''
    ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : value;
}

/**
 * Candidates for the cursor, unfiltered by `prefix` beyond what the kind of
 * slot implies — an editor does its own fuzzy matching and ranking.
 */
export function completionsAt(ctx: CursorContext, names: CompletionNames = {}): ScriptCompletion[] {
  if (ctx.inert) return [];
  if (ctx.argIndex < 0) {
    if (ctx.quoted) return [];
    return VERB_LIST.map((v) => ({
      insert: v.name,
      label: v.name,
      kind: 'verb' as const,
      detail: verbUsage(v),
      info: v.help,
    }));
  }
  const param = ctx.param;
  if (!param) return [];
  const detail = `<${param.name}>`;
  const values = (list: readonly string[], kind: ScriptCompletion['kind']) =>
    list.map((v) => ({ insert: asToken(v, ctx.quoted), label: v, kind, detail }));
  switch (param.type) {
    case 'enum':
      return ctx.quoted ? [] : values(param.values ?? [], 'value');
    case 'boolean':
      return ctx.quoted ? [] : values(BOOLEANS, 'value');
    case 'object':
      return values(names.objects ?? [], 'object');
    case 'viewpoint':
      return values(names.viewpoints ?? [], 'viewpoint');
    default:
      return [];
  }
}

/** The signature for the line under the cursor, with the active parameter. */
export interface ScriptSignature {
  readonly verb: VerbSpec;
  /** Index into `verb.params`, or `-1` when past the last one or on the verb. */
  readonly active: number;
  /** `verbUsage` split so an editor can emphasise the active parameter. */
  readonly parts: readonly { text: string; active: boolean }[];
}

export function signatureAt(ctx: CursorContext): ScriptSignature | null {
  if (!ctx.verb || ctx.inert) return null;
  const verb = ctx.verb;
  const active = ctx.argIndex >= 0 && ctx.argIndex < verb.params.length ? ctx.argIndex : -1;
  const parts = [
    { text: verb.name, active: false },
    ...verb.params.map((p, i) => ({
      text: p.optional ? `[${p.name}]` : `<${p.name}>`,
      active: i === active,
    })),
  ];
  return { verb, active, parts };
}
