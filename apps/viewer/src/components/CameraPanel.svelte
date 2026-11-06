<script lang="ts">
  /**
   * The Camera tool (#224): what the camera is doing, in words, and the
   * controls for it. Every action goes through the same viewer-state verbs as
   * the keyboard, palette, HUD and scripts; this panel keeps no camera state of
   * its own. Opening it changes nothing about the view.
   */
  import { Save, Download, Upload } from 'lucide-svelte';
  import { vs, getRenderer, setFov, setCameraMode, trackBody, lookAtBody, clearLookAt, frameBody, flyToTracked, jumpToBody, resetCamera, applyViewpoint, cycleCamera } from '../lib/viewer-state.svelte';
  import { presentationControl } from '../lib/presentation-control';
  import { exportCameraView, importCameraViewFromFile } from '../lib/camera-view-io';
  import { cameraFrameLabel } from '../lib/camera-summary';
  import { shortcutFor } from '../lib/keymap';
  import { toolDef } from '../lib/shell.svelte';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';
  import CameraControls from './shell/CameraControls.svelte';
  import Separator from '$lib/components/ui/separator/separator.svelte';

  interface Props { onClose: () => void }
  let { onClose }: Props = $props();

  const MODES = [
    { id: 'free-orbit', label: 'Free orbit', help: 'Orbit, pan and zoom around the tracked object. Nothing is locked.' },
    { id: 'sc-fixed', label: 'Locked to spacecraft', help: 'Rides in the spacecraft’s own axes, so the view turns with it.' },
    { id: 'body-fixed', label: 'Body fixed', help: 'Rotates with the body, so surface features stay put on screen.' },
    { id: 'lvlh', label: 'LVLH', help: 'Local vertical / horizontal frame along the orbit. The frame places the camera.' },
    { id: 'chase', label: 'Chase', help: 'Follows the tracked object from behind. The frame places the camera.' },
    { id: 'surface', label: 'Surface flight', help: 'Flies low over the tracked body’s surface.' },
    { id: 'surface-explorer', label: 'Surface explorer', help: 'Looks around from ground level on the tracked body.' },
    { id: 'instrument', label: 'Instrument', help: 'Looks along a sensor’s boresight; the sensor sets the field of view.' },
  ] as const;

  const bodies = $derived(vs.bodies.map(b => b.name));
  const tracked = $derived(vs.trackedBodyName);
  const mode = $derived(MODES.find(m => m.id === vs.cameraMode));
  const hasSensors = $derived((void vs.frameTick, (getRenderer()?.getSensorNames().length ?? 0) > 0));

  /** Why a mode cannot be chosen now, or null. Shown, never silently substituted. */
  function unavailable(id: string): string | null {
    if (id === 'free-orbit') return null;
    if (!tracked) return 'needs a tracked object';
    if (id === 'instrument' && !hasSensors) return 'no sensors in this scene';
    return null;
  }

  let message = $state('');
  function run(label: string, ok: boolean) { message = ok ? '' : `${label} isn’t available right now.`; }

  function chooseMode(id: string) {
    const reason = unavailable(id);
    if (reason) { message = `Can’t switch to ${MODES.find(m => m.id === id)?.label}: ${reason}.`; return; }
    run(`Switching to ${MODES.find(m => m.id === id)?.label}`, setCameraMode(id as Parameters<typeof setCameraMode>[0]));
  }

  // ── FOV: read the renderer's live projection, so wheel, permalink and host changes show ──
  let fov = $state(60);
  $effect(() => { void vs.frameTick; const r = getRenderer(); if (r) fov = r.camera.fov; });
  const fovLocked = $derived(vs.cameraMode === 'instrument');

  // ── Named viewpoints: the existing entry point, not a second manager ──
  let viewpoints = $state<{ name: string }[]>([]);
  let selectedViewpoint = $state('');
  let vpCounter = $state(0);
  const refreshViewpoints = () => { viewpoints = getRenderer()?.cameraController.getViewpoints().map(v => ({ name: v.name })) ?? []; };
  $effect(() => { void vs.bodies; refreshViewpoints(); });

  const select = 'ui-control w-full min-w-0 rounded border border-border bg-surface-3 px-1.5 py-1 text-text-primary';
  const btn = 'ui-control flex min-h-8 items-center justify-center gap-1 rounded border border-border bg-surface-3 px-2 text-text-secondary hover:bg-border-active hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40';
