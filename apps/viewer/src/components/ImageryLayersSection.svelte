<script lang="ts" module>
  /** Open state survives selecting another body, for this page session only. */
  let rememberedOpen = false;
</script>

<script lang="ts">
  import { setImageryVisible, setImageryOpacity, moveImageryLayer, setImageryTime } from '../lib/appearance-control';
  /**
   * The selected body's streamed imagery stack (#123): which sources it has,
   * which are on, their opacity and order. The settings are transient, scoped
   * to the body in this catalog session; the catalog sets the defaults.
   *
   * Rows stay one line plus provenance; opacity, order and the numbers behind
   * the status sit behind each row's expander. A badge appears only when it
   * explains why an enabled layer is not showing, or showing worse than it can.
   *
   * A selected rover or spacecraft shows its parent's imagery, since that is
   * the surface it sits on. The Surface layers panel passes `bodyName` to show
   * one body's stack under the same controls.
   */
  import { vs, getRenderer, flyToRegion } from '../lib/viewer-state.svelte';
  import type { BodyMesh, ImageryLayerInfo, ImageryLayerTime, ImageryTimePolicy, SurfaceTransitionState } from '@cosmolabe/three';
  import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Crosshair, Lock } from 'lucide-svelte';

  interface Props {
    /** A specific body, instead of following the selection. */
    bodyName?: string;
    /** Open regardless of the remembered state (the Surface layers imagery view). */
    startOpen?: boolean;
  }
  let { bodyName, startOpen = false }: Props = $props();

  // svelte-ignore state_referenced_locally
  let open = $state(startOpen || rememberedOpen);
  $effect(() => { rememberedOpen = open; });

  /** Layers whose details are expanded, by id. */
  let expanded = $state(new Set<string>());
  function toggleExpanded(id: string) {
    const next = new Set(expanded);
    if (!next.delete(id)) next.add(id);
    expanded = next;
  }

  /** Bumped by every change made here, so the list refreshes without waiting for the poll. */
  let rev = $state(0);
  /** The list refreshes four times a second, whatever the frame rate. */
  let tick = $derived((void vs.frameTick, Math.floor(performance.now() / 250)));

  interface Surface {
    body: string;
    layers: ImageryLayerInfo[];
    state: SurfaceTransitionState | null;
    imageryOnly: boolean;
  }

  let surface = $derived.by((): Surface | null => {
    void tick;
    void rev;
    const r = getRenderer();
    const target = bodyName ?? vs.selectedBodyName;
    if (!r || !target) return null;
    let bm = r.getBodyMesh(target);
    if (!bodyName && bm && bm.imageryLayers.length === 0 && bm.body.parentName) bm = r.getBodyMesh(bm.body.parentName);
    if (!bm || bm.imageryLayers.length === 0) return null;
    return {
      body: bm.body.name,
      layers: bm.imageryLayers,
      state: bm.surfaceTransitionState,
      imageryOnly: bm.isImageryOnlySurface,
    };
  });

  /** Top of the stack first, as layer lists usually read. */
  let topFirst = $derived(surface ? [...surface.layers].reverse() : []);
  let enabledCount = $derived(surface ? surface.layers.filter((l) => l.visible).length : 0);

  function bodyMesh() {
    return surface ? getRenderer()?.getBodyMesh(surface.body) ?? null : null;
  }

  function setVisible(layer: ImageryLayerInfo, visible: boolean) {
    if (surface) setImageryVisible(surface.body, layer.id, visible);
    rev++;
  }

  function setOpacity(layer: ImageryLayerInfo, value: number) {
    if (surface) setImageryOpacity(surface.body, layer.id, value);
    rev++;
  }

  function setPolicy(layer: ImageryLayerInfo, policy: ImageryTimePolicy) {
    if (surface) setImageryTime(surface.body, layer.id, { policy });
    rev++;
  }

  function setDate(layer: ImageryLayerInfo, date: string) {
    // A cleared or half-typed date input is not a choice.
    if (surface && date) setImageryTime(surface.body, layer.id, { date });
    rev++;
  }

  /** `up` moves toward the top of the stack (drawn over more layers). */
  function move(layer: ImageryLayerInfo, up: boolean) {
    if (!surface) return;
    const index = surface.layers.findIndex((l) => l.id === layer.id);
    moveImageryLayer(surface.body, layer.id, index + (up ? 1 : -1));
    rev++;
  }

  /** The body the hover footprint is drawn on, so it is cleared there even after the selection moves. */
  let footprintOwner: BodyMesh | null = null;

  /** Outline a regional layer's footprint on the globe while its row is hovered. */
  function highlight(layer: ImageryLayerInfo | null) {
    footprintOwner?.showImageryFootprint(null);
    footprintOwner = layer?.bounds ? bodyMesh() : null;
    footprintOwner?.showImageryFootprint(layer!.bounds, layer!.latitudeConvention);
  }
  let surfaceBody = $derived(surface?.body);
  $effect(() => { void surfaceBody; return () => highlight(null); });

  const STATE_LABEL: Record<SurfaceTransitionState, string> = {
    static: 'Static map',
    preloading: 'Static map · preloading',
    waiting: 'Loading imagery',
    streamed: 'Streaming',
    fallback: 'Static map · stream failed',
  };

  interface Badge { text: string; tone: 'muted' | 'warn' | 'error'; title: string }

  /** Why an enabled layer is not showing, or showing worse than it can; null when it is fine. */
  function badge(layer: ImageryLayerInfo, s: Surface): Badge | null {
    if (!layer.visible) return null;
    const t = layer.temporal;
    if (t && t.date === null) return timeBadge(t);
    if (t?.state === 'nearest') {
      return { text: 'Nearest day', tone: 'warn', title: `No imagery for ${t.requestedDate}; showing ${t.date}, ${plural(Math.abs(t.offsetDays), 'day')} ${t.offsetDays < 0 ? 'earlier' : 'later'}` };
    }
    if (t && layer.status === 'failed' && layer.requests > 0) {
      return { text: 'No imagery', tone: 'error', title: `The provider has no tiles for ${t.date}; the layers beneath are shown` };
    }
    if (layer.status === 'failed' || (layer.role === 'base' && s.state === 'fallback')) {
      return { text: 'Unavailable', tone: 'error', title: 'This source could not be loaded; the layers beneath it are shown' };
    }
    // Off the streamed surface the header already says why nothing streams.
    if (s.state !== 'streamed') return null;
    const v = layer.view;
    if (!v) return layer.role === 'overlay' ? { text: 'Loading', tone: 'muted', title: 'Waiting for tiles' } : null;
    if (!v.inCoverage) {
      // A global layer is out of view only when the globe is, which needs no badge.
      return layer.bounds ? { text: 'Out of view', tone: 'muted', title: `Covers ${formatBounds(layer.bounds)}; none of it is in view` } : null;
    }
    if (v.zoomLevel !== null && v.zoomLevel < layer.minZoom) {
      if (v.cacheFull) {
        return { text: 'Cache full', tone: 'warn', title: 'The tile cache is full, so finer tiles cannot load here; raise maxCacheBytes in the catalog’s terrain block' };
      }
      return { text: 'Zoom in', tone: 'muted', title: 'Too far out for this layer’s data; zoom closer to see it' };
    }
    if (v.missingTiles > 0) {
      return { text: 'Gaps', tone: 'warn', title: `${plural(v.missingTiles, 'tile')} in view could not load this layer; the layers beneath show through` };
    }
    if (v.degradedTiles > 0) {
      return { text: 'Lower res', tone: 'warn', title: `${plural(v.degradedTiles, 'source tile')} in view failed to load; coarser tiles stand in` };
    }
    return null;
  }

  /** Why a time-indexed layer shows nothing at all. */
  function timeBadge(t: ImageryLayerTime): Badge | null {
    switch (t.state) {
      case 'before-range':
        return { text: 'Before data', tone: 'muted', title: `${t.requestedDate} is before this source’s first day (${t.range.start}); the layers beneath are shown` };
      case 'after-range':
        return { text: 'After data', tone: 'muted', title: `${t.requestedDate} is after this source’s last day (${t.range.end}); the layers beneath are shown` };
      case 'not-yet-published':
        return { text: 'Not published', tone: 'muted', title: `${t.requestedDate} is later than this source can have published; the layers beneath are shown` };
      case 'invalid':
        return t.policy === 'follow-simulation' ? null
          : { text: 'No date', tone: 'warn', title: t.policy === 'latest' ? 'The provider has not said which day is newest' : 'The date is not a valid UTC day' };
      default:
        return null;
    }
  }

  const POLICY_LABEL: Record<ImageryTimePolicy, string> = {
    fixed: 'Fixed date',
    'follow-simulation': 'Follow simulation',
    latest: 'Latest available',
  };

  /** The acquisition day under the name, kept short: what is on screen and how it was chosen. */
  function timeSummary(t: ImageryLayerTime): string {
    const how = t.policy === 'fixed' ? 'fixed' : t.policy === 'latest' ? 'latest' : 'follows time';
    if (t.date) return `Acquired ${t.date} · ${how}${t.state === 'nearest' ? ' · nearest day' : ''}`;
    return t.requestedDate ? `No imagery for ${t.requestedDate} · ${how}` : `No date yet · ${how}`;
  }

  function plural(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
  }

  function formatBounds([w, s, e, n]: [number, number, number, number]): string {
    const lon = (v: number) => `${Math.abs(v).toFixed(2)}°${v < 0 ? 'W' : 'E'}`;
    const lat = (v: number) => `${Math.abs(v).toFixed(2)}°${v < 0 ? 'S' : 'N'}`;
    return `${lon(w)}–${lon(e)}, ${lat(s)}–${lat(n)}`;
  }

  function formatResolution(m: number): string {
    if (m < 1) return `${(m * 100).toFixed(0)} cm/px`;
    if (m < 1000) return `${m.toFixed(m < 10 ? 1 : 0)} m/px`;
    return `${(m / 1000).toFixed(1)} km/px`;
  }

  /** The one-line provenance under the name. */
  function provenance(layer: ImageryLayerInfo): string {
    const parts = [layer.role === 'base' ? 'Base' : '', layer.attribution];
    if (layer.resolutionMeters != null) parts.push(formatResolution(layer.resolutionMeters));
    return parts.filter(Boolean).join(' · ');
  }
