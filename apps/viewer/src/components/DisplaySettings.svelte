<script lang="ts">
  import { ANGULAR_GRID_STEPS } from '@cosmolabe/control';
  import { vs, setGridSettings, setDisplayOption, setImageryLighting, setLighting, setTerrainShadowMode } from '../lib/viewer-state.svelte';

  import { getRenderer } from '../lib/viewer-state.svelte';
  import { takeScreenshot, isRecordingVideo, toggleVideoRecording } from '../lib/capture';
  import { Camera, Video, Square } from 'lucide-svelte';
  import { toolDef, openTool, closeTool, isToolOpen } from '../lib/shell.svelte';
  import GeographicNames from './GeographicNames.svelte';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';
  import Checkbox from '$lib/components/ui/checkbox/checkbox.svelte';
  import Separator from '$lib/components/ui/separator/separator.svelte';
  import { shortcutFor } from '../lib/keymap';

  interface Props {
    onClose: () => void;
    debugActive: boolean;
    onToggleDebug: () => void;
  }
  let { onClose, debugActive, onToggleDebug }: Props = $props();

  let recording = $state(false);

  $effect(() => {
    const r = getRenderer();
    if (r) recording = isRecordingVideo(r);
  });

  // Followed per frame like the Instrument view window, so a scene bound after
  // this panel opened still lists its sensors. Joined so a quiet frame changes
  // nothing downstream.
  const sensorList = $derived.by(() => {
    void vs.frameTick;
    return getRenderer()?.getSensorNames().join('\n') ?? '';
  });
  const sensors = $derived(sensorList ? sensorList.split('\n') : []);
  const hasAcquiredImagery = $derived.by(() => {
    void vs.frameTick;
    return getRenderer()?.hasAcquiredImagery ?? false;
  });

  // Terrain shadows (#205): shown whenever a loaded body has terrain with heights a shadow can be built from. The select
  // is the viewer's choice when it has made one, else what the catalog configured (Off unless it sets `solarShadows`).
  // Followed per frame: the terrain, and its clipmap, are created and filled after the scene loads.
  const shadowSummary = $derived.by(() => {
    void vs.frameTick;
    const s = getRenderer()?.terrainShadowSummary() ?? null;
    return s && JSON.stringify({ mode: s.mode, state: s.state, unknown: Math.round(s.unknownFraction * 100), coarse: Math.round(s.coarseFraction * 100), baked: s.bakedOnly });
  });
  const shadow = $derived(shadowSummary ? JSON.parse(shadowSummary) as { mode: 'off' | 'low' | 'medium' | 'high'; state: string | null; unknown: number; coarse: number; baked: boolean } : null);
  const shadowStatusText = $derived.by(() => {
    if (!shadow) return '';
    if (vs.lightingMode === 'flood') return 'Flood shows the imagery without simulated sunlight or terrain shadows.';
    const original = shadow.baked && vs.imageryLightingMode === 'original';
    if (shadow.mode === 'off') {
      if (!original) return '';
      return vs.lightingMode === 'shadow'
        ? 'The simulated night side is brighter. Photographic shadows remain.'
        : 'The simulated Sun moves the day/night boundary. Photographic shadows remain.';
    }
    // The finest clipmap level, around the view's centre.
    if (shadow.coarse > 0 && (shadow.state === 'ready' || shadow.state === 'partial')) {
      return `Terrain heights here are farther apart than the shadow detail${shadow.coarse < 100 ? ` (${shadow.coarse} %)` : ''}: shadows there are only as sharp as the heights support.`;
    }
    switch (shadow.state) {
      case 'building': return 'Building terrain data…';
      case 'partial': return original
        ? 'Terrain shadows use loaded heights. Gaps use the reference-sphere horizon.'
        : `Some terrain not loaded (${shadow.unknown} %). Simulated shadows may be incomplete.`;
      case 'ready': return original
        ? 'Simulated terrain shadows are layered over the photograph.'
        : 'On, from the loaded terrain heights.';
      case 'out-of-range': return original
        ? 'Terrain shadows are out of range. Using the reference-sphere horizon.'
        : 'Terrain shadows are out of range.';
      default: return 'Starts when the camera is near the surface.';
    }
  });
</script>

