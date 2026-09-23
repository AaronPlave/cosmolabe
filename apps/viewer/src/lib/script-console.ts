/**
 * The script console's runner: a small state machine over `execute`, kept out
 * of the component so it can be tested against a fake host without mounting
 * anything. The component only renders `RunnerState`.
 *
 * It is a sequence runner, not a debugger. Three rules shape it:
 *
 * - **Pause means "after the current statement".** `execute`'s
 *   `beforeStatement` gate is held; nothing in flight is frozen, because an
 *   arbitrary viewer operation — a camera fly-to, say — cannot honestly claim
 *   to be pausable mid-way.
 * - **Except `wait`, which is ours.** The runner hands `execute` a host whose
 *   `wait` is a timer the runner owns, so a paused `wait 60` stops counting at
 *   once, and the console can show how long is left.
 * - **Stop is immediate** — the abort signal interrupts the statement in
 *   flight and a recording the script started — and so is anything that
 *   takes the console away: the component stops the runner on unmount, and
 *   the runner stops itself on the host's `load` event.
 */
import {
  execute,
  parse,
  ScriptRuntimeError,
  ScriptSyntaxError,
  type Program,
  type ScriptProblemKind,
  type ViewerControl,
} from '@cosmolabe/control';

export type RunnerPhase =
  | 'idle'
  /** Held at the gate, or inside a frozen `wait`. */
  | 'paused'
  /** Pause asked for; the statement in flight is finishing. */
  | 'pausing'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled';

/** How a source line figures in the current or last run. */
export type LineStatus = 'done' | 'active' | 'error' | 'cancelled';

export interface RunnerProblem {
  readonly line: number;
  readonly kind: ScriptProblemKind;
  readonly message: string;
}

export interface RunnerState {
  readonly phase: RunnerPhase;
  /** Statements in the program — blank lines and comments do not count. */
  readonly total: number;
  /** Statements finished. */
  readonly completed: number;
  /** The line running, or held at, when there is one. */
  readonly activeLine: number | null;
  readonly lines: Readonly<Record<number, LineStatus>>;
  /** Every syntax problem, or the one runtime problem that ended the run. */
  readonly problems: readonly RunnerProblem[];
  /** The `wait` in flight, in seconds. */
  readonly wait: { readonly remaining: number; readonly total: number } | null;
  /** Run time so far, excluding time spent paused. */
  readonly elapsedMs: number;
  /** Frames the script captured. */
  readonly captures: number;
  /** Why the run was stopped, for a `cancelled` phase. */
  readonly stopReason: string | null;
}

export const IDLE: RunnerState = {
  phase: 'idle',
  total: 0,
  completed: 0,
  activeLine: null,
  lines: {},
  problems: [],
  wait: null,
  elapsedMs: 0,
  captures: 0,
  stopReason: null,
};

/** How often a running `wait` refreshes its countdown. */
const WAIT_TICK_MS = 100;

export class ScriptRunner {
  private state: RunnerState = IDLE;
  private controller: AbortController | null = null;
  private pauseRequested = false;
  private releaseGate: (() => void) | null = null;
  /** Wall-clock start of the current un-paused stretch, or null while paused. */
  private activeSince: number | null = null;
  private accumulatedMs = 0;
  /** Line statuses of the run in progress, and the last line announced. */
  private lines: Record<number, LineStatus> = {};
  private lastLine: number | null = null;
  private waitTimer: {
    remainingMs: number;
    totalMs: number;
    since: number | null;
    handle: ReturnType<typeof setTimeout> | null;
    ticker: ReturnType<typeof setInterval> | null;
    resolve: () => void;
  } | null = null;

  constructor(private readonly emit: (state: RunnerState) => void) {}

  get current(): RunnerState {
    return this.state;
  }

  get busy(): boolean {
    return this.state.phase === 'running' || this.state.phase === 'pausing' || this.state.phase === 'paused';
  }

