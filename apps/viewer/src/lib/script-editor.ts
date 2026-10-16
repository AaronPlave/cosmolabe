/**
 * The script editor: CodeMirror 6 configured for the `verb arg…` language.
 *
 * Everything language-aware comes from `@cosmolabe/control` — the tokens are
 * the ones `parse` reads, completions and signatures are `completionsAt` and
 * `signatureAt` over the verb table, and lint is `parse` itself. This file is
 * only the binding, so the editor cannot disagree with the interpreter about
 * what a line means.
 *
 * It is also where a run becomes visible: the runner's line statuses are
 * decorations here — the active line carries a rail, finished lines dim, a
 * failed line is marked — which is what lets the editor stand in for a
 * transcript that used to repeat the whole script underneath it.
 */
import { EditorState, Compartment, StateEffect, StateField, RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  EditorView, Decoration, WidgetType, keymap, lineNumbers, drawSelection, placeholder as placeholderExt,
  showTooltip, type DecorationSet, type Tooltip,
} from '@codemirror/view';
import { StreamLanguage, HighlightStyle, syntaxHighlighting, bracketMatching } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import {
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, startCompletion, closeCompletion,
  type Completion, type CompletionContext, type CompletionResult,
} from '@codemirror/autocomplete';
import { linter, type Diagnostic } from '@codemirror/lint';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  ScriptSyntaxError, VERBS, completionsAt, cursorContext, parse, signatureAt,
  type CompletionNames,
} from '@cosmolabe/control';
import type { LineStatus } from './script-console';

// ── Language ──

interface TokState { atLineStart: boolean; }

/**
 * Colouring only — `parse` is the authority on validity, and reports through
 * lint. The first word of a line is the verb; a known one reads as a keyword
 * and an unknown one does not, which is a hint before lint catches up.
 */
const scriptLanguage = StreamLanguage.define<TokState>({
  name: 'cosmolabe-script',
  startState: () => ({ atLineStart: true }),
  token(stream, state) {
    if (stream.sol()) state.atLineStart = true;
    if (stream.eatSpace()) return null;
    if (stream.peek() === '#') { stream.skipToEnd(); return 'comment'; }
    const first = state.atLineStart;
    state.atLineStart = false;
    if (stream.peek() === '"') {
      stream.next();
      let escaped = false;
      let ch: string | void;
      while ((ch = stream.next()) != null) {
        if (!escaped && ch === '"') break;
        escaped = !escaped && ch === '\\';
      }
      return 'string';
    }
    if (stream.peek() === '[') {
      stream.next();
      stream.eatWhile((c) => c !== ']');
      stream.eat(']');
      return 'number';
    }
    stream.eatWhile((c) => c !== ' ' && c !== '\t' && c !== '#');
    const word = stream.current();
    if (first) return VERBS.has(word) ? 'keyword' : 'invalid';
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(word)) return 'number';
    if (/^(on|off|true|false)$/.test(word)) return 'atom';
    return null;
  },
});

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--color-accent)' },
  { tag: t.string, color: 'var(--color-event-accent)' },
  { tag: t.number, color: 'var(--color-text-column)' },
  { tag: t.atom, color: 'var(--color-text-column)' },
  { tag: t.comment, color: 'var(--color-text-muted)', fontStyle: 'italic' },
  { tag: t.invalid, color: 'var(--color-text-primary)', textDecoration: 'underline dotted var(--color-error)' },
]);

// ── Completion ──

function completionSource(getNames: () => CompletionNames) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const ctx = cursorContext(line.text, context.pos - line.from);
    // Only offer unprompted once something has been typed, or right after a
    // space that opened an argument slot; Ctrl-Space always asks.
    if (!context.explicit && ctx.prefix === '' && ctx.argIndex < 0) return null;
    const items = completionsAt(ctx, getNames());
    if (items.length === 0) return null;
    const options: Completion[] = items.map((c) => ({
      label: c.label,
      detail: c.kind === 'verb' ? c.detail?.slice(c.label.length).trim() : undefined,
      info: c.info,
      type: c.kind === 'verb' ? 'keyword' : c.kind === 'value' ? 'enum' : 'variable',
      apply: (view, _completion, from, to) => {
        // A verb with parameters, or an argument with more to follow, gets its
        // trailing space and reopens the list for the next slot.
        const spec = c.kind === 'verb' ? VERBS.get(c.insert) : ctx.verb;
        const more = c.kind === 'verb'
          ? (spec?.params.length ?? 0) > 0
          : (ctx.verb?.params.length ?? 0) > ctx.argIndex + 1;
        const text = c.insert + (more ? ' ' : '');
        // Typing `"` auto-closes it; a completion inside that quote brings its
        // own closing quote, so absorb the automatic one rather than doubling it.
        const end = ctx.quoted && view.state.sliceDoc(to, to + 1) === '"' ? to + 1 : to;
        view.dispatch({
          changes: { from, to: end, insert: text },
          selection: { anchor: from + text.length },
          userEvent: 'input.complete',
        });
        if (more) startCompletion(view);
      },
    }));
    return {
      from: line.from + ctx.from,
      options,
      validFor: ctx.quoted ? /^[^"]*$/ : /^[^\s"#[]*$/,
    };
  };
}

