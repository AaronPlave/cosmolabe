<script lang="ts" module>
  /** Open state survives selecting another body, for this page session only. */
  let rememberedOpen = false;
</script>

<script lang="ts">
  /**
   * The selected body's streamed imagery stack (#123): which sources it has,
   * which are on, their opacity and order. The settings are transient, scoped
   * to the body in this catalog session; the catalog sets the defaults.
   *
   * A selected rover or spacecraft shows its parent's imagery, since that is
   * the surface it sits on.
   */
  import { vs, getRenderer, flyToRegion } from '../lib/viewer-state.svelte';
  import { layerCovers, type ImageryLayerInfo, type SurfaceTransitionState } from '@cosmolabe/three';
  import { ArrowDown, ArrowUp, Crosshair } from 'lucide-svelte';

  let open = $state(rememberedOpen);
  $effect(() => { rememberedOpen = open; });

  /** Bumped by every change made here, so the list refreshes without waiting for the poll. */
  let rev = $state(0);
  /** The list refreshes four times a second, whatever the frame rate. */
  let tick = $derived((void vs.frameTick, Math.floor(performance.now() / 250)));

  interface Surface {
    body: string;
    layers: ImageryLayerInfo[];
    state: SurfaceTransitionState | null;
    imageryOnly: boolean;
    /** Camera sub-point on the body, for coverage. */
    camera: { latDeg: number; lonDeg: number } | null;
  }

  let surface = $derived.by((): Surface | null => {
    void tick;
    void rev;
    const r = getRenderer();
    if (!r || !vs.selectedBodyName) return null;
    let bm = r.getBodyMesh(vs.selectedBodyName);
    if (bm && bm.imageryLayers.length === 0 && bm.body.parentName) bm = r.getBodyMesh(bm.body.parentName);
    if (!bm || bm.imageryLayers.length === 0) return null;

    const toCam = r.camera.position.clone().sub(bm.position);
    const bf = toCam.divideScalar(r.scaleFactor).applyQuaternion(bm.mesh.quaternion.clone().invert());
    const len = bf.length();
    let camera: Surface['camera'] = null;
    if (len > 1e-10) {
      const point = { xKm: bf.x, yKm: -bf.z, zKm: bf.y };
      camera = bm.terrainBodyFixedToGeodetic(point) ?? {
        latDeg: Math.asin(point.zKm / len) * 180 / Math.PI,
        lonDeg: Math.atan2(point.yKm, point.xKm) * 180 / Math.PI,
      };
    }
    return {
      body: bm.body.name,
      layers: bm.imageryLayers,
      state: bm.surfaceTransitionState,
      imageryOnly: bm.isImageryOnlySurface,
      camera,
    };
  });

  /** Top of the stack first, as layer lists usually read. */
  let topFirst = $derived(surface ? [...surface.layers].reverse() : []);
  let shownCount = $derived(surface ? surface.layers.filter((l) => l.visible).length : 0);

  function bodyMesh() {
    return surface ? getRenderer()?.getBodyMesh(surface.body) ?? null : null;
  }

  function setVisible(layer: ImageryLayerInfo, visible: boolean) {
    bodyMesh()?.setImageryLayerVisible(layer.id, visible);
    rev++;
  }

  function setOpacity(layer: ImageryLayerInfo, value: number) {
    bodyMesh()?.setImageryLayerOpacity(layer.id, value);
    rev++;
  }

  /** `up` moves toward the top of the stack (drawn over more layers). */
  function move(layer: ImageryLayerInfo, up: boolean) {
    if (!surface) return;
    const index = surface.layers.findIndex((l) => l.id === layer.id);
    bodyMesh()?.moveImageryLayer(layer.id, index + (up ? 1 : -1));
    rev++;
  }

  /** Outline a regional layer's footprint on the globe while its row is hovered. */
  function highlight(layer: ImageryLayerInfo | null) {
    bodyMesh()?.showImageryFootprint(layer?.bounds ?? null);
  }
  $effect(() => () => highlight(null));

  const STATE_LABEL: Record<SurfaceTransitionState, string> = {
    static: 'Static map',
    preloading: 'Static map · preloading',
    waiting: 'Loading imagery',
    streamed: 'Streaming',
    fallback: 'Static map · stream failed',
  };

  interface Badge { text: string; tone: 'muted' | 'ok' | 'warn' | 'error'; title: string }

  function badge(layer: ImageryLayerInfo, s: Surface): Badge {
    if (!layer.visible) return { text: 'Off', tone: 'muted', title: 'Switched off — nothing is requested' };
    if (layer.status === 'failed' || (layer.role === 'base' && s.state === 'fallback')) {
      return { text: 'Unavailable', tone: 'error', title: 'This source could not be loaded; the layers beneath it are shown' };
    }
    if (s.state === 'fallback') {
      return { text: 'Standby', tone: 'muted', title: 'The streamed surface failed to load, so the static map is shown instead' };
    }
    if (s.camera && layer.bounds && !layerCovers(layer.bounds, s.camera.latDeg, s.camera.lonDeg)) {
      return { text: 'Not here', tone: 'muted', title: `Covers ${formatBounds(layer.bounds)}; the camera is outside it` };
    }
    if (s.state === 'static' || s.state === 'preloading') {
      return { text: 'Standby', tone: 'muted', title: 'The static map is shown at this distance; zoom closer to stream this layer' };
    }
    if (layer.status === 'partial') {
      return { text: 'Gaps', tone: 'warn', title: `${layer.failedTiles} of ${layer.requests} tiles failed; lower layers fill in` };
    }
    if (layer.status === 'idle' || s.state === 'waiting') return { text: 'Loading', tone: 'muted', title: 'Waiting for tiles' };
    return { text: 'On', tone: 'ok', title: `${layer.requests} tiles requested` };
  }

  function formatBounds([w, s, e, n]: [number, number, number, number]): string {
    const lon = (v: number) => `${Math.abs(v).toFixed(2)}°${v < 0 ? 'W' : 'E'}`;
    const lat = (v: number) => `${Math.abs(v).toFixed(2)}°${v < 0 ? 'S' : 'N'}`;
    return `${lon(w)}–${lon(e)}, ${lat(s)}–${lat(n)}`;
  }

  function formatResolution(m: number | null): string | null {
    if (m == null) return null;
    if (m < 1) return `${(m * 100).toFixed(0)} cm/px`;
    if (m < 1000) return `${m.toFixed(m < 10 ? 1 : 0)} m/px`;
    return `${(m / 1000).toFixed(1)} km/px`;
  }

  function details(layer: ImageryLayerInfo): string {
    const parts = [layer.attribution];
    const res = formatResolution(layer.metersPerPixel);
    if (res) parts.push(`~${res}`);
    parts.push(layer.bounds ? 'regional' : 'global');
    if (layer.minZoom > 0) parts.push(`from z${layer.minZoom}`);
    return parts.filter(Boolean).join(' · ');
  }
