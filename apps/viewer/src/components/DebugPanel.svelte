<script lang="ts">
  import { onMount } from 'svelte';
  import { vs, getRenderer } from '../lib/viewer-state.svelte';
  import { X } from 'lucide-svelte';

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
  <div class="absolute top-3 left-3 z-15 bg-black/90 backdrop-blur-md border border-border rounded-lg p-2.5 min-w-52 text-[11px] font-mono text-text-muted animate-fade-in">
    <div class="flex items-center justify-between mb-2">
      <span class="text-text-secondary text-[10px] uppercase tracking-wider font-sans font-semibold">Debug</span>
      <button class="bg-transparent border-none text-text-muted cursor-pointer p-0.5 rounded hover:text-text-primary transition-colors" onclick={onClose}><X size={12} /></button>
    </div>

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
      <div class="section-label mt-2">Scene</div>
      <div class="row"><span class="label">Bodies</span><span class="val">{info.bodies}</span></div>
      <div class="row"><span class="label">Kernels</span><span class="val">{info.kernels}</span></div>

      <div class="section-label mt-3">Renderer</div>
      <div class="row"><span class="label">Draw calls</span><span class="val">{fmtNum(info.drawCalls)}</span></div>
      <div class="row"><span class="label">Triangles</span><span class="val">{fmtNum(info.triangles)}</span></div>
      <div class="row"><span class="label">Geometries</span><span class="val">{info.geometries}</span></div>
      <div class="row"><span class="label">Textures</span><span class="val">{info.textures}</span></div>
      <div class="row"><span class="label">Programs</span><span class="val">{info.programs}</span></div>

      <div class="section-label mt-3">Camera</div>
      <div class="row"><span class="label">Mode</span><span class="val">{info.mode}</span></div>
      <div class="row"><span class="label">Tracking</span><span class="val">{info.tracked}</span></div>
      <div class="row"><span class="label">Distance</span><span class="val">{fmtDist(info.camDistKm)}</span></div>
      <div class="row"><span class="label">FOV</span><span class="val">{info.fov}&deg;</span></div>

      <div class="section-label mt-3">Time</div>
      <div class="row"><span class="label">ET</span><span class="val">{info.et.toFixed(1)}</span></div>
      <div class="row"><span class="label">Rate</span><span class="val">{vs.rateText}</span></div>
    </div>
  </div>
{/if}

<style>
  @keyframes fade-in {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .animate-fade-in { animation: fade-in 0.12s ease; }

  .section-label {
    font-family: var(--font-sans);
    font-size: 9px;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    padding-bottom: 2px;
  }

  .row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    line-height: 1.5;
  }

  .label {
    color: var(--color-text-muted);
  }

  .val {
    color: var(--color-text-primary);
    opacity: 0.9;
  }

  svg {
    background: var(--color-surface-3);
  }
</style>
