/**
 * The Ask prompt's session (#311): one conversation with a model driving this
 * viewer through `AgentTools`, and what the panel shows of it.
 *
 * Scoped to the scene. A catalog load stops a running request (its tools
 * refuse a scene they were not planned for) and the next request starts a new
 * conversation, so nothing said about one catalog's objects is applied to the
 * next. Bounded: a conversation holds `MAX_TURNS` requests, then the next one
 * starts a new conversation — history is never trimmed in place, because a
 * provider validates a replayed conversation against what it sent. What the
 * person sees is not reset by either: earlier requests stay in the panel, and
 * the first request of a new conversation says why the model starts without
 * them.
 *
 * Where the model is reached: a transport an embedding host supplies, or the
 * deployment's (`askDeployment`). With neither, `askAvailable()` is false and
 * the viewer offers no prompt at all.
 */
import {
  createAgentTools, runAgent, type AgentMessage, type AgentOutcome, type AgentTask, type AgentToolResult, type AgentTools, type AgentTransport,
} from '@cosmolabe/control';
import { askDeployment, type AskDeployment } from '../deployment';
import { getCosmo } from '../loader';
import { etToUtcString, onViewerEvent, sceneId } from '../viewer-state.svelte';
import { resettable } from '../session.svelte';
import { onToolClose } from '../shell.svelte';
import { createHttpTransport } from './http-transport';

/** Requests per conversation before it starts over. */
export const MAX_TURNS = 12;

export interface AskStep {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  result: AgentToolResult | null;
}

export type AskStatus = 'running' | AgentOutcome['kind'];

export interface AskTurn {
  readonly id: number;
  readonly prompt: string;
  /** Set on the first request of a conversation the model started over: why it does not remember the ones above. */
  readonly fresh: string | null;
  steps: AskStep[];
  /** The model's answer: the text of its last message, not its narration while it worked. */
  reply: string;
  /** That narration, kept for the details view and out of the answer. */
  notes: string[];
  status: AskStatus;
  error: string | null;
  /** The transport's code for a failed request (`budget-exhausted`, `rate-limited`, …), when it had one. */
  errorCode: string | null;
}

/** Requests the panel keeps showing; older ones scroll away for good. */
const MAX_SHOWN = 50;

export const ask = $state({
  turns: [] as AskTurn[],
  running: false,
});
resettable(ask);

// ── Where the model is ──

let hostTransport: AgentTransport | null = null;
let deployment: AskDeployment | null = null;
let embedded = false;

/** Embedding: the host's own transport, or null for no prompt. Replaces the deployment's. */
export function setHostAskTransport(transport: AgentTransport | null) {
  embedded = true;
  hostTransport = transport;
}

function config(): AskDeployment {
  if (embedded) return { mode: 'off' };
  deployment ??= askDeployment();
  return deployment;
}

/** Whether the viewer offers the prompt at all. */
export function askAvailable(): boolean {
  return hostTransport !== null || config().mode !== 'off';
}

let transport: AgentTransport | null = null;

function currentTransport(): AgentTransport | null {
  if (hostTransport) return hostTransport;
  const c = config();
  if (c.mode === 'off') return null;
  transport ??= createHttpTransport(c.endpoint);
  return transport;
}

// ── The conversation ──

let tools: AgentTools | null = null;
const agentTools = () => (tools ??= createAgentTools(getCosmo(), { formatTime: etToUtcString }));

let history: AgentMessage[] = [];
let historyScene = -1;
/** Requests in the conversation the model currently remembers. */
let conversationTurns = 0;
let task: AgentTask | null = null;
let running: Promise<unknown> | null = null;
let turnSeq = 0;
/** Bumped whenever the conversation is replaced, so a run that ends late cannot write into the new one. */
let conversation = 0;

/** The model forgets what was said; what the panel shows stays. */
function startOver() {
  conversation++;
  history = [];
  historyScene = sceneId();
  conversationTurns = 0;
}

/**
 * Send a request. A request still running is superseded: its later tool calls
 * refuse, and its reply, if one comes, is dropped.
 */
