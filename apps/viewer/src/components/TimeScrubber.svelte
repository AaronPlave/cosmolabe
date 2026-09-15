<script lang="ts">
  import { clampFraction, KEYBOARD_STEP } from '../lib/scrubber-math';
  import { Search } from 'lucide-svelte';
  import * as Popover from '$lib/components/ui/popover';

  interface Props {
    /** Current position 0-1 on the zoomed range */
    fraction: number;
    /** Called during drag with the new fraction */
    onScrub: (fraction: number) => void;
    /** Called when drag begins */
    onScrubStart?: () => void;
    /** Called when drag ends */
    onScrubEnd?: () => void;
    /** Called on scroll wheel — true = zoom in */
    onZoom?: (zoomIn: boolean) => void;
    /** Called to reset zoom */
    onResetZoom?: () => void;
    /** Called to set a specific zoom duration in seconds */
    onSetZoom?: (seconds: number) => void;
    /** Start date label. Empty hides it — the compact layout drops both
     *  bounds so the track itself gets the width. */
    startLabel: string;
    /** End date label. Empty hides it, as with `startLabel`. */
    endLabel: string;
    /** Whether the scrubber is zoomed in */
    isZoomed?: boolean;
    /** Viewport start/end as fractions of full range */
    viewportStart?: number;
    viewportEnd?: number;
    /** Current time position as fraction of full range (for minimap playhead) */
    globalPlayhead?: number;
    /** Visible duration label (e.g. "~43d") — clickable for presets */
    rangeLabel?: string;
    /**
     * Ticks to draw on the track, as fractions of the *zoomed* range. Event
     * finder results use this so a search result reads as a position in time
     * and not only as a row in a list. Out-of-range fractions are the caller's
     * to drop.
     */
    markers?: readonly {
      fraction: number;
      endFraction?: number;
      selected?: boolean;
      active?: boolean;
      title?: string;
      kind?: string;
      state?: string;
      onSelect?: () => void;
    }[];
  }

  let {
    fraction, onScrub, onScrubStart, onScrubEnd,
    onZoom, onResetZoom, onSetZoom,
    startLabel, endLabel,
    isZoomed = false, viewportStart = 0, viewportEnd = 1, globalPlayhead = 0.5,
    rangeLabel, markers = [],
  }: Props = $props();

  let trackEl: HTMLDivElement | undefined = $state();

  let dragging = $state(false);
  let dragFraction = $state(0);
  let lastClientX = 0;
  let pointerStartX = 0;
  let pointerMoved = false;
  let pendingMarkerSelect: (() => void) | undefined;
  let trackRect: DOMRect | null = null;

  let zoomMenuOpen = $state(false);

  let displayFraction = $derived(dragging ? dragFraction : fraction);

  const ZOOM_PRESETS = [
    { label: '1 min', seconds: 60 },
    { label: '10 min', seconds: 600 },
    { label: '1 hr', seconds: 3600 },
    { label: '6 hr', seconds: 21600 },
    { label: '1 day', seconds: 86400 },
    { label: '1 wk', seconds: 604800 },
    { label: '1 mo', seconds: 2592000 },
    { label: '6 mo', seconds: 15552000 },
    { label: '1 yr', seconds: 31556952 },
  ];

  // Non-passive wheel listener so preventDefault works and zoom fires
  $effect(() => {
    if (!trackEl) return;
    const el = trackEl;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY === 0) return;
      onZoom?.(e.deltaY < 0);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  });

  function onPointerDown(e: PointerEvent) {
    if (!trackEl) return;
    if (!(e.target instanceof Element) || !e.target.closest('.event-marker')) {
      pendingMarkerSelect = undefined;
    }
    trackRect = trackEl.getBoundingClientRect();
    trackEl.setPointerCapture(e.pointerId);
    dragFraction = clampFraction((e.clientX - trackRect.left) / trackRect.width);
    lastClientX = e.clientX;
    pointerStartX = e.clientX;
    pointerMoved = false;
    dragging = true;
    onScrubStart?.();
    onScrub(dragFraction);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging || !trackRect) return;
    const dx = e.clientX - lastClientX;
    if (Math.abs(e.clientX - pointerStartX) > 3) pointerMoved = true;
    lastClientX = e.clientX;
    dragFraction = clampFraction(dragFraction + dx / trackRect.width);
    onScrub(dragFraction);
  }

  function onMarkerClick(event: MouseEvent, onSelect?: () => void) {
    event.stopPropagation();
    // Pointer activation is resolved in onPointerUp because capture retargets
    // the click to the track. A keyboard-generated click has detail === 0.
    if (event.detail === 0) onSelect?.();
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragging) return;
    trackEl?.releasePointerCapture(e.pointerId);
    dragging = false;
    onScrubEnd?.();
    const select = pendingMarkerSelect;
    pendingMarkerSelect = undefined;
    if (!pointerMoved) select?.();
  }

  function selectPreset(seconds: number) {
    zoomMenuOpen = false;
    onSetZoom?.(seconds);
  }

  function onKeyDown(e: KeyboardEvent) {
    let newFraction: number | null = null;
    switch (e.key) {
      case 'ArrowLeft':
        newFraction = clampFraction(fraction - KEYBOARD_STEP);
        break;
      case 'ArrowRight':
        newFraction = clampFraction(fraction + KEYBOARD_STEP);
        break;
      case 'Home':
        newFraction = 0;
        break;
      case 'End':
        newFraction = 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    onScrub(newFraction);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="scrubber-wrapper"
  role="slider"
  tabindex="0"
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={Math.round(displayFraction * 100)}
  aria-label="Time scrubber — scroll to zoom"
  onkeydown={onKeyDown}
>
  <div class="scrubber-row">
    {#if startLabel}<span class="date-label">{startLabel}</span>{/if}

    <div class="track-column">
      <div
        bind:this={trackEl}
        class="track"
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
      >
        {#each markers as marker}
          <button
            type="button"
            class="event-marker"
            class:interval={(marker.endFraction ?? marker.fraction) > marker.fraction}
            class:selected={marker.selected}
            class:active={marker.active}
            class:partial={marker.state === 'partial'}
            class:full={marker.state === 'full'}
            class:annular={marker.state === 'annular'}
            data-kind={marker.kind}
            style="left: {marker.fraction * 100}%; width: {Math.max(0, (marker.endFraction ?? marker.fraction) - marker.fraction) * 100}%"
            title={marker.title}
            aria-label={marker.title ?? 'Select timeline event'}
            onpointerdown={() => { pendingMarkerSelect = marker.onSelect; }}
            onclick={(event) => onMarkerClick(event, marker.onSelect)}
          ></button>
        {/each}
        <div class="playhead" style="left: {displayFraction * 100}%"></div>
      </div>

      <!-- Minimap line below the track — always visible -->
      <div class="minimap-line">
        <div
          class="minimap-highlight"
          class:zoomed={isZoomed}
          style="left: {viewportStart * 100}%; width: {(viewportEnd - viewportStart) * 100}%"
        ></div>
        <div class="minimap-playhead" style="left: {globalPlayhead * 100}%"></div>
      </div>
    </div>

    {#if endLabel}<span class="date-label">{endLabel}</span>{/if}

    <!-- Range / zoom popover -->
    <Popover.Root bind:open={zoomMenuOpen}>
      <Popover.Trigger class="icon-btn font-mono text-[10px] min-w-16 justify-center" title="Set time range (scroll on scrubber to zoom)">
        {#if rangeLabel}
          {rangeLabel}
        {:else}
          <Search size={10} />
        {/if}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" sideOffset={8} class="w-24 p-1">
          <div class="flex flex-col gap-0.5">
            {#each ZOOM_PRESETS as preset}
              <button class="zoom-preset" onclick={() => selectPreset(preset.seconds)}>
                {preset.label}
              </button>
            {/each}
            <div class="border-t border-border mt-0.5 pt-0.5">
              <button class="zoom-preset text-accent" onclick={() => { zoomMenuOpen = false; onResetZoom?.(); }}>
                All
              </button>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  </div>
</div>

<style>
  .scrubber-wrapper {
    flex: 1;
    min-width: 5rem;
    border-radius: 4px;
  }

  .scrubber-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* ── Date labels ── */

  .date-label {
    font-family: var(--font-mono);
    font-size: var(--text-section);
    color: var(--color-text-muted);
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* ── Track column ── */

  .track-column {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0;
    min-width: 0;
  }

  /* ── Main track ── */

  .track {
    position: relative;
    width: 100%;
    height: 12px;
    border: 1px solid var(--color-chrome-divider);
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.07);
    cursor: pointer;
    touch-action: none;
    user-select: none;
    overflow: hidden;
  }

  .playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--color-text-primary);
    transform: translateX(-50%);
    pointer-events: none;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45);
  }

  /* ── Event finder results ── */

  .event-marker {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    min-width: 2px;
    padding: 0;
    border: 0;
    border-radius: 1px;
    background: var(--color-event-accent);
    opacity: 0.45;
    transform: translateX(-50%);
    cursor: pointer;
  }

  .event-marker.interval {
    min-width: 4px;
    opacity: 0.72;
    transform: none;
  }

  .event-marker.selected {
    width: 2px;
    opacity: 1;
    box-shadow: inset 0 0 0 1px var(--color-text-primary);
  }

  .event-marker.active {
    opacity: 1;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.72), 0 0 4px currentColor;
  }

  .event-marker[data-kind='closest-approach'] { background: #72b7d8; }
  .event-marker[data-kind='distance-range'] { background: #71b896; }
  .event-marker[data-kind='occultation'] { background: #8c72d8; }
  .event-marker.partial { background: #e0a84c; }
  .event-marker.full { background: #8c72d8; }
  .event-marker.annular { background: #d96f4c; }

  .track:hover .playhead {
    box-shadow: 0 0 5px rgba(255, 255, 255, 0.38);
  }

  .track:hover .event-marker {
    opacity: 0.68;
  }

  .track:hover .event-marker.selected {
    opacity: 1;
  }

  .track:hover .event-marker.active {
    opacity: 1;
  }

  .scrubber-wrapper:focus-visible .track {
    border-color: rgba(110, 170, 255, 0.7);
  }

  /* ── Minimap line — always visible, 1px below track ── */

  .minimap-line {
    width: 100%;
    height: 2px;
    background: var(--color-border);
    margin-top: 1px;
    position: relative;
  }

  .minimap-highlight {
    position: absolute;
    top: 0;
    height: 100%;
    min-width: 4px;
    /* background: var(--color-text-muted); */
    transition: background 0.15s;
  }

  .minimap-highlight.zoomed {
    background: var(--color-accent);
  }

  .minimap-playhead {
    position: absolute;
    top: -1px;
    bottom: -1px;
    width: 2px;
    background: var(--color-text-primary);
    transform: translateX(-50%);
    pointer-events: none;
    border-radius: 1px;
  }

  /* ── Zoom presets in popover ── */

  .zoom-preset {
    font-family: var(--font-mono);
    font-size: var(--text-interface);
    color: var(--color-text-secondary);
    background: none;
    border: none;
    padding: 3px 8px;
    border-radius: 3px;
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
    white-space: nowrap;
    width: 100%;
    text-align: left;
  }

  .zoom-preset:hover {
    background: var(--color-surface-3);
    color: var(--color-text-primary);
  }

  /* ── Match icon-btn style from BottomBar ── */

  :global(.icon-btn) {
    background: none;
    border: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    flex-shrink: 0;
    transition: color 0.1s, background 0.1s;
  }

  :global(.icon-btn:hover) {
    color: var(--color-text-primary);
    background: var(--color-surface-3);
  }

  @media (max-width: 719px) {
    :global(.icon-btn) {
      display: none;
    }
  }
</style>
