/**
 * The Ask prompt's session (#311): one conversation with a model driving this
 * viewer through `AgentTools`, and what the panel shows of it.
 *
 * Scoped to the scene. A catalog load stops a running request (its tools
 * refuse a scene they were not planned for) and the next request starts a new
 * conversation, so nothing said about one catalog's objects is applied to the
 * next. Bounded: a conversation holds `MAX_TURNS` requests, then the next one
 * starts a new conversation. Earlier requests are replayed condensed — the
 * person's words, the answer and what the viewer did (`compactHistory`) — so a
 * long conversation does not resend every tool result on every round. What the
 * person sees is not reset by either: earlier requests stay in the panel, and
 * the first request of a new conversation says why the model starts without
 * them.
 *
 * Where the model is reached: a transport an embedding host supplies, or the
 * deployment's (`askDeployment`). With neither, `askAvailable()` is false and
 * the viewer offers no prompt at all.
 */
import {
  createCapabilityTools, runAgent, type AgentMessage, type AgentOutcome, type AgentTask, type AgentToolResult, type AgentTools, type AgentTransport, type CapabilityToolsOptions,
} from '@cosmolabe/control';
import { builtInAgentMetadata } from './public-metadata';
import { askDeployment, resolveDevAskToolMode, type AskDeployment } from '../deployment';
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
  /** That narration, kept for the Details view and out of the answer. */
  notes: string[];
  status: AskStatus;
  error: string | null;
  /** The transport's reason for an `error`, when it gave one (`budget_exhausted`, `rate_limited`, …). */
  errorCode: string | null;
  /** Model round trips and tokens processed, once the request ends (tokens null when the proxy does not report them). */
  stats: { rounds: number; rawTokens: number | null } | null;
}

