import type { ScriptReadiness, ScriptReadinessRequest, ScriptSceneOptions, ScriptCancelSignal } from '@cosmolabe/control';
import { getEventReadiness, validEventReference } from './event-control';
import { getRenderer, sceneId, vs, onViewerEvent } from './viewer-state.svelte';

function validateRequest(request: ScriptReadinessRequest): void {
  if (!request || !['assets', 'imagery', 'cube-base', 'terrain', 'event'].includes(request.kind)) throw new Error('Unknown readiness predicate');
  if (request.kind === 'event') {
    if (!validEventReference(request.reference) || !Number.isFinite(request.et) || !['timeline', 'native-draw'].includes(request.policy)) throw new Error('Event readiness needs an exact reference, finite epoch and explicit capture policy');
    return;
  }
  if (request.kind !== 'assets' && (typeof request.body !== 'string' || !request.body)) throw new Error('Readiness needs an exact body name');
  if (request.kind === 'imagery' && (typeof request.layer !== 'string' || !request.layer)) throw new Error('Imagery readiness needs an exact layer ID');
}
/** Reuses the renderer's observed counters. It never starts, retries or manages streaming. */
export function getReadiness(request: ScriptReadinessRequest, opts?: ScriptSceneOptions): ScriptReadiness {
  validateRequest(request);
  const renderer = getRenderer();
  const scene = renderer ? sceneId() : null;
  const result = (status: ScriptReadiness['status'], missing: string[], limitations: string[]): ScriptReadiness =>
    ({ scene, status, request: { ...request }, missing, limitations });
  const limitations = ['Observation of the current view only; no regional or planetary coverage or source-accuracy guarantee.'];
  if (opts?.scene !== undefined && opts.scene !== scene) return result('stale', ['The requested scene is no longer bound.'], limitations);
  if (!renderer) return result('unavailable', ['No renderer is bound.'], limitations);
  if (request.kind === 'event') return getEventReadiness(request);
  if (request.kind === 'assets') {
    const summary = vs.assetSummary;
    const notes = ['Initial models, textures and trajectories only; streamed terrain/imagery is excluded.'];
    if (!vs.assetsReady) return result('partial', ['Initial assets are still loading.'], notes);
    if (summary?.timedOut) return result('timed-out', [`${summary.stillPending.length} initial assets did not settle before the asset deadline.`], notes);
    if (summary?.failed) return result('failed', [`${summary.failed} initial assets failed.`], notes);
    return result('ready', [], notes);
  }
  const bm = renderer.getBodyMesh(request.body);
  if (!bm) return result('unavailable', [`No rendered body ${request.body}.`], limitations);
  if (!bm.visible) return result('unavailable', ['The body is hidden.'], limitations);
  if (request.kind === 'terrain') {
    const coverage = bm.terrainViewCoverage;
    const notes = [...limitations, 'Coverage is within the declared product footprint and streamer replacement hierarchy; no guarantee outside that footprint, of source accuracy, or CPU analytical sample residency. Target LOD is required separately from coarse coverage.'];
    if (!coverage || !coverage.physical) return result('unavailable', ['No physical streamed terrain product or coverage predicate.'], notes);
    if (!coverage.frameAvailable) return result('unavailable', ['The terrain frame is unavailable.'], notes);
    if (bm.surfaceTransitionState === 'fallback' || coverage.failed) return result('failed', ['Required geometry failed; the view may use a static fallback.'], notes);
    const missing: string[] = [];
    if (bm.surfaceTransitionState !== 'streamed') missing.push('Physical streamed terrain is not drawn.');
    if (!coverage.observed || !renderer.surfaceViewIsCurrent(request.body)) missing.push('The current view has not been observed by a successful streaming update.');
    if (!coverage.coverageTiles || !coverage.drawn) missing.push('No product geometry coverage is drawn in this view.');
    if (coverage.missing) missing.push(`${coverage.missing} required coverage tiles are missing.`);
    if (coverage.pending) missing.push(`${coverage.pending} geometry requests are pending.`);
    if (!coverage.targetLod) missing.push('Drawn geometry has not reached the configured screen-space target LOD.');
    return result(missing.length ? 'partial' : 'ready', missing, notes);
  }
  if (request.kind === 'cube-base') {
    const stats = bm.terrainCubeImageryStats;
    const notes = [...limitations, 'Only mandatory cube imagery on currently drawn terrain blocks. Missing geometry and target LOD completeness are excluded.'];
    if (!stats) return result('unavailable', ['No initialized cube imagery product.'], notes);
    if (stats.manifestFailed) return result('failed', ['Cube imagery manifest failed.'], notes);
    if (!renderer.surfaceViewIsCurrent(request.body)) return result('partial', ['The current camera/time/source settings have not been observed by a streaming update.'], notes);
    if (!stats.ready || bm.surfaceTransitionState !== 'streamed' || !stats.tiles) return result('partial', ['Cube imagery is not drawn yet.'], notes);
    if (stats.baseUncoveredBlocks > 0) return result('partial', [`${stats.baseUncoveredBlocks} drawn blocks lack mandatory base imagery.`], notes);
    return result('ready', [], notes);
  }
  const layer = bm.imageryLayers.find(l => l.id === request.layer);
  if (!layer) return result('unavailable', [`No imagery layer ${request.layer}.`], limitations);
  if (layer.status === 'failed') return result('failed', ['The imagery source failed.'], limitations);
  if (!layer.visible || layer.opacity === 0) return result('unavailable', ['The imagery layer is hidden or transparent.'], limitations);
  if (bm.surfaceTransitionState === 'fallback') return result('failed', ['The streamed surface failed; the static map is drawn.'], limitations);
  // A dated layer is only ready for the day it is asked to show: while a newer day waits out the throttle the old one is still on screen.
  const time = layer.temporal;
  // Pending is its own fact: a change to *no imagery* has no pending day, but the old day is still on screen.
  if (time?.pending) return result('partial', [`${time.pendingDate ? `Imagery for ${time.pendingDate}` : 'A change to no imagery'} has not replaced ${time.date ?? 'no imagery'} yet.`], limitations);
  if (time && time.date === null) return result('unavailable', [`No imagery is shown for ${time.requestedDate ?? 'this time'} (${time.state}).`], limitations);
  if (bm.surfaceTransitionState !== 'streamed') return result('partial', ['Streamed imagery is resident or loading but is not drawn.'], limitations);
  if (!renderer.surfaceViewIsCurrent(request.body)) return result('partial', ['The current camera/time/source settings have not been observed by a streaming update.'], limitations);
  const view = layer.view;
  if (!view) return result('partial', ['The imagery layer has no drawn-view observation yet.'], limitations);
  if (!view.inCoverage) return result('unavailable', ['The view is outside the declared source coverage.'], limitations);
  if (view.zoomLevel === null || view.zoomLevel < layer.minZoom) return result('unavailable', ['The view does not reach the source minimum zoom.'], limitations);
  const missing = [];
  if (view.missingTiles) missing.push(`${view.missingTiles} required view tiles are missing.`);
  if (view.degradedTiles) missing.push(`${view.degradedTiles} view tiles use degraded imagery.`);
  if (view.cacheFull) missing.push('The imagery cache is full.');
  return result(missing.length ? 'partial' : 'ready', missing, limitations);
}

