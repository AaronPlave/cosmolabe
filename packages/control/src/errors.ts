/**
 * Two error classes, each carrying every problem it found.
 *
 * Two, not a five-class taxonomy: what a caller does about a bad script is the
 * same whatever kind of bad it is — show the author the line. The `kind` field
 * on a problem is there for a console that wants to colour them differently,
 * not for control flow.
 *
 * They follow `SpiceError`'s form (`packages/cspice-wasm/src/index.ts`): a real
 * `Error` subclass with extra readonly fields. This repo has no `Result<T, E>`,
 * and introducing one for the script host alone would be a second convention.
 */
import type { Statement } from './contracts.js';

export type ScriptProblemKind =
  /** The line could not be read as `verb arg…`. */
  | 'syntax'
  /** No such verb. */
  | 'unknown-verb'
  /** Wrong number or type of arguments. */
  | 'arguments'
  /** The verb is not allowed in this context (see `ParseOptions.forbid`). */
  | 'forbidden'
  /** The host does not implement the method this verb needs. */
  | 'unsupported'
  /** The host returned `false`: no object, viewpoint, layer or mode by that name. */
  | 'unknown-target'
  /** The host threw. */
  | 'failed';

export interface ScriptProblem {
  readonly kind: ScriptProblemKind;
  /** 1-based line number in the source. */
  readonly line: number;
  /** The verb the line named, when it named a recognizable one. */
  readonly verb?: string;
  /** What went wrong, without the line prefix. */
  readonly message: string;
  /** The source line, verbatim. */
  readonly text: string;
}

/** `line 3: gotoObject: no object named "Titam" (did you mean "Titan"?)` */
export function formatProblem(problem: ScriptProblem): string {
  return `line ${problem.line}: ${problem.message}`;
}

function summarize(problems: readonly ScriptProblem[]): string {
  return problems.map(formatProblem).join('\n');
}

/**
 * The script could not be read. Carries **every** problem in it.
 *
 * All of them on purpose: a syntax pass that stops at the first error makes
 * fixing a twenty-line script a twenty-run job.
 */
export class ScriptSyntaxError extends Error {
  constructor(readonly problems: readonly ScriptProblem[]) {
    super(summarize(problems));
    this.name = 'ScriptSyntaxError';
  }
}

/**
 * A statement failed while running. Carries the one problem that stopped it.
 *
 * One, not all of them, and the run stops there: a half-applied scene still
 * renders and still looks plausible, which is exactly the failure mode that
 * makes a wrong picture confident enough to be baselined.
 */
export class ScriptRuntimeError extends Error {
  constructor(
    readonly problems: readonly ScriptProblem[],
    /** The statement that failed. */
    readonly statement: Statement,
    /** How many statements ran before it. */
    readonly ran: number,
  ) {
    super(summarize(problems));
    this.name = 'ScriptRuntimeError';
  }
}