/** What the viewer did for a request, counted from the steps' own results. */
export function tally(turn: Pick<AskTurn, 'steps'>) {
  const unrun = (s: AskStep) => !s.result;
  const stopped = (s: AskStep) => !!s.result && !s.result.ok && (s.result.code === 'superseded' || s.result.code === 'cancelled');
  const inspection = (s: AskStep) => ['listCapabilities', 'describeCapabilities', 'getOperationResult'].includes(s.name);
  const inspected = turn.steps.filter(s => inspection(s) && s.result?.ok).length;
  const partial = turn.steps.filter(s => s.result?.ok && s.result.receipt?.status === 'partial').length;
  const done = turn.steps.filter((s) => !inspection(s) && s.result?.ok && s.result.receipt?.status !== 'partial').length;
  const refused = turn.steps.filter((s) => s.result && !s.result.ok && !stopped(s)).length;
  const running = turn.steps.filter(unrun).length;
  return { total: turn.steps.length, done, partial, inspected, refused, running, notRun: turn.steps.filter(stopped).length };
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
export function endNote(turn: AskTurn, label: (step: AskStep) => string = (s) => s.name): { text: string; tone: 'warning' | 'error' } | null {
  if (turn.status === 'running' || turn.status === 'done') return null;
  // What the view now holds from this request, in the words the action list uses.
  const applied = turn.steps.filter(s => s.result?.ok && !READ_ONLY.test(actionName(s))).map(label);
  const failed = tally(turn).refused;
  const account = applied.length ? ` Already applied: ${applied.join('; ')}.${failed ? ` ${plural(failed, 'step')} refused.` : ''}` : failed ? ` Nothing changed; ${plural(failed, 'step')} refused.` : '';
  if (turn.status === 'error') {
    if (turn.errorCode === 'budget_exhausted') {
      return { tone: 'warning', text: `Stopped: the model proxy's raw-token safety cap (cached tokens included) is used up, so this request has no answer.${account} Press Clear to start a new conversation once the proxy accepts requests again.` };
    }
    if (turn.errorCode === 'cost_budget_exhausted') {
      return { tone: 'warning', text: `Stopped: the model proxy's estimated-cost guard was reached or pricing is unavailable (an estimate, not a bill).${account} Press Clear to start a new conversation once the proxy accepts requests again.` };
    }
    if (turn.errorCode === 'rate_limited') {
      return { tone: 'warning', text: `Stopped: the model proxy's rate limit was reached; requests resume in a minute.${account}` };
    }
    return { tone: 'error', text: `${turn.error ?? 'The request failed.'}${account}` };
  }
  const ending = ENDINGS[turn.status];
  return ending ? { tone: 'warning', text: `${ending}${account}` } : null;
}

const READ_ONLY = /^(describe|get|list|resolve|search|check|find|inspect)/;
const actionName = (s: AskStep) => s.name === 'invokeCapability' && typeof (s.input as { id?: unknown })?.id === 'string'
  ? ((s.input as { id: string }).id.split('.').at(-1) ?? s.name) : s.name;

/** Requests the panel keeps showing; older ones scroll away for good. */
const MAX_SHOWN = 50;

export const ask = $state({
  turns: [] as AskTurn[],
  running: false,
  serviceBlocked: null as string | null,
  toolMode: standaloneToolMode(),
});
resettable(ask);

// ── Where the model is ──

let serviceTimer: ReturnType<typeof setTimeout> | null = null;
function resetServiceBlock() {
  if (serviceTimer !== null) clearTimeout(serviceTimer);
  serviceTimer = null;
  ask.serviceBlocked = null;
}

let hostTransport: AgentTransport | null = null;
let hostCapabilities: CapabilityToolsOptions = {};
let deployment: AskDeployment | null = null;
let embedded = false;

/** Embedding: the host's own transport, or null for no prompt. Replaces the deployment's. */
export function setHostAskTransport(transport: AgentTransport | null, capabilities: CapabilityToolsOptions = {}, mode: 'fixed' | 'discovery' = 'fixed') {
  stopAsk();
  resetServiceBlock();
  tools?.dispose();
  tools = null;
  changeToolMode(mode);
  startOver();
  embedded = true;
  hostTransport = transport;
  hostCapabilities = capabilities;
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
const agentTools = () => (tools ??= createCapabilityTools(getCosmo(), {
  ...(embedded ? hostCapabilities : {
    allowAuthoring: true, allowExternal: true,
    confirmAuthoring: (operation: string, input: unknown) => requestApproval('authoring', operation, input),
    confirmExternal: (operation: string, input: unknown) => requestApproval('external', operation, input),
  }),
  surface: ask.toolMode, formatTime: etToUtcString, metadata: builtInAgentMetadata,
}));

/** Exact-call approval owned by the visible Ask UI, never by model/catalog text. */
export const askApproval = $state({ pending: null as null | { kind: 'authoring' | 'external'; operation: string; input: string } });
let approvalResolve: ((approved: boolean) => void) | null = null;
function requestApproval(kind: 'authoring' | 'external', operation: string, input: unknown): Promise<boolean> {
  answerAskApproval(false);
  askApproval.pending = { kind, operation, input: JSON.stringify(input, null, 2) };
  return new Promise(resolve => { approvalResolve = resolve; });
}
export function answerAskApproval(approved: boolean) {
  const resolve = approvalResolve;
  approvalResolve = null;
  askApproval.pending = null;
  resolve?.(approved);
}

let history: AgentMessage[] = [];
let historyScene = -1;
/** Requests in the conversation the model currently remembers. */
let conversationTurns = 0;
let task: AgentTask | null = null;
let running: Promise<unknown> | null = null;
let turnSeq = 0;
/** Bumped whenever the conversation is replaced, so a run that ends late cannot write into the new one. */
let conversation = 0;

function standaloneToolMode(): 'fixed' | 'discovery' {
  return resolveDevAskToolMode(import.meta.env.DEV, typeof location === 'undefined' ? '' : location.search);
}

function changeToolMode(mode: 'fixed' | 'discovery') {
  if (ask.toolMode === mode) return;
  stopAsk();
  tools?.dispose();
  tools = null;
  ask.toolMode = mode;
  startOver();
}

// Back/forward URL changes reset provider history before another request can run.
// submitAsk also synchronizes pushState/replaceState changes, which emit no event.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  const syncMode = () => { if (!embedded) changeToolMode(standaloneToolMode()); };
  window.addEventListener('popstate', syncMode);
  import.meta.hot?.dispose(() => window.removeEventListener('popstate', syncMode));
}

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
  if (ask.serviceBlocked) return;
  const text = prompt.trim();
  const t = currentTransport();
  if (!text || !t) return;

  if (!embedded) changeToolMode(standaloneToolMode());
  answerAskApproval(false);
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
  const turn: AskTurn = { id: ++turnSeq, prompt: text, fresh, steps: [], reply: '', notes: [], status: 'running', error: null, errorCode: null, stats: null };
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
      // The reply is the model's last message. Text beside tool calls is its
      // planning, not an answer: it is kept apart, for the Details view.
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
  const { messages, outcome, stats } = await run;
  mine.finish();
  if (conversation === mineConversation && historyScene === sceneId()) history = [...messages];
  const view = live();
  if (view) {
    view.status = outcome.kind;
    view.stats = { rounds: stats.rounds, rawTokens: stats.rawTokens };
    view.error = outcome.kind === 'error' ? outcome.message : null;
    view.errorCode = outcome.kind === 'error' ? outcome.code ?? null : null;
    if (outcome.kind === 'error' && ['budget_exhausted', 'cost_budget_exhausted', 'rate_limited'].includes(outcome.code ?? '')) {
      // The turn's own note explains it; this only gates the input box.
      ask.serviceBlocked = outcome.code === 'rate_limited' ? 'Requests resume in a minute.' : 'Press Clear to continue once the proxy allows requests again.';
      if (outcome.code === 'rate_limited') serviceTimer = setTimeout(resetServiceBlock, 60000);
    }
  }
  if (task === mine) {
    task = null;
    ask.running = false;
  }
}

/** Stop the running request: a flight it started stops where it is; nothing else is undone. */
export function stopAsk() {
  answerAskApproval(false);
  task?.cancel();
}

/** Forget the conversation. */
export function clearAsk() {
  stopAsk();
  resetServiceBlock();
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
  resetServiceBlock();
  tools?.dispose();
  tools = null;
  transport = null;
  hostTransport = null;
  hostCapabilities = {};
  ask.toolMode = standaloneToolMode();
  deployment = null;
  embedded = false;
  conversation++;
  history = [];
  historyScene = -1;
  task = null;
  running = null;
}
