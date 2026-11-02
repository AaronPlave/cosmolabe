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
  ScriptActivity,
  ScriptCancelSignal,
  ScriptEventMap,
  ScriptTime,
  ScriptVec3,
  Statement,
  VerbValue,
  ViewerControl,
} from './contracts.js';
import { ScriptRuntimeError } from './errors.js';
import { execute } from './execute.js';
import { agentMetadata, type AgentMetadataPolicy } from './agent-metadata.js';
import { quote } from './snapshot.js';
import { suggest } from './suggest.js';
import { VERBS, type VerbParam, type VerbSpec } from './verbs.js';
import type { OperationReceipt } from './capabilities.js';

type FlightEnd = ScriptEventMap['flightEnd'];

/** The JSON Schema subset the tools are described in. */
export interface AgentJsonSchema {
  readonly type?: 'object' | 'string' | 'number' | 'boolean' | 'array' | 'null' | readonly ('object' | 'array' | 'string' | 'number' | 'boolean' | 'null')[];
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
export type AgentToolEffect = 'read' | 'camera' | 'time' | 'selection' | 'display' | 'export' | 'authoring';

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

export type AgentToolResult = (
  | { readonly ok: true; readonly summary: string; readonly data?: unknown; readonly completion?: { readonly kind: 'flight'; readonly id: number; readonly outcome: 'arrived' } }
  | { readonly ok: false; readonly code: AgentErrorCode; readonly error: string }
) & { readonly receipt?: OperationReceipt };

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
  /** Immediate bounded observation; does not begin/supersede a task. */
  inspect?(): AgentToolResult;
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
  /** Catalog adapter only: include all registered verbs, retaining execute as the dispatcher. */
  vocabulary?: 'curated' | 'catalog';
  /** Trusted per-tool omissions, enforced even for direct task calls. */
  omittedTools?: Readonly<Record<string, string>>;
  /** Trusted host permission; captures are refused by default even in catalog mode. */
  allowExport?: boolean;
  /** Trusted host permission for saved definitions and annotation mutations. */
  allowAuthoring?: boolean;
  /** Only the trusted host can approve public metadata; never derive this policy from catalog fields. */
  metadata?: AgentMetadataPolicy;
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
  'event-query': 'An exact query ID from listEventQueries.',
  'event-result': 'An exact result ID within the named query from listEventResults.',
  instrument: 'A sensor name from listInstruments; empty closes the synthetic feed.',
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
  { name: 'listEventQueries', effect: 'read', method: 'listEventQueries', description: 'Bounded configured Event Finder identities/kinds and flags; no result arrays or private query metadata.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'getEventSearch', effect: 'read', method: 'getEventSearch', description: 'Event search status, current-call progress, error code and exact selection. Error text is withheld.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'listEventResults', effect: 'read', method: 'listEventResults', description: 'A bounded page of exact query/result identities and event times; no private solver metadata.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'number', minimum: 0 }, limit: { type: 'number', minimum: 1, maximum: 100 } }, required: ['query'], additionalProperties: false } },
  { name: 'listInstruments', effect: 'read', method: 'listInstruments', description: 'Bounded available sensor names for synthetic scene feeds; not calibrated observation inventory.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'getInstrument', effect: 'read', method: 'getInstrument', description: 'Selected synthetic scene instrument with native FOV and truthful pointing authority; no pixel data.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'listBookmarks', effect: 'read', method: 'listBookmarks', description: 'Bounded session bookmark names. Full portable poses are available to trusted hosts.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'listPlaceSources', effect: 'read', method: 'listPlaceSources', description: 'A bounded page of source IDs with body, search inclusion and label visibility; no resource locations.', inputSchema: { type: 'object', properties: { offset: { type: 'number', minimum: 0 }, limit: { type: 'number', minimum: 1, maximum: 50 } }, additionalProperties: false } },
  { name: 'listMeasurements', effect: 'read', method: 'listMeasurements', description: 'Saved semantic measurement IDs, kinds and visibility. Endpoints/provenance are withheld from model transport; trusted hosts use the typed port.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'listGeographicLayers', effect: 'read', method: 'listGeographicLayers', description: 'A bounded page of geographic layer IDs, body/frame, editability, visibility and availability.', inputSchema: { type: 'object', properties: { offset: { type: 'number', minimum: 0 }, limit: { type: 'number', minimum: 1, maximum: 50 } }, additionalProperties: false } },
  { name: 'listGeographicFeatures', effect: 'read', method: 'listGeographicFeatures', description: 'A bounded page of stable feature IDs and geometry types in an exact layer.', inputSchema: { type: 'object', properties: { layer: { type: 'string' }, offset: { type: 'number', minimum: 0 }, limit: { type: 'number', minimum: 1, maximum: 100 } }, required: ['layer'], additionalProperties: false } },
  { name: 'getSurfaceAppearance', effect: 'read', method: 'getSurfaceAppearance', description: 'Current terrain appearance settings or an explicit unavailable reason.', inputSchema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'], additionalProperties: false } },
  { name: 'getReadiness', effect: 'read', method: 'getReadiness', description: 'Observe assets, one current-view imagery source, mandatory cube base on drawn blocks, or current-view physical terrain coverage with explicit footprint and target-LOD limitations. Does not prefetch.', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['assets', 'imagery', 'cube-base', 'terrain'] }, body: { type: 'string' }, layer: { type: 'string' } }, required: ['kind'], additionalProperties: false } },
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
    description: 'Compact activity page. Sort ranks the ENTIRE matching collection before paging; duration is the catalog interval in seconds, not distance or telemetry. Missing durations sort last. Use getActivity for site, navigation references and full provenance.',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: { type: 'string' },
        kind: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 50 },
        offset: { type: 'number', minimum: 0 },
        sort: { type: 'string', enum: ['start', 'duration', 'name'] },
        order: { type: 'string', enum: ['asc', 'desc'] },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'getActivity', effect: 'read', method: 'listActivities',
    description: 'Details of one catalog activity: navigation references, site association, timing and available provenance. No selection or time changes.',
    inputSchema: { type: 'object', properties: { activity: { type: 'string' } }, required: ['activity'], additionalProperties: false },
  },
  {
    name: 'getSurfaceData',
    effect: 'read',
    method: 'getSurfaceData',
    description: 'Configured surface products: terrain elevation/LOD, cube imagery, base/normal/displacement textures, other imagery, and independently managed overlays. Declared provenance and runtime readiness, residency and current-view coverage are separate; null means unknown. Use for dataset inventory even when getImagery reports zero overlays.',
    inputSchema: {
      type: 'object',
      properties: { object: { type: 'string', description: PARAM_HELP.object } },
      required: ['object'],
      additionalProperties: false,
    },
  },
  {
    name: 'getImagery',
    effect: 'read',
    method: 'getImagery',
    description:
      'An object\'s streamed imagery layers: id, attribution (provenance), resolution, coverage, load status and whether it draws in the current view. '
      + 'Only independently managed layers are listed. Zero layers does not mean no surface datasets: use getSurfaceData for terrain, cube imagery and textures.',
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
      case 'null': return value === null;
      default: return false;
    }
  });
}

