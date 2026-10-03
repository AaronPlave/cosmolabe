<script lang="ts">
  import { onMount } from 'svelte';
  import { TERRAIN_DEBUG_MODES, type TerrainDebugMode, type TerrainPerformanceMetrics } from '@cosmolabe/three';
  import { vs, getRenderer } from '../lib/viewer-state.svelte';
  import { toolDef } from '../lib/shell.svelte';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  // Rolling history for sparkline charts
  const HISTORY_LEN = 60;
  let fpsHistory = $state<number[]>([]);
  let heapHistory = $state<number[]>([]);

  let frameCount = 0;
  let currentFps = $state(0);
  let currentHeapMB = $state<number | null>(null);
  let terrainDebug = $state(false);
  let terrainDebugMode = $state<TerrainDebugMode>('none');

  /** One legend line per debug surface mode; the encoding lives in TerrainManager. */
  const DEBUG_MODE_LEGEND: Record<TerrainDebugMode, string> = {
    'none': 'Normal rendering',
    'lod': 'Tile depth: shallow dark → deep bright',
    'geometric-error': 'Declared tile error: low dark → high bright',
    'screen-error': 'Screen-space error this frame: low dark → high bright',
    'cpu-coverage': 'Green: CPU heights decoded · amber: split from parent',
    'datum-height': 'Mean height vs datum: blue below · red above',
    'seam-error': 'Edge mismatch vs neighbours: green 0 → red ≥ 5 m · grey: none cached',
    'residual': 'Detail − base: blue negative · white 0 · red positive · grey: fields not loaded',
    'coverage': 'Detail taper weight: dark base only → bright full detail',
    'source-boundary': 'Red: coverage edge · amber: blend band · green: detail · dark: base only',
  };

  /**
   * Terrain numbers for the selected body, or the first body with streamed
   * terrain when the selection has none (selecting a rover should not blank
   * the planet's terrain diagnostics). Polled with FPS rather than derived
   * per frame: the memory estimate walks the loaded tiles.
   */
  interface TerrainSnapshot { body: string; metrics: TerrainPerformanceMetrics; source: string | null; state: string; debugMode: TerrainDebugMode; }
  let terrain = $state<TerrainSnapshot | null>(null);

  function pollTerrain(): void {
    const r = getRenderer();
    if (!r) { terrain = null; return; }
    const names = [vs.selectedBodyName, ...vs.bodies.map((b) => b.name)].filter((n): n is string => !!n);
    for (const name of names) {
      const bm = r.getBodyMesh(name);
      const metrics = bm?.terrainMetrics;
      if (bm && metrics) {
        terrain = {
          body: name, metrics, source: bm.terrainSourceId,
          state: bm.terrainDiagnostics?.state ?? 'unloaded',
          debugMode: bm.terrainDebugMode ?? 'none',
        };
        // The renderer owns the mode; the panel only mirrors it, so reopening
        // the panel or reloading a catalog never shows a stale selection.
        terrainDebugMode = terrain.debugMode;
        return;
      }
    }
    terrain = null;
  }

  const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  const fixed = (v: number) => v.toFixed(v < 10 ? 2 : 1);

  onMount(() => {
    let running = true;
    let lastSample = performance.now();

    const loop = () => {
      if (!running) return;
      frameCount++;
      const now = performance.now();

      // Sample every 500ms
      if (now - lastSample >= 500) {
        const elapsed = (now - lastSample) / 1000;
        currentFps = Math.round(frameCount / elapsed);
        frameCount = 0;
        lastSample = now;

        fpsHistory = [...fpsHistory.slice(-(HISTORY_LEN - 1)), currentFps];
        pollTerrain();

        const perf = performance as any;
        if (perf.memory) {
          currentHeapMB = Math.round(perf.memory.usedJSHeapSize / (1024 * 1024));
          heapHistory = [...heapHistory.slice(-(HISTORY_LEN - 1)), currentHeapMB];
        }
      }

      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);

    return () => { running = false; };
  });

  // Renderer stats — re-derive each frame
  let info = $derived.by(() => {
    void vs.et;
    const r = getRenderer();
    if (!r) return null;

    const ri = r.renderer.info;
    const cam = r.camera;
    const cc = r.cameraController;
    const camDistKm = cam.position.distanceTo(cc.controls.target) / r.scaleFactor;
    return {
      kernels: vs.kernelCount,
      bodies: vs.bodies.length,
      drawCalls: ri.render.calls,
      triangles: ri.render.triangles,
      geometries: ri.memory.geometries,
      textures: ri.memory.textures,
      programs: ri.programs?.length ?? 0,
      fov: cam.fov,
      camDistKm,
      mode: cc.mode,
      tracked: cc.trackedBody?.body.name ?? '—',
      et: vs.et,
    };
  });

  function fmtNum(n: number): string {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(n);
  }

  function fmtDist(km: number): string {
    if (km < 1) return `${(km * 1000).toFixed(0)} m`;
    if (km < 1000) return `${km.toFixed(1)} km`;
    if (km < 1e6) return `${(km / 1000).toFixed(1)}K km`;
    return `${(km / 1e6).toFixed(2)}M km`;
  }

  /** Build an SVG polyline points string from a number array, normalized 0-1 vertically */
  function sparkline(data: number[], width: number, height: number): string {
    if (data.length < 2) return '';
    const max = Math.max(...data, 1);
    const step = width / (HISTORY_LEN - 1);
    return data.map((v, i) => {
      const x = i * step;
      const y = height - (v / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }
</script>

{#if info}
  <InstrumentPanel key="debug" title="Diagnostics" width={toolDef('debug').width} {onClose}>
    <div class="diagnostics">

    <!-- FPS chart -->
    <div class="mb-1.5">
      <div class="row mb-0.5">
        <span class="label">FPS</span>
        <span class="val">{currentFps}</span>
      </div>
      <svg class="w-full h-6 block" viewBox="0 0 180 24" preserveAspectRatio="none">
        <polyline points={sparkline(fpsHistory, 180, 24)} fill="none" stroke="var(--color-text-muted)" stroke-width="1" vector-effect="non-scaling-stroke" />
      </svg>
    </div>

    <!-- Heap chart -->
    {#if currentHeapMB !== null}
      <div class="mb-1.5">
        <div class="row mb-0.5">
          <span class="label">JS Heap</span>
          <span class="val">{currentHeapMB} MB</span>
        </div>
        <svg class="w-full h-6 block" viewBox="0 0 180 24" preserveAspectRatio="none">
          <polyline points={sparkline(heapHistory, 180, 24)} fill="none" stroke="var(--color-text-muted)" stroke-width="1" vector-effect="non-scaling-stroke" />
        </svg>
      </div>
    {/if}

    <div class="flex flex-col">
      <div class="ui-section-label mt-2">Scene</div>
      <div class="row"><span class="label">Bodies</span><span class="val">{info.bodies}</span></div>
      <div class="row"><span class="label">Kernels</span><span class="val">{info.kernels}</span></div>
      <!-- Initial models + textures. A scene can be fully "loaded" and still be
           missing assets; this is where that shows, rather than only in the console. -->
      {#if vs.assetSummary}
        <div class="row">
          <span class="label">Assets</span>
          <span class="val">
            {vs.assetSummary.loaded}/{vs.assetSummary.total}
            {#if vs.assetSummary.failed > 0}&middot; {vs.assetSummary.failed} failed{/if}
            {#if vs.assetSummary.timedOut}&middot; {vs.assetSummary.stillPending.length} timed out{/if}
          </span>
        </div>
        {#each vs.assetSummary.failures.slice(0, 5) as failure}
          <div class="row"><span class="label">&nbsp;&nbsp;{failure.owner}</span><span class="val">{failure.role} &mdash; {failure.reason}</span></div>
        {/each}
      {/if}

      <div class="ui-section-label mt-3">Renderer</div>
      <div class="row"><span class="label">Draw calls</span><span class="val">{fmtNum(info.drawCalls)}</span></div>
      <div class="row"><span class="label">Triangles</span><span class="val">{fmtNum(info.triangles)}</span></div>
      <div class="row"><span class="label">Geometries</span><span class="val">{info.geometries}</span></div>
      <div class="row"><span class="label">Textures</span><span class="val">{info.textures}</span></div>
      <div class="row"><span class="label">Programs</span><span class="val">{info.programs}</span></div>

      <div class="ui-section-label mt-3">Camera</div>
      <div class="row"><span class="label">Mode</span><span class="val">{info.mode}</span></div>
      <div class="row"><span class="label">Tracking</span><span class="val">{info.tracked}</span></div>
      <div class="row"><span class="label">Distance</span><span class="val">{fmtDist(info.camDistKm)}</span></div>
      <div class="row"><span class="label">FOV</span><span class="val">{info.fov}&deg;</span></div>

      <div class="ui-section-label mt-3">Time</div>
      <div class="row"><span class="label">ET</span><span class="val">{info.et.toFixed(1)}</span></div>
      <div class="row"><span class="label">Rate</span><span class="val">{vs.rateText}</span></div>

      <div class="ui-section-label mt-3">Terrain{#if terrain}&nbsp;&middot; {terrain.body}{/if}</div>
      {#if terrain}
        {@const t = terrain.metrics}
        <div class="row"><span class="label">Sampler</span><span class="val">{terrain.state}</span></div>
        <div class="row"><span class="label">Source</span><span class="val max-w-32 truncate" title={terrain.source ?? undefined}>{terrain.source ?? '—'}</span></div>
        <div class="row" title="active / visible / decoded in the CPU sampler"><span class="label">Tiles</span><span class="val">{t.tiles.active} / {t.tiles.visible} / {t.tiles.cpu}</span></div>
        <div class="row" title="CPU height query, last / mean. Browser timers are coarse (~0.1 ms) without cross-origin isolation."><span class="label">Sample</span><span class="val">{t.sample.lastMicros.toFixed(1)} / {t.sample.meanMicros.toFixed(1)} us</span></div>
        <div class="row" title="tiles.update() per frame, mean / max over 120 frames"><span class="label">Update</span><span class="val">{fixed(t.update.meanMs)} / {fixed(t.update.maxMs)} ms</span></div>
        <div class="row" title="per tile: renderer mesh build / CPU sampler decode"><span class="label">Parse</span><span class="val">{fixed(t.parse.meanMs)} / {fixed(t.cpuDecode.meanMs)} ms</span></div>
        <div class="row" title="requests issued · queued + downloading + parsing"><span class="label">Requests</span><span class="val">{t.network.requests} &middot; {t.network.queued + t.network.downloading + t.network.parsing} open{#if t.network.failed}&nbsp;&middot; {t.network.failed} failed{/if}</span></div>
        <div class="row" title="tile LRU cache / its limit"><span class="label">Cache</span><span class="val">{mb(t.memory.cacheBytes)} / {mb(t.memory.maxCacheBytes)}</span></div>
        <div class="row" title="estimated from loaded tiles: geometry / textures"><span class="label">GPU est.</span><span class="val">{mb(t.memory.geometryBytes)} / {mb(t.memory.textureBytes)}</span></div>
      {:else}
        <div class="row"><span class="label">Sampler</span><span class="val">none</span></div>
      {/if}
      <label class="row cursor-pointer">
        <span class="label">Tile bounds</span>
        <input
          type="checkbox"
          class="m-0"
          checked={terrainDebug}
          onchange={(e) => {
            terrainDebug = (e.target as HTMLInputElement).checked;
            getRenderer()?.showTerrainDebug(terrainDebug);
          }}
        />
      </label>
      <label class="row">
        <span class="label">Debug view</span>
        <select
          class="val m-0 bg-transparent"
          value={terrainDebugMode}
          onchange={(e) => {
            terrainDebugMode = (e.target as HTMLSelectElement).value as TerrainDebugMode;
            getRenderer()?.setTerrainDebugMode(terrainDebugMode);
          }}
        >
          {#each TERRAIN_DEBUG_MODES as mode}
            <option value={mode}>{mode}</option>
          {/each}
        </select>
      </label>
      {#if terrainDebugMode !== 'none'}
        <div class="label legend">{DEBUG_MODE_LEGEND[terrainDebugMode]}</div>
      {/if}
    </div>
    </div>
  </InstrumentPanel>
{/if}

<style>

  .diagnostics {
    font-family: var(--font-sans);
    color: var(--color-text-muted);
  }

  .row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    line-height: 1.5;
  }

  .label {
    font-size: var(--text-label);
    color: var(--color-text-muted);
  }

  .val {
    font-family: var(--font-mono);
    font-size: var(--text-readout);
    font-variant-numeric: tabular-nums slashed-zero;
    color: var(--color-text-primary);
  }

  svg {
    background: transparent;
  }

  .legend {
    line-height: 1.35;
    margin-top: 2px;
  }
</style>
