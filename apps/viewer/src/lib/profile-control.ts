/** Semantic adapter for the existing timeline profiles; no second sampler or store. */
import type { ScriptProfileDefinition, ScriptProfileInfo, ViewerControl } from '@cosmolabe/control';
import { configuredItem, configuredProfiles, createConfiguredProfile, updateConfiguredProfile, removeConfiguredItem, resolveProfile, setConfiguredItemEnabled, setConfiguredItemVisible } from './analysis.svelte';
import { getSceneUniverse, sceneId, vs } from './viewer-state.svelte';
import { setTimelineDepth } from './shell.svelte';
import { PROFILE_QUANTITIES, profileQuantity, sampleProfile } from './profile-sampling';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const limitations = [
  'Display samples of Universe.absolutePositionOf in km and ET seconds past J2000; no SPICE GF coverage certificate is required. Missing position samples remain gaps.',
  'Range is center-to-center distance, not altitude or height above an irregular physical surface. Sampled minima are not certified contact events. Never substitute a closest-approach search or distance profile for requested physical clearance without explicit acceptance.',
  'Relative speed and signed range rate use central differences at ±0.5 seconds; negative range rate is closing. Phase angle is at the target between observer and illuminator (default Sun), in degrees.',
  'The timeline samples its visible window at pixel-dependent density, clipped to the optional profile window. Frame/aberration/step overrides are not supported: positions use the existing absolute-position display path.',
];
interface TimelineObservation { signature: string; samples: number; missing: number; traceVisible: boolean }
const rows = new Map<string, TimelineObservation>();
export function profileSignature(id: string): string {
  const item = configuredItem(id);
  return JSON.stringify([sceneId(), item, item?.type === 'continuous-profile' ? resolveProfile(item) : null, vs.trackedBodyName, vs.kernelRevision, vs.scrubMin, vs.scrubMax]);
}
/** Called only by the mounted native row; cleanup cannot erase a newer observation. */
export function observeProfileRow(id: string, observation: TimelineObservation): () => void {
  rows.set(id, observation);
  return () => { if (rows.get(id) === observation) rows.delete(id); };
}
function guard(scene?: number) {
  if (!getSceneUniverse()) throw new Error('No scene is loaded');
  if (scene !== undefined && scene !== sceneId()) throw new Error('Profile belongs to another scene');
}
function definition(id: string): ScriptProfileDefinition | null {
  const item = configuredItem(id);
  return item?.type === 'continuous-profile' ? copy({ id: item.id, label: item.label, profile: item.profile, enabled: item.enabled, visible: item.visible }) : null;
}
export function getProfile(id: string, opts?: { scene?: number }): ScriptProfileInfo {
  const scene = getSceneUniverse() ? sceneId() : null;
  const timeline = { present: false, traceVisible: false, window: { start: vs.scrubMin, end: vs.scrubMax }, samples: 0, missing: 0 };
  const empty = { scene, definition: null, resolved: null, timeline, limitations: [...limitations] };
  if (scene === null || opts?.scene !== undefined && opts.scene !== scene) return { ...empty, status: 'scene-reloaded' };
  const item = configuredItem(id), def = definition(id);
  if (!def || item?.type !== 'continuous-profile') return { ...empty, status: 'missing-profile' };
  const resolved = copy(resolveProfile(item));
  resolved.bodies.observer ??= vs.trackedBodyName ?? undefined;
  const spec = profileQuantity(resolved.quantity), bodies = resolved.bodies;
  const universe = getSceneUniverse()!;
  const supported = !!spec && !!bodies.observer && !!bodies.target && bodies.observer !== bodies.target
    && !!universe.getBody(bodies.observer) && !!universe.getBody(bodies.target)
    && (spec.id !== 'phase-angle' || !!universe.getBody(bodies.illuminator || 'Sun'));
  const values = supported ? sampleProfile(spec!, { observer: bodies.observer!, target: bodies.target!, illuminator: bodies.illuminator }, timeline.window, 65,
    (body, et) => universe.absolutePositionOf(body, et), item.profile.window).values : [];
  const valid = values.filter(v => v !== null).length;
  const observed = rows.get(id);
  if (item.enabled && observed?.signature === profileSignature(id)) {
    timeline.present = true;
    timeline.traceVisible = observed.traceVisible;
    timeline.samples = observed.samples;
    timeline.missing = observed.missing;
  }
  const notes = [...limitations];
  if (!supported) notes.push('Unsupported quantity or missing/distinct scene participants.');
  if (!valid) notes.push('No available position samples in the bounded display probes of the visible timeline/profile window.');
  if (timeline.missing) notes.push(`${timeline.missing} native timeline samples are missing; the trace contains gaps.`);
  if (values.length > valid) notes.push(`${values.length - valid} of ${values.length} bounded display probes are missing; probes do not certify continuous coverage.`);
  if (!timeline.present) notes.push('No current native timeline row observation; configured state alone does not prove timeline presence.');
  return { scene, definition: def, resolved, timeline,
    status: !supported || !valid && !timeline.traceVisible ? 'unavailable' : values.length > valid || timeline.missing > 0 || item.enabled && (!timeline.present || item.visible && !timeline.traceVisible) ? 'partial' : 'available', limitations: notes };
}
export const profileControl: Pick<Required<ViewerControl>, 'getProfileOptions' | 'listProfiles' | 'getProfile' | 'upsertProfile' | 'removeProfile'> = {
  getProfileOptions: () => ({ quantities: PROFILE_QUANTITIES.map(({ id, label, unit }) => ({ id, label, unit })), window: { start: vs.scrubBaseMin, end: vs.scrubBaseMax }, limitations: [...limitations] }),
  listProfiles: () => ({ scene: getSceneUniverse() ? sceneId() : null, total: configuredProfiles().length, items: configuredProfiles().slice(0, 64).map(p => definition(p.id)!) }),
  getProfile,
  upsertProfile: (input, opts) => {
    guard(opts?.scene);
    if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['id','label','profile','enabled','visible'].includes(k))) throw new Error('Invalid profile definition');
    const { id, profile, label, enabled, visible } = input;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || Object.hasOwn(Object.prototype, id)) throw new Error('Invalid profile ID');
    if (label !== undefined && (typeof label !== 'string' || label.length > 160)) throw new Error('Invalid profile label');
    if (enabled !== undefined && typeof enabled !== 'boolean' || visible !== undefined && typeof visible !== 'boolean') throw new Error('Invalid profile flags');
    if (!record(profile) || !profileQuantity(profile.quantity) || Object.keys(profile).some(k => !['quantity','bodies','window'].includes(k))) throw new Error('Unsupported profile quantity or parameters; see getProfileOptions');
    if (profile.window !== undefined && (!record(profile.window) || Object.keys(profile.window).some(k => !['start','end'].includes(k)) || !Number.isFinite(profile.window.start) || !Number.isFinite(profile.window.end) || profile.window.end <= profile.window.start)) throw new Error('Invalid profile time window');
    if (profile.bodies !== undefined && (!record(profile.bodies) || Object.entries(profile.bodies).some(([k,v]) => !['observer','target','illuminator'].includes(k) || typeof v !== 'string' || !getSceneUniverse()!.getBody(v)))) throw new Error('Missing scene participant');
    const prior = configuredItem(id);
    if (prior && prior.type !== 'continuous-profile') throw new Error('ID belongs to another analysis item');
    // Resolve defaults exactly as the native row does before accepting a mutation.
    const resolved = resolveProfile({ id, label: label ?? '', enabled: true, visible: true, type: 'continuous-profile', profile });
    const observer = resolved.bodies.observer ?? vs.trackedBodyName;
    if (!observer || !resolved.bodies.target || observer === resolved.bodies.target || !getSceneUniverse()!.getBody(observer) || !getSceneUniverse()!.getBody(resolved.bodies.target)) throw new Error('A distinct observer and target in this scene are required');
    if (profile.quantity === 'phase-angle' && !getSceneUniverse()!.getBody(resolved.bodies.illuminator || 'Sun')) throw new Error('Missing illuminator');
    if (!prior && configuredProfiles().length >= 64) throw new Error('Profile limit is 64');
    if (prior) updateConfiguredProfile(id, copy(profile), label);
    else createConfiguredProfile(copy(profile), label ?? profileQuantity(profile.quantity)!.label, id);
    if (enabled !== undefined) setConfiguredItemEnabled(id, enabled);
    if (visible !== undefined) setConfiguredItemVisible(id, visible);
    const item = configuredItem(id)!;
    if (item.enabled && item.visible && (!prior || visible === true || enabled === true)) setTimelineDepth('expanded');
    return true;
  },
  removeProfile: (id, opts) => { guard(opts?.scene); if (!definition(id)) return false; removeConfiguredItem(id); return true; },
};