</script>

<InstrumentPanel key="camera" title="Camera" width={toolDef('camera').width} {onClose}>
  <!-- Current view -->
  <section class="px-3 py-1" aria-label="Current view">
    <div class="ui-section-label mb-1">Current view</div>
    <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
      <dt class="text-text-muted">Mode</dt><dd class="m-0 text-text-primary">{mode?.label ?? vs.cameraMode}</dd>
      <dt class="text-text-muted">Tracking</dt><dd class="m-0 truncate text-text-primary" title="The object the camera follows">{tracked ?? 'Nothing (free camera)'}</dd>
      <dt class="text-text-muted">Looking at</dt><dd class="m-0 truncate text-text-primary" title="An object the camera is aimed at, independent of tracking">{vs.lookAtBodyName ?? (tracked ? `${tracked} (tracked)` : '—')}</dd>
      <dt class="text-text-muted">Frame</dt><dd class="m-0 truncate text-text-primary">{cameraFrameLabel()}</dd>
      {#if vs.surfaceTarget}
        <dt class="text-text-muted">Target</dt><dd class="m-0 truncate text-text-primary">{vs.surfaceTarget.place?.name ?? `${vs.surfaceTarget.label.wide.lat}, ${vs.surfaceTarget.label.wide.lon}`}</dd>
      {/if}
    </dl>
  </section>

  <Separator class="my-1" />

  <!-- Navigation behaviour -->
  <section class="px-3 py-1" aria-label="Navigation behavior">
    <div class="ui-section-label mb-1">Navigation</div>
    <select class={select} aria-label="Camera mode" value={vs.cameraMode} onchange={(e) => { chooseMode(e.currentTarget.value); e.currentTarget.value = vs.cameraMode; }}>
      {#each MODES as m (m.id)}
        {@const why = unavailable(m.id)}
        <option value={m.id} disabled={!!why}>{m.label}{why ? ` — ${why}` : ''}</option>
      {/each}
    </select>
    <p class="helper">{mode?.help}</p>
    <button class="{btn} mt-1 w-full" onclick={() => cycleCamera()} title="The same as the cycle shortcut">Next mode {#if shortcutFor('cam:cycle')}<kbd class="font-mono text-metadata text-text-muted">{shortcutFor('cam:cycle')}</kbd>{/if}</button>
  </section>

  <Separator class="my-1" />

  <!-- Relationships -->
  <section class="px-3 py-1" aria-label="Tracking and look-at">
    <div class="ui-section-label mb-1">Tracking and aim</div>
    <label class="mb-1 flex flex-col gap-0.5 text-xs text-text-secondary">Track
      <select class={select} value={tracked ?? ''} onchange={(e) => run('Tracking that object', trackBody(e.currentTarget.value))}>
        {#if !tracked}<option value="" disabled>Nothing</option>{/if}
        {#each bodies as name (name)}<option value={name}>{name}</option>{/each}
      </select>
    </label>
    <label class="flex flex-col gap-0.5 text-xs text-text-secondary">Look at
      <span class="flex gap-1">
        <select class={select} value={vs.lookAtBodyName ?? ''} onchange={(e) => { if (e.currentTarget.value && e.currentTarget.value !== vs.lookAtBodyName) lookAtBody(e.currentTarget.value); }}>
          <option value="">{tracked ? `${tracked} (tracked)` : 'Nothing'}</option>
          {#each bodies as name (name)}<option value={name}>{name}</option>{/each}
        </select>
        <button class={btn} disabled={!vs.lookAtBodyName} onclick={clearLookAt} aria-label="Clear look-at target" title="Clear look-at target">Clear</button>
      </span>
    </label>
    <p class="helper">Selecting an object in the scene or catalog never moves the camera; these do.</p>
  </section>

  <Separator class="my-1" />

  <!-- Actions -->
  <section class="px-3 py-1" aria-label="Camera actions">
    <div class="ui-section-label mb-1">Go to {tracked ?? 'tracked object'}</div>
    <div class="grid grid-cols-3 gap-1">
      <button class={btn} disabled={!tracked} title="Fit the tracked object in view" onclick={() => run('Frame', frameBody())}>Frame</button>
      <button class={btn} disabled={!tracked} title="Animate to the framed view ({shortcutFor('cam:fly-to') ?? ''})" onclick={() => run('Fly to', flyToTracked())}>Fly to</button>
      <button class={btn} disabled={!tracked} title="Cut to the view a flight would land on" onclick={() => run('Jump', !!tracked && jumpToBody(tracked))}>Jump</button>
    </div>
    <button class="{btn} mt-1 w-full" disabled={vs.cameraMode === 'free-orbit' && !tracked && !vs.lookAtBodyName} onclick={resetCamera} title="Back to free orbit, releasing look-at">Reset to free orbit</button>
    {#if message}<p class="helper text-error" role="alert">{message}</p>{/if}
  </section>

  <Separator class="my-1" />

  <!-- FOV -->
  <section class="px-3 py-1" aria-label="Field of view">
    <label class="flex items-center gap-2 text-xs text-text-primary">
      <span>FOV</span>
      <input type="range" class="fov-slider min-w-15 flex-1" min="1" max="120" value={fov} disabled={fovLocked}
        oninput={(e) => { fov = Number(e.currentTarget.value); setFov(fov); }} />
      <span class="ui-readout min-w-7 text-right text-text-secondary">{Math.round(fov)}&deg;</span>
    </label>
    {#if fovLocked}<p class="helper">The sensor sets the field of view in Instrument mode.</p>{/if}
  </section>

  <!-- Named viewpoints -->
  {#if viewpoints.length > 0}
    <Separator class="my-1" />
    <section class="px-3 py-1" aria-label="Viewpoints">
      <div class="ui-section-label mb-1">Viewpoints</div>
      <select class="{select} mb-1" aria-label="Viewpoint" bind:value={selectedViewpoint}
        onchange={() => { if (selectedViewpoint) applyViewpoint(selectedViewpoint, { animate: true }); }}>
        <option value="">-- select --</option>
        {#each viewpoints as vp (vp.name)}<option value={vp.name}>{vp.name}</option>{/each}
      </select>
      <div class="grid grid-cols-3 gap-1">
        <button class={btn} title="Save current view to session" aria-label="Save current view" onclick={() => {
          vpCounter++; const name = `Saved ${vpCounter}`;
          presentationControl.saveBookmark(name); refreshViewpoints(); selectedViewpoint = name;
        }}><Save size={12} /></button>
        <button class={btn} title="Download current view as JSON" aria-label="Download view" onclick={() => { const r = getRenderer(); if (r) exportCameraView(r); }}><Download size={12} /></button>
        <button class={btn} title="Load view from JSON file" aria-label="Load view" onclick={async () => { const r = getRenderer(); if (!r) return; await importCameraViewFromFile(r); refreshViewpoints(); }}><Upload size={12} /></button>
      </div>
    </section>
  {/if}

  <Separator class="my-1" />
  <CameraControls />
</InstrumentPanel>

<style>
  .helper { margin: 3px 0 0; font-size: var(--text-metadata); line-height: 1.35; color: var(--color-text-muted); }
  .fov-slider { height: 16px; appearance: none; background: transparent; cursor: pointer; }
  .fov-slider:disabled { opacity: 0.4; cursor: not-allowed; }
  .fov-slider::-webkit-slider-runnable-track { height: 3px; border-radius: 2px; background: var(--color-border-strong); }
  .fov-slider::-webkit-slider-thumb { width: 10px; height: 10px; margin-top: -3.5px; appearance: none; border: 1px solid var(--color-border-strong); border-radius: 50%; background: var(--color-text-secondary); }
  .fov-slider::-moz-range-track { height: 3px; border-radius: 2px; background: var(--color-border-strong); }
  .fov-slider::-moz-range-thumb { width: 10px; height: 10px; border: 1px solid var(--color-border-strong); border-radius: 50%; background: var(--color-text-secondary); }
</style>
