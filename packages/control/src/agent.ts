import { EVENT_ROLES } from '@cosmolabe/core';
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
  ScriptEventReference,
  ScriptCancelSignal,
  ScriptEventMap,
  ScriptTime,
  ScriptVec3,
  ScriptViewComposition,
  Statement,
  VerbValue,
  ViewerControl,
} from './contracts.js';
import type { TrajectoryExtremaQuery } from '@cosmolabe/interop';
import { ScriptRuntimeError } from './errors.js';
import { execute } from './execute.js';
import { eventQueryMetadata, eventPageMetadata, eventVisualizationMetadata } from './event-agent-metadata.js';
import { agentMetadata, type AgentMetadataPolicy } from './agent-metadata.js';
import { quote } from './snapshot.js';
import { suggest } from './suggest.js';
import { VERBS, type OperationContract, type VerbParam, type VerbSpec } from './verbs.js';
import type { OperationReceipt } from './capabilities.js';
import { evaluate, parsePredicate, preconditionProblem, PREDICATE_KINDS, type GoalReport, type Predicate, type StateDomain } from './outcome.js';

type FlightEnd = ScriptEventMap['flightEnd'];

const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** The model-facing composition: rounded, no fields it cannot use. */
export function compositionData(v: ScriptViewComposition) {
  return { et: v.et, playing: v.playing, tracked: v.tracked, orbitDistanceKm: r3(v.orbitDistanceKm), fovDeg: r3(v.fovDeg),
    objects: v.objects.map(o => !o.available ? { object: o.object, available: false } : {
      object: o.object, inView: o.inView, rangeKm: o.rangeKm === null ? null : r3(o.rangeKm), angularRadiusDeg: o.angularRadiusDeg === null ? null : r3(o.angularRadiusDeg),
      bearingDeg: o.bearingDeg?.map(r3) ?? null, hiddenBy: o.occlusion ? `${o.occlusion.by} (${o.occlusion.kind})` : null }) };
}
/** One plain sentence about where the named objects are. */
export function compositionSentence(v: ScriptViewComposition): string {
  return v.objects.map(o => !o.available ? `${o.object} is not in this scene`
    : `${o.object} ${o.inView ? 'in view' : 'out of view'}${o.rangeKm !== null ? ` at ${o.rangeKm < 1 ? `${r3(o.rangeKm * 1000)} m` : `${r3(o.rangeKm)} km`}` : ''}${o.occlusion ? `, ${o.occlusion.kind === 'full' ? 'hidden' : 'partly hidden'} behind ${o.occlusion.by}` : ''}`).join('; ') + '.';
}

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
  readonly requiresAuthoring?: boolean;
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
) & { readonly receipt?: OperationReceipt; readonly outcome?: OperationOutcome; readonly facts?: readonly ResultFact[] };

/**
 * What a write left, judged by its own contract: the predicates it had to
 * leave and the viewer's check of them. No predicates means its result cannot
 * be observed (`unobservable` says why): such a call is never verified.
 */
export interface OperationOutcome {
  readonly writes: readonly StateDomain[];
  readonly expected: readonly Predicate[];
  readonly report: GoalReport | null;
  readonly unobservable: string | null;
}

/**
 * A number or classification a read published, typed so an answer can be
 * checked against it: a measured range, an epoch, whether a range minimum is
 * an encounter and by which criterion.
 */
export type ResultFact = EventResultFact | { readonly kind: 'event-window'; readonly query: string; readonly startUtc: string; readonly endUtc: string; readonly maxRangeKm: number | null };
export interface EventResultFact {
  readonly kind: 'event-result';
  readonly query: string;
  readonly id: string;
  readonly observer: string | null;
  readonly target: string | null;
  readonly utc: string | null;
  readonly rangeKm: number | null;
  readonly altitudeKm: number | null;
  readonly encounter: boolean | null;
  readonly criterion: string | null;
  /** The body whose sphere of influence the criterion uses. */
  readonly criterionBody: string | null;
  readonly thresholdKm: number | null;
}

/** A sequence of calls made for one request; see `AgentTools.begin`. */
export interface AgentTask {
  readonly id: number;
  /** Fires when the task is cancelled, superseded or its scene goes. */
  readonly signal: ScriptCancelSignal;
  /** Why the task can no longer act, or null while it can. */
  readonly ended: AgentErrorCode | null;
  /** The person moved the camera / the clock themselves during this task. */
  readonly taken?: { readonly camera: boolean; readonly time: boolean };
  call(name: string, input: unknown): Promise<AgentToolResult>;
  /** Stop the task: a flight it is waiting on is stopped, later calls refused. */
  cancel(): void;
  /** Release the task without stopping anything it started. */
  finish(): void;
}

