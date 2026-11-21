/** Semantic adapter for the existing timeline profiles; no second sampler or store. */
import type { ScriptProfileData, ScriptProfileSampleRequest, ScriptProfileDefinition, ScriptProfileInfo, ViewerControl } from '@cosmolabe/control';
import { configuredItem, configuredProfiles, createConfiguredProfile, updateConfiguredProfile, removeConfiguredItem, resolveProfile, setConfiguredItemEnabled, setConfiguredItemVisible } from './analysis.svelte';
import { getSceneUniverse, sceneId, etToUtcString, vs } from './viewer-state.svelte';
import { setTimelineDepth } from './shell.svelte';
import { PROFILE_QUANTITIES, profileQuantity, quantityAt, sampleProfile } from './profile-sampling';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const limitations = [
  'Display samples of Universe.absolutePositionOf in km and ET seconds past J2000; no SPICE GF coverage certificate is required. Missing position samples remain gaps.',
  'Range is center-to-center distance, not altitude or height above an irregular physical surface. Sampled minima are not certified contact events. Never substitute a closest-approach search or distance profile for requested physical clearance without explicit acceptance.',
  'Relative speed and signed range rate use central differences at ±0.5 seconds; negative range rate is closing. Phase angle is at the target between observer and illuminator (default Sun), in degrees.',
  'This profile API does not assess physical-surface model availability. Unsupported clearance or null terrain metadata does not prove a scene lacks an irregular mesh or DSK surface model. State the unsupported profile quantity, not an unverified absence of surface data.',
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
  // Probe only the intersection: clipping is intentional, not missing ephemeris.
  const window = { start: Math.max(timeline.window.start, item.profile.window?.start ?? -Infinity), end: Math.min(timeline.window.end, item.profile.window?.end ?? Infinity) };
  const intersects = window.end > window.start;
  const values = supported && intersects ? sampleProfile(spec!, { observer: bodies.observer!, target: bodies.target!, illuminator: bodies.illuminator }, window, 65,
    (body, et) => universe.absolutePositionOf(body, et), item.profile.window).values : [];
  const valid = values.filter(v => v !== null).length;
  const observed = rows.get(id);
  if (observed?.signature === profileSignature(id)) {
    timeline.present = true;
    timeline.traceVisible = observed.traceVisible;
    timeline.samples = observed.samples;
    timeline.missing = observed.missing;
  }
  const notes = [...limitations];
  if (!supported) notes.push('Unsupported quantity or missing/distinct scene participants.');
  if (!intersects) notes.push('Profile window does not overlap the visible timeline window; no position coverage was assessed.');
  if (intersects && !valid) notes.push('No available position samples in the bounded display probes of the visible timeline/profile window.');
  if (timeline.missing) notes.push(`${timeline.missing} native timeline samples are missing; the trace contains gaps.`);
  if (values.length > valid) notes.push(`${values.length - valid} of ${values.length} bounded display probes are missing; probes do not certify continuous coverage.`);
  if (!timeline.present) notes.push('No current native timeline row observation; configured state alone does not prove timeline presence.');
  return { scene, definition: def, resolved, timeline,
    status: !supported || intersects && !valid && !timeline.traceVisible ? 'unavailable' : !intersects || values.length > valid || timeline.missing > 0 || item.enabled && (!timeline.present || item.visible && !timeline.traceVisible) ? 'partial' : 'available', limitations: notes };
}
const MAX_DATA_SAMPLES = 32;
/** Read the existing sampler, independent of row pixel density or visibility. */
function readProfileData(id: string, request: ScriptProfileSampleRequest, point: boolean, opts?: { scene?: number }): ScriptProfileData {
  if (!record(request)) throw new Error('Profile sample request required');
  const { start, end } = request, count = point ? 1 : request.count ?? 32;
  if (Object.keys(request).some(k => !['start', 'end', 'count'].includes(k)) || !Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(end - start) || end < start || !point && end === start || !Number.isInteger(count) || count < (point ? 1 : 2) || count > MAX_DATA_SAMPLES) throw new Error('Finite ET window and integer sample count from 2 to 32 required');
  const scene = getSceneUniverse() ? sceneId() : null;
  const result: ScriptProfileData = { scene, id, status: 'unavailable', quantity: null, unit: null, bodies: null,
    requestedWindow: { start, end }, window: null, samples: [], missing: 0, gaps: [], minimum: null, maximum: null,
    sampling: { method: point ? 'exact-point' : 'uniform', requestedCount: count, maxCount: MAX_DATA_SAMPLES, stepSeconds: null, coverage: 'not-certified', interpolation: 'none' },
    limitations: [
      'Exact evaluations of the existing display quantity at returned ET epochs; no interpolation across gaps. Missing positions remain null. These reads do not move the scene or alter the profile.',
      'Minimum/maximum compare only the returned finite samples (earliest on ties). Approximate sampled extrema, not certified global or local extrema; no refinement or continuous coverage guarantee. Gaps describe missing sampled epochs only. A finer requested interval/count can change the result.',
      'Center-to-center minimum is not physical surface clearance, contact or first touchdown. Authored touchdown viewpoints are separate annotations. Physical DSK/mesh availability is not assessed by this API.',
      'Positions use Universe.absolutePositionOf in km and ET seconds past J2000. Relative speed/range rate use ±0.5-second differences; phase angle is in degrees. No frame/aberration overrides or GF coverage certificate.',
    ] };
  if (scene === null || opts?.scene !== undefined && opts.scene !== scene) return { ...result, status: 'scene-reloaded' };
  const item = configuredItem(id);
  if (item?.type !== 'continuous-profile') return { ...result, status: 'missing-profile' };
  const resolved = copy(resolveProfile(item));
  resolved.bodies.observer ??= vs.trackedBodyName ?? undefined;
  result.quantity = resolved.quantity;
  const spec = profileQuantity(resolved.quantity);
  result.unit = spec?.unit ?? null;
  result.bodies = resolved.bodies;
  const window = { start: Math.max(start, item.profile.window?.start ?? -Infinity), end: Math.min(end, item.profile.window?.end ?? Infinity) };
  if (window.end < window.start || !point && window.end === window.start) {
    result.limitations.push('Requested time/window does not overlap the configured profile window; position coverage was not assessed.');
    return result;
  }
  result.window = window;
  const u = getSceneUniverse()!, b = resolved.bodies;
  if (!spec || !b.observer || !b.target || b.observer === b.target || !u.getBody(b.observer) || !u.getBody(b.target) || spec.id === 'phase-angle' && !u.getBody(b.illuminator || 'Sun')) {
    result.limitations.push('Unsupported quantity or missing/distinct scene participants.');
    return result;
  }
  const bodies = { observer: b.observer, target: b.target, illuminator: b.illuminator };
  const pos = (body: string, et: number) => u.absolutePositionOf(body, et);
  const series = point ? { ets: [start], values: [quantityAt(spec.id, bodies, start, pos)] } : sampleProfile(spec, bodies, window, count, pos);
  result.sampling.stepSeconds = point ? null : (window.end - window.start) / (count - 1);
  result.samples = series.ets.map((et, i) => ({ et, utc: etToUtcString(et), value: Number.isFinite(series.values[i]) ? series.values[i] : null }));
  let gap: ScriptProfileData['gaps'][number] | undefined;
  for (const sample of result.samples) {
    if (sample.value === null) {
      result.missing++;
      if (!gap) { gap = { start: sample.et, end: sample.et, samples: 0 }; result.gaps.push(gap); }
      gap.end = sample.et; gap.samples++;
    } else {
      gap = undefined;
      if (!result.minimum || sample.value < result.minimum.value!) result.minimum = { ...sample };
      if (!result.maximum || sample.value > result.maximum.value!) result.maximum = { ...sample };
    }
  }
  result.status = !result.minimum ? 'unavailable' : result.missing ? 'partial' : 'available';
  if (window.start !== start || window.end !== end) result.limitations.push('Returned samples cover the intersection with the configured profile window; intentional clipping is not missing trajectory data.');
  return result;
}
export const profileControl: Pick<Required<ViewerControl>, 'getProfileOptions' | 'listProfiles' | 'getProfile' | 'getProfileValue' | 'sampleProfileData' | 'upsertProfile' | 'removeProfile'> = {
  getProfileOptions: () => ({ quantities: PROFILE_QUANTITIES.map(({ id, label, unit }) => ({ id, label, unit })), window: { start: vs.scrubBaseMin, end: vs.scrubBaseMax }, limitations: [...limitations] }),
  listProfiles: () => ({ scene: getSceneUniverse() ? sceneId() : null, total: configuredProfiles().length, items: configuredProfiles().slice(0, 64).map(p => definition(p.id)!) }),
  getProfile,
  getProfileValue: (id, et, opts) => readProfileData(id, { start: et, end: et }, true, opts),
  sampleProfileData: (id, request, opts) => readProfileData(id, request, false, opts),
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
