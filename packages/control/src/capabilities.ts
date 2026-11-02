/** Discoverable, instance-bound rendering of the existing control vocabulary (#328). */
import { agentDefinitions, createAgentTools, violation, type AgentErrorCode, type AgentJsonSchema, type AgentTask, type AgentToolDef, type AgentToolEffect, type AgentToolResult, type AgentTools, type AgentToolsOptions } from './agent.js';
import { eventVisualizationMetadata } from './event-agent-metadata.js';
import type { ScriptReadinessRequest, ViewerControl } from './contracts.js';
import { VERBS } from './verbs.js';

export const CAPABILITY_VERSION = 1;
export const CAPABILITY_LIMITS = { page: 12, selected: 8, query: 160, receipts: 64, inputChars: 16000 } as const;
export type CapabilityEffect = 'read' | 'viewer' | 'authoring' | 'external';
export interface CapabilityScope { readonly viewer: string; readonly scene: number | null; readonly revision: number }
export interface CapabilitySummary {
  readonly id: string;
  readonly version: typeof CAPABILITY_VERSION;
  readonly domain: string;
  readonly description: string;
  readonly effect: CapabilityEffect;
  readonly available: boolean;
  readonly reason: string | null;
}
export interface CapabilityDescription extends CapabilitySummary {
  readonly tool: AgentToolDef;
  readonly outputSchema: AgentJsonSchema;
  readonly scope: CapabilityScope;
  readonly references: readonly { field: string; kind: string; scope: 'scene' }[];
  readonly dependencies: readonly string[];
  readonly conventions: string;
  readonly provenance: string;
  readonly permission: 'none' | 'host-and-confirmation';
}
export type OperationStatus = 'accepted' | 'running' | 'completed' | 'refused' | 'partial' | 'cancelled' | 'stale';
export interface OperationReceipt {
  readonly id: string;
  readonly operation: string;
  readonly version: typeof CAPABILITY_VERSION;
  readonly scope: CapabilityScope;
  readonly task: number;
  readonly status: OperationStatus;
  readonly requestedTarget: Readonly<Record<string, string>>;
  /** Only verified exact scene references; never inferred from a tool's intent. */
  readonly resolvedTarget: Readonly<Record<string, string>>;
  readonly observation: { readonly scope: CapabilityScope; readonly state: unknown };
  readonly warnings: readonly string[];
  readonly provenance: 'viewer-observation';
  readonly verification: 'observed' | 'host-return';
}
export interface CapabilityQuery {
  readonly version?: number;
  readonly domain?: string;
  readonly effects?: readonly CapabilityEffect[];
  readonly availableOnly?: boolean;
  readonly query?: string;
  readonly offset?: number;
  readonly limit?: number;
}
export interface CapabilityPage {
  readonly version: typeof CAPABILITY_VERSION;
  readonly scope: CapabilityScope;
  readonly items: readonly CapabilitySummary[];
  readonly total: number;
  readonly nextOffset: number | null;
}
export interface CapabilityToolsOptions extends Omit<AgentToolsOptions, 'vocabulary' | 'allowExport' | 'allowAuthoring'> {
  /** Fixed mode retains familiar direct schemas plus the small discovery bridge. */
  readonly surface?: 'fixed' | 'discovery';
  /** Trusted host policy only; never populated from a scene or model argument. */
  readonly omitted?: Readonly<Record<string, string>>;
  readonly allowExternal?: boolean;
  readonly allowAuthoring?: boolean;
  readonly confirmAuthoring?: (operation: string, input: unknown) => Promise<boolean>;
  /** A trusted UI/host confirmation, bound to this exact call. Model text cannot grant it. */
  readonly confirmExternal?: (operation: string, input: unknown) => Promise<boolean>;
  /** Observe accepted/running/final progress; callback failures do not change execution. */
  readonly onReceipt?: (receipt: OperationReceipt) => void;
}
export interface CapabilityTools extends AgentTools {
  listCapabilities(query?: CapabilityQuery): CapabilityPage;
  describeCapabilities(ids: readonly string[], version?: number): readonly CapabilityDescription[];
  getOperationResult(id: string): OperationReceipt | null;
}

