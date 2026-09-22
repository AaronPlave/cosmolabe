/**
 * The script console's run loop, kept out of the component so it can be tested
 * against a fake host without mounting anything.
 *
 * The transcript **streams**: each statement is appended as it starts, not
 * when the run ends. It has to, once `wait` exists — a console that shows
 * nothing for the ten seconds a script spends waiting reads as a hung one.
 */
import {
  execute,
  parse,
  ScriptRuntimeError,
  ScriptSyntaxError,
  type ScriptImage,
  type ViewerControl,
} from '@cosmolabe/control';

export interface TranscriptEntry {
  /** 1-based source line — the console's gutter. */
  readonly line: number;
  /** The source line, echoed so a failure shows what it was about. */
  readonly text: string;
  readonly status: 'running' | 'ok' | 'error';
  /** Why it failed, without the `line N:` prefix the gutter already shows. */
  readonly message?: string;
}

export interface ConsoleRunResult {
  readonly ok: boolean;
  readonly ran: number;
  readonly images: readonly ScriptImage[];
}

/**
 * Parse and run `source`, calling `emit` with the whole transcript every time
 * it changes.
 *
 * A syntax error runs nothing and reports every problem at once, like `parse`
 * does. A runtime error marks the statement that failed and stops there, like
 * `execute` does; the statements before it keep their `ok`, because they did
 * happen and the scene shows it.
 */
export async function runWithTranscript(
  source: string,
  host: ViewerControl,
  emit: (entries: readonly TranscriptEntry[]) => void,
): Promise<ConsoleRunResult> {
  let program;
  try {
    program = parse(source);
  } catch (err) {
    if (!(err instanceof ScriptSyntaxError)) throw err;
    emit(err.problems.map((p) => ({ line: p.line, text: p.text, status: 'error', message: p.message })));
    return { ok: false, ran: 0, images: [] };
  }

  const entries: TranscriptEntry[] = [];
  const settleLast = () => {
    const last = entries.at(-1);
    if (last?.status === 'running') entries[entries.length - 1] = { ...last, status: 'ok' };
  };

  emit(entries.slice());
  try {
    const report = await execute(program, host, {
      onStatement: (statement) => {
        // The previous statement finished — `execute` only moves on once it has.
        settleLast();
        entries.push({ line: statement.line, text: statement.text, status: 'running' });
        emit(entries.slice());
      },
    });
    settleLast();
    emit(entries.slice());
    return { ok: true, ran: report.ran, images: report.images };
  } catch (err) {
    if (!(err instanceof ScriptRuntimeError)) throw err;
    const problem = err.problems[0];
    const last = entries.at(-1);
    const entry: TranscriptEntry = {
      line: err.statement.line,
      text: err.statement.text,
      status: 'error',
      message: problem?.message ?? err.message,
    };
    if (last && last.line === err.statement.line) entries[entries.length - 1] = entry;
    else entries.push(entry);
    emit(entries.slice());
    return { ok: false, ran: err.ran, images: [] };
  }
}