/** The first way `value` violates `schema`, or null. */
export function violation(schema: AgentJsonSchema, value: unknown, path: string): string | null {
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
      if (!Object.hasOwn(schema.properties, key)) return `${path}: unknown field ${JSON.stringify(key)} (fields: ${Object.keys(schema.properties).join(', ') || 'none'})`;
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

/** Registration comes from VERBS and the bounded read implementations above. No catalog code executes. */
export function agentDefinitions(): readonly (AgentToolDef & { method?: keyof ViewerControl })[] {
  return [...READ_TOOLS, ...[...VERBS.values()].map(spec => ({
    ...verbTool(spec, AGENT_VERBS.find(v => v.verb === spec.name)?.effect ?? (spec.category === 'Authoring' ? 'authoring' : spec.category === 'Capture' ? 'export' : spec.category === 'Camera' || spec.name === 'gotoObject' ? 'camera'
      : spec.category === 'Time' || spec.name === 'seekActivity' || spec.name === 'selectEventResult' ? 'time'
        : spec.category === 'Scene' ? 'selection' : 'display')), method: spec.method,
  }))];
}

/** Bind the agent tools to one viewer. */
export function createAgentTools(host: ViewerControl, opts: AgentToolsOptions = {}): AgentTools {
  const metadata = agentMetadata(opts.metadata);
  const placeSummary = metadata.place;
  let taskSeq = 0;
  let current: TaskImpl | null = null;

  const verbTools = AGENT_VERBS.flatMap(({ verb, effect }) => {
    const spec = VERBS.get(verb);
    return spec ? [{ spec, def: verbTool(spec, effect) }] : [];
  });

  const list = (): readonly AgentToolDef[] => opts.vocabulary === 'catalog'
    ? agentDefinitions().filter(t => !t.method || has(host, t.method)).map(({ method: _m, ...def }) => def)
    : [
    ...READ_TOOLS.filter((t) => !t.method || has(host, t.method)).map(({ method: _m, ...def }) => def),
    ...verbTools.filter(({ spec }) => has(host, spec.method)).map(({ def }) => def),
  ];

  // The person's own navigation, observed for every task: a flight they
  // interrupted leaves the camera theirs for the rest of that task.
  const offFlight = host.on('flightEnd', (e) => {
    if (e.outcome === 'interrupted' && current) current.cameraTaken = true;
  });

  const offInput = host.on('cameraInput', () => { if (current) current.cameraTaken = true; });
  const offLoad = host.on('load', () => current?.end('stale'));

  const sceneId = () => attempt(() => host.getScene?.())?.id ?? null;
  const hasScene = () => (has(host, 'getScene') ? sceneId() !== null : true);

  /**
   * What an activity's record says about where it happened, and which places
   * in the scene that could be. The link is stated for what it is: a direct
   * reference (`references.location`), a name match (the `site` equals a
   * place's name), or none. A model reads this instead of guessing from a ref's
   * spelling.
   */
  function activitySite(a: ScriptActivity) {
    const ref = a.references?.location;
    const direct = ref && has(host, 'getPlace') ? attempt(() => host.getPlace!(ref)) : undefined;
    const wanted = a.site?.trim().toLowerCase();
    const named = wanted && has(host, 'searchPlaces')
      ? (attempt(() => host.searchPlaces!(a.site!, { body: a.body, limit: 10 })) ?? []).filter((p) => p.name.trim().toLowerCase() === wanted)
      : [];
    const places = direct ? [direct] : named;
    const basis = direct ? 'the activity references this place'
      : named.length ? `the activity's site name equals ${named.length === 1 ? 'this place name' : 'these places\' names'}; the record has no direct place reference`
        : a.site ? 'no place in this scene has the site\'s name, and the record has no place reference'
          : 'the record names no site';
    return {
      ...(a.site ? { name: a.site } : {}),
      ...(ref ? { locationRef: ref } : {}),
      link: direct ? 'direct reference' : named.length ? 'name match' : 'none',
      basis,
      places: places.map(placeSummary),
    };
  }

  function activitySummary(a: ScriptActivity) {
    return {
      id: a.id, name: a.name, kind: a.kind, vehicle: a.vehicle, body: a.body, ...(a.mission ? { mission: a.mission } : {}),
      start: a.start, end: a.end,
      ...(opts.formatTime ? { startUtc: attempt(() => opts.formatTime!(a.start)), endUtc: attempt(() => opts.formatTime!(a.end)) } : {}),
      ...(a.references ? { references: { trajectory: a.references.trajectory, location: a.references.location, viewpoint: a.references.viewpoint, objects: a.references.objects } } : {}),
      site: activitySite(a),
      provenance: {
        source: metadata.text(a.provenance.source), version: metadata.text(a.provenance.version),
        authority: metadata.text(a.provenance.authority), timing: metadata.text(a.provenance.timing),
        limitations: metadata.text(a.provenance.limitations), uncertaintySeconds: a.provenance.uncertaintySeconds,
        withheld: 'Unapproved provenance is null; timing and source accuracy must not be inferred from missing metadata.',
      },
    };
  }

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
      ['places', 'searchPlaces'], ['mission activities', 'listActivities'], ['imagery', 'getImagery'], ['surface datasets', 'getSurfaceData'], ['scene identity', 'getScene'],
    ].filter(([, m]) => !has(host, m as keyof ViewerControl)).map(([label]) => label);
    const data = {
      scene,
      time: { et, ...(opts.formatTime ? { utc: attempt(() => opts.formatTime!(et)) } : {}), playing: host.isPlaying(), rate: host.getRate() },
      selectedObject: selected,
      tracked,
      flight: host.getFlight(),
      selectedActivity: activity ? activitySummary(activity) : null,
      selectedPlace: place ? placeSummary(place) : null,
      objects: { names: objects.items, total: objects.total },
      viewpoints: { names: viewpoints.items, total: viewpoints.total },
      ...(activityCount !== undefined ? { activities: activityCount } : {}),
      focusSurfaceData: focus && has(host, 'getSurfaceData') ? attempt(() => { const data = host.getSurfaceData!(focus); return data ? metadata.surface(data) : null; }) ?? null : null,
      focusImagery: imagery ? metadata.imagery(imagery) : null,
      unsupported: lacks,
    };
    const summary = scene === null && has(host, 'getScene')
      ? 'No scene is loaded.'
      : `${scene?.catalog ?? 'Scene'}: ${objects.total} objects; selected object ${selected ?? 'none'}; selected activity ${activity?.name ?? 'none'}; selected place ${place?.name ?? 'none'}; tracking ${tracked ?? 'nothing'}.`;
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
        candidates.push({ kind: 'place', id: p.ref, label: p.name, detail: `${p.kind} on ${p.body}${p.unavailable ? ' — navigation unavailable' : ''}` });
      }
    }
    if (kinds.has('activity') && has(host, 'listActivities')) {
      const words = q.split(/\s+/).filter(Boolean);
      const acts = (attempt(() => host.listActivities!()) ?? [])
        .filter((a) => words.every((w) => `${a.name} ${a.id} ${a.kind} ${a.vehicle}`.toLowerCase().includes(w)));
      for (const a of acts.slice(0, 8)) candidates.push({ kind: 'activity', id: a.id, label: a.name, detail: `${a.kind}, ${a.vehicle}${a.site ? `, site ${a.site}` : ''}` });
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

  function getActivity(input: Input): AgentToolResult {
    const activity = host.listActivities!().find(a => a.id === input.activity);
    return activity ? { ok: true, summary: activity.name, data: activitySummary(activity) }
      : { ok: false, code: 'refused', error: 'No activity with that id in this scene.' };
  }

  function listActivities(input: Input): AgentToolResult {
    const all = host.listActivities!({ vehicle: input.vehicle as string | undefined, kind: input.kind as string | undefined });
    const duration = (a: ScriptActivity) => a.temporality === 'interval' && Number.isFinite(a.start) && Number.isFinite(a.end) && a.end >= a.start ? a.end - a.start : null;
    const sort = (input.sort as string | undefined) ?? 'start';
    const order = (input.order as string | undefined) ?? 'asc';
    const value = (a: ScriptActivity) => sort === 'duration' ? duration(a) : sort === 'name' ? a.name : a.start;
    const sorted = [...all].sort((a, b) => {
      const x = value(a), y = value(b);
      if (x === null || y === null) return x === y ? a.id.localeCompare(b.id) : x === null ? 1 : -1;
      const cmp = typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y) : Number(x) - Number(y);
      return (order === 'desc' ? -cmp : cmp) || a.id.localeCompare(b.id);
    });
    const offset = Math.floor((input.offset as number | undefined) ?? 0);
    const limit = Math.floor((input.limit as number | undefined) ?? 10);
    const items = sorted.slice(offset, offset + limit);
    const nextOffset = offset + items.length < all.length ? offset + items.length : null;
    return { ok: true, summary: `${all.length} matching activities; sorted across all matches by ${sort} ${order}; ${items.length} returned.`, data: {
      total: all.length, offset, returned: items.length, nextOffset, complete: offset === 0 && nextOffset === null,
      sort, order, missingDuration: all.filter(a => duration(a) === null).length,
      activities: items.map(a => ({ id: a.id, name: a.name, vehicle: a.vehicle, kind: a.kind,
        start: a.start, end: a.end, durationSeconds: duration(a), timing: metadata.text(a.provenance.timing) })),
    } };
  }

  function getSurfaceData(input: Input): AgentToolResult {
    const name = input.object as string;
    const data = host.getSurfaceData!(name);
    if (!data) return { ok: false, code: 'refused', error: `surface data unavailable for ${JSON.stringify(name)}` };
    return { ok: true, summary: `${data.body}: configured surface products and independently managed overlays; unknown runtime observations are null.`, data: metadata.surface(data) };
  }

  function getImagery(input: Input): AgentToolResult {
    const name = input.object as string;
    const imagery = host.getImagery!(name);
    if (!imagery) {
      const s = suggest(name, attempt(() => host.listObjects()) ?? []);
      return { ok: false, code: 'refused', error: `no object named ${JSON.stringify(name)}${s ? ` (did you mean ${JSON.stringify(s)}?)` : ''}` };
    }
    const summary = imagery.layers.length === 0
      ? `${imagery.body} has no independently managed overlays. Use getSurfaceData for terrain, cube imagery and textures.`
      : `${imagery.body}: ${imagery.layers.length} imagery layer${imagery.layers.length === 1 ? '' : 's'}${imagery.imageryOnly ? ' (imagery only, no terrain elevation)' : ''}.`;
    return { ok: true, summary, data: metadata.imagery(imagery) };
  }

  /**
   * Read back what a write was meant to leave in place, from the viewer. A
   * selection is shared state anything can change, so "selected" is claimed
   * only when the viewer says it is. Returns a refusal when it is not, else
   * the sentence to append to the result.
   */
  function readBack(name: string, args: Input): { problem: string } | { note: string } | null {
    if (name === 'select' || name === 'deselect') {
      const expected = name === 'select' ? args.object : null;
      return host.getSelected() === expected ? { note: `Selected object: ${host.getSelected() ?? 'none'}.` }
        : { problem: 'the viewer does not report the requested object selection' };
    }
    if (name === 'track' || name === 'untrack') {
      const expected = name === 'track' ? args.object : null;
      return host.getTracked() === expected ? { note: `Tracked object: ${host.getTracked() ?? 'none'}.` }
        : { problem: 'the viewer does not report the requested tracking state' };
    }
    if (name === 'setTimeRate' && host.getRate() !== args.rate) return { problem: 'the clock does not report the requested rate' };
    if (name === 'setPlaying' && host.isPlaying() !== args.on) return { problem: 'the clock does not report the requested playback state' };
    if (name === 'setTime' && !host.isPlaying() && typeof args.when === 'number' && Math.abs(host.getTime() - args.when) > 0.001) return { problem: 'the clock does not report the requested ET' };
    if (name === 'seekActivity' && !host.isPlaying()) {
      const activity = host.listActivities?.().find(a => a.id === args.activity);
      const expected = args.edge === 'end' ? activity?.end : activity?.start;
      if (expected !== undefined && Math.abs(host.getTime() - expected) > 0.001) return { problem: 'the clock does not report the requested activity edge' };
    }
    if (name === 'showImagery' || name === 'setImageryOpacity') {
      const layer = host.getImagery?.(args.object as string)?.layers.find(l => l.id === args.layer);
      const held = layer && (name === 'showImagery' ? layer.visible === args.visible : layer.opacity === args.opacity);
      return held ? { note: 'The imagery layer reports the requested setting.' } : { problem: 'the imagery layer does not report the requested setting' };
    }
    if (name === 'selectActivity' && has(host, 'getSelectedActivity')) {
      const now = attempt(() => host.getSelectedActivity!());
      return now && now.id === args.activity ? { note: `The viewer now reports ${now.name} (${now.id}) as the selected activity.` }
        : { problem: `the activity was asked to be selected, but the viewer reports ${now ? `${now.name} (${now.id})` : 'none'} as selected` };
    }
    if (name === 'gotoPlace' && has(host, 'getSelectedPlace')) {
      const now = attempt(() => host.getSelectedPlace!());
      return now && now.ref === args.place ? { note: `The viewer now reports ${now.name} as the selected place.` }
        : { problem: `the place was asked to be selected, but the viewer reports ${now ? now.name : 'none'} as selected` };
    }
    if (name === 'seekActivity' || name === 'setTime' || name === 'setPlaying') {
      const utc = opts.formatTime ? attempt(() => opts.formatTime!(host.getTime())) : null;
      return { note: `The clock now reads ${utc ?? `ET ${host.getTime()}`}. Playback ${host.isPlaying() ? 'continues; this moment is not held' : 'is paused'}.` };
    }
    return null;
  }

  const reads: Record<string, (input: Input) => AgentToolResult> = {
    describeScene, resolve, searchPlaces, listActivities, getActivity, getSurfaceData, getImagery,
    listEventQueries: () => ({ ok: true, summary: 'Configured event searches.', data: { items: host.listEventQueries!().slice(0, 32).map(q => ({ id: q.id, kind: q.query.kind, enabled: q.enabled, visible: q.visible })) } }),
    getEventSearch: () => {
      const s = host.getEventSearch!();
      return { ok: true, summary: 'Event search state.', data: { scene: s.scene, query: s.query, status: s.status, progress: s.progress, error: s.error ? { code: s.error.code } : null, selected: s.selected } };
    },
    listEventResults: input => {
      const page = host.listEventResults!(input.query as string, { offset: input.offset as number | undefined, limit: input.limit as number | undefined });
      return { ok: true, summary: 'Event result identities and times.', data: { total: page.total, items: page.items.map(e => ({ id: e.id, query: e.queryId, kind: e.kind, temporality: e.temporality, ...(e.temporality === 'instant' ? { et: e.et } : { start: e.start, end: e.end }) })) } };
    },
    listInstruments: () => ({ ok: true, summary: 'Synthetic scene sensors.', data: { items: host.listInstruments!().slice(0, 64) } }),
    getInstrument: () => {
      const i = host.getInstrument!();
      return { ok: true, summary: 'Synthetic scene feed, not a calibrated observation.', data: i ? { sensor: i.sensor, spacecraft: i.spacecraft, target: i.target, fov: i.fov, viewFov: i.viewFov, pointing: i.pointing, observedEt: i.observedEt, observation: i.observation } : null };
    },
    listBookmarks: () => ({ ok: true, summary: 'Session bookmarks.', data: { items: host.listBookmarks!().slice(0, 64).map(b => ({ name: b.name })) } }),
    listPlaceSources: input => {
      const offset = input.offset as number ?? 0, limit = input.limit as number ?? 25;
      if (!Number.isInteger(offset) || !Number.isInteger(limit)) return { ok: false, code: 'invalid-input', error: 'Pagination must use integers' };
      const sources = host.listPlaceSources!();
      return { ok: true, summary: 'Place source inclusion and labels.', data: { total: sources.length, offset, sources: sources.slice(offset, offset + limit) } };
    },
    listMeasurements: () => ({ ok: true, summary: 'Saved measurement definitions (endpoint metadata withheld).', data: {
      selected: host.getSelectedMeasurement?.() ?? null,
      items: host.listMeasurements!().slice(0, 32).map(m => ({ id: m.id, kind: m.kind, visible: m.visible !== false })),
    } }),
    listGeographicLayers: input => {
      const offset = input.offset as number ?? 0, limit = input.limit as number ?? 25;
      if (!Number.isInteger(offset) || !Number.isInteger(limit)) return { ok: false, code: 'invalid-input', error: 'Pagination must use integers' };
      const all = host.listGeographicLayers!();
      return { ok: true, summary: 'Geographic layers.', data: { total: all.length, offset, layers: all.slice(offset, offset + limit).map(l => ({
        id: l.id, name: l.name, body: l.body, frame: metadata.text(l.frame), features: l.features, status: l.status, diagnostics: l.diagnostics, visible: l.visible, editable: l.editable, navigable: l.navigationUnavailable === null,
      })) } };
    },
    listGeographicFeatures: input => {
      const page = host.listGeographicFeatures!(input.layer as string, { offset: input.offset as number | undefined, limit: input.limit as number | undefined });
      return page ? { ok: true, summary: 'Geographic features.', data: page } : { ok: false, code: 'refused', error: 'Unknown geographic layer' };
    },
    getSurfaceAppearance: input => {
      const appearance = host.getSurfaceAppearance!(input.body as string);
      return appearance ? { ok: true, summary: 'Terrain appearance.', data: appearance } : { ok: false, code: 'refused', error: 'Unknown rendered body' };
    },
    getReadiness: input => ({ ok: true, summary: 'Observed readiness with explicit limitations.', data: host.getReadiness!(input as unknown as import('./contracts.js').ScriptReadinessRequest) }),
  };

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
      if (this.ended === 'stale') return { ok: false, code: 'stale', error: 'the scene changed since this request began; nothing was done' };
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
      if (opts.omittedTools?.[name]) return { ok: false, code: 'refused', error: opts.omittedTools[name] };
      const def = list().find((t) => t.name === name);
      if (!def) {
        const s = suggest(name, list().map((t) => t.name));
        return { ok: false, code: 'unknown-tool', error: `no tool ${JSON.stringify(name)} on this viewer${s ? ` (did you mean ${JSON.stringify(s)}?)` : ''}` };
      }
      const problem = violation(def.inputSchema, input ?? {}, 'input');
      if (problem) return { ok: false, code: 'invalid-input', error: problem };
      const refused = this.gate(def);
      if (refused) return refused;
      if (def.effect === 'authoring' && !opts.allowAuthoring) return { ok: false, code: 'refused', error: 'Authoring permission is required.' };
      if (def.effect === 'export' && !opts.allowExport) return { ok: false, code: 'refused', error: 'Export permission is required.' };
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
          const code: AgentErrorCode = p.kind === 'cancelled' ? (this.ended ?? 'cancelled')
            : p.kind === 'unknown-target' ? 'refused'
              : 'failed';
          return { ok: false, code, error: p.message };
        }

        // An asynchronous host method may finish after a scene reload or Stop.
        // Never report that late result as completion in the new scene.
        const late = this.gate(def);
        if (late) return late;

        if (own !== null) {
          const end = await awaitFlight(this, own, seen);
          if (end === 'ended') {
            const code = this.ended ?? 'stale';
            return { ok: false, code, error: code === 'stale' ? 'the scene changed during the flight' : `the flight was left where it was: this request was ${code}` };
          }
          const settled = this.gate(def);
          if (settled) return settled;
          if (end.outcome === 'interrupted') {
            return { ok: false, code: 'interrupted', error: `the person took over the camera before it reached ${end.target ?? 'the destination'}; leaving the view to them` };
          }
          if (end.outcome === 'stopped') return { ok: false, code: 'failed', error: `the flight to ${end.target ?? 'the destination'} was stopped by another camera command` };
          const back = readBack(name, args);
          if (back && 'problem' in back) return { ok: false, code: 'failed', error: `${text}: ${back.problem}` };
          return { ok: true, summary: `${text}: arrived${end.target ? ` at ${end.target}` : ''}.${back ? ` ${back.note}` : ''}`, completion: { kind: 'flight', id: own, outcome: 'arrived' } };
        }
        const back = readBack(name, args);
        if (back && 'problem' in back) return { ok: false, code: 'failed', error: `${text}: ${back.problem}` };
        return { ok: true, summary: `${text}: done.${back ? ` ${back.note}` : ''}` };
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
    inspect: describeScene,
    list: () => list().filter(def => !opts.omittedTools?.[def.name]),
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
      offInput();
      offLoad();
      current?.end('cancelled');
    },
  };
}
