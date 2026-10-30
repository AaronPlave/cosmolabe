/**
 * Agent tools — the `ViewerControl` port as typed tools a language model can
 * call (#311): `{ name, description, inputSchema }`, the shape MCP and the
 * model providers' tool-use APIs share.
 *
 * Not a second command system. Every write tool is a verb from `VERB_LIST`,
 * run through `execute`, so it gets the same capability check, the same
 * located refusals ("no object named …, did you mean …?") and the same
 * cancellation as a script line. What this module adds is what a model needs
 * that a script author does not:
 *
 * - **Strict input validation.** Model output is untrusted. Input is checked
 *   against the schema it was offered — no unknown keys, no missing ones, no
 *   coercion — before anything reaches the viewer.
 * - **Reads that bound themselves.** `describeScene`, `resolve`, `searchPlaces`,
 *   `listActivities` and `getImagery` answer with what the scene actually has,
 *   capped in size, so a model resolves names instead of guessing them.
 * - **Observed completion.** A flight tool returns when the flight ends, and
 *   says how it ended, rather than when it starts.
 * - **One scene, many drivers.** A newer task supersedes an older one. A task
 *   started against one scene refuses to act on the next. A person who takes
 *   the camera mid-flight keeps it: the task's later camera tools refuse rather
 *   than reassert the view.
 *
 * Optional `ViewerControl` methods remain the capability declaration: a tool
 * whose method the host lacks is not listed.
 */
import type {
  ScriptCancelSignal,
  ScriptEventMap,
  ScriptPlace,
  ScriptTime,
  ScriptVec3,
  Statement,
  VerbValue,
  ViewerControl,
} from './contracts.js';
import { ScriptRuntimeError } from './errors.js';
import { execute } from './execute.js';
import { quote } from './snapshot.js';
import { suggest } from './suggest.js';
import { VERBS, type VerbParam, type VerbSpec } from './verbs.js';

type FlightEnd = ScriptEventMap['flightEnd'];

/** The JSON Schema subset the tools are described in. */
export interface AgentJsonSchema {
  readonly type?: 'object' | 'string' | 'number' | 'boolean' | 'array' | readonly ('string' | 'number')[];
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly properties?: Readonly<Record<string, AgentJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: false;
  readonly items?: AgentJsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

/** What a tool can change; `read` tools change nothing. */
export type AgentToolEffect = 'read' | 'camera' | 'time' | 'selection' | 'display';

export interface AgentToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: AgentJsonSchema & { readonly type: 'object' };
  readonly effect: AgentToolEffect;
}

/**
 * Why a call did not do what it asked.
 *
 * - `invalid-input`: the input did not match the schema; nothing ran.
 * - `unknown-tool`: no such tool on this viewer.
 * - `refused`: the viewer refused — usually no such name; the message says
 *   which names exist.
 * - `failed`: the viewer tried and could not (an unreachable place, say).
 * - `no-scene`: nothing is loaded.
 * - `stale`: the scene changed since the task began.
 * - `superseded`: a newer request replaced this task.
 * - `cancelled`: the task was stopped.
 * - `interrupted`: the person took over the camera during this task.
 */
export type AgentErrorCode =
  | 'invalid-input' | 'unknown-tool' | 'refused' | 'failed' | 'no-scene'
  | 'stale' | 'superseded' | 'cancelled' | 'interrupted';

export type AgentToolResult =
  | { readonly ok: true; readonly summary: string; readonly data?: unknown }
  | { readonly ok: false; readonly code: AgentErrorCode; readonly error: string };

/** A sequence of calls made for one request; see `AgentTools.begin`. */
export interface AgentTask {
  readonly id: number;
  /** Fires when the task is cancelled, superseded or its scene goes. */
  readonly signal: ScriptCancelSignal;
  /** Why the task can no longer act, or null while it can. */
  readonly ended: AgentErrorCode | null;
  call(name: string, input: unknown): Promise<AgentToolResult>;
  /** Stop the task: a flight it is waiting on is stopped, later calls refused. */
  cancel(): void;
  /** Release the task without stopping anything it started. */
  finish(): void;
}

