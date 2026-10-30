/**
 * The Ask prompt's session (#311): one conversation with a model driving this
 * viewer through `AgentTools`, and what the panel shows of it.
 *
 * Scoped to the scene. A catalog load stops a running request (its tools
 * refuse a scene they were not planned for) and starts the conversation over,
 * so nothing said about one catalog's objects is applied to the next. Bounded:
 * a conversation holds `MAX_TURNS` requests, then starts over — history is
 * never trimmed in place, because a provider validates a replayed
 * conversation against what it sent.
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
import { createAnthropicTransport } from './anthropic-transport';

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
  steps: AskStep[];
  reply: string;
  status: AskStatus;
  error: string | null;
}

export const ask = $state({
  turns: [] as AskTurn[],
  running: false,
  /** A line about the conversation itself: it started over, and why. */
  notice: null as string | null,
  /** BYOK only: whether a key is held (the key itself is not state). */
  hasKey: false,
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

/** Development mode: the person must paste a key first. */
export function askNeedsKey(): boolean {
  return !hostTransport && config().mode === 'byok';
}

/** In memory for this session only: never stored, never in a URL. */
let byokKey = '';

export function setAskKey(key: string) {
  byokKey = key.trim();
  ask.hasKey = byokKey !== '';
  transport = null;
}

let transport: AgentTransport | null = null;

function currentTransport(): AgentTransport | null {
  if (hostTransport) return hostTransport;
  const c = config();
  if (c.mode === 'off') return null;
  if (c.mode === 'byok' && !byokKey) return null;
  transport ??= c.mode === 'proxy'
    ? createAnthropicTransport({ model: c.model, baseURL: c.endpoint })
    : createAnthropicTransport({ model: c.model, apiKey: byokKey });
  return transport;
}

// ── The conversation ──

let tools: AgentTools | null = null;
const agentTools = () => (tools ??= createAgentTools(getCosmo(), { formatTime: etToUtcString }));

let history: AgentMessage[] = [];
let historyScene = -1;
let task: AgentTask | null = null;
let running: Promise<unknown> | null = null;
let turnSeq = 0;
/** Bumped whenever the conversation is replaced, so a run that ends late cannot write into the new one. */
let conversation = 0;

function startOver(notice: string | null) {
  conversation++;
  history = [];
  historyScene = sceneId();
  ask.turns = [];
  ask.notice = notice;
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

  if (historyScene !== sceneId()) startOver(history.length ? 'A new scene loaded, so the conversation started over.' : null);
  else if (ask.turns.length >= MAX_TURNS) startOver(`The conversation reached ${MAX_TURNS} requests and started over.`);

  const mineConversation = conversation;
  const turn: AskTurn = { id: ++turnSeq, prompt: text, steps: [], reply: '', status: 'running', error: null };
  ask.turns.push(turn);
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
      if (e.type === 'text') view.reply = view.reply ? `${view.reply}\n${e.text}` : e.text;
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
  startOver(null);
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
  byokKey = '';
  conversation++;
  history = [];
  historyScene = -1;
  task = null;
  running = null;
}