/** A bounded observation wait. Every exit removes timers and listeners, including abort/unload. */
export function waitUntilReady(request: ScriptReadinessRequest, opts: ScriptSceneOptions & { timeoutMs?: number; signal?: ScriptCancelSignal } = {}): Promise<ScriptReadiness> {
  validateRequest(request);
  const timeoutMs = opts.timeoutMs ?? 15000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 120000) throw new Error('Readiness timeout must be 0–120000 ms');
  // Freeze caller-owned reference fields for the entire wait.
  const predicate = request.kind === 'event' ? { ...request, reference: { ...request.reference } } : { ...request };
  const renderer = getRenderer();
  if (!renderer) return Promise.resolve(getReadiness(predicate, opts));
  const expected = opts.scene ?? sceneId();
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let offLoad = () => {}, offUnload = () => {};
    let done = false;
    const deadline = performance.now() + timeoutMs;
    const finish = (result: ScriptReadiness) => {
      if (done) return;
      done = true; clearTimeout(timer); offLoad(); offUnload(); opts.signal?.removeEventListener('abort', abort); resolve(result);
    };
    const abort = () => finish({ ...getReadiness(predicate), status: 'cancelled', missing: ['The readiness wait was cancelled.'] });
    const stale = () => finish({ ...getReadiness(predicate), status: 'stale', missing: ['The scene was replaced or disposed.'] });
    const check = () => {
      if (opts.signal?.aborted) { abort(); return; }
      if (getRenderer() !== renderer || sceneId() !== expected) { stale(); return; }
      const result = getReadiness(predicate, { scene: expected });
      if (result.status !== 'partial') { finish(result); return; }
      if (performance.now() >= deadline) { finish({ ...result, status: 'timed-out' }); return; }
      timer = setTimeout(check, Math.min(50, Math.max(0, deadline - performance.now())));
    };
    offLoad = onViewerEvent('load', stale);
    offUnload = onViewerEvent('unload', stale);
    opts.signal?.addEventListener('abort', abort);
    check();
  });
}
