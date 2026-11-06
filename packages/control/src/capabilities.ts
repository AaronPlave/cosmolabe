/** Discoverable, instance-bound rendering of the existing control vocabulary (#328). */
import { agentDefinitions, createAgentTools, normalizeInput, violation, type AgentDefinition, type AgentErrorCode, type AgentJsonSchema, type AgentTask, type AgentToolDef, type AgentToolResult, type AgentTools, type AgentToolsOptions } from './agent.js';
import type { OperationContract } from './verbs.js';
import type { StateDomain } from './outcome.js';
import { eventVisualizationMetadata } from './event-agent-metadata.js';
import type { ScriptReadinessRequest, ViewerControl } from './contracts.js';
import { VERBS } from './verbs.js';

export const CAPABILITY_VERSION = 1;
export const CAPABILITY_LIMITS = { page: 12, selected: 8, query: 160, receipts: 64, inputChars: 16000, index: 8000 } as const;
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
  /** 'host' retains allowAuthoring; destructive input variants also need confirmation. */
  readonly permission: 'none' | 'host' | 'host-and-confirmation';
  /** The operation's own usage notes, from its contract. */
  readonly guide: string | null;
  /** From the operation's contract: what it changes and how its result is observed. */
  readonly behaviour: {
    readonly writes: readonly StateDomain[];
    /** Its result is checked by predicates over these reads; null when it cannot be observed. */
    readonly observedBy: readonly string[] | null;
    readonly unobservable: string | null;
    /** Some input variants destroy saved state (exact-call confirmation). */
    readonly destructiveVariants: boolean;
    /** Safe to repeat for reads; writes are never retried automatically either way. */
    readonly idempotent: boolean;
  };
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
  /** Trusted permission for local definitions; never inferred from the model or catalog. */
  readonly allowAuthoring?: boolean;
  /** Required for deletion/replacement/whole-state restore, not routine local edits. */
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
export const DEFAULT_ASK_DIRECT = ['describeScene', 'resolve', 'getEventSearchOptions', 'getSpatialContext', 'composeView', 'checkGoal'] as const;
export function defaultAskDefinitions() {
  return agentDefinitions().filter(d => (DEFAULT_ASK_DIRECT as readonly string[]).includes(d.name));
}

const objectSchema = (properties: Record<string, AgentJsonSchema>, required: string[] = []): AgentToolDef['inputSchema'] =>
  ({ type: 'object', properties, required, additionalProperties: false });
const DISCOVERY: readonly AgentToolDef[] = [
  { name: 'listCapabilities', effect: 'read', description: 'Find supported semantic operations. Bounded search by query/domain/effect, including unavailable reasons. Returns IDs, not detailed schemas. Describe selected IDs when you need their schemas; prior description is optional.',
    inputSchema: objectSchema({ version: { type: 'number' }, query: { type: 'string' }, domain: { type: 'string' }, effects: { type: 'array', maxItems: 4, items: { type: 'string', enum: ['read', 'viewer', 'authoring', 'external'] } }, availableOnly: { type: 'boolean' }, offset: { type: 'number', minimum: 0 }, limit: { type: 'number', minimum: 1, maximum: CAPABILITY_LIMITS.page } }) },
  { name: 'describeCapabilities', effect: 'read', description: 'Describe up to eight exact capability IDs at version 1. Returns their input schemas, scope, units, availability, provenance and permission. Described IDs remain usable for this task until the scene changes. Then invokeCapability with the exact ID and schema-valid input.',
    inputSchema: objectSchema({ ids: { type: 'array', minItems: 1, maxItems: CAPABILITY_LIMITS.selected, items: { type: 'string' } }, version: { type: 'number' } }, ['ids']) },
  { name: 'getOperationResult', effect: 'read', description: 'Inspect an operation receipt by its returned ID, including running, cancelled and failed outcomes. Null means evicted or another viewer; never means success.',
    inputSchema: objectSchema({ id: { type: 'string' } }, ['id']) },
  { name: 'invokeCapability', effect: 'display', description: 'Run one known capability by exact namespaced ID, version 1, and its schema-valid input object. The viewer automatically resolves and validates its schema, permissions and scene before execution. Returns a verified receipt; never retries writes.',
    inputSchema: objectSchema({ id: { type: 'string' }, version: { type: 'number' }, input: { type: 'object' } }, ['id', 'input']) },
];