/** A small schema shortlist, never an authorization allowlist. All other
 * registry operations are invocable through the same validated dispatcher. */
export const DEFAULT_ASK_DIRECT = ['describeScene', 'resolve', 'getEventSearchOptions', 'getSpatialContext'] as const;
export function defaultAskDefinitions() {
  return agentDefinitions().filter(d => (DEFAULT_ASK_DIRECT as readonly string[]).includes(d.name));
}

const objectSchema = (properties: Record<string, AgentJsonSchema>, required: string[] = []): AgentToolDef['inputSchema'] =>
  ({ type: 'object', properties, required, additionalProperties: false });
const DISCOVERY: readonly AgentToolDef[] = [
  { name: 'listCapabilities', effect: 'read', description: 'Find supported semantic operations. Bounded search by query/domain/effect, including unavailable reasons. Returns IDs, not detailed schemas. Describe selected IDs when you need their schemas; prior description is optional.',
    inputSchema: objectSchema({ version: { type: 'number' }, query: { type: 'string' }, domain: { type: 'string', enum: ['scene', 'spatial', 'camera', 'time', 'activities', 'places', 'surface', 'grids', 'display', 'capture', 'measurements', 'geographic', 'readiness', 'events', 'instruments', 'bookmarks'] }, effects: { type: 'array', maxItems: 4, items: { type: 'string', enum: ['read', 'viewer', 'authoring', 'external'] } }, availableOnly: { type: 'boolean' }, offset: { type: 'number', minimum: 0 }, limit: { type: 'number', minimum: 1, maximum: CAPABILITY_LIMITS.page } }) },
  { name: 'describeCapabilities', effect: 'read', description: 'Describe up to eight exact capability IDs at version 1. Returns their input schemas, scope, units, availability, provenance and permission. Described IDs remain usable for this task until the scene changes. Then invokeCapability with the exact ID and schema-valid input.',
    inputSchema: objectSchema({ ids: { type: 'array', minItems: 1, maxItems: CAPABILITY_LIMITS.selected, items: { type: 'string' } }, version: { type: 'number' } }, ['ids']) },
  { name: 'getOperationResult', effect: 'read', description: 'Inspect an operation receipt by its returned ID, including running, cancelled and failed outcomes. Null means evicted or another viewer; never means success.',
    inputSchema: objectSchema({ id: { type: 'string' } }, ['id']) },
  { name: 'invokeCapability', effect: 'display', description: 'Run one known capability by exact namespaced ID, version 1, and its schema-valid input object. The viewer automatically resolves and validates its schema, permissions and scene before execution. Returns a verified receipt; never retries writes.',
    inputSchema: objectSchema({ id: { type: 'string' }, version: { type: 'number' }, input: { type: 'object' } }, ['id', 'input']) },
];