  /** Parse and run `source`. Resolves when the run ends, however it ends. */
  async run(source: string, host: ViewerControl): Promise<RunnerState> {
    if (this.busy) return this.state;

    let program: Program;
    try {
      program = parse(source);
    } catch (err) {
      if (!(err instanceof ScriptSyntaxError)) throw err;
      const lines: Record<number, LineStatus> = {};
      for (const p of err.problems) lines[p.line] = 'error';
      this.set({
        ...IDLE,
        phase: 'failed',
        lines,
        problems: err.problems.map((p) => ({ line: p.line, kind: p.kind, message: p.message })),
      });
      return this.state;
    }

    const controller = new AbortController();
    this.controller = controller;
    this.pauseRequested = false;
    this.accumulatedMs = 0;
    this.activeSince = Date.now();
    this.set({ ...IDLE, phase: 'running', total: program.statements.length });

    const stopWatching = host.on('load', () => this.stop('a new scene loaded'));
    this.lines = {};
    this.lastLine = null;
    const lines = this.lines;

    try {
      const report = await execute(program, this.hostWithOwnWait(host), {
        signal: controller.signal,
        // A statement's index is how many finished before it — the one count
        // that is right both while it runs and while the run is held before it.
        beforeStatement: (statement) => this.gate(statement.line, program.statements.indexOf(statement)),
        onStatement: (statement) => {
          this.markActive(statement.line);
          this.set({ completed: program.statements.indexOf(statement), wait: null });
        },
      });
      if (this.lastLine != null) lines[this.lastLine] = 'done';
      this.finish({
        phase: 'done',
        completed: report.ran,
        activeLine: null,
        lines: { ...lines },
        captures: report.images.length,
      });
    } catch (err) {
      if (!(err instanceof ScriptRuntimeError)) {
        this.finish({ phase: 'failed', problems: [{ line: 0, kind: 'failed', message: String(err) }] });
        throw err;
      }
      const problem = err.problems[0];
      const cancelled = problem?.kind === 'cancelled';
      // Everything before the line the run ended on is done; that line was
      // interrupted, refused, or held at and never reached.
      for (const [n, status] of Object.entries(lines)) {
        if (status === 'active' && Number(n) !== err.statement.line) lines[Number(n)] = 'done';
      }
      lines[err.statement.line] = cancelled ? 'cancelled' : 'error';
      this.finish({
        phase: cancelled ? 'cancelled' : 'failed',
        completed: err.ran,
        activeLine: null,
        lines: { ...lines },
        problems: cancelled
          ? []
          : [{ line: err.statement.line, kind: problem?.kind ?? 'failed', message: problem?.message ?? err.message }],
      });
    } finally {
      stopWatching();
      this.controller = null;
    }
    return this.state;
  }

  /** Stop after the current statement — at once, if that statement is a `wait`. */
  pause(): void {
    if (this.state.phase !== 'running') return;
    this.pauseRequested = true;
    if (this.waitTimer) {
      this.freezeWait();
      this.enterPaused();
    } else {
      this.set({ phase: 'pausing' });
    }
  }

  resume(): void {
    if (this.state.phase !== 'paused' && this.state.phase !== 'pausing') return;
    this.pauseRequested = false;
    this.continueFromPause();
  }

  /** While paused: run exactly one statement (or finish the held `wait`), then pause again. */
  step(): void {
    if (this.state.phase !== 'paused') return;
    this.continueFromPause();
  }

  /** Stop now. `reason` finishes "Stopped: …". */
  stop(reason = 'stopped'): void {
    if (!this.controller || this.controller.signal.aborted) return;
    this.set({ stopReason: reason });
    this.clearWait();
    this.controller.abort();
  }

  // ── internals ──

  private set(patch: Partial<RunnerState>): void {
    this.state = { ...this.state, ...patch, elapsedMs: this.elapsed() };
    this.emit(this.state);
  }