export interface AgentTools {
  /** Immediate bounded observation; does not begin/supersede a task. */
  inspect?(): AgentToolResult;
  /** The host's own check of predicates, outside any task's budget: what the loop runs before an answer stands. */
  verify?(predicates: readonly Predicate[]): GoalReport;
  /** The contract of the operation a call would run (resolving a discovery bridge), or null for an unknown one. */
  contractOf?(name: string, input: unknown): OperationContract | null;
  /** Usage notes of the operations this viewer offers now, by name: the planner's feature guidance. */
  guides?(): readonly { name: string; guide: string }[];
  /** Whether a `state` predicate may read this method on this viewer. */
  readable?(method: string): boolean;
  /** Why a write would contradict what the conversation holds, judged before it runs; null when nothing held speaks to it. */
  preflight?(name: string, input: unknown, held: readonly Predicate[]): string | null;
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
  { verb: 'circleCenterRight', effect: 'camera' },
  { verb: 'circleCenterLeft', effect: 'camera' },
  { verb: 'circleCenterUp', effect: 'camera' },
  { verb: 'circleCenterDown', effect: 'camera' },
  { verb: 'dolly', effect: 'camera' },
  { verb: 'composeView', effect: 'camera' },
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

/** The curated verb names, for parity checks against `VERBS`. */
export const CURATED_AGENT_VERBS: readonly string[] = AGENT_VERBS.map(v => v.verb);

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
  for (const p of spec.params) properties[p.name] = p.name === 'reference' ? { ...paramSchema(p), description: 'JSON text of the complete run reference {scene,query,id,revision} returned by getEventResultPage; never a bare event ID.' } : paramSchema(p);
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

/** A registered operation: the tool a model sees, the port method it needs and its contract. */
export type AgentDefinition = AgentToolDef & { readonly method?: keyof ViewerControl; readonly contract: OperationContract };

const READ_TOOLS: readonly AgentDefinition[] = [
  { name: 'getTimelineWindow', effect: 'read', method: 'getTimelineWindow', contract: { namespace: 'time', writes: [] }, description: 'The timeline\'s visible window, ET and UTC. Moves nothing.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'getViewComposition', contract: { namespace: 'camera', writes: [] }, effect: 'read', method: 'getViewComposition', description: 'Where named objects are in the current view: in view or not, screen position, bearing from the view centre, distance from the camera, apparent size, and whether a nearer body hides them. Moves nothing. Geometry, not pixels.', inputSchema: { type: 'object', properties: { objects: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 } }, required: ['objects'], additionalProperties: false } },
  { name: 'checkGoal', effect: 'read', description: 'State and check what the person asked for that your actions do not already imply, as an AND of typed predicates read from the viewer: e.g. keep Psyche close AND Mars in view is [{p:"range",object:"Psyche",maxKm:1},{p:"inView",object:"Mars"},{p:"legible",object:"Mars"}]; a flyby request is {p:"eventSelected",query,pick:"closest",encounter:true}. Every change you make already holds itself to its own result (select → selected), and the conversation keeps earlier requests\' predicates: a new one on the same slot replaces the old, moving the camera to another subject retires earlier camera predicates, and release (slot names from earlier results, e.g. "range:Psyche") drops ones the person gave up. Returns met, partial (drawing, data or legible size not yet observed), unmet or inconclusive for the whole held goal. Predicates: selected/tracked {object|null}; inView/legible {object}; range {object,maxKm?,minKm?}; epoch {et|utc}; paused {value}; rate {value}; activity/place {id}; eventQuery/eventRun/eventEpoch/eventFramed/eventDrawn {query}; eventSelected {query,id?,pick?,encounter?}; probeUnder/featureUnder {object}; featureSelected {layer?,feature?}; ready {kind,body?,layer?}; state {read,args,path,equals} over a registered read. At most three checks per request.', inputSchema: { type: 'object', additionalProperties: false, properties: {
    require: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['p'], properties: {
      p: { type: 'string', enum: [...PREDICATE_KINDS] }, object: { type: ['string', 'null'] }, maxKm: { type: 'number' }, minKm: { type: 'number' }, et: { type: 'number' }, utc: { type: 'string' },
      value: { type: ['boolean', 'number'] }, query: { type: 'string' }, id: { type: ['string', 'null'] }, pick: { type: 'string', enum: ['closest'] }, encounter: { type: 'boolean' },
      framing: { type: 'string', enum: ['pair', 'target'] }, layer: { type: 'string' }, feature: { type: 'string' }, read: { type: 'string' }, args: { type: 'array' }, path: { type: 'string' }, equals: {},
      kind: { type: 'string', enum: ['assets', 'imagery', 'cube-base', 'terrain'] }, body: { type: 'string' }, policy: { type: 'string', enum: ['rendered', 'reference', 'terrain'] },
    } } },
    release: { type: 'array', maxItems: 12, items: { type: 'string' }, description: 'Held predicates the person explicitly gave up, by slot (e.g. "range:Psyche", "view:Mars", "clock").' },
  } }, contract: { namespace: 'scene', writes: [] } },
  { name: 'getSpatialContext', contract: { namespace: 'spatial', writes: [], guide: 'For "top of a body", the north pole and the top of the visible disc differ: ask when ambiguous. Take reference shape and body-fixed frame from this read, never from memory. It is body-scoped: check a saved feature on its layer\'s body (Mars), not on the vehicle above it (Ingenuity).' }, effect: 'read', method: 'getSpatialContext', description: 'Small targeted entity/body read: exact epoch, active parent, state in parent body-fixed frame, availability, supported reference shape and Draw coordinate/frame conventions, compatible editable layer. Use own coordinates for a point ON this body; parentCoordinates are for ground projection UNDER this entity. Use before creating points; no existing layer is not an impossibility. No large scene inventory.', inputSchema: { type: 'object', properties: { object: { type: 'string' } }, required: ['object'], additionalProperties: false } },
  { name: 'getObjectState', contract: { namespace: 'spatial', writes: [] }, effect: 'read', method: 'getObjectState', description: 'Targeted actual entity position/attitude and source availability at one epoch/frame/centre. No trajectory sampling, scene summary or camera pixels. Missing frame/coverage remains unavailable.', inputSchema: { type: 'object', properties: { object: { type: 'string' }, et: { type: 'number' }, frame: { type: 'string' }, center: { type: 'string' } }, required: ['object'], additionalProperties: false } },
  { name: 'projectGroundPoint', contract: { namespace: 'spatial', writes: [] }, effect: 'read', method: 'projectGroundPoint', description: 'Compute a radial sub-point of an entity’s actual current position on its active parent, through existing frame and surface authorities. rendered (default) uses drawn authoritative surfaces, reference is explicitly sphere/ellipsoid-only, terrain refuses without physical terrain evidence. Never uses camera pixels or mission-site coordinates. Preserves clock/camera. Use pinGroundPoint for a transient marker; saved annotations require host authoring permission.', inputSchema: { type: 'object', properties: { object: { type: 'string' }, policy: { type: 'string', enum: ['rendered','reference','terrain'] } }, required: ['object'], additionalProperties: false } },
  { name: 'getProbePoint', contract: { namespace: 'spatial', writes: [] }, effect: 'read', method: 'getProbePoint', description: 'Small read of the actual Point Probe pin, including UI-originated pins, placement epoch, fixed-frame position, source/datum, physical-terrain evidence and native observed draw state. A pin is transient display; absent means none, not no ground projection capability.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'getEventSearchOptions', contract: { namespace: 'events', writes: [] }, effect: 'read', method: 'getEventSearchOptions', description: 'For show-when/flew-past/closest-approach requests, discover built-in event kinds, participant roles, defaults and loaded-kernel coverage for a computed encounter (authored viewpoint dates do not compute it). Use exact kind closest-approach for range minima. Supply kind and bodies to assess coverage and a supported suggestedWindow. Catalog window alone never proves coverage. Numerical altitude/terrain searches may use it as an explicit Time window, with authoritative trajectory/terrain coverage checked during sampling; they do not use SPICE GF coverage. A suggested interval may be approximate; the solver remains authoritative. upsertEventQuery takes definition as JSON text {id,label,enabled:true,visible:true,query:{id,kind,bodies,window,step,abcorr,params}} using the host permissions for routine scene analysis; no repeated confirmation.', inputSchema: { type: 'object', properties: { kind: { type: 'string' }, bodies: { type: 'object', properties: Object.fromEntries(EVENT_ROLES.map(role => [role, { type: 'string' }])), additionalProperties: false }, abcorr: { type: 'string', enum: ['NONE','LT','LT+S','CN','CN+S','XLT','XLT+S','XCN','XCN+S'] } }, additionalProperties: false } },
  { name: 'getEventQueryInfo', contract: { namespace: 'events', writes: [] }, effect: 'read', method: 'getEventQueryInfo', description: 'Exact configured query specification, declared units, loaded-kernel provenance and shared availability/coverage. Solver fault text and unapproved frames are withheld.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'getEventResultPage', contract: { namespace: 'events', writes: [], guide: 'For "closest", order range-ascending: it compares every measured candidate before paging; the first chronological result is not the smallest range. State the searched start and end dates (windowUtc) and step limits; never imply all-time coverage. Each result says whether its range minimum is an encounter and by which criterion: quote its distances and classification, not your own.' }, effect: 'read', method: 'getEventResultPage', description: 'At most five computed events per page (default one; larger requested read limits are clamped). order range-ascending compares the ENTIRE completed candidate set by measured range before paging, returns ranking.compared, and refuses missing ranges. Use it for closest, never chronological result 0. Run-scoped references work with presentEventResult or focusEventResult. Follow nextOffset for more. Distinguishes no-results, missing query, stale computation and search failure.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'number', minimum: 0 }, limit: { type: 'number', minimum: 1 }, order: { type: 'string', enum: ['chronological','range-ascending'] } }, required: ['query'], additionalProperties: false } },
  { name: 'getEventVisualization', contract: { namespace: 'events', writes: [] }, effect: 'read', method: 'getEventVisualization', description: 'Observed or partial event selection, timeline, epoch, object highlights and native draw-enabled marker/span/geometry state. No camera changes or pixel-visibility promise.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'listEventQueries', contract: { namespace: 'events', writes: [] }, effect: 'read', method: 'listEventQueries', description: 'Bounded configured Event Finder identities/kinds and flags; no result arrays or private query metadata.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'getEventSearch', contract: { namespace: 'events', writes: [] }, effect: 'read', method: 'getEventSearch', description: 'Event search status, current-call progress, error code and exact selection. Error text is withheld.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'listEventResults', contract: { namespace: 'events', writes: [] }, effect: 'read', method: 'listEventResults', description: 'Legacy query/result IDs and times only, without run references. For focusing a computed search, use getEventResultPage; never invent a run revision.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'number', minimum: 0 }, limit: { type: 'number', minimum: 1, maximum: 100 } }, required: ['query'], additionalProperties: false } },
  { name: 'listInstruments', contract: { namespace: 'instruments', writes: [] }, effect: 'read', method: 'listInstruments', description: 'Bounded available sensor names for synthetic scene feeds; not calibrated observation inventory.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'getInstrument', contract: { namespace: 'instruments', writes: [] }, effect: 'read', method: 'getInstrument', description: 'Selected synthetic scene instrument with native FOV and truthful pointing authority; no pixel data.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'listBookmarks', contract: { namespace: 'bookmarks', writes: [] }, effect: 'read', method: 'listBookmarks', description: 'Bounded session bookmark names. Full portable poses are available to trusted hosts.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'listPlaceSources', contract: { namespace: 'places', writes: [] }, effect: 'read', method: 'listPlaceSources', description: 'A bounded page of source IDs with body, search inclusion and label visibility; no resource locations.', inputSchema: { type: 'object', properties: { offset: { type: 'number', minimum: 0 }, limit: { type: 'number', minimum: 1, maximum: 50 } }, additionalProperties: false } },
  { name: 'listMeasurements', contract: { namespace: 'measurements', writes: [] }, effect: 'read', method: 'listMeasurements', description: 'Saved semantic definitions, selected ID, source/target positions and visibility. Free-form labels, private frames and terrain-source provenance are withheld. Entity distances are centre distances, never surface clearance.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'listGeographicLayers', contract: { namespace: 'geographic', writes: [] }, effect: 'read', method: 'listGeographicLayers', description: 'A bounded page of geographic layer IDs, body/frame, editability, visibility and availability.', inputSchema: { type: 'object', properties: { offset: { type: 'number', minimum: 0 }, limit: { type: 'number', minimum: 1, maximum: 50 } }, additionalProperties: false } },
  { name: 'listGeographicFeatures', contract: { namespace: 'geographic', writes: [] }, effect: 'read', method: 'listGeographicFeatures', description: 'A bounded page of stable feature IDs and geometry types in an exact layer.', inputSchema: { type: 'object', properties: { layer: { type: 'string' }, offset: { type: 'number', minimum: 0 }, limit: { type: 'number', minimum: 1, maximum: 100 } }, required: ['layer'], additionalProperties: false } },
  { name: 'getSurfaceAppearance', contract: { namespace: 'surface', writes: [] }, effect: 'read', method: 'getSurfaceAppearance', description: 'Current terrain appearance settings or an explicit unavailable reason.', inputSchema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'], additionalProperties: false } },
  { name: 'getReadiness', contract: { namespace: 'readiness', writes: [] }, effect: 'read', method: 'getReadiness', description: 'Observe assets, one current-view imagery source, mandatory cube base on drawn blocks, current-view physical terrain coverage, or an exact event/run/epoch with explicit timeline/native-draw policy and limitations. Does not prefetch.', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['assets', 'imagery', 'cube-base', 'terrain', 'event'] }, body: { type: 'string' }, layer: { type: 'string' }, reference: { type: 'object', properties: { scene: { type: 'number' }, query: { type: 'string' }, id: { type: 'string' }, revision: { type: 'number' } }, required: ['scene', 'query', 'id', 'revision'], additionalProperties: false }, et: { type: 'number' }, policy: { type: 'string', enum: ['timeline', 'native-draw'] } }, required: ['kind'], additionalProperties: false } },
  {
    name: 'findTrajectoryExtrema', effect: 'read', method: 'findTrajectoryExtrema',
    contract: { namespace: 'analysis', writes: [], guide: 'Height extrema: take the frame, reference shape and source from getSurfaceData; never invent a radius or compute from raw points. Distinguish sphere height, ellipsoid height and terrain clearance (AGL), and ask when the datum is ambiguous. For flights use catalog flight intervals, excluding parked time. Report provenance, coverage, sampling and unknown height error; a partial result cannot name a winner.' },
    description: 'Compute height extrema using the shared numerical analysis. Specify radial reference-sphere height, ellipsoid height, or physical-terrain clearance (AGL); ask which datum when altitude is ambiguous. For flights use catalog activity intervals, excluding parked time. Never calculate from raw points or authored targets. Report coverage, source, sampling and unknown global height error; partial results cannot establish a collection winner. May offer Show me with navigateToAnalysisResult.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['objects', 'body', 'frame', 'metric', 'extremum', 'reference', 'scope', 'stepSeconds', 'timeToleranceSeconds'], properties: {
      objects: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32 }, body: { type: 'string' }, frame: { type: 'string' },
      metric: { type: 'string', enum: ['radialHeightAboveReferenceSphere', 'heightAboveReferenceEllipsoid', 'heightAbovePhysicalTerrain'] }, extremum: { type: 'string', enum: ['maximum', 'minimum'] },
      reference: { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { type: 'string', enum: ['sphere', 'ellipsoid'] }, radiusKm: { type: 'number' }, radiiKm: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 } } },
      scope: { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { type: 'string', enum: ['activities', 'windows'] }, activityKind: { type: 'string' }, window: { type: 'object', additionalProperties: false, required: ['start', 'end'], properties: { start: { type: 'number' }, end: { type: 'number' } } }, ids: { type: 'array', items: { type: 'string' }, maxItems: 128 }, windows: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'object', additionalProperties: false, required: ['start', 'end'], properties: { start: { type: 'number' }, end: { type: 'number' } } } } } },
      stepSeconds: { type: 'number', minimum: 0.000001 }, sampling: { type: 'string', enum: ['adaptive', 'fixed'], description: 'Fixed (default) respects the explicit maximum step. Adaptive scales with duration, source breakpoints and known periods, reporting actual spacing without a global error bound.' }, timeToleranceSeconds: { type: 'number', minimum: 0.000001 }, maxEvaluations: { type: 'number', minimum: 1, maximum: 200000 },
      terrain: { type: 'object', additionalProperties: false, required: ['id', 'revision'], properties: { id: { type: 'string' }, revision: { type: 'string' } } },
    } },
  },
  {
    name: 'navigateToAnalysisResult', effect: 'camera', method: 'navigateToAnalysisResult',
    contract: { namespace: 'analysis', writes: ['camera', 'time', 'selection'], expect: (_a, _h, data) => { const o = (data as { observed?: { et: number; object: string } } | undefined)?.observed; return o ? [{ p: 'epoch', et: o.et }, { p: 'selected', object: o.object }, { p: 'tracked', object: o.object }, { p: 'paused', value: true }] : []; } },
    description: 'Show a current measured height result: seek its epoch, select its actual vehicle/activity and frame the vehicle. Uses only an ID returned by findTrajectoryExtrema. Stale results refuse.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['resultId'], properties: { resultId: { type: 'string' } } },
  },
  {
    name: 'describeScene',
    contract: { namespace: 'scene', writes: [], guide: 'selectedObject is object selection only; selectedActivity and selectedPlace are independent: never say nothing is selected when either is present.' },
    effect: 'read',
    description:
      'The viewer now: catalog and scene id, time and playback, selection, tracked object, flight, selected activity and place, '
      + 'object and viewpoint names (bounded), the imagery of the body in focus, and which capabilities this viewer lacks. Call it first.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'resolve',
    contract: { namespace: 'scene', writes: [], guide: 'When several candidates match, never call one clearly meant: take the one the selection or the person\'s words settle (a planet, a place, an activity), otherwise name the candidates with their kinds and ask.' },
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
    contract: { namespace: 'places', writes: [] },
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
    contract: { namespace: 'activities', writes: [], guide: 'For a collection maximum or minimum, sort over all matches or page completely; never pick a winner from an unsorted prefix. Duration is end minus start, not distance: if "longest" does not say which, ask. Missing metrics cannot establish a winner.' },
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
    contract: { namespace: 'activities', writes: [], guide: 'Where an activity happened comes from its record: site.link is "direct reference", "name match" or "none"; say which in those words and never infer a link from how a ref is spelled. Place fields are the source\'s own attributes. Timing and position carry provenance (estimated, bounded, reconstructed): say so briefly; never present an inferred landing as telemetry.' },
    description: 'Details of one catalog activity: navigation references, site association, timing and available provenance. No selection or time changes.',
    inputSchema: { type: 'object', properties: { activity: { type: 'string' } }, required: ['activity'], additionalProperties: false },
  },
  {
    name: 'getSurfaceData',
    contract: { namespace: 'surface', writes: [], guide: 'Zero getImagery layers means no independently managed overlays, never no imagery or terrain. Name configured products separately from readiness, residency and view coverage; unknown observations, resolution and provenance stay unknown. coversDrawnTiles covers drawn terrain only; when coversView is null say current-view coverage is unknown.' },
    effect: 'read',
    method: 'getSurfaceData',
    description: 'Configured surface products and physical reference shapes: body referenceShape is catalog radii; terrain.datum.referenceShape is the physical CPU source datum for AGL analysis. Includes terrain elevation/LOD, cube imagery, textures and overlays. Provenance and runtime readiness, residency and current-view coverage are separate; null means unknown.',
    inputSchema: {
      type: 'object',
      properties: { object: { type: 'string', description: PARAM_HELP.object } },
      required: ['object'],
      additionalProperties: false,
    },
  },
  {
    name: 'getImagery',
    contract: { namespace: 'surface', writes: [], guide: 'Say how many managed layers there are, which is the base and which are visible and in view; leave resolutions and technical names unless asked. Provenance is each layer\'s attribution and source; imageryOnly means no terrain elevation.' },
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
  if (schema.type === undefined) return true;
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

const typesOf = (schema: AgentJsonSchema) => schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type as string];
/**
 * Undo the common ways a model mis-encodes a valid call, before validation:
 * an optional field sent as null, a number or boolean sent as text, an array
 * or object sent as JSON text, and a single JSON-text parameter (json,
 * definition) sent as the object itself. Anything still wrong is refused by
 * `violation` as before; nothing here guesses a value.
 */