export interface AgentTools {
  /** The tools this viewer can run, in a stable order. */
  list(): readonly AgentToolDef[];
  /**
   * Start a task, superseding the one running: its pending flight wait ends
   * and its later calls refuse with `superseded`. The flight itself continues
   * unless the new task moves the camera, as a person's newer command would.
   */
  begin(): AgentTask;
  /** One call as a task of its own (superseding the one running). */
  call(name: string, input: unknown): Promise<AgentToolResult>;
  /** Cancel the running task, if any. */
  cancel(): void;
  /** Unsubscribe from the viewer and end the running task. */
  dispose(): void;
}

export interface AgentToolsOptions {
  /** Renders scene time for `describeScene` (a UTC calendar string, say). */
  formatTime?(et: number): string;
}

// ── The curated verb set ──
//
// Read-only and reversible view operations. Left out on purpose: captures and
// recording (they produce files), `wait`/`runTo` (sequencing a model does not
// need), `setCamera` (raw poses a model has no basis for), the grid's fine
// settings, and `displayNote` (prose belongs in the reply, not on the scene).
const AGENT_VERBS: readonly { verb: string; effect: AgentToolEffect }[] = [
  { verb: 'select', effect: 'selection' },
  { verb: 'deselect', effect: 'selection' },
  { verb: 'flyTo', effect: 'camera' },
  { verb: 'jumpTo', effect: 'camera' },
  { verb: 'frameObject', effect: 'camera' },
  { verb: 'track', effect: 'camera' },
  { verb: 'untrack', effect: 'camera' },
  { verb: 'pointAtObject', effect: 'camera' },
  { verb: 'clearLookAt', effect: 'camera' },
  { verb: 'gotoPlace', effect: 'camera' },
  { verb: 'gotoCoordinates', effect: 'camera' },
  { verb: 'viewpoint', effect: 'camera' },
  { verb: 'setFrame', effect: 'camera' },
  { verb: 'circleCenter', effect: 'camera' },
  { verb: 'dolly', effect: 'camera' },
  { verb: 'stopFlight', effect: 'camera' },
  { verb: 'setTime', effect: 'time' },
  { verb: 'setTimeRate', effect: 'time' },
  { verb: 'setPlaying', effect: 'time' },
  { verb: 'selectActivity', effect: 'selection' },
  { verb: 'seekActivity', effect: 'time' },
  { verb: 'navigateActivity', effect: 'selection' },
  { verb: 'setObjectVisible', effect: 'display' },
  { verb: 'showTrajectory', effect: 'display' },
  { verb: 'showLabel', effect: 'display' },
  { verb: 'setLayer', effect: 'display' },
  { verb: 'showImagery', effect: 'display' },
  { verb: 'setImageryOpacity', effect: 'display' },
  { verb: 'showBodyGrid', effect: 'display' },
];

/** What each parameter type means to a caller that did not write the scene. */
const PARAM_HELP: Partial<Record<VerbParam['type'], string>> = {
  object: 'An object name exactly as describeScene or resolve reports it.',
  viewpoint: 'A viewpoint name exactly as describeScene reports it.',
  place: 'A place ref from searchPlaces or resolve — not the display name.',
  imagery: "A layer id from getImagery for the object named in this call.",
  activity: 'An activity id from listActivities, resolve or describeScene.',
  time: 'A UTC calendar string (e.g. "2021-04-30T19:00:00"), or seconds past J2000 as a number.',
  vector: 'Three numbers.',
};

function paramSchema(p: VerbParam): AgentJsonSchema {
  const description = PARAM_HELP[p.type];
  switch (p.type) {
    case 'number': return { type: 'number' };
    case 'boolean': return { type: 'boolean' };
    case 'enum': return { type: 'string', enum: p.values ?? [] };
    case 'time': return { type: ['string', 'number'], description };
    case 'vector': return { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description };
    default: return description ? { type: 'string', description } : { type: 'string' };
  }
}