export function capabilityDomain(name: string, effect: AgentToolEffect): string {
  if (/SpatialContext|GroundPoint|ProbePoint|ObjectState/.test(name)) return 'spatial';
  if (/Event/.test(name)) return 'events';
  if (/Instrument/.test(name)) return 'instruments';
  if (/Bookmark|ViewState/.test(name)) return 'bookmarks';
  if (/Measurement/.test(name)) return 'measurements';
  if (/Geographic|Annotation/.test(name)) return 'geographic';
  if (/Readiness|Ready/.test(name)) return 'readiness';
  if (/Activity|Activities/.test(name)) return 'activities';
  if (/Place|Coordinates/.test(name)) return 'places';
  if (/Imagery|Surface/.test(name)) return 'surface';
  if (/Grid/.test(name)) return 'grids';
  if (effect === 'camera') return 'camera';
  if (effect === 'time') return 'time';
  if (effect === 'export') return 'capture';
  return effect === 'read' || effect === 'selection' ? 'scene' : 'display';
}
const idOf = (def: AgentToolDef) => `${capabilityDomain(def.name, def.effect)}.${def.name}`;
const effectOf = (def: AgentToolDef): CapabilityEffect => def.effect === 'read' ? 'read' : def.effect === 'export' ? 'external' : def.effect === 'authoring' ? 'authoring' : 'viewer';
const fail = (error: string, code: AgentErrorCode = 'invalid-input'): AgentToolResult => ({ ok: false, code, error });
const SCOPE_SCHEMA = objectSchema({ viewer: { type: 'string' }, scene: { type: ['number', 'null'] }, revision: { type: 'number' } }, ['viewer', 'scene', 'revision']);
const TEXT: AgentJsonSchema = { type: 'string' }, NUMBER: AgentJsonSchema = { type: 'number' };
const NULLABLE_RECORD: AgentJsonSchema = { type: ['object', 'null'] };
const RECORDS: AgentJsonSchema = { type: 'array', items: { type: 'object' } };
const STRINGS: AgentJsonSchema = { type: 'array', items: TEXT };
/** Domain envelopes; nested public science metadata retains the native port's projection. */
const READ_OUTPUTS: Readonly<Record<string, AgentJsonSchema>> = {
  getSpatialContext: { type: 'object' }, projectGroundPoint: { type: 'object' }, getProbePoint: NULLABLE_RECORD, getObjectState: NULLABLE_RECORD,
  getEventQueryInfo: { type: 'object' }, getEventResultPage: objectSchema({ status: TEXT, total: NUMBER, offset: NUMBER, nextOffset: { type: ['number', 'null'] }, items: RECORDS, query: { type: 'object' } }), getEventVisualization: { type: 'object' },
  listEventQueries: objectSchema({ items: RECORDS }), getEventSearch: { type: 'object' },
  listEventResults: objectSchema({ total: NUMBER, items: RECORDS }),
  listInstruments: objectSchema({ items: STRINGS }), getInstrument: NULLABLE_RECORD,
  listBookmarks: objectSchema({ items: RECORDS }),
  listPlaceSources: objectSchema({ total: NUMBER, offset: NUMBER, sources: RECORDS }),
  listMeasurements: objectSchema({ selected: { type: ['string', 'null'] }, items: RECORDS }),
  listGeographicLayers: objectSchema({ total: NUMBER, offset: NUMBER, layers: RECORDS }),
  listGeographicFeatures: objectSchema({ total: NUMBER, features: RECORDS }),
  getSurfaceAppearance: objectSchema({ settings: NULLABLE_RECORD, unavailable: { type: ['string', 'null'] } }),
  getReadiness: objectSchema({ scene: { type: ['number', 'null'] }, status: TEXT, request: { type: 'object' }, missing: STRINGS, limitations: STRINGS }),
  describeScene: objectSchema({ scene: NULLABLE_RECORD, time: objectSchema({ et: NUMBER, utc: TEXT, playing: { type: 'boolean' }, rate: NUMBER }),
    selectedObject: { type: ['string', 'null'] }, tracked: { type: ['string', 'null'] }, flight: NULLABLE_RECORD,
    selectedActivity: NULLABLE_RECORD, selectedPlace: NULLABLE_RECORD, objects: objectSchema({ names: STRINGS, total: NUMBER }),
    viewpoints: objectSchema({ names: STRINGS, total: NUMBER }), activities: NUMBER, focusSurfaceData: NULLABLE_RECORD, focusImagery: NULLABLE_RECORD, unsupported: STRINGS }),
  resolve: objectSchema({ candidates: RECORDS, ambiguous: { type: 'boolean' } }, ['candidates', 'ambiguous']),
  searchPlaces: { type: 'array', maxItems: 25, items: { type: 'object' } },
  listActivities: objectSchema({ total: NUMBER, offset: NUMBER, returned: NUMBER, nextOffset: { type: ['number', 'null'] }, complete: { type: 'boolean' },
    sort: TEXT, order: TEXT, missingDuration: NUMBER, activities: RECORDS }, ['total', 'offset', 'returned', 'nextOffset', 'complete', 'activities']),
  getActivity: { type: 'object', properties: { id: TEXT, name: TEXT, kind: TEXT, vehicle: TEXT, body: TEXT, start: NUMBER, end: NUMBER, site: { type: 'object' }, references: { type: 'object' }, provenance: { type: 'object' } }, required: ['id', 'name', 'provenance'] },
  getSurfaceData: objectSchema({ body: TEXT, bodyFrame: { type: ['string', 'null'] }, surface: { type: ['string', 'null'] }, terrain: NULLABLE_RECORD,
    cubeImagery: NULLABLE_RECORD, textures: RECORDS, imageryProducts: RECORDS, overlays: RECORDS }, ['body', 'terrain', 'cubeImagery', 'textures', 'imageryProducts', 'overlays']),
  getImagery: objectSchema({ body: TEXT, surface: { type: ['string', 'null'] }, imageryOnly: { type: 'boolean' }, layers: RECORDS }, ['body', 'layers']),
};
const RECEIPT_SCHEMA: AgentJsonSchema = objectSchema({
  ok: { type: 'boolean' }, summary: { type: 'string' }, data: {}, code: { type: 'string' }, error: { type: 'string' },
  completion: objectSchema({ kind: { type: 'string', enum: ['flight'] }, id: { type: 'number' }, outcome: { type: 'string', enum: ['arrived'] } }, ['kind', 'id', 'outcome']),
  receipt: objectSchema({ id: { type: 'string' }, operation: { type: 'string' }, version: { type: 'number' },
    scope: SCOPE_SCHEMA, task: { type: 'number' }, status: { type: 'string', enum: ['accepted', 'running', 'completed', 'refused', 'partial', 'cancelled', 'stale'] },
    requestedTarget: { type: 'object' }, resolvedTarget: { type: 'object' }, observation: objectSchema({ scope: SCOPE_SCHEMA, state: {} }, ['scope', 'state']), warnings: { type: 'array', items: { type: 'string' } }, provenance: { type: 'string', enum: ['viewer-observation'] }, verification: { type: 'string', enum: ['observed', 'host-return'] },
  }, ['id', 'operation', 'version', 'scope', 'task', 'status', 'requestedTarget', 'resolvedTarget', 'observation', 'warnings', 'provenance', 'verification']),
}, ['ok', 'receipt']);
let instanceSeq = 0;

