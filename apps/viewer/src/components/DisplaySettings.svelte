<script lang="ts">
  import { vs, setDisplayOption, setLighting, setCameraMode } from '../lib/viewer-state.svelte';
  import { getRenderer } from '../lib/viewer-state.svelte';
  import { CameraModeName } from '@cosmolabe/three';
  import { X, Save, Navigation } from 'lucide-svelte';
  import Checkbox from '$lib/components/ui/checkbox/checkbox.svelte';
  import Separator from '$lib/components/ui/separator/separator.svelte';

  interface Props {
    onClose: () => void;
    debugActive: boolean;
    onToggleDebug: () => void;
  }
  let { onClose, debugActive, onToggleDebug }: Props = $props();

  let fov = $state(60);
  let viewpoints = $state<{ name: string }[]>([]);
  let selectedViewpoint = $state('');
  let vpCounter = $state(0);
  let sensors = $state<string[]>([]);
  let activeInstrument = $state('');

  $effect(() => {
    const r = getRenderer();
    if (!r) return;
    fov = r.camera.fov;
    viewpoints = r.cameraController.getViewpoints().map(v => ({ name: v.name }));
    sensors = r.getSensorNames();
    activeInstrument = r.activeInstrumentView ?? '';
  });

  function onFovInput(e: Event) {
    const val = Number((e.target as HTMLInputElement).value);
    fov = val;
    const r = getRenderer();
    if (r) { r.camera.fov = val; r.camera.updateProjectionMatrix(); }
  }

  function handleBackdrop(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains('settings-backdrop')) onClose();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="settings-backdrop absolute inset-0 z-25" onclick={handleBackdrop}>
  <div class="absolute bottom-16 right-3 w-60 bg-black/90 backdrop-blur-xl border border-border rounded-lg py-2 shadow-2xl animate-fade-up">
    <!-- Header -->
    <div class="flex items-center justify-between px-3 pb-1.5 text-[12px] font-semibold text-text-primary border-b border-border mb-1">
      <span>Display</span>
      <button class="bg-transparent border-none text-text-muted cursor-pointer p-0.5 hover:text-text-primary" onclick={onClose}><X size={14} /></button>
    </div>

    <!-- Toggle rows -->
    {#each [
      { key: 'trajectories', label: 'Trajectories', shortcut: 'T', value: vs.showTrajectories },
      { key: 'labels', label: 'Labels', shortcut: 'L', value: vs.showLabels },
      { key: 'grid', label: 'Grid', shortcut: 'G', value: vs.showGrid },
      { key: 'axes', label: 'Axes', shortcut: 'X', value: vs.showAxes },
      { key: 'debug', label: 'Debug stats', shortcut: '', value: debugActive },
    ] as opt}
      <label class="flex items-center gap-2 px-3 py-1 text-[12px] cursor-pointer hover:bg-surface-3 transition-colors">
        <Checkbox checked={opt.value} onCheckedChange={() => opt.key === 'debug' ? onToggleDebug() : setDisplayOption(opt.key, !opt.value)} class="h-3.5 w-3.5" />
        <span class="flex-1 text-text-primary">{opt.label}</span>
        {#if opt.shortcut}
          <span class="text-[10px] text-text-muted bg-surface-3 px-1 py-px rounded">{opt.shortcut}</span>
        {/if}
      </label>
    {/each}

    <Separator class="my-1" />

    <!-- Lighting -->
    <div class="flex items-center gap-2 px-3 py-1 text-[12px]">
      <span class="flex-1 text-text-primary">Lighting</span>
      <select
        class="bg-surface-3 text-text-primary border border-border rounded px-1.5 py-0.5 text-[11px] cursor-pointer outline-none"
        value={vs.lightingMode}
        onchange={(e) => setLighting((e.target as HTMLSelectElement).value as 'natural' | 'shadow' | 'flood')}
      >
        <option value="natural">Natural</option>
        <option value="shadow">Shadow</option>
        <option value="flood">Flood</option>
      </select>
    </div>

    <!-- FOV -->
    <div class="flex items-center gap-2 px-3 py-1 text-[12px]">
      <span class="text-text-primary">FOV</span>
      <input type="range" class="flex-1 min-w-15 h-4" min="1" max="120" value={fov} oninput={onFovInput} />
      <span class="font-mono text-[11px] text-text-secondary min-w-7 text-right">{fov}&deg;</span>
    </div>

    <!-- Camera mode -->
    <div class="flex items-center gap-2 px-3 py-1 text-[12px]">
      <span class="flex-1 text-text-primary">Camera</span>
      <select
        class="bg-surface-3 text-text-primary border border-border rounded px-1.5 py-0.5 text-[11px] cursor-pointer outline-none"
        value={vs.cameraMode}
        onchange={(e) => setCameraMode((e.target as HTMLSelectElement).value as CameraModeName)}
      >
        <option value="free-orbit">Free Orbit</option>
        <option value="sc-fixed">Locked</option>
        <option value="body-fixed">Body Fixed</option>
        <option value="lvlh">LVLH</option>
        <option value="chase">Chase</option>
        <option value="surface">Surface Flight</option>
        <option value="surface-explorer">Surface Explorer</option>
        <option value="instrument">Instrument</option>
      </select>
    </div>

    <!-- Viewpoints -->
    {#if viewpoints.length > 0}
      <Separator class="my-1" />
      <div class="flex items-center gap-2 px-3 py-1 text-[12px]">
        <span class="flex-1 text-text-primary">Viewpoint</span>
        <select
          class="bg-surface-3 text-text-primary border border-border rounded px-1.5 py-0.5 text-[11px] cursor-pointer outline-none max-w-28"
          bind:value={selectedViewpoint}
          onchange={() => {
            if (!selectedViewpoint) return;
            const r = getRenderer();
            if (!r) return;
            const vp = r.cameraController.getViewpoint(selectedViewpoint);
            if (!vp) return;
            if (vp.trackBody) {
              const bm = r.getBodyMesh(vp.trackBody);
              if (bm) {
                r.cameraController.track(bm);
                r.cameraController.applyViewpoint(vp);
                if (vp.target.lengthSq() > 1e-30) r.cameraController.track(null);
              }
            } else {
              r.cameraController.goToViewpoint(selectedViewpoint, 1.0);
            }
          }}
        >
          <option value="">-- select --</option>
          {#each viewpoints as vp}<option value={vp.name}>{vp.name}</option>{/each}
        </select>
      </div>
      <div class="flex gap-1 px-3 py-1">
        <button class="inline-flex items-center gap-1 text-[11px] text-text-secondary bg-surface-3 border border-border rounded px-2 py-0.5 cursor-pointer hover:bg-border-active hover:text-text-primary transition-colors" onclick={() => {
          const r = getRenderer();
          if (r) {
            vpCounter++;
            const name = `Saved ${vpCounter}`;
            r.cameraController.saveViewpoint(name);
            viewpoints = r.cameraController.getViewpoints().map(v => ({ name: v.name }));
            selectedViewpoint = name;
          }
        }}><Save size={11} /> Save</button>
        <button class="inline-flex items-center gap-1 text-[11px] text-text-secondary bg-surface-3 border border-border rounded px-2 py-0.5 cursor-pointer hover:bg-border-active hover:text-text-primary transition-colors" onclick={() => {
          const r = getRenderer();
          const tracked = r?.cameraController.trackedBody;
          if (r && tracked) r.cameraController.flyTo(tracked, { scaleFactor: 1e-6 });
        }}><Navigation size={11} /> Fly to</button>
      </div>
    {/if}

    <!-- Instruments -->
    {#if sensors.length > 0}
      <Separator class="my-1" />
      <div class="flex items-center gap-2 px-3 py-1 text-[12px]">
        <span class="flex-1 text-text-primary">Instrument</span>
        <select
          class="bg-surface-3 text-text-primary border border-border rounded px-1.5 py-0.5 text-[11px] cursor-pointer outline-none max-w-28"
          bind:value={activeInstrument}
          onchange={() => { getRenderer()?.setInstrumentView(activeInstrument || null, { marginX: 16, marginY: 60 }); }}
        >
          <option value="">Off</option>
          {#each sensors as name}<option value={name}>{name}</option>{/each}
        </select>
        <span class="text-[10px] text-text-muted bg-surface-3 px-1 py-px rounded">I</span>
      </div>
    {/if}
  </div>
</div>

<style>
  @keyframes fade-up {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .animate-fade-up { animation: fade-up 0.12s ease; }
</style>
