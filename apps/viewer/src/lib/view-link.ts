import { applyViewState, validateViewState, ViewStateError } from '@cosmolabe/control';
import { catalogLocation, allEntries, requestedCatalog } from './catalog-nav';
import { catalogs } from './catalogs.svelte';
import { getRenderer, vs } from './viewer-state.svelte';
import { createViewerControl } from './viewer-control';
import { getUniverse } from './loader';
import { captureSharedEvents, restoreSharedEvents } from './event-finder.svelte';
import { configuredProfiles, createConfiguredProfile, removeConfiguredItem, setConfiguredItemEnabled, setConfiguredItemVisible } from './analysis.svelte';
import { sharedProfileOf, validateProfileLinkState, type ProfileLinkState } from './profile-link-state';
import { viewLink, type ViewerViewState } from './view-state-url';

export function captureViewState(pageUrl = location.href): ViewerViewState {
  const r = getRenderer();
  if (!r || !vs.assetsReady || vs.showLoading) throw new ViewStateError('Wait for the catalog to finish loading before sharing.');
  if (r.cameraController.animating) throw new ViewStateError('Wait for the camera movement to finish before sharing.');
  const page = new URL(pageUrl);
  const listed = allEntries(catalogs.sources).find(e => e.entry.catalogUrl === catalogs.currentUrl);
  const ref = listed ? catalogLocation(listed, pageUrl) : requestedCatalog(page.search);
  if (!catalogs.currentUrl || !ref || ('catalog' in ref && new URL(`./${ref.catalog}.json`, page).href !== catalogs.currentUrl)) {
    throw new ViewStateError('This catalog has no portable URL. Open it from a catalog source before sharing.');
  }
  const host = createViewerControl();
  const camera = host.getCamera();
  const cc = r.cameraController;
  // Match only catalog-owned viewpoints, never session-only Saved views. A
  // remembered dropdown value becomes stale as soon as the camera is dragged.
  const matches = (a: readonly number[], b: readonly number[]) => a.every((x, i) => Math.abs(x - b[i]) <= 1e-9 * Math.max(1, Math.abs(x)));
  const named = getUniverse()?.viewpoints.find(v => {
    const vp = cc.getViewpoint(v.name);
    return vp && (vp.trackBody ?? null) === (cc.originBody?.body.name ?? null) &&
      matches(camera.position, vp.position.toArray().map(x => x / r.scaleFactor)) &&
      matches(camera.target, vp.target.toArray().map(x => x / r.scaleFactor)) && matches(camera.up, vp.up.toArray());
  });
  const state = validateViewState({ version: 1, catalog: ref,
    time: { kind: 'fixed', source: 'ET', et: host.getTime() },
    view: named ? { kind: 'named', name: named.name, fov: camera.fov }
      : { kind: 'pose', version: 1, frame: 'ECLIPJ2000', origin: host.getCameraReference!(), camera },
    navigation: { selected: host.getSelected(), tracked: host.getTracked(), lookAt: cc.lookAtBody?.body.name ?? null, mode: cc.mode },
    playback: { playing: host.isPlaying(), rate: host.getRate() },
    display: { trajectories: vs.showTrajectories, labels: vs.showLabels, grid: vs.showGrid,
      axes: vs.showAxes, sensors: vs.showSensors, sensorLabels: vs.showSensorLabels },
  });
  const events = captureSharedEvents();
  const profiles = configuredProfiles();
  return { ...state, ...(events ? { events } : {}),
    ...(profiles.length ? { profiles: validateProfileLinkState({ version: 1, profiles: profiles.map(sharedProfileOf) }) } : {}) };
}

/** Replace the timeline profiles with the shared ones (none when the link has none).
 * Synchronous: profiles are sampled on demand, so there is nothing to rerun. */
function restoreSharedProfiles(input: ProfileLinkState | undefined): void {
  const state = input ? validateProfileLinkState(input) : undefined;
  for (const entry of state?.profiles ?? []) {
    for (const body of Object.values(entry.profile.bodies ?? {})) {
      if (!getUniverse()?.getBody(body)) throw new ViewStateError(`Profile context: body "${body}" is unavailable in this catalog.`);
    }
  }
  for (const item of configuredProfiles()) removeConfiguredItem(item.id);
  for (const entry of state?.profiles ?? []) {
    const item = createConfiguredProfile(entry.profile, entry.label);
    setConfiguredItemEnabled(item.id, entry.enabled);
    setConfiguredItemVisible(item.id, entry.visible);
  }
}

/** Copy a portable snapshot without changing the current address or history. */
export async function copyViewLink(): Promise<string> {
  const url = viewLink(captureViewState(), location.href);
  await navigator.clipboard.writeText(url);
  return url;
}

export async function restoreView(state: ViewerViewState, signal?: AbortSignal): Promise<void> {
  const r = getRenderer();
  if (signal?.aborted) return;
  // Searches may take time; keep the encoded epoch paused while rebuilding.
  applyViewState(createViewerControl(), { ...state, playback: { ...state.playback, playing: false } }, { afterSeek: () => r?.renderFrame() });
  try {
    restoreSharedProfiles(state.profiles);
    await restoreSharedEvents(state.events, signal);
  } finally {
    if (!signal?.aborted && getRenderer() === r) {
      applyViewState(createViewerControl(), state, { afterSeek: () => r?.renderFrame() });
      r?.renderFrame();
    }
  }
}