// ── Signature help ──

function signatureTooltip(state: EditorState): Tooltip | null {
  // Read-only means a run owns the editor; help for typing is noise then.
  if (state.readOnly) return null;
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const line = state.doc.lineAt(sel.head);
  const sig = signatureAt(cursorContext(line.text, sel.head - line.from));
  if (!sig) return null;
  return {
    pos: sel.head,
    above: true,
    strictSide: true,
    arrow: false,
    create: () => {
      const dom = document.createElement('div');
      dom.className = 'cm-script-signature';
      const usage = document.createElement('div');
      usage.className = 'cm-script-signature-usage';
      sig.parts.forEach((part, i) => {
        if (i > 0) usage.append(' ');
        const span = document.createElement('span');
        span.textContent = part.text;
        if (part.active) span.className = 'cm-script-signature-active';
        usage.append(span);
      });
      const help = document.createElement('div');
      help.className = 'cm-script-signature-help';
      help.textContent = sig.verb.help;
      dom.append(usage, help);
      return { dom };
    },
  };
}

const signatureField = StateField.define<Tooltip | null>({
  create: signatureTooltip,
  update(value, tr) {
    if (!tr.docChanged && !tr.selection && tr.startState.readOnly === tr.state.readOnly) return value;
    return signatureTooltip(tr.state);
  },
  provide: (f) => showTooltip.from(f),
});

// ── Lint ──

const scriptLinter = linter((view) => {
  const doc = view.state.doc;
  try {
    parse(doc.toString());
    return [];
  } catch (err) {
    if (!(err instanceof ScriptSyntaxError)) return [];
    return err.problems.map((p): Diagnostic => {
      const line = doc.line(Math.min(p.line, doc.lines));
      return { from: line.from, to: line.to, severity: 'error', message: p.message };
    });
  }
}, { delay: 250 });

// ── Run state ──

export interface RunDecorations {
  readonly lines: Readonly<Record<number, LineStatus>>;
  readonly activeLine: number | null;
  /** Shown at the end of the active line — a `wait` countdown. */
  readonly activeNote: string | null;
}

export const setRunDecorations = StateEffect.define<RunDecorations>();

class NoteWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: NoteWidget) { return other.text === this.text; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-run-note';
    span.textContent = this.text;
    return span;
  }
}

function buildRunDecorations(state: EditorState, run: RunDecorations): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  for (let n = 1; n <= doc.lines; n++) {
    const status = run.lines[n];
    if (!status) continue;
    const line = doc.line(n);
    builder.add(line.from, line.from, Decoration.line({ class: `cm-run-${status}` }));
    if (n === run.activeLine && run.activeNote) {
      builder.add(line.to, line.to, Decoration.widget({ widget: new NoteWidget(run.activeNote), side: 1 }));
    }
  }
  return builder.finish();
}

const runField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setRunDecorations)) return buildRunDecorations(tr.state, e.value);
    return tr.docChanged ? Decoration.none : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ── Theme ──