  private finish(patch: Partial<RunnerState>): void {
    this.clearWait();
    this.pauseRequested = false;
    this.releaseGate = null;
    if (this.activeSince != null) this.accumulatedMs += Date.now() - this.activeSince;
    this.activeSince = null;
    this.set({ wait: null, ...patch });
  }

  private elapsed(): number {
    return this.accumulatedMs + (this.activeSince != null ? Date.now() - this.activeSince : 0);
  }

  private enterPaused(): void {
    if (this.activeSince != null) this.accumulatedMs += Date.now() - this.activeSince;
    this.activeSince = null;
    this.set({ phase: 'paused' });
  }

  private continueFromPause(): void {
    this.activeSince = Date.now();
    this.set({ phase: 'running' });
    if (this.waitTimer) {
      this.thawWait();
    } else {
      const release = this.releaseGate;
      this.releaseGate = null;
      release?.();
    }
  }

  /**
   * The statement at `line` becomes the one the rail is on: the previous one
   * is done. Called when a statement starts, and when the run is held just
   * before one — a paused script points at what runs next, not at the `wait`
   * that already finished.
   */
  private markActive(line: number): void {
    if (this.lastLine != null && this.lastLine !== line) this.lines[this.lastLine] = 'done';
    this.lines[line] = 'active';
    this.lastLine = line;
    this.set({ activeLine: line, lines: { ...this.lines } });
  }

  private gate(line: number, completed: number): void | Promise<void> {
    if (!this.pauseRequested) return;
    this.set({ wait: null, completed });
    this.markActive(line);
    this.enterPaused();
    return new Promise<void>((resolve) => { this.releaseGate = resolve; });
  }

  /**
   * The host, with `wait` replaced by the runner's pausable timer.
   *
   * A prototype link rather than a copy, so every other method — including
   * ones added to the contract later — reaches the real host unchanged.
   */
  private hostWithOwnWait(host: ViewerControl): ViewerControl {
    const wrapped = Object.create(host) as ViewerControl;
    wrapped.wait = (seconds: number) => this.startWait(seconds);
    return wrapped;
  }

  private startWait(seconds: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const totalMs = Math.max(0, seconds * 1000);
      this.waitTimer = { remainingMs: totalMs, totalMs, since: null, handle: null, ticker: null, resolve };
      this.thawWait();
    });
  }

  private thawWait(): void {
    const w = this.waitTimer;
    if (!w) return;
    w.since = Date.now();
    w.handle = setTimeout(() => {
      this.clearWait();
      w.resolve();
      // A Step through a held `wait` pauses again at the next gate, which
      // `pauseRequested` (still set) arranges; nothing more to do here.
    }, w.remainingMs);
    w.ticker = setInterval(() => this.publishWait(), WAIT_TICK_MS);
    this.publishWait();
  }

  private freezeWait(): void {
    const w = this.waitTimer;
    if (!w || w.since == null) return;
    w.remainingMs = Math.max(0, w.remainingMs - (Date.now() - w.since));
    w.since = null;
    if (w.handle) clearTimeout(w.handle);
    if (w.ticker) clearInterval(w.ticker);
    w.handle = w.ticker = null;
    this.publishWait();
  }

  private publishWait(): void {
    const w = this.waitTimer;
    if (!w) return;
    const remainingMs = w.since != null ? Math.max(0, w.remainingMs - (Date.now() - w.since)) : w.remainingMs;
    this.set({ wait: { remaining: remainingMs / 1000, total: w.totalMs / 1000 } });
  }

  private clearWait(): void {
    const w = this.waitTimer;
    if (!w) return;
    if (w.handle) clearTimeout(w.handle);
    if (w.ticker) clearInterval(w.ticker);
    this.waitTimer = null;
  }
}

/** `26.4s`, `1m 05s` — for the status line. */
export function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`;
}