/** An operation's ID namespace, from its own contract. */
export const capabilityDomain = (def: AgentDefinition): string => def.contract.namespace;
const idOf = (def: AgentDefinition) => `${def.contract.namespace}.${def.name}`;
// Destructive variants are the operation's own declaration. Malformed JSON is
// never treated as a reversible edit; normal validation still runs below.
const destructiveEdit = (def: AgentDefinition, input: unknown): boolean => {
  try { return def.contract.destructive?.(input as Record<string, unknown>) ?? false; } catch { return true; }
};
const effectOf = (def: AgentToolDef): CapabilityEffect => def.effect === 'read' ? 'read' : def.effect === 'export' ? 'external' : def.effect === 'authoring' ? 'authoring' : 'viewer';
const fail = (error: string, code: AgentErrorCode = 'invalid-input'): AgentToolResult => ({ ok: false, code, error });
const SCOPE_SCHEMA = objectSchema({ viewer: { type: 'string' }, scene: { type: ['number', 'null'] }, revision: { type: 'number' } }, ['viewer', 'scene', 'revision']);
const TEXT: AgentJsonSchema = { type: 'string' }, NUMBER: AgentJsonSchema = { type: 'number' };
const NULLABLE_RECORD: AgentJsonSchema = { type: ['object', 'null'] };
const RECORDS: AgentJsonSchema = { type: 'array', items: { type: 'object' } };
const STRINGS: AgentJsonSchema = { type: 'array', items: TEXT };
const PROFILE_DATA_OUTPUT = objectSchema({ scene: { type: ['number', 'null'] }, id: TEXT, status: TEXT,
  quantity: { type: ['string', 'null'] }, unit: { type: ['string', 'null'] }, bodies: NULLABLE_RECORD,
  requestedWindow: { type: 'object' }, window: NULLABLE_RECORD, samples: { type: 'array', maxItems: 32, items: { type: 'object' } },
  missing: NUMBER, gaps: RECORDS, minimum: NULLABLE_RECORD, maximum: NULLABLE_RECORD, sampling: { type: 'object' }, limitations: STRINGS });