</script>

{#if surface}
  <details class="mt-2 pt-2 border-t border-border" bind:open>
    <summary class="ui-section-label imagery-summary">
      Imagery{#if surface.body !== vs.selectedBodyName}&nbsp;&middot; {surface.body}{/if}
      <span class="ui-meta normal-case tracking-normal font-normal">{shownCount}/{surface.layers.length} on</span>
    </summary>
    <div class="ui-meta mt-1 mb-1">
      {surface.imageryOnly ? 'On the ellipsoid' : 'Draped on terrain'}{#if surface.state}&nbsp;&middot; {STATE_LABEL[surface.state]}{/if}
    </div>
    <ul class="flex flex-col gap-1.5" aria-label="Imagery layers, top first">
      {#each topFirst as layer, i (layer.id)}
        {@const b = badge(layer, surface)}
        {@const stackIndex = surface.layers.length - 1 - i}
        <li
          class="layer"
          class:off={!layer.visible}
          onmouseenter={() => layer.bounds && highlight(layer)}
          onmouseleave={() => highlight(null)}
        >
          <div class="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={layer.visible}
              disabled={!layer.optional}
              title={layer.optional ? (layer.visible ? 'Hide layer' : 'Show layer') : 'The base layer is always shown'}
              aria-label="Show {layer.name}"
              onchange={(e) => setVisible(layer, (e.target as HTMLInputElement).checked)}
            />
            <span class="layer-name ui-body text-text-primary" title={layer.name}>{layer.name}</span>
            <span class="badge" data-tone={b.tone} title={b.title}>{b.text}</span>
            {#if layer.bounds}
              {@const bounds = layer.bounds}
              <button class="layer-action" onclick={() => flyToRegion(surface.body, bounds)} title="Fly to this layer" aria-label="Fly to {layer.name}">
                <Crosshair size={11} />
              </button>
            {/if}
          </div>
          <div class="ui-meta layer-details" title={layer.bounds ? formatBounds(layer.bounds) : 'Global coverage'}>{details(layer)}</div>
          {#if layer.role === 'overlay' && layer.visible}
            <div class="flex items-center gap-1.5">
              <input
                type="range"
                class="opacity-slider flex-1 min-w-0"
                min="0"
                max="1"
                step="0.05"
                value={layer.opacity}
                aria-label="{layer.name} opacity"
                oninput={(e) => setOpacity(layer, Number((e.target as HTMLInputElement).value))}
              />
              <span class="ui-readout text-text-secondary w-8 text-right">{Math.round(layer.opacity * 100)}%</span>
              <span class="inline-flex" role="group" aria-label="Reorder {layer.name}">
                <button class="layer-action" disabled={stackIndex >= surface.layers.length - 1} onclick={() => move(layer, true)} title="Draw above the next layer" aria-label="Move {layer.name} up">
                  <ArrowUp size={11} />
                </button>
                <button class="layer-action" disabled={stackIndex <= 1} onclick={() => move(layer, false)} title="Draw below the next layer" aria-label="Move {layer.name} down">
                  <ArrowDown size={11} />
                </button>
              </span>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </details>
{/if}

<style>
  .imagery-summary {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    cursor: pointer;
    list-style: none;
  }
  .imagery-summary::-webkit-details-marker {
    display: none;
  }
  .imagery-summary::before {
    content: '▸';
    margin-right: 4px;
  }
  details[open] > .imagery-summary::before {
    content: '▾';
  }
  .layer.off .layer-name {
    color: var(--color-text-muted);
  }
  .layer-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .layer-details {
    padding-left: 20px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    flex: none;
    border-radius: 3px;
    padding: 0 5px;
    background: var(--color-control);
    font-size: var(--text-metadata);
    line-height: 1.5;
    color: var(--color-text-secondary);
  }
  .badge[data-tone='ok'] { color: var(--color-success); }
  .badge[data-tone='warn'] { color: var(--color-warning); }
  .badge[data-tone='error'] { color: var(--color-error); }
  .layer-action {
    display: inline-flex;
    align-items: center;
    padding: 3px 4px;
    border: none;
    border-radius: 3px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
  }
  .layer-action:hover:not(:disabled) {
    color: var(--color-text-primary);
    background: var(--color-surface-3);
  }
  .layer-action:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .opacity-slider {
    height: 16px;
    margin-left: 20px;
    appearance: none;
    background: transparent;
    cursor: pointer;
  }
  .opacity-slider::-webkit-slider-runnable-track {
    height: 3px;
    border-radius: 2px;
    background: var(--color-border-strong);
  }
  .opacity-slider::-webkit-slider-thumb {
    width: 10px;
    height: 10px;
    margin-top: -3.5px;
    appearance: none;
    border: 1px solid var(--color-border-strong);
    border-radius: 50%;
    background: var(--color-text-secondary);
  }
  .opacity-slider::-moz-range-track {
    height: 3px;
    border-radius: 2px;
    background: var(--color-border-strong);
  }
  .opacity-slider::-moz-range-thumb {
    width: 10px;
    height: 10px;
    border: 1px solid var(--color-border-strong);
    border-radius: 50%;
    background: var(--color-text-secondary);
  }
</style>