</script>

{#if surface}
  <details class="mt-2 pt-2 border-t border-border" bind:open>
    <summary class="ui-section-label imagery-summary">
      Imagery{#if surface.body !== (bodyName ?? vs.selectedBodyName)}&nbsp;&middot; {surface.body}{/if}
      <span class="ui-meta normal-case tracking-normal font-normal">{enabledCount} of {surface.layers.length} enabled</span>
    </summary>
    <div class="ui-meta mt-1 mb-1">
      {surface.imageryOnly ? 'Surface imagery' : 'Draped on terrain'}{#if surface.state}&nbsp;&middot; {STATE_LABEL[surface.state]}{/if}
    </div>
    <ul class="flex flex-col" aria-label="Imagery layers, top first">
      {#each topFirst as layer, i (layer.id)}
        {@const b = badge(layer, surface)}
        {@const stackIndex = surface.layers.length - 1 - i}
        {@const isOpen = expanded.has(layer.id)}
        <li
          class="layer"
          class:off={!layer.visible}
          onmouseenter={() => layer.bounds && highlight(layer)}
          onmouseleave={() => highlight(null)}
        >
          <div class="flex items-center gap-1">
            {#if layer.optional}
              <input
                type="checkbox"
                class="layer-toggle"
                checked={layer.visible}
                title={layer.visible ? 'Hide layer' : 'Show layer'}
                aria-label="Show {layer.name}"
                onchange={(e) => setVisible(layer, (e.target as HTMLInputElement).checked)}
              />
            {:else}
              <span class="layer-lock" title="Base layer — always shown" aria-label="Base layer, always shown" role="img">
                <Lock size={11} />
              </span>
            {/if}
            <span class="layer-name ui-body text-text-primary" title={layer.description ?? layer.name}>{layer.name}</span>
            {#if b}
              <span class="badge" data-tone={b.tone} title={b.title}>{b.text}</span>
            {/if}
            {#if layer.bounds}
              {@const bounds = layer.bounds}
              <button class="layer-action" onclick={() => flyToRegion(surface.body, bounds, layer.latitudeConvention)} title="Fly to this layer" aria-label="Fly to {layer.name}">
                <Crosshair size={13} />
              </button>
            {/if}
            <button
              class="layer-action"
              onclick={() => toggleExpanded(layer.id)}
              title={isOpen ? 'Hide details' : 'Opacity, order and details'}
              aria-label="{layer.name} details"
              aria-expanded={isOpen}
            >
              {#if isOpen}<ChevronDown size={13} />{:else}<ChevronRight size={13} />{/if}
            </button>
          </div>
          <div class="ui-meta layer-indent layer-provenance">{provenance(layer)}</div>
          {#if layer.temporal}
            <!-- The acquisition day is the one fact that says which epoch the pixels depict, so it is never truncated. -->
            <div class="ui-meta layer-indent layer-day" class:muted={layer.temporal.date === null}>{timeSummary(layer.temporal)}</div>
          {/if}
          {#if isOpen}
            <div class="layer-indent layer-details ui-meta">
              {#if layer.description}<div class="text-text-secondary">{layer.description}</div>{/if}
              {#if layer.role === 'overlay'}
                <label class="flex items-center gap-2">
                  <span class="w-12">Opacity</span>
                  <input
                    type="range"
                    class="opacity-slider flex-1 min-w-0"
                    min="0"
                    max="1"
                    step="0.05"
                    value={layer.opacity}
                    disabled={!layer.visible}
                    aria-label="{layer.name} opacity"
                    oninput={(e) => setOpacity(layer, Number((e.target as HTMLInputElement).value))}
                  />
                  <span class="ui-readout text-text-secondary w-10 text-right">{Math.round(layer.opacity * 100)}%</span>
                </label>
                <div class="flex items-center gap-2" role="group" aria-label="Reorder {layer.name}">
                  <span class="w-12">Order</span>
                  <button class="order-button" disabled={stackIndex >= surface.layers.length - 1} onclick={() => move(layer, true)} aria-label="Move {layer.name} up">
                    <ArrowUp size={12} /> Raise
                  </button>
                  <button class="order-button" disabled={stackIndex <= 1} onclick={() => move(layer, false)} aria-label="Move {layer.name} down">
                    <ArrowDown size={12} /> Lower
                  </button>
                </div>
              {/if}
              {#if layer.temporal}
                {@const t = layer.temporal}
                <div class="layer-time flex flex-col gap-1" role="group" aria-label="{layer.name} observation date">
                  <label class="flex items-center gap-2">
                    <span class="w-12">Date</span>
                    <select
                      class="time-select flex-1 min-w-0"
                      value={t.policy}
                      disabled={t.policies.length < 2}
                      aria-label="{layer.name} date mode"
                      onchange={(e) => setPolicy(layer, (e.target as HTMLSelectElement).value as ImageryTimePolicy)}
                    >
                      {#each t.policies as p (p)}<option value={p}>{POLICY_LABEL[p]}</option>{/each}
                    </select>
                  </label>
                  {#if t.policy === 'fixed' && layer.role === 'overlay'}
                    <label class="flex items-center gap-2">
                      <span class="w-12">Day</span>
                      <input
                        type="date"
                        class="time-select flex-1 min-w-0"
                        value={t.date ?? t.requestedDate ?? ''}
                        min={t.range.start ?? undefined}
                        max={t.range.end ?? undefined}
                        aria-label="{layer.name} observation date, UTC"
                        onchange={(e) => setDate(layer, (e.target as HTMLInputElement).value)}
                      />
                    </label>
                  {/if}
                  <div class="text-text-secondary">
                    {#if t.date}Showing the daily image acquired {t.date} (UTC){:else}Showing no imagery{/if}{#if t.pendingDate}; loading {t.pendingDate}…{/if}
                  </div>
                  {#if t.policy === 'follow-simulation' && t.requestedDate && t.requestedDate !== t.date}
                    <div class="text-text-secondary">Simulation day {t.requestedDate}{#if t.date}; nearest available day shown{/if}</div>
                  {/if}
                  <div class="text-text-secondary">
                    {t.semantics === 'acquisition' ? 'Acquisition' : 'Valid'} date, not the simulation epoch. {t.illumination === 'baked' ? 'Lit as acquired; it is not relit to the simulated Sun.' : 'Reflectance; lighting follows the simulated Sun.'}
                  </div>
                </div>
              {/if}
              <dl class="layer-facts">
                {#if layer.temporal}
                  <dt>Cadence</dt><dd>{layer.temporal.cadence === 'day' ? 'Daily (UTC)' : layer.temporal.cadence}</dd>
                  <dt>Available</dt><dd>{layer.temporal.range.start ?? 'unknown'} – {layer.temporal.range.end ?? 'present'}{#if layer.temporal.range.source === 'provider'} (from provider){/if}</dd>
                  {#if layer.temporal.switches > 0}<dt>Date changes</dt><dd>{layer.temporal.switches}</dd>{/if}
                {/if}
                <dt>Coverage</dt><dd>{layer.bounds ? formatBounds(layer.bounds) : 'Global'}</dd>
                {#if layer.resolutionMeters != null}
                  <dt>Source resolution</dt><dd>{formatResolution(layer.resolutionMeters)}</dd>
                {/if}
                {#if layer.metersPerPixel != null}
                  <dt>Available tile resolution</dt><dd>~{formatResolution(layer.metersPerPixel)} at zoom {layer.maxLevel}{#if layer.minZoom > 0}, from zoom {layer.minZoom}{/if}</dd>
                {/if}
                {#if layer.view?.zoomLevel != null}
                  <dt>In view</dt><dd>zoom {layer.view.zoomLevel}{#if layer.view.degradedTiles}, {plural(layer.view.degradedTiles, 'tile')} from coarser data{/if}{#if layer.view.missingTiles}, {plural(layer.view.missingTiles, 'tile')} missing{/if}</dd>
                {/if}
                {#if layer.requests > 0}
                  <dt>Session</dt><dd>{plural(layer.requests, 'request')}{#if layer.failedTiles}, {layer.failedTiles} failed{/if}</dd>
                {/if}
              </dl>
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
  .layer {
    padding: 3px 0;
  }
  .layer-toggle {
    width: 14px;
    height: 14px;
    margin: 0 3px;
    cursor: pointer;
  }
  .layer-lock {
    display: inline-flex;
    justify-content: center;
    width: 20px;
    color: var(--color-text-muted);
  }
  .layer-indent {
    padding-left: 24px;
  }
  .layer-provenance {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .layer-day {
    color: var(--color-text-secondary);
  }
  .layer-day.muted {
    color: var(--color-text-muted);
  }
  .layer-details {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 4px 0 6px;
  }
  .layer-facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 8px;
    margin: 0;
    padding-top: 6px;
    border-top: 1px solid var(--color-border);
  }
  .layer-facts dt {
    color: var(--color-text-secondary);
  }
  .layer-facts dd {
    margin: 0;
    color: var(--color-text-primary);
  }
  .order-button {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 3px 8px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
  }
  .order-button:hover:not(:disabled) {
    color: var(--color-text-primary);
    background: var(--color-surface-3);
  }
  .order-button:disabled {
    opacity: 0.35;
    cursor: default;
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
  .badge[data-tone='warn'] { color: var(--color-warning); }
  .badge[data-tone='error'] { color: var(--color-error); }
  .layer-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    min-height: 24px;
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
  .time-select {
    padding: 2px 4px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-control);
    color: var(--color-text-primary);
    font: inherit;
  }
  .opacity-slider {
    height: 16px;
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