<InstrumentPanel key="display" title="Display" width={toolDef('display').width} {onClose}>

    <!-- Toggle rows -->
    {#each [
      { key: 'trajectories' as const, label: 'Trajectories', shortcut: shortcutFor('disp:traj'), value: vs.showTrajectories },
      { key: 'grid' as const, label: 'Grid', shortcut: shortcutFor('disp:grid'), value: vs.showGrid },
      { key: 'axes' as const, label: 'Axes', shortcut: shortcutFor('disp:axes'), value: vs.showAxes },
      { key: 'sensors' as const, label: 'Sensors', shortcut: '', value: vs.showSensors },
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
    <div class="ui-section-label px-3 py-1">Labels</div>
    {#each [
      { key: 'labels' as const, label: 'Body labels', shortcut: shortcutFor('disp:labels'), value: vs.showLabels },
      { key: 'sensorLabels' as const, label: 'Sensor labels', shortcut: undefined, value: vs.showSensorLabels },
    ] as opt}
      <label class="option-row ui-body flex items-center gap-2 px-3 py-1 cursor-pointer hover:bg-surface-3 transition-colors">
        <Checkbox checked={opt.value} onCheckedChange={() => setDisplayOption(opt.key, !opt.value)} class="h-3.5 w-3.5" />
        <span class="flex-1 text-text-primary">{opt.label}</span>
        {#if opt.shortcut}<span class="ui-meta bg-surface-3 px-1 py-px rounded">{opt.shortcut}</span>{/if}
      </label>
    {/each}
    <GeographicNames />

    <Separator class="my-1" />

    <div class="px-3 py-1 space-y-2">
      <div class="ui-section-label">Surface grid</div>
      <label class="ui-body flex items-center gap-2">
        <Checkbox checked={vs.grid.labels} onCheckedChange={() => setGridSettings({ labels: !vs.grid.labels })} class="h-3.5 w-3.5" />
        <span>Coordinate labels</span>
      </label>
      <label class="ui-body flex items-center gap-2">
        <span>Opacity</span>
        <input aria-label="Grid opacity" aria-describedby="grid-opacity-help" type="range" class="fov-slider flex-1 min-w-0"
          min="0" max="100" step="1" value={Math.round(vs.grid.opacity * 100)}
          oninput={e => setGridSettings({ opacity: Number(e.currentTarget.value) / 100 })} />
        <span class="ui-readout min-w-8 text-right">{Math.round(vs.grid.opacity * 100)}%</span>
      </label>
      <p id="grid-opacity-help" class="ui-meta text-text-secondary">Fades grid lines and coordinate labels together.</p>
      <label class="ui-body flex items-center justify-between gap-2">
        <span>Target</span>
        <select aria-label="Grid target" class="ui-control bg-surface-3 rounded" value={vs.grid.scope}
          onchange={e => setGridSettings({ scope: e.currentTarget.value as 'tracked' | 'bodies' | 'all', perBody: {} })}>
          <option value="tracked">Tracked body</option><option value="bodies">Chosen bodies</option><option value="all">All eligible bodies</option>
        </select>
      </label>
      {#if vs.grid.scope === 'bodies'}
        <label class="ui-body block">Body names
          <input class="ui-control w-full bg-surface-3 rounded px-1" aria-label="Grid body names" placeholder="Earth, Moon"
            value={vs.grid.bodies.join(', ')} onchange={e => setGridSettings({ bodies: e.currentTarget.value.split(',').map(s => s.trim()).filter(Boolean) })} />
        </label>
      {/if}
      <label class="ui-body flex items-center justify-between gap-2">
        <span>Density</span>
        <select aria-label="Grid density" class="ui-control bg-surface-3 rounded" value={vs.grid.density}
          onchange={e => setGridSettings({ density: e.currentTarget.value as 'auto' | 'manual' })}>
          <option value="auto">Auto</option><option value="manual">Manual</option>
        </select>
      </label>
      {#if vs.grid.density === 'manual'}
        <label class="ui-body flex items-center justify-between gap-2">Spacing (degrees)
          <select aria-label="Grid angular spacing" class="ui-control w-18 bg-surface-3 rounded"
            value={vs.grid.spacingDeg} onchange={e => setGridSettings({ spacingDeg: Number(e.currentTarget.value) })}>
            {#each ANGULAR_GRID_STEPS as step}<option value={step}>{step}°</option>{/each}
          </select>
        </label>
      {/if}
      {#if vs.grid.density === 'manual'}
        <label class="ui-body flex items-center gap-2">
          <Checkbox checked={vs.grid.minorLines} onCheckedChange={() => setGridSettings({ minorLines: !vs.grid.minorLines })} class="h-3.5 w-3.5" />
          <span>Minor lines</span>
        </label>
      {:else}
        <p class="ui-meta text-text-secondary">Major lines carry labels; lighter lines divide each cell.</p>
      {/if}
      <label class="ui-body flex items-center gap-2">
        <Checkbox checked={vs.grid.coordinateFrame} onCheckedChange={() => setGridSettings({ coordinateFrame: !vs.grid.coordinateFrame })} class="h-3.5 w-3.5" />
        <span>Labels at viewport border</span>
      </label>
      <p class="ui-meta text-text-secondary">In close overhead views, labels move to ticks where grid lines cross the screen border. Turn off for labels at fixed geographic sites on the surface. Zoomed-out views keep surface labels.</p>
      <details class="ui-meta text-text-secondary"><summary>Coordinates and surface</summary>
        <p>East-positive longitude (E/W), geodetic latitude on spheres and rotational ellipsoids. Triaxial bodies use planetocentric latitude. Lines follow the rendered surface and its current level of detail. Triaxial globes use a planetocentric reference surface. Mesh-body grids and DSK draping are unavailable.</p>
      </details>
    </div>
    <Separator class="my-1" />

    <!-- Lighting -->
    <div class="ui-body flex items-center gap-2 px-3 py-1">
      <span class="flex-1 text-text-primary">Lighting</span>
      <select
        class="ui-control bg-surface-3 text-text-primary border border-border rounded px-1.5 py-0.5 cursor-pointer outline-none"
        aria-label="Lighting"
        value={vs.lightingMode}
        onchange={(e) => setLighting((e.target as HTMLSelectElement).value as 'natural' | 'shadow' | 'flood')}
      >
        <option value="natural">Natural</option>
        <option value="shadow">Shadow</option>
        <option value="flood">Flood</option>
      </select>
    </div>

    {#if hasAcquiredImagery}
      <label class="ui-body flex flex-wrap items-center gap-2 px-3 py-1">
        <span class="flex-1 text-text-primary" title="Simulated lighting adds slope shading to photography that already contains acquisition lighting. Flood always shows the source imagery.">Imagery lighting</span>
        <select
          class="ui-control bg-surface-3 text-text-primary border border-border rounded px-1.5 py-0.5 cursor-pointer outline-none max-w-full"
          value={vs.imageryLightingMode}
          disabled={vs.lightingMode === 'flood'}
          onchange={(e) => setImageryLighting(e.currentTarget.value === 'simulated' ? 'simulated' : 'original')}
        >
          <option value="original">Original photography</option>
          <option value="simulated">Simulated (approximate)</option>
        </select>
      </label>
    {/if}

    {#if shadow}
      <div class="ui-body flex items-center gap-2 px-3 py-1">
        <span class="flex-1 text-text-primary" title="Uses loaded heights to estimate current Sun visibility. On photographs, simulated shadows are layered over the original acquisition shadows. Higher quality costs more GPU time.">Terrain shadows</span>
        <select
          class="ui-control bg-surface-3 text-text-primary border border-border rounded px-1.5 py-0.5 cursor-pointer outline-none"
          aria-label="Terrain shadows"
          aria-describedby={shadowStatusText ? 'terrain-shadow-status' : undefined}
          data-testid="terrain-shadow-mode"
          value={shadow.mode}
          onchange={(e) => setTerrainShadowMode((e.target as HTMLSelectElement).value as 'off' | 'low' | 'medium' | 'high')}
        >
          <option value="off">Off</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>
      {#if shadowStatusText}<p class="ui-meta text-text-secondary px-3 pb-1" id="terrain-shadow-status" data-testid="terrain-shadow-status">{shadowStatusText}</p>{/if}
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
          value={isToolOpen('instrument') ? (vs.instrumentSensor ?? '') : ''}
          onchange={(e) => {
            // The same window the `I` key opens; Off closes it.
            const name = (e.target as HTMLSelectElement).value;
            if (!name) { closeTool('instrument'); return; }
            vs.instrumentSensor = name;
            openTool('instrument');
          }}
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