export function normalizeInput(schema: AgentJsonSchema, value: unknown): unknown {
  const types = typesOf(schema);
  if (typeof value === 'string' && !types.includes('string')) {
    if (types.includes('number') && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(value.trim())) return Number(value);
    if (types.includes('boolean') && /^(true|false)$/.test(value.trim())) return value.trim() === 'true';
    if (types.includes('array') || types.includes('object')) {
      try { const parsed = JSON.parse(value); if (typeOk(schema, parsed)) return normalizeInput(schema, parsed); } catch { /* left for validation to refuse */ }
    }
    return value;
  }
  if (Array.isArray(value)) return schema.items ? value.map(v => normalizeInput(schema.items!, v)) : value;
  if (value && typeof value === 'object' && schema.properties) {
    const props = schema.properties, required = schema.required ?? [];
    const keys = Object.keys(props);
    const text = keys.length === 1 && required.includes(keys[0]) && ['json', 'definition'].includes(keys[0]) && typesOf(props[keys[0]]).includes('string') ? keys[0] : null;
    const entries = Object.entries(value);
    if (text && entries.length && entries.every(([k]) => !Object.hasOwn(props, k))) return { [text]: JSON.stringify(value) };
    // fromEntries keeps every own key (even "__proto__"), so validation still sees unknown fields.
    return Object.fromEntries(entries.flatMap(([k, v]) => {
      const sub = Object.hasOwn(props, k) ? props[k] : undefined;
      return v === null && sub && !required.includes(k) && !typesOf(sub).includes('null') ? [] : [[k, sub ? normalizeInput(sub, v) : v]];
    }));
  }
  return value;
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

/** Port getters every viewer has; with registered reads, what a `state` predicate may call. */
const CORE_READS: readonly (keyof ViewerControl)[] = ['getTime', 'getRate', 'isPlaying', 'getSelected', 'getTracked', 'getCamera', 'getFlight', 'listObjects', 'listViewpoints',
  'getScene', 'getSelectedPlace', 'getSelectedActivity', 'getSelectedGeographicFeature', 'getSelectedMeasurement', 'getViewComposition', 'getTimelineWindow', 'getCameraReference'];

const has = (host: ViewerControl, method: keyof ViewerControl) =>
  typeof (host as unknown as Record<string, unknown>)[method] === 'function';

/** Registration comes from VERBS and the bounded read implementations above. No catalog code executes. */
export function agentDefinitions(): readonly AgentDefinition[] {
  return [...READ_TOOLS, ...[...VERBS.values()].map(spec => ({ contract: spec.contract,
    ...verbTool(spec, AGENT_VERBS.find(v => v.verb === spec.name)?.effect ?? (spec.sceneEdit ? 'display' : spec.category === 'Authoring' ? 'authoring' : spec.category === 'Capture' ? 'export' : spec.category === 'Camera' || spec.name === 'gotoObject' ? 'camera'
      : spec.category === 'Time' || spec.name === 'seekActivity' || spec.name === 'selectEventResult' || spec.name === 'focusEventResult' ? 'time'
        : spec.category === 'Scene' ? 'selection' : 'display')), method: spec.method, requiresAuthoring: spec.sceneEdit,
  }))];
}

/** Familiar direct schemas; all other operations remain discoverable from the same catalog. */
export function fixedAgentDefinitions(): ReturnType<typeof agentDefinitions> {
  for (const { verb } of AGENT_VERBS) {
    if (!VERBS.has(verb)) throw new Error(`Unregistered fixed agent verb: ${verb}`);
  }
  const direct = new Set([...AGENT_VERBS.map(v => v.verb), 'navigateToAnalysisResult']);
  return agentDefinitions().filter(def => def.effect === 'read' || direct.has(def.name));
}

/** Bind the agent tools to one viewer. */
export function createAgentTools(host: ViewerControl, opts: AgentToolsOptions = {}): AgentTools {
  const metadata = agentMetadata(opts.metadata);
  const placeSummary = metadata.place;
  let taskSeq = 0;
  let current: TaskImpl | null = null;
  const measuredResults = new Map<string,{ et:number; object:string; activityId:string | null }>();

  const available = () => (opts.vocabulary === 'catalog' ? agentDefinitions() : fixedAgentDefinitions()).filter(t => !t.method || has(host, t.method));
  const list = (): readonly AgentToolDef[] => available().map(({ method: _m, contract: _c, ...def }) => def);

  // The person's own navigation, observed for every task: a flight they
  // interrupted leaves the camera theirs for the rest of that task.
  const offFlight = host.on('flightEnd', (e) => {
    if (e.outcome === 'interrupted' && current) current.cameraTaken = true;
  });

  const offInput = host.on('cameraInput', () => { if (current) current.cameraTaken = true; });
  // A clock change while this task is not itself writing is someone else's: the person's scrubbing or play button.
  const offTime = host.on('time', e => { if (current && !current.writing && e.cause !== 'playback') current.clockTaken = true; });
  const offPlayback = host.on('playback', () => { if (current && !current.writing) current.clockTaken = true; });
  const offLoad = host.on('load', () => { measuredResults.clear(); current?.end('stale'); });

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
   * A plain sentence about what a write left, for the model: where named
   * objects now sit in the view, what the clock reads. Whether the write took
   * effect is the contract's predicates' job (`outcomeOf`), not this note's.
   */
  function note(name: string, args: Input): { note: string; data?: unknown } | null {
    if (name === 'selectGeographicFeature' && host.getSelectedGeographicFeature && host.listGeographicLayers) {
      const selected = host.getSelectedGeographicFeature();
      const layer = selected ? host.listGeographicLayers().find(l => l.id === selected.layer) : undefined;
      const context = layer?.body ? host.getSpatialContext?.(layer.body) : null;
      return selected ? { note: `Layer ${layer ? layer.visible ? 'is visible' : 'is hidden' : 'visibility is unavailable'}; native drawing ${context?.drawing.some(d => d.layers.includes(selected.layer) && d.features > 0) ? 'group is observed' : 'has not yet been observed'}. A missing draw observation does not mean the edit failed; group counts do not prove unoccluded pixels.`,
        data: { selectedFeature: selected, body: layer?.body ?? null, visible: layer?.visible ?? null, spatial: context ? metadata.spatialContext(context) : null } } : null;
    }
    if (name === 'upsertEventQuery' && host.getEventQueryInfo) {
      const info = host.getEventQueryInfo(String(JSON.parse(args.definition as string).id));
      return { note: `Search availability: ${info.status}.${info.status !== 'available' ? ' Use the returned coverage to correct the window before running; saving a definition does not establish computability.' : ''}`, data: { query: eventQueryMetadata(info, metadata.text) } };
    }
    if (name === 'presentEventResult' && host.getEventVisualization) return { note: `Native event drawing is ${host.getEventVisualization().status}.` };
    if ((/^circleCenter|^(dolly|pointAtObject|composeView|frameObject)$/.test(name)) && host.getViewComposition) {
      const named = name === 'composeView' ? [args.anchor, args.target, args.also] : name === 'pointAtObject' ? [host.getTracked(), args.object] : [args.object ?? host.getTracked()];
      const objects = [...new Set(named.filter((n): n is string => typeof n === 'string'))];
      const v = host.getViewComposition(objects);
      return { note: objects.length ? compositionSentence(v) : `Camera ${r3(v.orbitDistanceKm)} km from its orbit centre.`, data: compositionData(v) };
    }
    if (name === 'seekActivity' || name === 'setTime' || name === 'setPlaying' || name === 'runTo') {
      const utc = opts.formatTime ? attempt(() => opts.formatTime!(host.getTime())) : null;
      return { note: `The clock now reads ${utc ?? `ET ${host.getTime()}`}. Playback ${host.isPlaying() ? 'continues; this moment is not held' : 'is paused'}.` };
    }
    return null;
  }

  /** Reads a `state` predicate may call: every registered read's port method, what contracts observe, and the core getters. */
  const readMethods = (): ReadonlySet<string> => new Set<string>([...CORE_READS, ...agentDefinitions().flatMap(d => [
    ...(d.contract.writes.length === 0 && d.method ? [d.method] : []), ...(d.contract.observes ?? [])])]);
  const verifyAll = (predicates: readonly Predicate[]) => evaluate(host, predicates, { reads: readMethods() });

  /** Judge a finished write by its own contract. */
  function outcomeOf(def: AgentDefinition, args: Input, data?: unknown): OperationOutcome {
    let expected: readonly Predicate[] = [];
    try { expected = def.contract.expect?.(args, host, data) ?? []; } catch { expected = []; }
    return { writes: def.contract.writes, expected, report: expected.length ? verifyAll(expected) : null,
      unobservable: expected.length ? null : def.contract.unobservable ?? 'this operation declares no observable result' };
  }
  /** A write whose contract's predicates read false did not take effect; anything else is reported as observed. */
  function judged(def: AgentDefinition, text: string, args: Input, base: { summary: string; data?: unknown; completion?: { kind: 'flight'; id: number; outcome: 'arrived' } }): AgentToolResult {
    const outcome = outcomeOf(def, args, base.data);
    const failing = outcome.report?.checks.filter(c => c.ok === false && !c.soft) ?? [];
    if (failing.length) return { ok: false, code: 'failed', error: `${text}: the viewer does not show the expected result: ${failing.map(c => c.detail).join('; ')}`, outcome };
    const back = attempt(() => note(def.name, args)) ?? null;
    const status = outcome.report ? outcome.report.status === 'met' ? '' : ` Viewer check ${outcome.report.status}: ${outcome.report.checks.filter(c => c.ok !== true).map(c => c.detail).join('; ')}.` : ` Not observable: ${outcome.unobservable}.`;
    return { ok: true, summary: `${base.summary}${back ? ` ${back.note}` : ''}${status}`, ...(base.completion ? { completion: base.completion } : {}),
      ...(base.data !== undefined ? { data: base.data } : back?.data !== undefined ? { data: back.data } : {}), outcome };
  }

  const reads: Record<string, (input: Input) => AgentToolResult> = {
    describeScene, resolve, searchPlaces, listActivities, getActivity, getSurfaceData, getImagery,
    getSpatialContext: input => ({ ok: true, summary: 'Targeted body/state/Draw conventions; missing layers can be created after approval.', data: metadata.spatialContext(host.getSpatialContext!(input.object as string)) }),
    getObjectState: input => ({ ok: true, summary: 'Targeted state and availability; unapproved provenance stays local.', data: metadata.objectState(host.getObjectState!(input.object as string, { frame: input.frame as string | undefined, center: input.center as string | undefined, time: typeof input.et === 'number' ? { kind: 'et', et: input.et } : undefined })) }),
    projectGroundPoint: input => ({ ok: true, summary: 'Shared radial ground projection; inspect status/source before placing a marker.', data: metadata.groundProjection(host.projectGroundPoint!(input.object as string, input.policy as import('./contracts.js').ScriptSurfacePolicy | undefined)) }),
    getProbePoint: () => ({ ok: true, summary: 'Actual native/UI Point Probe state; draw-enabled does not promise unoccluded pixels.', data: metadata.probePoint(host.getProbePoint!()) }),
    getTimelineWindow: () => { const w = host.getTimelineWindow!(); return { ok: true, summary: 'Timeline window.', data: { ...w, ...(opts.formatTime ? { startUtc: attempt(() => opts.formatTime!(w.start)), endUtc: attempt(() => opts.formatTime!(w.end)) } : {}) } }; },
    getViewComposition: input => ({ ok: true, summary: 'Current view composition.', data: compositionData(host.getViewComposition!(input.objects as string[])) }),
    checkGoal: input => {
      const predicates = ((input.require as unknown[] | undefined) ?? []).map(parsePredicate);
      if (!predicates.length) throw new Error('require lists at least one predicate');
      const result = verifyAll(predicates);
      const failed = result.checks.filter(c => c.ok !== true).map(c => `${c.slot}: ${c.detail}`);
      return { ok: true, summary: `Goal ${result.status}${failed.length ? `: ${failed.join('; ')}` : ''}.`, data: result };
    },
    getEventSearchOptions: input => {
      const options = host.getEventSearchOptions!(input as Parameters<NonNullable<ViewerControl['getEventSearchOptions']>>[0]);
      const coverage = options.coverage;
      return { ok: true, summary: 'Registry defaults and assessed kernel coverage; routine query configuration uses existing host permission without repeated confirmation. Suggested window is limited to the declared catalog interval, never a global flyby claim.', data: {
        ...options, coverage: coverage ? { status: coverage.status, exact: coverage.exact, windows: coverage.windows.slice(0, 32).map(w => ({ start: w.start, end: w.end })), totalWindows: coverage.windows.length, problems: coverage.problems.length, caveats: coverage.caveats.length } : null,
      } };
    },
    getEventQueryInfo: input => ({ ok: true, summary: 'Shared query availability and provenance.', data: eventQueryMetadata(host.getEventQueryInfo!(input.query as string), metadata.text) }),
    getEventResultPage: input => {
      const data = eventPageMetadata(host.getEventResultPage!(input.query as string, { offset: input.offset as number | undefined, limit: Math.min(5, input.limit as number | undefined ?? 1), ...(input.order ? { order: input.order as 'chronological' | 'range-ascending' } : {}) }), metadata.text);
      const window = data.query.definition?.windowUtc;
      const facts: ResultFact[] = data.items.map((item): EventResultFact => {
        const metric = (key: string) => item.metrics.find(m => m.key === key && m.unit === 'km')?.value ?? null;
        const c = 'encounter' in item ? item.encounter : undefined;
        return { kind: 'event-result', query: item.reference.query, id: item.reference.id, observer: (item.bodies as Record<string, string>).observer ?? null, target: (item.bodies as Record<string, string>).target ?? null,
          utc: 'utc' in item ? item.utc ?? null : null, rangeKm: metric('range'), altitudeKm: metric('altitude'), encounter: c?.encounter ?? null, criterion: c?.criterion ?? null, criterionBody: c?.body ?? null, thresholdKm: c?.thresholdKm ?? null };
      });
      if (window && data.query.definition) facts.push({ kind: 'event-window', query: data.query.definition.id, startUtc: window.start, endUtc: window.end, maxRangeKm: typeof data.query.definition.params.maxRangeKm === 'number' ? data.query.definition.params.maxRangeKm : null });
      const classified = facts.filter((f): f is EventResultFact => f.kind === 'event-result' && f.encounter !== null);
      const encounters = classified.length ? ` ${classified.filter(f => f.encounter).length} of ${classified.length} on this page ${classified.filter(f => f.encounter).length === 1 ? 'is an encounter' : 'are encounters'} by ${classified[0].criterion === 'sphere-of-influence' ? `${classified[0].criterionBody}'s sphere of influence (${classified[0].thresholdKm?.toExponential(2)} km)` : 'the search\'s max range'}; the rest are distant range minima, not flybys.` : '';
      return { ok: true, summary: `Run-scoped results${data.ranking ? `; compared all ${data.ranking.compared} measured candidates` : ''}.${window ? ` Searched window: ${window.start} through ${window.end}. Report these actual bounds; closest is within this window, never an all-time claim. ${data.query.definition?.params.scope === 'global' ? 'This is a deepest-only query: one returned global minimum does NOT mean only one local approach occurred.' : 'Counts describe the measured local candidates returned by this query.'}` : ''}${encounters}`, data, facts };
    },
    getEventVisualization: () => ({ ok: true, summary: 'Event visualization readback; partial is not drawn acceptance.', data: eventVisualizationMetadata(host.getEventVisualization!()) }),
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
      // Recognize native diagnostics without forwarding catalog names or arbitrary faults.
      const reason = i?.pointingUnavailable;
      let pointingUnavailable: string | null = reason ? metadata.text(reason)?.slice(0, 512) ?? 'Physical pointing is unavailable; details remain local.' : null;
      if (i && reason) for (const carrier of [i.sensor, i.spacecraft].filter((n): n is string => n !== null)) {
        if (reason === `${carrier}'s attitude is unavailable at this time.`) pointingUnavailable = 'Attitude is unavailable at this time.';
        if (reason === `${carrier} or its spacecraft has no state or attitude at this time.`) pointingUnavailable = 'Sensor or spacecraft state or attitude is unavailable at this time.';
        if (reason === `${carrier}'s attitude is host-supplied and ${i.sensor} declares no mounting on it (geometry.mounting), so its pointing is unknown.`) pointingUnavailable = 'Host-supplied attitude has no declared sensor mounting, so pointing is unknown.';
      }
      if (i && reason) for (const diagnostic of [
        'geometry.mounting needs boresight and up, each three finite numbers in the spacecraft body frame',
        'geometry.mounting.boresight is zero', 'geometry.mounting.up is parallel to the boresight',
      ]) if (reason === `${i.sensor}: ${diagnostic}.`) pointingUnavailable = `${diagnostic}.`;
      return { ok: true, summary: 'Synthetic scene feed, not a calibrated observation. Pointing describes the last observed frame; compare observedEt with scene time for freshness.', data: i ? { sensor: i.sensor, spacecraft: i.spacecraft, target: i.target, fov: i.fov, viewFov: i.viewFov, pointing: i.pointing, pointingUnavailable, observedEt: i.observedEt, fresh: i.fresh, renderError: i.renderError, observation: i.observation } : null };
    },
    listBookmarks: () => ({ ok: true, summary: 'Session bookmarks.', data: { items: host.listBookmarks!().slice(0, 64).map(b => ({ name: b.name })) } }),
    listPlaceSources: input => {
      const offset = input.offset as number ?? 0, limit = input.limit as number ?? 25;
      if (!Number.isInteger(offset) || !Number.isInteger(limit)) return { ok: false, code: 'invalid-input', error: 'Pagination must use integers' };
      const sources = host.listPlaceSources!();
      return { ok: true, summary: 'Place source inclusion and labels.', data: { total: sources.length, offset, sources: sources.slice(offset, offset + limit) } };
    },
    listMeasurements: () => ({ ok: true, summary: 'Semantic measurement definitions; free-form labels and source provenance withheld. Centre distance is not clearance.', data: {
      selected: host.getSelectedMeasurement?.() ?? null,
      items: host.listMeasurements!().slice(0, 32).map(metadata.measurement),
    } }),
    listGeographicLayers: input => {
      const offset = input.offset as number ?? 0, limit = input.limit as number ?? 25;
      if (!Number.isInteger(offset) || !Number.isInteger(limit)) return { ok: false, code: 'invalid-input', error: 'Pagination must use integers' };
      const all = host.listGeographicLayers!();
      return { ok: true, summary: 'Geographic layer identities and status; unapproved metadata is withheld.', data: { total: all.length, offset, layers: all.slice(offset, offset + limit).map(metadata.geographicLayer) } };
    },
    listGeographicFeatures: input => {
      if (!Number.isInteger(input.offset ?? 0) || !Number.isInteger(input.limit ?? 25)) return { ok: false, code: 'invalid-input', error: 'Pagination must use integers' };
      const page = host.listGeographicFeatures!(input.layer as string, { offset: input.offset as number | undefined, limit: input.limit as number | undefined });
      return page ? { ok: true, summary: 'Geographic feature identities and geometry types; properties remain local. Names and source IDs may be withheld: a null name does not establish that an authored label failed to save.', data: { total: page.total, features: page.features.slice(0, (input.limit as number | undefined) ?? 25).map(metadata.geographicFeature) } } : { ok: false, code: 'refused', error: 'Unknown geographic layer' };
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
    clockTaken = false;
    /** A write of this task's is running: viewer notifications now are its own. */
    writing = false;
    get taken() { return { camera: this.cameraTaken, time: this.clockTaken }; }
    /** The flight this task started and has not seen end; the only one its Stop may stop. */
    ownFlight: number | null = null;
    /** Outcome checks this request has made; bounded so a failing goal cannot loop. */
    goalChecks = 0;

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
      if (name === 'navigateToAnalysisResult') {
        const blocked = ['setTime','setPlaying','select','frameObject'].find(operation => opts.omittedTools?.[operation]);
        if (blocked) return { ok:false,code:'refused',error:`Result navigation requires ${blocked}: ${opts.omittedTools![blocked]}` };
      }
      const def = available().find((t) => t.name === name);
      if (!def) {
        const s = suggest(name, list().map((t) => t.name));
        return { ok: false, code: 'unknown-tool', error: `no tool ${JSON.stringify(name)} on this viewer${s ? ` (did you mean ${JSON.stringify(s)}?)` : ''}` };
      }
      input = normalizeInput(def.inputSchema, input ?? {});
      const problem = violation(def.inputSchema, input, 'input');
      if (problem) return { ok: false, code: 'invalid-input', error: problem };
      const refused = this.gate(def);
      if (refused) return refused;
      if ((def.effect === 'authoring' || def.requiresAuthoring) && !opts.allowAuthoring) return { ok: false, code: 'refused', error: 'Authoring permission is required.' };
      if (def.effect === 'export' && !opts.allowExport) return { ok: false, code: 'refused', error: 'Export permission is required.' };
      const args = (input ?? {}) as Input;

      if (name === 'findTrajectoryExtrema') {
        measuredResults.clear();
        try {
          const response = await host.findTrajectoryExtrema!(args as unknown as TrajectoryExtremaQuery, { signal: this.signal });
          const late = this.gate(def);
          if (late) return late;
          measuredResults.clear();
          for (const result of response.results.slice(0,128)) measuredResults.set(result.id,{et:result.et,object:result.object,activityId:result.activityId});
          // Closed projection: provenance may contain private source paths.
          const data = { status: response.status, results: response.results.slice(0,128).map(metadata.trajectoryExtremum), faults: response.faults.slice(0,128).map(f => ({ code: f.code, object: f.object, activityId: f.activityId, window: f.window ? {start:f.window.start,end:f.window.end} : undefined, message: 'Analysis unavailable, incomplete or interrupted; inspect the local result for details.' })) };
          return { ok: true, summary: `Height analysis ${response.status}; ${response.results.length} results. Global height error unknown.`, data };
        } catch { return { ok: false, code: 'failed', error: 'Height analysis failed; inspect the local source and coverage.' }; }
      }
      if (name === 'navigateToAnalysisResult') {
        const expected = measuredResults.get(args.resultId as string);
        if (!expected) return { ok:false,code:'refused',error:'Unknown or superseded analysis result. Run the analysis in this session before navigating.' };
        const done = host.navigateToAnalysisResult!(args.resultId as string);
        if (!done) return { ok:false,code:'refused',error:'The result is unavailable or stale.' };
        const late = this.gate(def);
        if (late) return late;
        const observed = {et:host.getTime(),object:host.getSelected(),tracked:host.getTracked(),playing:host.isPlaying(),activityId:host.getSelectedActivity?.()?.id ?? null};
        const verified = !!expected && Math.abs(observed.et-expected.et)<1e-5 && observed.object===expected.object && observed.tracked===expected.object && !observed.playing && (!expected.activityId || observed.activityId===expected.activityId);
        if (!verified) return {ok:false,code:'failed',error:'The viewer did not report the measured epoch, vehicle, activity and paused playback after navigation.'};
        return judged(def, name, args, { summary:'Selected and framed the measured vehicle at the observed result epoch.', data:{verified,observed:{...observed, et: expected.et}} });
      }

      if (name === 'checkGoal' && ++this.goalChecks > 3) return { ok: false, code: 'refused', error: 'Three outcome checks already ran for this request. Report the observed state and the unmet part plainly.' };
      const read = reads[name];
      if (read) {
        try {
          return read(args);
        } catch (err) {
          if (name === 'checkGoal') return { ok: false, code: 'invalid-input', error: err instanceof Error ? err.message : String(err) };
          if (['getObjectState', 'getSpatialContext', 'projectGroundPoint', 'getProbePoint', 'listGeographicLayers', 'listGeographicFeatures'].includes(name)) return { ok: false, code: 'failed', error: 'Requested data could not be read; inspect the local viewer for source/frame details.' };
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
        this.writing = true;
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
          this.writing = false;
          if (!(err instanceof ScriptRuntimeError)) return { ok: false, code: 'failed', error: String(err) };
          const p = err.problems[0];
          const code: AgentErrorCode = p.kind === 'cancelled' ? (this.ended ?? 'cancelled')
            : p.kind === 'unknown-target' ? 'refused'
              : 'failed';
          return { ok: false, code, error: p.message };
        }

        // An asynchronous host method may finish after a scene reload or Stop.
        // Never report that late result as completion in the new scene.
        this.writing = false;
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
          return judged(def, text, args, { summary: `${text}: arrived${end.target ? ` at ${end.target}` : ''}.`, completion: { kind: 'flight', id: own, outcome: 'arrived' } });
        }
        return judged(def, text, args, { summary: `${text}: done.` });
      } finally {
        this.writing = false;
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
    verify: verifyAll,
    contractOf: name => available().find(d => d.name === name)?.contract ?? null,
    readable: method => readMethods().has(method) && has(host, method as keyof ViewerControl),
    preflight: (name, input, held) => {
      const def = available().find(d => d.name === name);
      if (!def?.contract.expect || !held.length) return null;
      try { return preconditionProblem(host, def.contract.expect((input ?? {}) as Input, host), held); } catch { return null; }
    },
    guides: () => available().filter(d => d.contract.guide && !opts.omittedTools?.[d.name]).map(d => ({ name: d.name, guide: d.contract.guide! })),
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
      offTime();
      offPlayback();
      offLoad();
      current?.end('cancelled');
    },
  };
}
