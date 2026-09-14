<script lang="ts">
  import { vs, setDisplayOption, setFov, setLighting, setCameraMode } from '../lib/viewer-state.svelte';
  import { getRenderer } from '../lib/viewer-state.svelte';
  import { exportCameraView, importCameraViewFromFile } from '../lib/camera-view-io';
  import { takeScreenshot, isRecordingVideo, toggleVideoRecording } from '../lib/capture';
  import { CameraModeName } from '@cosmolabe/three';
  import { Save, Navigation, Download, Upload, Camera, Video, Square } from 'lucide-svelte';
  import { toolDef } from '../lib/shell.svelte';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';
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
  let recording = $state(false);

  $effect(() => {
    const r = getRenderer();
    if (!r) return;
    fov = r.camera.fov;
    viewpoints = r.cameraController.getViewpoints().map(v => ({ name: v.name }));
    sensors = r.getSensorNames();
    activeInstrument = r.activeInstrumentView ?? '';
    recording = isRecordingVideo(r);
  });

  function onFovInput(e: Event) {
    const val = Number((e.target as HTMLInputElement).value);
    fov = val;
    setFov(val);
  }

</script>

<InstrumentPanel key="display" title="Display" width={toolDef('display').width} {onClose}>

    <!-- Toggle rows -->
    {#each [
      { key: 'trajectories' as const, label: 'Trajectories', shortcut: 'T', value: vs.showTrajectories },
      { key: 'labels' as const, label: 'Labels', shortcut: 'L', value: vs.showLabels },
      { key: 'grid' as const, label: 'Grid', shortcut: 'G', value: vs.showGrid },
      { key: 'axes' as const, label: 'Axes', shortcut: 'X', value: vs.showAxes },
      { key: 'sensors' as const, label: 'Sensors', shortcut: '', value: vs.showSensors },
      { key: 'sensorLabels' as const, label: 'Sensor labels', shortcut: '', value: vs.showSensorLabels },
      { key: 'debug' as const, label: 'Debug stats', shortcut: '', value: debugActive },
    ] as opt}
      <label class="option-row ui-body flex items-center gap-2 px-3 py-1 cursor-pointer hover:bg-surface-3 transition-colors">
        <Checkbox checked={opt.value} onCheckedChange={() => opt.key === 'debug' ? onToggleDebug() : setDisplayOption(opt.key, !opt.value)} class="h-3.5 w-3.5" />
        <span class="flex-1 text-text-primary">{opt.label}</span>
        {#if opt.shortcut}
          <span class="ui-meta bg-surface-3 px-1 py-px rounded">{opt.shortcut}</span>
        {/if}
      </label>
    {/each}

    <Separator class="my-1" />

    <!-- Lighting -->
    <div class="ui-body flex items-center gap-2 px-3 py-1">
      <span class="flex-1 text-text-primary">Lighting</span>
      <select
        class="ui-control bg-surface-3 text-text-primary border border-border rounded px-1.5 py-0.5 cursor-pointer outline-none"
        value={vs.lightingMode}
        onchange={(e) => setLighting((e.target as HTMLSelectElement).value as 'natural' | 'shadow' | 'flood')}
      >
        <option value="natural">Natural</option>
        <option value="shadow">Shadow</option>
        <option value="flood">Flood</option>
      </select>
    </div>

    <!-- FOV -->
    <div class="ui-body flex items-center gap-2 px-3 py-1">
      <span class="text-text-primary">FOV</span>
      <input type="range" class="fov-slider flex-1 min-w-15" min="1" max="120" value={fov} oninput={onFovInput} />
      <span class="ui-readout text-text-secondary min-w-7 text-right">{fov}&deg;</span>
    </div>

    <!-- Camera mode -->
    <div class="ui-body flex items-center gap-2 px-3 py-1">
      <span class="flex-1 text-text-primary">Camera</span>
      <select
        class="ui-control bg-surface-3 text-text-primary border border-border rounded px-1.5 py-0.5 cursor-pointer outline-none"
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
      <div class="px-3 py-1">
        <div class="ui-section-label mb-1">Viewpoint</div>
        <div class="mb-1">
          <select
            class="ui-control w-full bg-surface-3 text-text-primary border border-border rounded px-1.5 py-0.5 cursor-pointer outline-none"
            bind:value={selectedViewpoint}
            onchange={() => {
              if (!selectedViewpoint) return;
              const r = getRenderer();
              if (!r) return;
              // Also seeks the clock when the viewpoint declares a `time`.
              r.applyNamedViewpoint(selectedViewpoint, { animate: true });
            }}
          >
            <option value="">-- select --</option>
            {#each viewpoints as vp}<option value={vp.name}>{vp.name}</option>{/each}
          </select>
        </div>
        <div class="grid grid-cols-4 gap-1">
          <button class="ui-control flex items-center justify-center h-6 text-text-secondary bg-surface-3 border border-border rounded cursor-pointer hover:bg-border-active hover:text-text-primary transition-colors" title="Save current view to session" onclick={() => {
            const r = getRenderer();
            if (r) {
              vpCounter++;
              const name = `Saved ${vpCounter}`;
              r.cameraController.saveViewpoint(name);
              viewpoints = r.cameraController.getViewpoints().map(v => ({ name: v.name }));
              selectedViewpoint = name;
            }
          }}><Save size={12} /></button>
          <button class="ui-control flex items-center justify-center h-6 text-text-secondary bg-surface-3 border border-border rounded cursor-pointer hover:bg-border-active hover:text-text-primary transition-colors" title="Fly to tracked body" onclick={() => {
            const r = getRenderer();
            const tracked = r?.cameraController.trackedBody;
            if (r && tracked) r.cameraController.flyTo(tracked, { scaleFactor: 1e-6 });
          }}><Navigation size={12} /></button>
          <button class="ui-control flex items-center justify-center h-6 text-text-secondary bg-surface-3 border border-border rounded cursor-pointer hover:bg-border-active hover:text-text-primary transition-colors" title="Download current view as JSON" onclick={() => {
            const r = getRenderer();
            if (r) exportCameraView(r);
          }}><Download size={12} /></button>
          <button class="ui-control flex items-center justify-center h-6 text-text-secondary bg-surface-3 border border-border rounded cursor-pointer hover:bg-border-active hover:text-text-primary transition-colors" title="Load view from JSON file" onclick={async () => {
            const r = getRenderer();
            if (!r) return;
            await importCameraViewFromFile(r);
            viewpoints = r.cameraController.getViewpoints().map(v => ({ name: v.name }));
          }}><Upload size={12} /></button>
        </div>
      </div>
    {/if}

    <!-- Capture -->
    <Separator class="my-1" />
    <div class="px-3 py-1">
      <div class="flex items-center gap-2 mb-1">
        <span class="ui-section-label flex-1">Capture</span>
        {#if recording}<span class="ui-meta flex items-center gap-1 text-red-400"><span class="inline-block w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"></span>REC</span>{/if}
      </div>
      <div class="grid grid-cols-2 gap-1">
        <button class="ui-control flex items-center justify-center gap-1 h-6 text-text-secondary bg-surface-3 border border-border rounded cursor-pointer hover:bg-border-active hover:text-text-primary transition-colors" title="Save screenshot (PNG)" onclick={() => {
          const r = getRenderer();
          if (r) takeScreenshot(r);
        }}><Camera size={12} /> Screenshot</button>
        <button class="ui-control flex items-center justify-center gap-1 h-6 border rounded cursor-pointer transition-colors {recording ? 'text-red-300 bg-red-900/30 border-red-700 hover:bg-red-900/50' : 'text-text-secondary bg-surface-3 border-border hover:bg-border-active hover:text-text-primary'}" title={recording ? 'Stop recording (download webm)' : 'Start recording video'} onclick={() => {
          const r = getRenderer();
          if (r) recording = toggleVideoRecording(r);
        }}>{#if recording}<Square size={11} /> Stop{:else}<Video size={12} /> Record{/if}</button>
      </div>
    </div>

    <!-- Instruments -->
    {#if sensors.length > 0}
      <Separator class="my-1" />
      <div class="ui-body flex items-center gap-2 px-3 py-1">
        <span class="flex-1 text-text-primary">Instrument</span>
        <select
          class="ui-control bg-surface-3 text-text-primary border border-border rounded px-1.5 py-0.5 cursor-pointer outline-none max-w-28"
          bind:value={activeInstrument}
          onchange={() => { getRenderer()?.setInstrumentView(activeInstrument || null, { marginX: 16, marginY: 60 }); }}
        >
          <option value="">Off</option>
          {#each sensors as name}<option value={name}>{name}</option>{/each}
        </select>
        <span class="ui-meta bg-surface-3 px-1 py-px rounded">I</span>
      </div>
    {/if}
</InstrumentPanel>

<style>
  .option-row:focus-within {
    background: var(--color-selected);
  }
  .fov-slider {
    height: 16px;
    appearance: none;
    background: transparent;
    cursor: pointer;
  }
  .fov-slider::-webkit-slider-runnable-track {
    height: 3px;
    border-radius: 2px;
    background: var(--color-border-strong);
  }
  .fov-slider::-webkit-slider-thumb {
    width: 10px;
    height: 10px;
    margin-top: -3.5px;
    appearance: none;
    border: 1px solid var(--color-border-strong);
    border-radius: 50%;
    background: var(--color-text-secondary);
  }
  .fov-slider:hover::-webkit-slider-thumb {
    background: var(--color-text-primary);
  }
  .fov-slider::-moz-range-track {
    height: 3px;
    border-radius: 2px;
    background: var(--color-border-strong);
  }
  .fov-slider::-moz-range-thumb {
    width: 10px;
    height: 10px;
    border: 1px solid var(--color-border-strong);
    border-radius: 50%;
    background: var(--color-text-secondary);
  }
</style>