function verbTool(spec: VerbSpec, effect: AgentToolEffect): AgentToolDef {
  const properties: Record<string, AgentJsonSchema> = {};
  for (const p of spec.params) properties[p.name] = paramSchema(p);
  const description = spec.name === 'flyTo' || spec.name === 'gotoPlace'
    ? `${spec.help} Returns when the flight ends, saying whether it arrived or the person took over.`
    : spec.help;
  return {
    name: spec.name,
    description,
    effect,
    inputSchema: {
      type: 'object',
      properties,
      required: spec.params.filter((p) => !p.optional).map((p) => p.name),
      additionalProperties: false,
    },
  };
}

const READ_TOOLS: readonly (AgentToolDef & { method?: keyof ViewerControl })[] = [
  {
    name: 'describeScene',
    effect: 'read',
    description:
      'The viewer now: catalog and scene id, time and playback, selection, tracked object, flight, selected activity and place, '
      + 'object and viewpoint names (bounded), the imagery of the body in focus, and which capabilities this viewer lacks. Call it first.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'resolve',
    effect: 'read',
    description:
      'Match a name or phrase against the scene\'s objects, viewpoints, places and mission activities. Returns candidates with the stable id '
      + 'each other tool takes. More than one candidate means ambiguous: ask, or pick from context and say which.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the person called it.' },
        kinds: { type: 'array', items: { type: 'string', enum: ['object', 'viewpoint', 'place', 'activity'] }, description: 'Limit to these kinds.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'searchPlaces',
    effect: 'read',
    method: 'searchPlaces',
    description: 'Named places (surface features, mission sites) from the scene\'s geographic layers, with their source and whether they can be navigated to.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        body: { type: 'string', description: 'Only places on this object.' },
        limit: { type: 'number', minimum: 1, maximum: 25 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'listActivities',
    effect: 'read',
    method: 'listActivities',
    description: 'Mission activities (flights, drives, phases…) with their times, vehicle and provenance, in time order. Bounded.',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: { type: 'string' },
        kind: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'getImagery',
    effect: 'read',
    method: 'getImagery',
    description:
      'An object\'s streamed imagery layers: id, attribution (provenance), resolution, coverage, load status and whether it draws in the current view. '
      + 'A body without streamed imagery reports no layers; imageryOnly means there is no terrain elevation behind it.',
    inputSchema: {
      type: 'object',
      properties: { object: { type: 'string', description: PARAM_HELP.object } },
      required: ['object'],
      additionalProperties: false,
    },
  },
];

// ── Validation ──

type Input = Readonly<Record<string, unknown>>;

function typeOk(schema: AgentJsonSchema, value: unknown): boolean {
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.some((t) => {
    switch (t) {
      case 'string': return typeof value === 'string';
      case 'number': return typeof value === 'number' && Number.isFinite(value);
      case 'boolean': return typeof value === 'boolean';
      case 'array': return Array.isArray(value);
      case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
      default: return false;
    }
  });
}

/** The first way `value` violates `schema`, or null. */
function violation(schema: AgentJsonSchema, value: unknown, path: string): string | null {
  if (!typeOk(schema, value)) {
    const t = Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type;
    return `${path} must be a ${t}`;
  }
  if (schema.enum && !schema.enum.includes(value as string)) {
    return `${path} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} needs at least ${schema.minItems} items`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} takes at most ${schema.maxItems} items`;
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const v = violation(schema.items, value[i], `${path}[${i}]`);
        if (v) return v;
      }
    }
  }
  if (schema.properties) {
    const obj = value as Input;
    for (const key of Object.keys(obj)) {
      if (!(key in schema.properties)) return `${path}: unknown field ${JSON.stringify(key)} (fields: ${Object.keys(schema.properties).join(', ') || 'none'})`;
    }
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined) return `${path}: missing ${JSON.stringify(key)}`;
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (obj[key] === undefined) continue;
      const v = violation(sub, obj[key], key);
      if (v) return v;
    }
  }
  return null;
}

// ── Statements from input ──

function verbValue(p: VerbParam, raw: unknown): VerbValue {
  if (raw === undefined) return undefined;
  if (p.type === 'time') {
    return (typeof raw === 'number' ? { kind: 'et', et: raw } : { kind: 'calendar', text: raw as string }) satisfies ScriptTime;
  }
  if (p.type === 'vector') return raw as unknown as ScriptVec3;
  return raw as string | number | boolean;
}

/** The script line a call is equivalent to — what a refusal echoes. */
function statementText(spec: VerbSpec, args: readonly VerbValue[]): string {
  const parts: string[] = [spec.name];
  for (const a of args) {
    if (a === undefined) break;
    if (typeof a === 'string') parts.push(quote(a));
    else if (typeof a === 'boolean') parts.push(a ? 'on' : 'off');
    else if (typeof a === 'number') parts.push(String(a));
    else if (Array.isArray(a)) parts.push(`[${a.join(', ')}]`);
    else {
      const t = a as ScriptTime;
      parts.push(t.kind === 'et' ? String(t.et) : quote(t.text));
    }
  }
  return parts.join(' ');
}

// ── Bounded reads ──

const MAX_NAMES = 40;

function bounded<T>(items: readonly T[], max: number): { items: T[]; total: number } {
  return { items: items.slice(0, max), total: items.length };
}

function placeSummary(p: ScriptPlace) {
  return {
    ref: p.ref, name: p.name, body: p.body, kind: p.kind, latitude: p.latitude, longitude: p.longitude,
    ...(p.diameterKm !== undefined ? { diameterKm: p.diameterKm } : {}),
    source: `${p.layer.name} (${p.source.kind}: ${p.source.identity})`,
    ...(p.unavailable ? { unavailable: p.unavailable } : {}),
  };
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** A minimal `AbortSignal`, so this package keeps no DOM types. */
class TaskSignal implements ScriptCancelSignal {
  aborted = false;
  private readonly listeners = new Set<() => void>();
  addEventListener(_type: 'abort', listener: () => void): void { this.listeners.add(listener); }
  removeEventListener(_type: 'abort', listener: () => void): void { this.listeners.delete(listener); }
  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const l of [...this.listeners]) l();
  }
}

const has = (host: ViewerControl, method: keyof ViewerControl) =>
  typeof (host as unknown as Record<string, unknown>)[method] === 'function';

/** Bind the agent tools to one viewer. */
export function createAgentTools(host: ViewerControl, opts: AgentToolsOptions = {}): AgentTools {
  let taskSeq = 0;
  let current: TaskImpl | null = null;

  const verbTools = AGENT_VERBS.flatMap(({ verb, effect }) => {
    const spec = VERBS.get(verb);
    return spec ? [{ spec, def: verbTool(spec, effect) }] : [];
  });

  const list = (): readonly AgentToolDef[] => [
    ...READ_TOOLS.filter((t) => !t.method || has(host, t.method)).map(({ method: _m, ...def }) => def),
    ...verbTools.filter(({ spec }) => has(host, spec.method)).map(({ def }) => def),
  ];

  // The person's own navigation, observed for every task: a flight they
  // interrupted leaves the camera theirs for the rest of that task.
  const offFlight = host.on('flightEnd', (e) => {
    if (e.outcome === 'interrupted' && current) current.cameraTaken = true;
  });

  const sceneId = () => attempt(() => host.getScene?.())?.id ?? null;
  const hasScene = () => (has(host, 'getScene') ? sceneId() !== null : true);

  function describeScene(): AgentToolResult {
    const scene = attempt(() => host.getScene?.()) ?? null;
    const et = host.getTime();
    const tracked = host.getTracked();
    const selected = host.getSelected();
    const objects = bounded(attempt(() => host.listObjects()) ?? [], MAX_NAMES);
    const viewpoints = bounded(attempt(() => host.listViewpoints()) ?? [], 20);
    const focus = tracked ?? selected;
    const imagery = focus && has(host, 'getImagery') ? attempt(() => host.getImagery!(focus)) : undefined;
    const activity = has(host, 'getSelectedActivity') ? attempt(() => host.getSelectedActivity!()) : undefined;
    const place = has(host, 'getSelectedPlace') ? attempt(() => host.getSelectedPlace!()) : undefined;
    const activityCount = has(host, 'listActivities') ? attempt(() => host.listActivities!().length) : undefined;
    const lacks = [
      ['places', 'searchPlaces'], ['mission activities', 'listActivities'], ['imagery', 'getImagery'], ['scene identity', 'getScene'],
    ].filter(([, m]) => !has(host, m as keyof ViewerControl)).map(([label]) => label);
    const data = {
      scene,
      time: { et, ...(opts.formatTime ? { utc: attempt(() => opts.formatTime!(et)) } : {}), playing: host.isPlaying(), rate: host.getRate() },
      selected,
      tracked,
      flight: host.getFlight(),
      selectedActivity: activity ? { id: activity.id, name: activity.name, kind: activity.kind, vehicle: activity.vehicle, start: activity.start, end: activity.end } : null,
      selectedPlace: place ? placeSummary(place) : null,
      objects: { names: objects.items, total: objects.total },
      viewpoints: { names: viewpoints.items, total: viewpoints.total },
      ...(activityCount !== undefined ? { activities: activityCount } : {}),
      focusImagery: imagery
        ? {
          body: imagery.body, surface: imagery.surface, imageryOnly: imagery.imageryOnly,
          layers: imagery.layers.map((l) => ({ id: l.id, name: l.name, visible: l.visible, status: l.status, attribution: l.attribution })),
        }
        : null,
      unsupported: lacks,
    };
    const summary = scene === null && has(host, 'getScene')
      ? 'No scene is loaded.'
      : `${scene?.catalog ?? 'Scene'}: ${objects.total} objects; selected ${selected ?? 'nothing'}; tracking ${tracked ?? 'nothing'}.`;
    return { ok: true, summary, data };
  }

  function resolve(input: Input): AgentToolResult {
    const query = (input.query as string).trim();
    const kinds = new Set((input.kinds as string[] | undefined) ?? ['object', 'viewpoint', 'place', 'activity']);
    const q = query.toLowerCase();
    const matches = (name: string) => name.toLowerCase().includes(q);
    const candidates: { kind: string; id: string; label: string; detail?: string }[] = [];
    if (kinds.has('object')) {
      const objects = attempt(() => host.listObjects()) ?? [];
      const exact = objects.filter((n) => n.toLowerCase() === q);
      const found = exact.length ? exact : objects.filter(matches);
      const near = found.length ? found : suggest(query, objects) ? [suggest(query, objects)!] : [];
      for (const n of near.slice(0, 8)) candidates.push({ kind: 'object', id: n, label: n });
    }
    if (kinds.has('viewpoint')) {
      for (const n of (attempt(() => host.listViewpoints()) ?? []).filter(matches).slice(0, 5)) candidates.push({ kind: 'viewpoint', id: n, label: n });
    }
    if (kinds.has('place') && has(host, 'searchPlaces')) {
      for (const p of attempt(() => host.searchPlaces!(query, { limit: 5 })) ?? []) {
        candidates.push({ kind: 'place', id: p.ref, label: p.name, detail: `${p.kind} on ${p.body}${p.unavailable ? ` — unavailable: ${p.unavailable}` : ''}` });
      }
    }
    if (kinds.has('activity') && has(host, 'listActivities')) {
      const words = q.split(/\s+/).filter(Boolean);
      const acts = (attempt(() => host.listActivities!()) ?? [])
        .filter((a) => words.every((w) => `${a.name} ${a.id} ${a.kind} ${a.vehicle}`.toLowerCase().includes(w)));
      for (const a of acts.slice(0, 8)) candidates.push({ kind: 'activity', id: a.id, label: a.name, detail: `${a.kind}, ${a.vehicle}` });
    }
    const summary = candidates.length === 0
      ? `Nothing in this scene matches ${JSON.stringify(query)}.`
      : candidates.length === 1
        ? `${JSON.stringify(query)} is the ${candidates[0].kind} ${JSON.stringify(candidates[0].id)}.`
        : `${candidates.length} candidates for ${JSON.stringify(query)}.`;
    return { ok: true, summary, data: { candidates, ambiguous: candidates.length > 1 } };
  }

  function searchPlaces(input: Input): AgentToolResult {
    const limit = Math.round((input.limit as number | undefined) ?? 8);
    const places = host.searchPlaces!(input.query as string, { body: input.body as string | undefined, limit });
    return { ok: true, summary: `${places.length} place${places.length === 1 ? '' : 's'} found.`, data: places.map(placeSummary) };
  }

  function listActivities(input: Input): AgentToolResult {
    const all = host.listActivities!({ vehicle: input.vehicle as string | undefined, kind: input.kind as string | undefined });
    const { items, total } = bounded(all, Math.round((input.limit as number | undefined) ?? 20));
    return {
      ok: true,
      summary: `${total} activit${total === 1 ? 'y' : 'ies'}${total > items.length ? `, first ${items.length} shown` : ''}.`,
      data: {
        total,
        activities: items.map((a) => ({
          id: a.id, name: a.name, kind: a.kind, vehicle: a.vehicle, body: a.body, start: a.start, end: a.end,
          ...(opts.formatTime ? { startUtc: attempt(() => opts.formatTime!(a.start)) } : {}),
          provenance: a.provenance,
        })),
      },
    };
  }

  function getImagery(input: Input): AgentToolResult {
    const name = input.object as string;
    const imagery = host.getImagery!(name);
    if (!imagery) {
      const s = suggest(name, attempt(() => host.listObjects()) ?? []);
      return { ok: false, code: 'refused', error: `no object named ${JSON.stringify(name)}${s ? ` (did you mean ${JSON.stringify(s)}?)` : ''}` };
    }
    const summary = imagery.layers.length === 0
      ? `${imagery.body} has no streamed imagery.`
      : `${imagery.body}: ${imagery.layers.length} imagery layer${imagery.layers.length === 1 ? '' : 's'}${imagery.imageryOnly ? ' (imagery only, no terrain elevation)' : ''}.`;
    return { ok: true, summary, data: imagery };
  }

  const reads: Record<string, (input: Input) => AgentToolResult> = { describeScene, resolve, searchPlaces, listActivities, getImagery };

  /**
   * Wait for the end of flight `id`, the one a call started, unless the task or
   * scene goes first. Any other flight's end is not this wait's business: a
   * host, a person or a newer request flying the camera must not resolve it.
   * `seen` holds the ends already told since before the call ran, so one that
   * arrived while the call was still returning is not missed.
   */
  function awaitFlight(task: TaskImpl, id: number, seen: ReadonlyMap<number, FlightEnd>): Promise<FlightEnd | 'ended'> {
    return new Promise((done) => {
      const offs: (() => void)[] = [];
      const finish = (v: FlightEnd | 'ended') => {
        for (const off of offs) off();
        task.signal.removeEventListener('abort', onAbort);
        done(v);
      };
      const onAbort = () => finish('ended');
      offs.push(host.on('flightEnd', (e) => { if (e.id === id) finish(e); }));
      // A scene replaced mid-flight disposes the camera without a flightEnd.
      offs.push(host.on('load', () => finish('ended')));
      task.signal.addEventListener('abort', onAbort);
      const already = seen.get(id);
      if (already) finish(already);
      else if (task.signal.aborted) finish('ended');
    });
  }

  class TaskImpl implements AgentTask {
    readonly id = ++taskSeq;
    readonly signal = new TaskSignal();
    readonly scene = sceneId();
    ended: AgentErrorCode | null = null;
    cameraTaken = false;
    /** The flight this task started and has not seen end; the only one its Stop may stop. */
    ownFlight: number | null = null;

    end(code: AgentErrorCode) {
      if (this.ended) return;
      this.ended = code;
      this.signal.abort();
      if (current === this) current = null;
    }

    cancel() {
      if (this.ended) return;
      // A flight this task started is its own work: stopping the task stops it,
      // where it is. One a person or a host started since is theirs, and so is
      // any flight when this task has none: Stop then ends the request only.
      // Nothing else this task did is undone.
      if (this.ownFlight !== null && attempt(() => host.getFlight())?.id === this.ownFlight) attempt(() => host.stopFlight());
      this.ownFlight = null;
      this.end('cancelled');
    }

    finish() {
      if (current === this) current = null;
      if (!this.ended) this.ended = 'cancelled';
    }

    private gate(def: AgentToolDef): AgentToolResult | null {
      if (this.ended === 'superseded') return { ok: false, code: 'superseded', error: 'a newer request replaced this one; nothing was done' };
      if (this.ended) return { ok: false, code: 'cancelled', error: 'this request was stopped; nothing was done' };
      if (this.scene !== sceneId()) {
        this.end('stale');
        return { ok: false, code: 'stale', error: 'the scene changed since this request began; nothing was done' };
      }
      if (def.effect !== 'read' && !hasScene()) return { ok: false, code: 'no-scene', error: 'no scene is loaded' };
      if (def.effect === 'camera' && this.cameraTaken) {
        return { ok: false, code: 'interrupted', error: 'the person moved the camera during this request; leaving the view to them' };
      }
      return null;
    }

    async call(name: string, input: unknown): Promise<AgentToolResult> {
      const def = list().find((t) => t.name === name);
      if (!def) {
        const s = suggest(name, list().map((t) => t.name));
        return { ok: false, code: 'unknown-tool', error: `no tool ${JSON.stringify(name)} on this viewer${s ? ` (did you mean ${JSON.stringify(s)}?)` : ''}` };
      }
      const problem = violation(def.inputSchema, input ?? {}, 'input');
      if (problem) return { ok: false, code: 'invalid-input', error: problem };
      const refused = this.gate(def);
      if (refused) return refused;
      const args = (input ?? {}) as Input;

      const read = reads[name];
      if (read) {
        try {
          return read(args);
        } catch (err) {
          return { ok: false, code: 'failed', error: err instanceof Error ? err.message : String(err) };
        }
      }

      const spec = VERBS.get(name)!;
      const values = spec.params.map((p) => verbValue(p, args[p.name]));
      while (values.length && values[values.length - 1] === undefined) values.pop();
      const text = statementText(spec, values);
      const statement: Statement = { line: 1, verb: name, args: values, text };

      // A camera call that starts a flight owns that flight, by id. Ends are
      // collected from before the call, so one told while it is still
      // returning is not lost.
      const flies = def.effect === 'camera' && name !== 'stopFlight';
      const seen = new Map<number, FlightEnd>();
      const offSeen = flies ? host.on('flightEnd', (e) => seen.set(e.id, e)) : () => {};
      let own: number | null = null;
      try {
        const before = flies ? attempt(() => host.getFlight())?.id : undefined;
        const running = execute({ statements: [statement], source: text }, host, { signal: this.signal });
        // `execute` invokes the statement before its first await, so the call
        // has already run: a flight playing now that was not before is this
        // call's, and not one another command started meanwhile.
        const after = flies ? attempt(() => host.getFlight()) : null;
        if (after && after.id !== before) {
          own = after.id;
          this.ownFlight = own;
        }
        try {
          await running;
        } catch (err) {
          if (!(err instanceof ScriptRuntimeError)) return { ok: false, code: 'failed', error: String(err) };
          const p = err.problems[0];
          const code: AgentErrorCode = p.kind === 'cancelled' ? (this.ended === 'superseded' ? 'superseded' : 'cancelled')
            : p.kind === 'unknown-target' ? 'refused'
              : 'failed';
          return { ok: false, code, error: p.message };
        }

        if (own !== null) {
          const end = await awaitFlight(this, own, seen);
          if (end === 'ended') {
            const code = this.ended ?? 'stale';
            return { ok: false, code, error: code === 'stale' ? 'the scene changed during the flight' : `the flight was left where it was: this request was ${code}` };
          }
          if (end.outcome === 'interrupted') {
            return { ok: false, code: 'interrupted', error: `the person took over the camera before it reached ${end.target ?? 'the destination'}; leaving the view to them` };
          }
          if (end.outcome === 'stopped') return { ok: false, code: 'failed', error: `the flight to ${end.target ?? 'the destination'} was stopped by another camera command` };
          return { ok: true, summary: `${text}: arrived${end.target ? ` at ${end.target}` : ''}.` };
        }
        return { ok: true, summary: `${text}: done.` };
      } finally {
        offSeen();
        if (this.ownFlight === own) this.ownFlight = null;
      }
    }
  }

  const begin = (): AgentTask => {
    current?.end('superseded');
    current = new TaskImpl();
    return current;
  };

  return {
    list,
    begin,
    call: async (name, input) => {
      const task = begin();
      try {
        return await task.call(name, input);
      } finally {
        task.finish();
      }
    },
    cancel: () => current?.cancel(),
    dispose: () => {
      offFlight();
      current?.end('cancelled');
    },
  };
}
