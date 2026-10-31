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
  reply: string;
  status: AskStatus;
  error: string | null;
  /** The transport's reason for an `error`, when it gave one (`budget_exhausted`, `rate_limited`, …). */
  errorCode: string | null;
}

/** What the viewer did for a request, counted from the steps' own results. */
export function tally(turn: Pick<AskTurn, 'steps'>) {
  const unrun = (s: AskStep) => !s.result;
  const stopped = (s: AskStep) => !!s.result && !s.result.ok && (s.result.code === 'superseded' || s.result.code === 'cancelled');
  const done = turn.steps.filter((s) => s.result?.ok).length;
  const refused = turn.steps.filter((s) => s.result && !s.result.ok && !stopped(s)).length;
  const running = turn.steps.filter(unrun).length;
  return { total: turn.steps.length, done, refused, running, notRun: turn.steps.filter(stopped).length };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const ENDINGS: Partial<Record<AskStatus, string>> = {
  cancelled: 'Stopped.',
  superseded: 'Replaced by a newer request.',
  stale: 'The scene changed, so this request stopped.',
  'step-limit': 'Stopped after too many steps.',
  'max-tokens': 'The reply was cut off.',
  refusal: 'The model declined this request.',
};

/**
 * What to tell the person when a request did not finish as a reply: the
 * reason, and what already happened to the view, from the steps' results (a
 * refused step is not counted as done). Null for a request that is running or
 * ended with its answer. Never suggests a retry: a view change is not undone by
 * stopping, and retrying a request that ran out of budget only fails again.
 */
export function endNote(turn: AskTurn): { text: string; tone: 'warning' | 'error' } | null {
  if (turn.status === 'running' || turn.status === 'done') return null;
  const t = tally(turn);
  const ran = t.done + t.refused;
  const account = ran === 0 ? '' : ` ${plural(ran, 'action')} ran${t.refused ? ` (${t.done} done, ${t.refused} refused)` : ''}; changes already made to the view remain.`;
  if (turn.status === 'error') {
    if (turn.errorCode === 'budget_exhausted') {
      return { tone: 'warning', text: `Request stopped: this proxy's local model budget is exhausted, so no answer was written.${account} Restart the proxy or raise TOKEN_BUDGET to continue.` };
    }
    if (turn.errorCode === 'rate_limited') {
      return { tone: 'warning', text: `Request stopped: the proxy's rate limit was reached; wait a minute.${account}` };
    }
    return { tone: 'error', text: `${turn.error ?? 'The request failed.'}${account}` };
  }
  const ending = ENDINGS[turn.status];
  return ending ? { tone: 'warning', text: `${ending}${account}` } : null;
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
  const turn: AskTurn = { id: ++turnSeq, prompt: text, fresh, steps: [], reply: '', status: 'running', error: null, errorCode: null };
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
      // The reply is the text of the model's last round only. Words before a
      // tool call are planning, not an answer, and go as the call is made.
      if (e.type === 'thinking') view.reply = '';
      else if (e.type === 'text') view.reply = view.reply ? `${view.reply}\n${e.text}` : e.text;
      else if (e.type === 'tool') {
        view.reply = '';
        view.steps.push({ id: e.id, name: e.name, input: e.input, result: null });
      }
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
    // A request that stopped before its answer has no reply to show: what is
    // left is a planning remark from a round that never ran its tools.
    if (outcome.kind !== 'done' && outcome.kind !== 'max-tokens' && outcome.kind !== 'refusal') view.reply = '';
  }
  if (task === mine) {
    task = null;
    ask.running = false;
  }
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
