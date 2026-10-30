/**
 * A plain TypeScript host — no framework — embedding the complete Cosmolabe
 * workspace beside its own mission UI: a clock that follows and drives the
 * viewer's, a spacecraft list, the mission plan, and source status.
 *
 * The host supplies mission data and context (sources, activities, time,
 * selection); Cosmolabe owns visualization and spatial analysis.
 */
import { mountCosmolabe, type CosmolabeViewer, type ScriptEventMap } from '@cosmolabe/viewer';
import { FixtureArchive, LiveFeed, archiveSource } from './telemetry';
import * as fixtures from './fixtures';
import { T0, T0_UTC, missionPlan, sceneCatalog } from './fixtures';
import './host.css';

const archive = new FixtureArchive();
const live = new LiveFeed();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const container = $('viewer');
const clock = $<HTMLInputElement>('clock');
const clockText = $('clock-text');
const selection = $('selection');
const statusEl = $('status');
const eventsEl = $('events');

let viewer: CosmolabeViewer | null = null;
const seen: { [K in keyof ScriptEventMap]?: ScriptEventMap[K][] } = {};

function record<K extends keyof ScriptEventMap>(event: K, data: ScriptEventMap[K]) {
  (seen[event] ??= [] as never[]).push(data as never);
  const line = document.createElement('li');
  line.textContent = `${event} ${JSON.stringify(data)}`;
  eventsEl.prepend(line);
  while (eventsEl.childElementCount > 40) eventsEl.lastElementChild!.remove();
}

const utc = (et: number) => new Date(Date.parse(T0_UTC) + (et - T0) * 1000).toISOString().replace('.000Z', 'Z');

async function mount(): Promise<CosmolabeViewer> {
  viewer = await mountCosmolabe(container, {
    ui: { timeline: true, toolRail: true, analysisPanels: true, catalogBrowser: false, homeScreen: false },
    missionState: [archiveSource(archive, 'sc1', { live }), archiveSource(archive, 'sc2')],
  });
  const { control } = viewer;
  // Viewer → host: mirror the clock, but not our own seeks echoed back.
  control.on('time', (e) => {
    record('time', e);
    if (e.cause !== 'host') clock.valueAsNumber = e.et - T0;
    clockText.textContent = utc(e.et);
  });
  control.on('select', (e) => { record('select', e); selection.textContent = e.name ?? '—'; });
  control.on('activitySelect', (e) => record('activitySelect', e));
  control.on('activities', (e) => record('activities', e));
  control.on('playback', (e) => record('playback', e));
  control.on('ready', (e) => record('ready', e));
  viewer.missionState.onChange(renderStatus);
  viewer.activities.replace('mission-plan', missionPlan());
  await viewer.loadCatalog({ json: sceneCatalog(), baseUrl: document.baseURI });
  control.setTimelineWindow?.({ kind: 'et', et: T0 }, { kind: 'et', et: T0 + 4 * 3600 });
  return viewer;
}

function renderStatus() {
  if (!viewer) { statusEl.textContent = 'unmounted'; return; }
  statusEl.textContent = viewer.missionState.sourceIds().map((id) => {
    const s = viewer!.missionState.status(id)!;
    const ch = (c?: { samples: number; evaluable: readonly { start: number; end: number }[]; error?: string }) =>
      c ? `${c.samples} samples, ${c.evaluable.length} runs${c.error ? `, error: ${c.error}` : ''}` : 'none';
    return `${id} [${s.connection}] position: ${ch(s.position)}; attitude: ${ch(s.attitude)}`;
  }).join('\n');
}

// Host → viewer: the host's own clock and selection controls.
clock.addEventListener('input', () => viewer?.control.setTime({ kind: 'et', et: T0 + clock.valueAsNumber }));
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-select]')) {
  button.addEventListener('click', () => {
    viewer?.control.select(button.dataset.select!);
    viewer?.control.track(button.dataset.select!);
  });
}
$('play').addEventListener('click', () => viewer?.control.setPlaying(!viewer.control.isPlaying()));
$('live').addEventListener('click', () => live.advance(120, archive));
$('disconnect').addEventListener('click', () => live.setConnected(false));
$('unmount').addEventListener('click', async () => {
  if (viewer) { await viewer.dispose(); viewer = null; renderStatus(); } else await mount();
});
$('narrow').addEventListener('click', () => container.classList.toggle('narrow'));

// For the acceptance test (scripts/test-embed-host.mjs): the same objects the UI uses.
Object.assign(window, { host: { get viewer() { return viewer; }, mount, archive, live, seen, T0, utc, sceneCatalog, missionPlan, archiveSource, fixtures, mountCosmolabe } });

// `?manual`: the acceptance test mounts itself, after measuring the page bare.
if (!new URLSearchParams(location.search).has('manual')) mount().catch((err) => {
  statusEl.textContent = `Mount failed: ${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
});