/** No alternate dispatcher, state store or model-driven permission mechanism. */
export function createCapabilityTools(host: ViewerControl, opts: CapabilityToolsOptions = {}): CapabilityTools {
  const raw = createAgentTools(host, { ...opts, vocabulary: 'catalog', allowExport: true, allowAuthoring: true });
  const instance = ++instanceSeq;
  let revision = 0, sequence = 0, disposed = false;
  const receipts = new Map<string, OperationReceipt>();
  const offLoad = host.on('load', () => { revision++; });
  const scope = (): CapabilityScope => {
    try { return { viewer: `viewer-${instance}`, scene: host.getScene?.()?.id ?? null, revision }; }
    catch { return { viewer: `viewer-${instance}`, scene: null, revision }; }
  };
  const observe = () => {
    try {
      const read = raw.inspect!();
      if (!read.ok) return { scope: scope(), state: null };
      const data = read.data as Record<string, unknown>;
      const state = Object.fromEntries(['scene', 'time', 'selectedObject', 'tracked', 'flight', 'selectedActivity', 'selectedPlace'].map(key => [key, data[key]]));
      const activity = data.selectedActivity as { id: string; name: string } | null;
      const place = data.selectedPlace as { ref: string; name: string; body: string } | null;
      state.selectedActivity = activity ? { id: activity.id, name: activity.name } : null;
      state.selectedPlace = place ? { ref: place.ref, name: place.name, body: place.body } : null;
      const camera = host.getCamera();
      state.camera = { position: camera.position.slice(0, 3), target: camera.target.slice(0, 3), up: camera.up.slice(0, 3), fov: camera.fov };
      state.cameraReference = host.getCameraReference?.() ?? null;
      if (host.getEventVisualization) state.events = eventVisualizationMetadata(host.getEventVisualization());
      return { scope: scope(), state: JSON.parse(JSON.stringify(state)) as unknown };
    }
    catch { return { scope: scope(), state: null }; }
  };
  const definitions = () => agentDefinitions();
  const versionCheck = (version: number = CAPABILITY_VERSION) => {
    if (disposed) throw new Error('Capability catalog disposed');
    if (version !== CAPABILITY_VERSION) throw new Error(`Unsupported capability version ${version}; expected ${CAPABILITY_VERSION}`);
  };
  const summary = (def: ReturnType<typeof definitions>[number]): CapabilitySummary => {
    const id = idOf(def);
    const reason = opts.omitted?.[id] ?? (def.method && typeof host[def.method] !== 'function' ? `Host does not implement ${def.method}`
      : effectOf(def) !== 'read' && (!host.getScene || scope().scene === null) ? 'Scene identity is required for writes'
        : effectOf(def) === 'authoring' && (!opts.allowAuthoring || !opts.confirmAuthoring) ? 'Host authoring permission and confirmation required'
        : effectOf(def) === 'external' && (!opts.allowExternal || !opts.confirmExternal) ? 'Host permission and confirmation required' : null);
    return { id, version: CAPABILITY_VERSION, domain: capabilityDomain(def.name, def.effect), description: def.description.slice(0, 640), effect: effectOf(def), available: reason === null, reason: reason?.slice(0, 640) ?? null };
  };
  const listCapabilities = (query: CapabilityQuery = {}): CapabilityPage => {
    versionCheck(query.version);
    const problem = violation(DISCOVERY[0].inputSchema, query, 'query');
    if (problem) throw new Error(problem);
    if ((query.query?.length ?? 0) > CAPABILITY_LIMITS.query) throw new Error('Search query exceeds 160 characters');
    if ((query.offset !== undefined && !Number.isInteger(query.offset)) || (query.limit !== undefined && !Number.isInteger(query.limit))) throw new Error('Pagination must use integers');
    const words = (query.query ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 24);
    const score = (c: CapabilitySummary) => words.reduce((n, w) => n + (c.id.toLowerCase().includes(w) ? 3 : c.description.toLowerCase().includes(w) ? 1 : 0), 0);
    const all = definitions().map(summary).filter(c => (!query.domain || c.domain === query.domain)
      && (!query.effects || query.effects.includes(c.effect)) && (!query.availableOnly || c.available)
      && (!words.length || score(c) > 0)).sort((a, b) => score(b) - score(a));
    const offset = query.offset ?? 0, limit = query.limit ?? CAPABILITY_LIMITS.page;
    const items = all.slice(offset, offset + limit);
    return { version: CAPABILITY_VERSION, scope: scope(), items, total: all.length, nextOffset: offset + items.length < all.length ? offset + items.length : null };
  };
  const describeCapabilities = (ids: readonly string[], version?: number): readonly CapabilityDescription[] => {
    versionCheck(version);
    const problem = violation(DISCOVERY[1].inputSchema, { ids, ...(version === undefined ? {} : { version }) }, 'input');
    if (problem) throw new Error(problem);
    return ids.map(id => {
      const def = definitions().find(d => idOf(d) === id);
      if (!def) throw new Error(`Unknown capability ${id.slice(0, 160)}`);
      const { method, ...tool } = def;
      const referenceKinds: Record<string, string> = { object: 'object', body: 'object', activity: 'activity', place: 'place', layer: 'imagery' };
      const parameters = VERBS.get(def.name)?.params ?? Object.keys(def.inputSchema.properties ?? {}).flatMap(name => referenceKinds[name] ? [{ name, type: referenceKinds[name] }] : []);
      const references = parameters.filter(p => ['object', 'viewpoint', 'place', 'activity', 'imagery', 'measurement', 'geographic-layer', 'geographic-feature', 'event-query', 'event-result', 'instrument'].includes(p.type))
        .map(p => ({ field: p.name, kind: p.type, scope: 'scene' as const }));
      return { ...summary(def), tool, outputSchema: { ...RECEIPT_SCHEMA, properties: { ...RECEIPT_SCHEMA.properties, data: READ_OUTPUTS[def.name] ?? { description: 'Writes report their resulting state through receipt.observation.' } } }, scope: scope(), references,
        dependencies: method ? [method] : [],
        conventions: 'Time: ET seconds past J2000 or UTC calendar; angles: degrees; distances and camera poses: km. Scene body/frame conventions are authoritative; no implicit coordinate transform. Consult verb parameter descriptions.',
        provenance: 'Scene/catalog declarations and observed runtime state are distinct. Null/withheld provenance, accuracy and coverage remain unknown.',
        permission: ['external', 'authoring'].includes(effectOf(def)) ? 'host-and-confirmation' : 'none' };
    });
  };
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const remember = (receipt: OperationReceipt) => {
    if (disposed) return;
    // Refresh insertion order so a long operation's final result stays inspectable.
    receipts.delete(receipt.id); receipts.set(receipt.id, copy(receipt));
    if (receipts.size > CAPABILITY_LIMITS.receipts) receipts.delete(receipts.keys().next().value!);
    try { opts.onReceipt?.(copy(receipt)); } catch { /* A host observer cannot change an operation's outcome. */ }
  };
  const getOperationResult = (id: string) => { versionCheck(); return copy(receipts.get(id) ?? null); };
  const begin = (): AgentTask => {
    versionCheck();
    const task = raw.begin();
    const bound = scope();
    let busy = false;
    let captureReadiness: { request: ScriptReadinessRequest; ready: boolean } | null = null;
    const wrapped: AgentTask = {
      id: task.id, signal: task.signal, get ended() { return task.ended; }, cancel: () => task.cancel(), finish: () => task.finish(),
      async call(name, input) {
        if (disposed) return fail('Capability catalog disposed', 'cancelled');
        if (task.ended) return fail(`Task ${task.ended}; nothing ran`, task.ended);
        if (bound.revision !== revision || bound.scene !== scope().scene) return fail('Scene changed; discover again', 'stale');
        // Hosts may invoke tasks concurrently; never interleave writes in a task.
        if (busy) return fail('Another operation is running in this task', 'refused');
        let serialized: string;
        try { serialized = JSON.stringify(input); } catch { return fail('Input must be JSON'); }
        if (!serialized || serialized.length > CAPABILITY_LIMITS.inputChars) return fail('Input exceeds JSON size budget');
        const named = definitions().find(d => idOf(d) === name);
        if (named) name = named.name;
        const discovery = DISCOVERY.find(d => d.name === name);
        if (discovery) {
          const problem = violation(discovery.inputSchema, input, 'input');
          if (problem) return fail(problem);
          try {
            const args = input as Record<string, unknown>;
            if (name === 'listCapabilities') return { ok: true, summary: 'Capability page; describe selected IDs to enable their schemas.', data: listCapabilities(args as CapabilityQuery) };
            if (name === 'getOperationResult') return { ok: true, summary: 'Observed operation receipt (null means unavailable).', data: getOperationResult(args.id as string) };
            if (name === 'invokeCapability') {
              versionCheck(args.version as number | undefined);
              const def = definitions().find(d => idOf(d) === args.id);
              return def ? wrapped.call(def.name, args.input) : fail('Unknown capability ID', 'unknown-tool');
            }
            const descriptions = describeCapabilities(args.ids as string[], args.version as number | undefined);
            return { ok: true, summary: 'Selected schemas. Use invokeCapability with the exact ID and schema-valid input. Described IDs remain usable for this task.', data: {
              version: CAPABILITY_VERSION, scope: scope(),
              selected: descriptions.map(({ id, tool, outputSchema, effect, available, reason, references, permission }) => ({ id, name: tool.name, description: tool.description.slice(0, 640), inputSchema: tool.inputSchema, outputDataSchema: outputSchema.properties?.data, effect, available, reason, references, permission })),
              conventions: descriptions[0].conventions, provenance: descriptions[0].provenance,
              output: 'ok/summary/data or ok/code/error, plus receipt: id, operation, version, scope, task, status, requestedTarget, resolvedTarget, observation, warnings, provenance, verification. Inspect getOperationResult for authoritative progress/results. Full output schema is available through the typed host describeCapabilities API.',
            } };
          } catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
        }
        const def = definitions().find(d => d.name === name);
        if (!def) return fail('Unknown capability tool', 'unknown-tool');
        // Schema hydration is deterministic. Discovery is optional, never a
        // model-maintained permission prerequisite. Permissions below still apply.
        const availability = summary(def);
        if (!availability.available) return fail(availability.reason!, 'refused');
        const problem = violation(def.inputSchema, input, 'input');
        if (problem) return fail(`${problem}. Expected input schema: ${JSON.stringify(def.inputSchema)}`);
        if (name === 'waitUntilReady') {
          try { captureReadiness = { request: JSON.parse((input as { json: string }).json) as ScriptReadinessRequest, ready: false }; }
          catch { return fail('Invalid readiness JSON'); }
        }
        if (effectOf(def) === 'external' && captureReadiness) {
          // A model cannot bypass a failed wait with a later export call. Recheck
          // freshness after approval as well, since the person may move/time-seek.
          if (!captureReadiness.ready || host.getReadiness?.(captureReadiness.request).status !== 'ready')
            return fail('Required readiness did not succeed or is no longer current; capture refused', 'refused');
        }
        // Copy only validated primitive reference fields; never retain arbitrary inputs.
        const args = input as Record<string, unknown>;
        const requestedTarget: Record<string, string> = {};
        for (const field of ['object', 'body', 'place', 'activity', 'layer', 'name']) if (typeof args[field] === 'string') requestedTarget[field] = args[field] as string;
        const id = `${instance}:${++sequence}`;
        let receipt: OperationReceipt = { id, operation: idOf(def), version: CAPABILITY_VERSION, scope: bound, task: task.id, status: 'accepted',
          requestedTarget, resolvedTarget: {}, observation: observe(), warnings: [], provenance: 'viewer-observation', verification: 'host-return' };
        busy = true;
        remember(receipt);
        let result: AgentToolResult;
        try {
          let confirmed = true;
          if (effectOf(def) === 'authoring') confirmed = await opts.confirmAuthoring!(idOf(def), JSON.parse(serialized));
          if (effectOf(def) === 'external') confirmed = await opts.confirmExternal!(idOf(def), JSON.parse(serialized));
          if (!confirmed) result = fail('Host confirmation declined', 'refused');
          else if (task.ended || bound.revision !== revision) result = fail('Task ended while awaiting confirmation', task.ended ?? 'stale');
          else if (effectOf(def) === 'external' && captureReadiness && host.getReadiness?.(captureReadiness.request).status !== 'ready') result = fail('Readiness changed while awaiting approval; capture refused', 'refused');
          else {
            receipt = { ...receipt, status: 'running' }; remember(receipt);
            result = await task.call(name, JSON.parse(serialized));
            if (result.ok && ['authoring', 'external'].includes(effectOf(def))) result = {
              ...result, summary: `${result.summary} Trusted UI/host approval was granted for this exact call.`,
            };
          }
        } catch { result = fail('Operation could not complete', 'failed'); }
        finally { busy = false; }
        if (name === 'waitUntilReady' && captureReadiness) captureReadiness.ready = result.ok;
        const observation = observe();
        // Features without a shared semantic read remain explicitly unverified (#297).
        const hasReadback = def.effect === 'read' || (result.ok && result.completion?.kind === 'flight')
          || ['select', 'deselect', 'track', 'untrack', 'setTime', 'setTimeRate', 'setPlaying', 'showImagery', 'setImageryOpacity'].includes(name)
          || (name === 'gotoPlace' && typeof host.getSelectedPlace === 'function')
          || (name === 'selectActivity' && typeof host.getSelectedActivity === 'function')
          || (name === 'seekActivity' && typeof host.listActivities === 'function')
          || (name === 'focusEventResult' && typeof host.getEventVisualization === 'function');
        const verified = observation.state !== null && hasReadback;
        const eventPartial = name === 'focusEventResult' && (observation.state as { events?: { status: string } } | null)?.events?.status !== 'observed';
        const status: OperationStatus = result.ok ? verified && !eventPartial ? 'completed' : 'partial' : result.code === 'stale' ? 'stale'
          : ['cancelled', 'superseded', 'interrupted'].includes(result.code) ? 'cancelled'
            : result.code === 'failed' ? 'partial' : 'refused';
        const resolvedTarget: Record<string, string> = {};
        const referenceWarnings: string[] = [];
        // Resolving identity is distinct from claiming the desired state held.
        if (observation.scope.revision === bound.revision) {
          for (const [field, value] of Object.entries(requestedTarget)) {
            try {
              if ((field === 'object' || field === 'body') && host.listObjects().includes(value)) resolvedTarget[field] = value;
              else if (field === 'activity' && host.listActivities?.().some(a => a.id === value)) resolvedTarget[field] = value;
              else if (field === 'place' && host.getPlace?.(value)?.ref === value) resolvedTarget[field] = value;
              else if (field === 'name' && host.listViewpoints().includes(value)) resolvedTarget[field] = value;
              else if (field === 'layer' && typeof args.object === 'string' && host.getImagery?.(args.object)?.layers.some(l => l.id === value)) resolvedTarget[field] = value;
            } catch { referenceWarnings.push(`Could not verify reference field ${field}`); }
          }
        }
        receipt = { ...receipt, status: result.ok && referenceWarnings.length ? 'partial' : status, resolvedTarget, observation, verification: verified ? 'observed' : 'host-return', warnings: [...(eventPartial && result.ok ? ['Event selection was applied; timeline or rendered event geometry has only partial readback. Inspect getEventVisualization before capture.'] : []), ...(observation.state === null ? ['Resulting viewer state could not be observed; the underlying tool result is retained but does not establish verified state.'] : []), ...(result.ok ? hasReadback ? [] : ['Host returned successfully; this operation lacks a shared semantic readback. See #297.'] : [result.error]), ...referenceWarnings] };
        remember(receipt);
        return { ...result, receipt };
      },
    };
    const perform = wrapped.call;
    wrapped.call = async (name, input) => {
      let result: AgentToolResult;
      try { result = await perform(name, input); }
      catch { result = fail('Operation observation failed; inspect current state before continuing', 'failed'); }
      if (result.receipt || DISCOVERY.some(d => d.name === name)) return result;
      const def = definitions().find(d => d.name === name);
      const receipt: OperationReceipt = {
        id: `${instance}:${++sequence}`, operation: def ? idOf(def) : `unknown.${name.slice(0, 160)}`,
        version: CAPABILITY_VERSION, scope: bound, task: task.id,
        status: !result.ok && result.code === 'stale' ? 'stale' : !result.ok && ['cancelled', 'superseded', 'interrupted'].includes(result.code) ? 'cancelled' : !result.ok && result.code === 'failed' ? 'partial' : 'refused',
        requestedTarget: {}, resolvedTarget: {}, observation: observe(), warnings: result.ok ? [] : [result.error],
        provenance: 'viewer-observation', verification: 'host-return',
      };
      if (!disposed) remember(receipt);
      return { ...result, receipt };
    };
    return wrapped;
  };
  const api: CapabilityTools = {
    list: () => { versionCheck(); return [...(opts.surface === 'fixed' ? defaultAskDefinitions().filter(d => (!d.method || typeof host[d.method] === 'function') && !opts.omitted?.[idOf(d)]) : [definitions().find(d => d.name === 'describeScene')!]), ...DISCOVERY.map(d => d.name === 'invokeCapability' ? { ...d, description: `${d.description} Compact registry IDs: ${definitions().map(def => `${idOf(def)}(${Object.keys(def.inputSchema.properties ?? {}).map(key => `${key}${def.inputSchema.required?.includes(key) ? '' : '?'}`).join(',')})`).join(', ')}.` } : d)]; },
    inspect: () => { versionCheck(); return raw.inspect!(); }, listCapabilities, describeCapabilities, getOperationResult, begin,
    call: async (name, input) => { const task = begin(); try { return await task.call(name, input); } finally { task.finish(); } },
    cancel: () => raw.cancel(),
    dispose: () => { disposed = true; offLoad(); raw.dispose(); receipts.clear(); },
  };
  return api;
}
