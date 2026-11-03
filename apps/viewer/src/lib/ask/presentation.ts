/** Human-readable presentation of the existing registry and exact-call approval.
 * These summaries never grant permission or change the approved arguments. */
import { VERB_LIST } from '@cosmolabe/control';
import type { AskStep, AskTurn } from './ask.svelte';

const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const words = (v: unknown) => typeof v === 'string' ? v : '';
export function actionMetadata(step: Pick<AskStep, 'name' | 'input'>): { label: string; diagnostic: boolean } {
  const input = record(step.input), name = step.name === 'invokeCapability' ? words(input.id).split('.').at(-1)! : step.name;
  const spec = VERB_LIST.find(v => v.name === name);
  return { label: spec?.help.split(/[;:]|\.\s/)[0].replace(/\.$/, '') ?? name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()),
    diagnostic: ['listCapabilities','describeCapabilities','getOperationResult'].includes(name) };
}
export function actionStatus(turn: Pick<AskTurn, 'status' | 'steps'>): string {
  const actions = turn.steps.filter(s => !actionMetadata(s).diagnostic);
  if (turn.status === 'running') return 'Working';
  if (!actions.length) return 'Request completed';
  const succeeded = actions.filter(s => s.result?.ok).length;
  // Partial readback and corrected schema errors remain in Details. A request
  // with no successful step must not look completed, even if a reply exists.
  return succeeded ? `${succeeded} viewer ${succeeded === 1 ? 'step' : 'steps'} completed · Details` : 'No viewer changes confirmed · Details';
}
export function approvalPresentation(pending: { kind: string; operation: string; input: string }, formatTime: (et: number) => string) {
  let input: Record<string, unknown> = {};
  try { input = record(JSON.parse(pending.input)); } catch { /* Exact input stays available. */ }
  const name = pending.operation.split('.').at(-1)!;
  const title = actionMetadata({ name, input }).label;
  // The shared verb stores a JSON definition as a text parameter. Decode it
  // once for display; approval remains bound to the original exact call.
  if (name === 'upsertEventQuery') {
    try {
      const definition = record(typeof input.definition === 'string' ? JSON.parse(input.definition) : input.definition);
      const query = record(definition.query), bodies = record(query.bodies), window = record(query.window);
      const dates = typeof window.start === 'number' && typeof window.end === 'number' ? `${formatTime(window.start)} → ${formatTime(window.end)}` : 'Dates unavailable';
      return { title: `Set up ${words(query.kind).replaceAll('-', ' ')} search`,
        description: `${words(bodies.observer)} → ${words(bodies.target)} · ${dates}. This adds or updates a search in the current scene. Coverage is checked before running.`,
        exact: JSON.stringify({ ...input, definition }, null, 2) };
    } catch { /* Malformed arguments are shown exactly, never guessed. */ }
  }
  return { title, description: pending.kind === 'authoring' ? 'This changes saved definitions in the current scene.' : 'This exports or records viewer output.', exact: pending.input };
}