const theme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--color-surface-3)',
    color: 'var(--color-text-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: '4px',
    fontSize: '11px',
    minHeight: '8rem',
  },
  '&.cm-focused': { outline: 'none', borderColor: 'var(--color-accent)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', maxHeight: '22rem' },
  '.cm-content': { padding: '4px 0', caretColor: 'var(--color-text-primary)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--color-text-faint)',
    border: 'none',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 8px', minWidth: '2.2em' },
  '.cm-line': { padding: '0 8px 0 4px' },
  '.cm-placeholder': { color: 'var(--color-text-faint)' },
  '&.cm-editor .cm-selectionBackground, ::selection': { backgroundColor: 'var(--color-selected)' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(110, 170, 255, 0.18)' },
  // Run state: restrained, not a debugger. A 2px rail and a faint wash for
  // the active line; finished lines step back; failures use the semantic colours.
  '.cm-run-active': {
    backgroundColor: 'var(--color-selected)',
    boxShadow: 'inset 2px 0 0 var(--color-accent)',
  },
  '.cm-run-done': { opacity: '0.55' },
  '.cm-run-error': {
    backgroundColor: 'rgba(248, 113, 113, 0.08)',
    boxShadow: 'inset 2px 0 0 var(--color-error)',
  },
  '.cm-run-cancelled': {
    backgroundColor: 'rgba(251, 191, 36, 0.06)',
    boxShadow: 'inset 2px 0 0 var(--color-warning)',
  },
  '.cm-run-note': {
    marginLeft: '1.5em',
    color: 'var(--color-text-secondary)',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--color-panel)',
    border: '1px solid var(--color-border-strong)',
    borderRadius: '4px',
    color: 'var(--color-text-primary)',
    fontSize: '11px',
  },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', maxHeight: '14em' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '1px 8px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--color-selected)',
    color: 'var(--color-text-primary)',
  },
  '.cm-completionDetail': { color: 'var(--color-text-muted)', fontStyle: 'normal', marginLeft: '0.75em' },
  '.cm-completionInfo': { padding: '4px 8px', maxWidth: '18em' },
  '.cm-script-signature': { padding: '4px 8px', maxWidth: '22em' },
  // Signature help is for the person typing; it should not hover over the
  // panel once focus has moved to the scene or a button.
  '&:not(.cm-focused) .cm-tooltip:has(.cm-script-signature)': { display: 'none' },
  '.cm-script-signature-usage': { fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)' },
  '.cm-script-signature-active': { color: 'var(--color-text-primary)', fontWeight: '600', textDecoration: 'underline' },
  '.cm-script-signature-help': { marginTop: '2px', color: 'var(--color-text-muted)' },
  '.cm-diagnostic-error': { borderLeft: '2px solid var(--color-error)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--color-error)' },
}, { dark: true });

// ── Assembly ──

export interface ScriptEditorOptions {
  doc: string;
  placeholder: string;
  /** The running viewer's names, read at completion time so they stay current. */
  getNames: () => CompletionNames;
  onChange: (doc: string) => void;
  onRun: () => void;
}

export interface ScriptEditorHandle {
  readonly view: EditorView;
  setDoc(doc: string): void;
  setReadOnly(readOnly: boolean): void;
  setRun(run: RunDecorations): void;
  destroy(): void;
}

export function createScriptEditor(parent: HTMLElement, opts: ScriptEditorOptions): ScriptEditorHandle {
  const readOnly = new Compartment();
  let lastActive: number | null = null;

  const extensions: Extension[] = [
    lineNumbers(),
    history(),
    drawSelection(),
    closeBrackets(),
    bracketMatching(),
    scriptLanguage,
    syntaxHighlighting(highlight),
    autocompletion({ override: [completionSource(opts.getNames)], icons: false }),
    signatureField,
    scriptLinter,
    runField,
    placeholderExt(opts.placeholder),
    readOnly.of([]),
    keymap.of([
      { key: 'Mod-Enter', run: () => { opts.onRun(); return true; }, preventDefault: true },
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    EditorView.updateListener.of((u) => { if (u.docChanged) opts.onChange(u.state.doc.toString()); }),
    EditorView.contentAttributes.of({ 'aria-label': 'Script source', spellcheck: 'false' }),
    theme,
  ];

  const view = new EditorView({ parent, state: EditorState.create({ doc: opts.doc, extensions }) });

  return {
    view,
    setDoc(doc) {
      if (doc === view.state.doc.toString()) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
    },
    setReadOnly(ro) {
      if (ro === view.state.readOnly) return;
      // A run is taking over: nothing the person was halfway through choosing
      // should stay open over the script it is executing.
      if (ro) closeCompletion(view);
      view.dispatch({
        effects: readOnly.reconfigure(ro ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
      });
    },
    setRun(run) {
      const effects: StateEffect<unknown>[] = [setRunDecorations.of(run)];
      // Follow the active line, but only when it moves — a countdown tick
      // must not yank the view back while someone scrolls to read ahead.
      if (run.activeLine != null && run.activeLine !== lastActive && run.activeLine <= view.state.doc.lines) {
        effects.push(EditorView.scrollIntoView(view.state.doc.line(run.activeLine).from, { y: 'nearest' }));
      }
      lastActive = run.activeLine;
      view.dispatch({ effects });
    },
    destroy() { view.destroy(); },
  };
}
