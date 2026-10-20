<script lang="ts">
  /**
   * Instrument View (#192): the scene as a physical instrument sees it, in a
   * window of its own — a second view, not a camera mode, so the main camera
   * and the timeline stay exactly as they were.
   *
   * The window is the shared `InstrumentPanel`, so it docks, floats, resizes,
   * minimizes and stacks like every other tool. The feed is a 2D canvas the
   * renderer copies its instrument pass into each frame (see
   * `InstrumentView.render`), which is what lets it take part in panel z-order
   * rather than being a hole cut through the UI to the scene canvas.
   *
   * The instrument's FOV and aspect are physical: resizing the window changes
   * how large the image is drawn, never what it covers. The renderer fits it
   * inside the canvas with bars.
   */
  import { CameraModeName } from '@cosmolabe/three';
  import { vs, getRenderer } from '../lib/viewer-state.svelte';
  import { shell, toolDef, isFloating, isExpanded } from '../lib/shell.svelte';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';

  let { onClose }: { onClose: () => void } = $props();

  let surface = $state<HTMLCanvasElement | null>(null);

  // The renderer is not reactive, so follow it per frame rather than trusting
  // any one load signal to fire after it binds. Both deriveds settle to equal
  // values between scenes, so nothing downstream re-runs on a quiet frame.
  const renderer = $derived.by(() => {
    void vs.frameTick;
    return getRenderer();
  });
  const sensorList = $derived(renderer?.getSensorNames().join('\n') ?? '');
  const sensors = $derived(sensorList ? sensorList.split('\n') : []);
  const sensor = $derived(vs.instrumentSensor != null && sensors.includes(vs.instrumentSensor) ? vs.instrumentSensor : null);

  // Opening with nothing chosen shows the first instrument, not an empty window.
  $effect(() => {
    if (vs.instrumentSensor == null && sensors.length > 0) vs.instrumentSensor = sensors[0];
  });

  // The renderer presents the feed here while the canvas exists. Minimizing
  // unmounts the canvas, which ends the feed: a hidden window renders nothing.
  $effect(() => {
    const r = renderer;
    const target = surface;
    if (!r || !target || !sensor) return;
    r.setInstrumentView(sensor, { surface: target });
    return () => r.setInstrumentView(null);
  });

  const info = $derived.by(() => {
    void vs.frameTick;
    return sensor ? renderer?.getInstrumentViewInfo() ?? null : null;
  });
  // From the scene graph rather than the live feed, so a minimized window
  // (which renders nothing) keeps its full name.
  const spacecraft = $derived(vs.bodies.find((b) => b.name === sensor)?.parentName);
  const title = $derived(sensor ? (spacecraft ? `${spacecraft} · ${sensor}` : sensor) : 'Instrument view');
  // The legacy Instrument camera mode draws this same feed over the whole
  // canvas; the window says so rather than showing a second, stale copy.
  const fullCanvas = $derived(vs.cameraMode === CameraModeName.INSTRUMENT);

  // A docked or sheet window has no height of its own; give the feed one at
  // roughly the instrument's aspect, within reason for very wide or tall FOVs.
  const sized = $derived(shell.layout === 'compact' || !isFloating('instrument'));
  const feedAspect = $derived(info ? Math.min(Math.max(info.fov[0] / info.fov[1], 1), 2.5) : 4 / 3);

  const deg = (d: number) => (d >= 10 ? d.toFixed(1) : d >= 1 ? d.toFixed(2) : d.toPrecision(3));
  const POINTING = { spice: 'SPICE attitude', target: 'Aimed at target', none: 'Unpointed' } as const;
</script>

<InstrumentPanel key="instrument" {title} width={toolDef('instrument').width} {onClose} expandable fill>
  <div class="meta ui-meta flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5">
    {#if sensors.length > 0}
      <select
        class="ui-control text-text-primary"
        aria-label="Instrument"
        value={sensor ?? ''}
        onchange={(e) => { vs.instrumentSensor = (e.target as HTMLSelectElement).value || null; }}
      >
        {#if !sensor}<option value="" disabled>Choose…</option>{/if}
        {#each sensors as name (name)}<option value={name}>{name}</option>{/each}
      </select>
    {/if}
    {#if info}
      <span title="Target">→ {info.target ?? 'no target'}</span>
      <span title="Live on the scene clock">Live · {vs.timeText}</span>
      <span title="Angular field of view">{deg(info.fov[0])}° × {deg(info.fov[1])}°</span>
      <span title="Pointing source" class:warn={info.pointing !== 'spice'}>{POINTING[info.pointing]}</span>
    {/if}
  </div>

  {#if sensors.length === 0}
    <p class="state">This scene has no instruments.</p>
  {:else if !sensor}
    <p class="state">
      {vs.instrumentSensor ? `${vs.instrumentSensor} isn't in this scene.` : 'No instrument selected.'}
      Choose one above.
    </p>
  {:else}
    <div
      class="feed"
      class:sized={sized && !isExpanded('instrument')}
      style:--feed-aspect={feedAspect}
    >
      <canvas bind:this={surface} aria-label="View from {sensor}"></canvas>
      {#if fullCanvas}
        <p class="state overlay">Showing full-canvas in Instrument camera mode.</p>
      {/if}
    </div>
  {/if}
</InstrumentPanel>

<style>
  .meta {
    border-color: var(--color-chrome-divider);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .meta select {
    max-width: 12rem;
  }
  .warn {
    color: var(--color-text-primary);
  }
  .feed {
    position: relative;
    flex: 1;
    min-height: 0;
    background: #000;
  }
  .feed.sized {
    flex: none;
    aspect-ratio: var(--feed-aspect);
    max-height: 60vh;
  }
  @media (max-width: 767px) {
    .feed.sized { max-height: 30vh; }
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
  .state {
    padding: var(--space-ui-3) var(--space-ui-4);
    color: var(--color-text-secondary);
  }
  .state.overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    background: rgba(0, 0, 0, 0.6);
  }
</style>