/** Domain envelopes; nested public science metadata retains the native port's projection. */
const READ_OUTPUTS: Readonly<Record<string, AgentJsonSchema>> = {
  getProfileValue: PROFILE_DATA_OUTPUT,
  sampleProfileData: PROFILE_DATA_OUTPUT,
  getProfileOptions: objectSchema({ quantities: RECORDS, window: { type: 'object' }, limitations: STRINGS }),
  listProfiles: objectSchema({ scene: { type: ['number','null'] }, total: NUMBER, items: RECORDS }),
  getProfile: objectSchema({ scene: { type: ['number','null'] }, status: TEXT, definition: NULLABLE_RECORD, resolved: NULLABLE_RECORD, timeline: { type: 'object' }, limitations: STRINGS }),
  findTrajectoryExtrema: objectSchema({ status:TEXT,results:RECORDS,faults:RECORDS },['status','results','faults']),
  getViewComposition: objectSchema({ et: NUMBER, playing: { type: 'boolean' }, tracked: { type: ['string', 'null'] }, orbitDistanceKm: NUMBER, fovDeg: NUMBER, objects: RECORDS }),
  checkGoal: objectSchema({ kind: TEXT, status: { type: 'string', enum: ['met', 'partial', 'unmet', 'inconclusive'] }, checks: RECORDS }, ['kind', 'status', 'checks']),
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
  getSurfaceData: objectSchema({ body: TEXT, referenceShape:NULLABLE_RECORD, bodyFrame: { type: ['string', 'null'] }, surface: { type: ['string', 'null'] }, terrain: NULLABLE_RECORD,
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
    const blockedNavigation = def.name === 'navigateToAnalysisResult' ? ['time.setTime','time.setPlaying','scene.select','camera.frameObject'].find(operation => opts.omitted?.[operation]) : undefined;
    const reason = opts.omitted?.[id] ?? (blockedNavigation ? `Result navigation requires ${blockedNavigation}: ${opts.omitted![blockedNavigation]}` : undefined) ?? (def.method && typeof host[def.method] !== 'function' ? `Host does not implement ${def.method}`
      : effectOf(def) !== 'read' && (!host.getScene || scope().scene === null) ? 'Scene identity is required for writes'
        : def.requiresAuthoring && !opts.allowAuthoring ? 'Host authoring permission required'
        : effectOf(def) === 'authoring' && (!opts.allowAuthoring || !opts.confirmAuthoring) ? 'Host authoring permission and confirmation required'
        : effectOf(def) === 'external' && (!opts.allowExternal || !opts.confirmExternal) ? 'Host permission and confirmation required' : null);
    return { id, version: CAPABILITY_VERSION, domain: capabilityDomain(def), description: def.description.slice(0, 640), effect: effectOf(def), available: reason === null, reason: reason?.slice(0, 640) ?? null };
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
        permission: ['external', 'authoring'].includes(effectOf(def)) ? 'host-and-confirmation' : def.requiresAuthoring ? 'host' : 'none',
        guide: def.contract.guide ?? null, behaviour: behaviour(def.contract) };
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
      id: task.id, signal: task.signal, get ended() { return task.ended; }, get taken() { return task.taken; }, cancel: () => task.cancel(), finish: () => task.finish(),
      async call(name, input) {
        if (disposed) return fail('Capability catalog disposed', 'cancelled');
        if (task.ended) return fail(`Task ${task.ended}; nothing ran`, task.ended);
        if (bound.revision !== revision || bound.scene !== scope().scene) return fail('Scene changed; discover again', 'stale');
        // Hosts may invoke tasks concurrently; never interleave writes in a task.
        if (busy) return fail('Another operation is running in this task', 'refused');
        const known = definitions().find(d => idOf(d) === name || d.name === name);
        if (known) input = normalizeInput(known.inputSchema, input);
        else if (name === 'invokeCapability' && input && typeof input === 'object') {
          const target = definitions().find(d => idOf(d) === (input as { id?: unknown }).id);
          if (target) input = { ...(input as object), input: normalizeInput(target.inputSchema, (input as { input?: unknown }).input ?? {}) };
        }
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
              selected: descriptions.map(({ id, tool, outputSchema, effect, available, reason, references, permission, guide }) => ({ id, name: tool.name, description: tool.description.slice(0, 640), inputSchema: tool.inputSchema, outputDataSchema: outputSchema.properties?.data, effect, available, reason, references, permission, ...(guide ? { guide } : {}) })),
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
          const needsAuthoringConfirmation = effectOf(def) === 'authoring' || (def.requiresAuthoring && destructiveEdit(def, input));
          if (needsAuthoringConfirmation) confirmed = opts.confirmAuthoring ? await opts.confirmAuthoring(idOf(def), JSON.parse(serialized)) : false;
          if (effectOf(def) === 'external') confirmed = await opts.confirmExternal!(idOf(def), JSON.parse(serialized));
          if (!confirmed) result = fail(needsAuthoringConfirmation && !opts.confirmAuthoring ? 'Host confirmation required' : 'Host confirmation declined', 'refused');
          else if (task.ended || bound.revision !== revision) result = fail('Task ended while awaiting confirmation', task.ended ?? 'stale');
          else if (effectOf(def) === 'external' && captureReadiness && host.getReadiness?.(captureReadiness.request).status !== 'ready') result = fail('Readiness changed while awaiting approval; capture refused', 'refused');
          else {
            receipt = { ...receipt, status: 'running' }; remember(receipt);
            result = await task.call(name, JSON.parse(serialized));
            if (result.ok && (needsAuthoringConfirmation || effectOf(def) === 'external')) result = {
              ...result, summary: `${result.summary} Trusted UI/host approval was granted for this exact call.`,
            };
          }
        } catch { result = fail('Operation could not complete', 'failed'); }
        finally { busy = false; }
        if (name === 'waitUntilReady' && captureReadiness) captureReadiness.ready = result.ok;
        const observation = observe();
        // Completed means observed: a read's own data, or a write whose contract's
        // predicates the viewer reports met. Anything else is partial, never completed.
        const outcome = result.outcome;
        const verified = observation.state !== null && result.ok && (effectOf(def) === 'read' ? true : outcome?.report?.status === 'met');
        const status: OperationStatus = result.ok ? verified ? 'completed' : 'partial' : result.code === 'stale' ? 'stale'
          : ['cancelled', 'superseded', 'interrupted'].includes(result.code) ? 'cancelled'
            : result.code === 'failed' ? 'partial' : 'refused';
        const outcomeWarnings = !result.ok || effectOf(def) === 'read' ? [] : !outcome?.report ? [`Not observable: ${outcome?.unobservable ?? 'no result declared'}.`]
          : outcome.report.status === 'met' ? [] : [`Viewer check ${outcome.report.status}: ${outcome.report.checks.filter(c => c.ok !== true).map(c => c.detail).join('; ')}.`];
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
        receipt = { ...receipt, status: result.ok && referenceWarnings.length ? 'partial' : status, resolvedTarget, observation, verification: verified ? 'observed' : 'host-return', warnings: [...(observation.state === null ? ['Resulting viewer state could not be observed; the underlying tool result is retained but does not establish verified state.'] : []), ...(result.ok ? outcomeWarnings : [result.error]), ...referenceWarnings] };
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
  const direct = () => opts.surface === 'fixed' ? defaultAskDefinitions().filter(d => (!d.method || typeof host[d.method] === 'function') && !opts.omitted?.[idOf(d)]) : [definitions().find(d => d.name === 'describeScene')!];
  const signature = (def: AgentDefinition) => `${idOf(def)}${def.contract.guide ? '*' : ''}(${Object.entries(def.inputSchema.properties ?? {}).map(([key, prop]) => `${key}${def.inputSchema.required?.includes(key) ? '' : '?'}:${Array.isArray(prop.type) ? prop.type.join('|') : prop.type ?? 'json'}${prop.enum ? '=' + prop.enum.join('|') : ''}${key === 'reference' ? '=JSON{scene,query,id,revision}' : ''}${prop.maximum !== undefined ? '<=' + prop.maximum : ''}`).join(',')})`;
  /**
   * The registry index the model sees, within a fixed budget however many
   * operations are registered: entries in registration order (built-ins
   * first) until the budget, then a count of the rest, which stay findable
   * through listCapabilities and invocable by ID.
   */
  const index = () => {
    const entries: string[] = [];
    let used = 0;
    const all = definitions();
    for (const def of all) {
      const entry = signature(def);
      if (used + entry.length + 2 > CAPABILITY_LIMITS.index) break;
      entries.push(entry); used += entry.length + 2;
    }
    const rest = all.length - entries.length;
    return `Compact registry IDs (* has usage notes: describe it before first use): ${entries.join(', ')}${rest ? `, and ${rest} more: find them with listCapabilities` : ''}.`;
  };
  const api: CapabilityTools = {
    list: () => { versionCheck(); return [...direct(), ...DISCOVERY.map(d => d.name === 'invokeCapability' ? { ...d, description: `${d.description} ${index()}` } : d)]; },
    inspect: () => { versionCheck(); return raw.inspect!(); }, verify: goal => { versionCheck(); return raw.verify!(goal); }, listCapabilities, describeCapabilities, getOperationResult, begin,
    contractOf: (name, input) => {
      if (DISCOVERY.some(d => d.name === name && d.name !== 'invokeCapability')) return { namespace: 'scene', writes: [] };
      const id = name === 'invokeCapability' ? (input as { id?: unknown } | null)?.id : name;
      return definitions().find(d => idOf(d) === id || d.name === id)?.contract ?? null;
    },
    readable: method => raw.readable?.(method) ?? false,
    preflight: (name, input, held) => {
      const def = name === 'invokeCapability' ? definitions().find(d => idOf(d) === (input as { id?: unknown } | null)?.id) : definitions().find(d => d.name === name || idOf(d) === name);
      return def ? raw.preflight?.(def.name, name === 'invokeCapability' ? (input as { input?: unknown }).input : input, held) ?? null : null;
    },
    // Notes for the directly offered tools only, so the prompt stays bounded; every other operation's notes come from the same registry: with a read in its namespace, a description, or its first use.
    guides: namespace => (namespace ? definitions().filter(d => d.contract.namespace === namespace) : direct()).filter(d => d.contract.guide && summary(d).available).map(d => ({ name: d.name, guide: d.contract.guide! })),
    call: async (name, input) => { const task = begin(); try { return await task.call(name, input); } finally { task.finish(); } },
    cancel: () => raw.cancel(),
    dispose: () => { disposed = true; offLoad(); raw.dispose(); receipts.clear(); },
  };
  return api;
}

function behaviour(c: OperationContract): CapabilityDescription['behaviour'] {
  const reads = c.writes.length === 0;
  return { writes: c.writes, observedBy: reads ? [] : c.unobservable ? null : [...new Set(['the viewer\'s shared reads', ...(c.observes ?? [])])],
    unobservable: reads ? null : c.unobservable ?? null, destructiveVariants: !!c.destructive, idempotent: reads || !!c.idempotent };
}