export async function submitAsk(prompt: string): Promise<void> {
  const text = prompt.trim();
  const t = currentTransport();
  if (!text || !t) return;

  const toolkit = agentTools();
  const mine = toolkit.begin(); // supersedes the running task, if any
  task = mine;
  await running; // its messages are complete once it settles
  if (task !== mine) return; // superseded again while waiting

  let fresh: string | null = null;
  if (historyScene !== sceneId()) {
    if (ask.turns.length > 0) fresh = 'A new scene loaded, so the model starts without the requests above.';
    startOver();
  } else if (conversationTurns >= MAX_TURNS) {
    fresh = `The model remembers ${MAX_TURNS} requests at a time, so it starts without the ones above.`;
    startOver();
  }

  const mineConversation = conversation;
  conversationTurns++;
  const turn: AskTurn = { id: ++turnSeq, prompt: text, fresh, steps: [], reply: '', notes: [], status: 'running', error: null, errorCode: null };
  ask.turns.push(turn);
  if (ask.turns.length > MAX_SHOWN) ask.turns.splice(0, ask.turns.length - MAX_SHOWN);
  const live = () => ask.turns.find((x) => x.id === turn.id);
  ask.running = true;

  const run = runAgent({
    transport: t,
    tools: toolkit,
    task: mine,
    history,
    prompt: text,
    onEvent: (e) => {
      const view = live();
      if (!view) return;
      if (e.type === 'text') {
        if (e.final) view.reply = view.reply ? `${view.reply}\n${e.text}` : e.text;
        else view.notes.push(e.text);
      }
      else if (e.type === 'tool') view.steps.push({ id: e.id, name: e.name, input: e.input, result: null });
      else if (e.type === 'tool-result') {
        const step = view.steps.find((s) => s.id === e.id);
        if (step) step.result = e.result;
      }
    },
  });
  running = run;
  const { messages, outcome } = await run;
  mine.finish();
  if (conversation === mineConversation && historyScene === sceneId()) history = [...messages];
  const view = live();
  if (view) {
    view.status = outcome.kind;
    view.error = outcome.kind === 'error' ? outcome.message : null;
    view.errorCode = outcome.kind === 'error' ? outcome.code ?? null : null;
  }
  if (task === mine) {
    task = null;
    ask.running = false;
  }
}

/** What a request's actions came to, from their actual results: not what the model said or how many it asked for. */
export function actionCounts(turn: Pick<AskTurn, 'steps'>): { total: number; done: number; refused: number; notRun: number } {
  let done = 0, refused = 0, notRun = 0;
  for (const { result } of turn.steps) {
    if (!result || (!result.ok && (result.code === 'superseded' || result.code === 'cancelled'))) notRun++;
    else if (result.ok) done++;
    else refused++;
  }
  return { total: turn.steps.length, done, refused, notRun };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 actions succeeded, 1 refused" — what the viewer did, in one line; empty when it did nothing. */
export function actionsSummary(turn: Pick<AskTurn, 'steps'>): string {
  const { total, done, refused, notRun } = actionCounts(turn);
  if (total === 0) return '';
  const parts = [`${plural(done, 'action')} succeeded`];
  if (refused) parts.push(`${refused} refused`);
  if (notRun) parts.push(`${notRun} not run`);
  return parts.join(', ');
}

/**
 * The line under a request that did not end in an answer: why it stopped, what
 * its actions came to, and that the view changes already made remain. Null for
 * a request that finished, and while it runs. A budget the proxy has spent is
 * not a reason to try again, so none is suggested.
 */
export function endingNote(turn: Pick<AskTurn, 'status' | 'steps' | 'error' | 'errorCode'>): string | null {
  if (turn.status === 'running' || turn.status === 'done') return null;
  const why = turn.status === 'error'
    ? turn.errorCode === 'budget-exhausted' ? 'Request stopped: the local model budget is spent.'
      : turn.errorCode === 'rate-limited' || turn.errorCode === 'upstream-rate-limited' ? 'Request stopped: too many requests too quickly. Wait a moment before asking again.'
        : `Request stopped: ${turn.error ?? 'the model could not be reached'}.`
    : ({
      cancelled: 'Stopped.',
      superseded: 'Replaced by a newer request.',
      stale: 'The scene changed, so this request stopped.',
      'step-limit': 'Stopped after too many steps.',
      'max-tokens': 'The reply was cut off.',
      refusal: 'The model declined this request.',
    } as Record<string, string>)[turn.status] ?? 'Stopped.';
  const summary = actionsSummary(turn);
  const answer = turn.status === 'error' || turn.status === 'step-limit' || turn.status === 'max-tokens' ? " The final answer wasn't generated." : '';
  if (!summary) return `${why} No actions had run.${answer}`;
  return `${why} ${summary}.${answer} Changes already made to the view remain.`;
}

/** Stop the running request: a flight it started stops where it is; nothing else is undone. */
export function stopAsk() {
  task?.cancel();
}

/** Forget the conversation. */
export function clearAsk() {
  stopAsk();
  startOver();
  ask.turns = [];
}

// A scene replaced under a running request ends it: its tools already refuse
// the new scene, and the model should not be asked to plan against it.
onViewerEvent('load', () => stopAsk());
// Closing the panel is the destructive act; minimizing it is not.
onToolClose('ask', () => stopAsk());

/** Embedding: release everything when the workspace is disposed. */
export function disposeAsk() {
  stopAsk();
  tools?.dispose();
  tools = null;
  transport = null;
  hostTransport = null;
  embedded = false;
  conversation++;
  history = [];
  historyScene = -1;
  task = null;
  running = null;
}
