/**
 * Run a parsed program against a host.
 *
 * Two rules, both chosen for the failure they prevent:
 *
 * **Every call is awaited**, so statements land in source order even when the
 * host is async. A `gotoObject` that resolves a frame later must not be
 * overtaken by the `screenshot` on the next line.
 *
 * **The run stops at the first runtime error.** A half-applied scene still
 * renders and still looks plausible — which is exactly how a confident picture
 * of the wrong thing gets baselined.
 */
import type {
  ExecuteOptions,
  ExecutionReport,
  Program,
  ScriptImage,
  Statement,
  ViewerControl,
} from './contracts.js';
import { ScriptRuntimeError, type ScriptProblem } from './errors.js';
import { suggestionSuffix } from './suggest.js';
import { VERBS, type VerbSpec } from './verbs.js';

/** The argument that named something, when the verb has one and it was given. */
function namedTarget(spec: VerbSpec, statement: Statement): string | undefined {
  if (!spec.resolvesName) return undefined;
  const index = spec.params.findIndex((p) => p.type === spec.resolvesName);
  if (index < 0) return undefined;
  const value = statement.args[index];
  return typeof value === 'string' ? value : undefined;
}

/**
 * What a `false` return means, said as usefully as the host's read side allows.
 *
 * The host returns `false` because it does not know the line number; this is
 * where that becomes a located error with a suggestion drawn from the scene
 * that is actually loaded.
 */
function refusalMessage(spec: VerbSpec, statement: Statement, host: ViewerControl): string {
  const target = namedTarget(spec, statement);
  if (target !== undefined && spec.resolvesName === 'object') {
    const objects = safeList(() => host.listObjects());
    return `${spec.name}: no object named ${JSON.stringify(target)}${suggestionSuffix(target, objects)}`;
  }
  if (target !== undefined && spec.resolvesName === 'viewpoint') {
    const viewpoints = safeList(() => host.listViewpoints());
    return `${spec.name}: no viewpoint named ${JSON.stringify(target)}${suggestionSuffix(target, viewpoints)}`;
  }
  const args = statement.text.trim().slice(spec.name.length).trim();
  return `${spec.name}: the viewer refused${args ? ` ${args}` : ''}`;
}

function safeList(read: () => readonly string[]): readonly string[] {
  try {
    return read();
  } catch {
    // A host whose read side throws still deserves a located error for the
    // write that failed; it just does not get a suggestion.
    return [];
  }
}

function isImage(value: unknown): value is ScriptImage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ScriptImage).dataUrl === 'string'
  );
}

export async function execute(
  program: Program,
  host: ViewerControl,
  opts: ExecuteOptions = {},
): Promise<ExecutionReport> {
  const images: ScriptImage[] = [];
  let ran = 0;
  let recording = false;

  /** Build the error for a failing statement, stopping anything the run started. */
  const abort = (statement: Statement, problem: ScriptProblem): ScriptRuntimeError => {
    // A recording that outlives the script that started it writes a video of
    // whatever the user does next and downloads it under the script's name.
    if (recording) {
      try {
        host.record?.(false);
      } catch {
        /* the run is already failing; do not mask its cause */
      }
      recording = false;
    }
    return new ScriptRuntimeError([problem], statement, ran);
  };

  for (const statement of program.statements) {
    // Non-null: `parse` rejects an unknown verb, so a statement can only name
    // one that is in the table.
    const spec = VERBS.get(statement.verb)!;
    opts.onStatement?.(statement);

    // An optional method the host did not implement is a capability it does not
    // have. Raising here, at the statement that needed it, is the whole point
    // of declaring capabilities that way: a silent no-op would let a script
    // "succeed" with no recording and no screenshot to show for it.
    if (typeof (host as unknown as Record<string, unknown>)[spec.method] !== 'function') {
      throw abort(statement, {
        kind: 'unsupported',
        line: statement.line,
        verb: spec.name,
        message: `${spec.name} is not supported by this viewer`,
        text: statement.text,
      });
    }

    let result: unknown;
    try {
      result = await spec.invoke(host, statement.args);
    } catch (err) {
      throw abort(statement, {
        kind: 'failed',
        line: statement.line,
        verb: spec.name,
        message: `${spec.name}: ${err instanceof Error ? err.message : String(err)}`,
        text: statement.text,
      });
    }

    if (result === false) {
      throw abort(statement, {
        kind: 'unknown-target',
        line: statement.line,
        verb: spec.name,
        message: refusalMessage(spec, statement, host),
        text: statement.text,
      });
    }

    if (isImage(result)) images.push(result);
    if (spec.name === 'record') recording = statement.args[0] === true;
    ran++;
  }

  return { ran, images };
}
