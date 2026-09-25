<script lang="ts">
  import { clampFraction, inWindow, KEYBOARD_STEP } from '../lib/scrubber-math';
  import RangeControl from './RangeControl.svelte';

  interface Props {
    /**
     * Current position on the zoomed range. Not clamped: outside 0-1 the
     * playhead is out of view and is not drawn.
     */
    fraction: number;
    /** Called during drag with the new fraction */
    onScrub: (fraction: number) => void;
    /** Called when drag begins */
    onScrubStart?: () => void;
    /** Called when drag ends */
    onScrubEnd?: () => void;
    /**
     * The timeline's ghost playhead, as a fraction of the zoomed range, or
     * null. Hover, like the wheel, is the dock's interaction surface's — the
     * track only draws it.
     */
    hoverFraction?: number | null;
    /** Timestamp shown over the ghost playhead. */
    hoverLabel?: string;
    /**
     * Draw the ghost line on the track. Off when the dock draws one line
     * through the track and every lane below it.
     */
    ghostLine?: boolean;
    /**
     * `inline`: bounds and range control beside the track. `stacked`: the
     * track alone, so it spans the timeline grid's axis column exactly; the
     * dock sets the bounds and range control in its own caption row.
     */
    layout?: 'inline' | 'stacked';
    /** Pan the zoom window by a fraction of the full range (minimap drag). */
    onViewportPan?: (deltaFraction: number) => void;
    /** Centre the zoom window on a fraction of the full range (minimap click). */
    onViewportCenter?: (fraction: number) => void;
    /** The track element, for rows that must share its horizontal extent. */
    trackEl?: HTMLDivElement;
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
    /** Visible span (e.g. "43 d") — the range control's label. */
    rangeLabel?: string;
    /** Track height, px: taller when collapsed, where it is the overview. */
    trackHeight?: number;
    /** Framing presets offered above "Fit mission" in the range popover. */
    fitOptions?: readonly { label: string; onSelect: () => void }[];
    /**
     * The overview's sub-bands: one per event family, so overlapping results
     * from different queries do not pile into the same pixels. 1 draws every
     * marker full height; `dense` (too many families to band) draws them as a
     * density — faint marks whose overlaps build up.
     */
    bands?: number;
    dense?: boolean;
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
      preview?: boolean;
      active?: boolean;
      title?: string;
      kind?: string;
      state?: string;
      /** Cross-highlighted from a hover elsewhere on the timeline. */
      previewed?: boolean;
      /** Sub-band of the overview (one per event family), of `bands`. */
      band?: number;
      onSelect?: () => void;
      onPreview?: () => void;
      onPreviewEnd?: () => void;
    }[];
  }

  let {
    fraction, onScrub, onScrubStart, onScrubEnd,
    onResetZoom, onSetZoom,
    startLabel, endLabel,
    isZoomed = false, viewportStart = 0, viewportEnd = 1, globalPlayhead = 0.5,
    rangeLabel, trackHeight = 12, fitOptions = [], markers = [], bands = 1, dense = false,
    hoverFraction = null, hoverLabel = '', ghostLine = true, layout = 'inline',
    onViewportPan, onViewportCenter,
    trackEl = $bindable(),
  }: Props = $props();

  let dragging = $state(false);
  let dragFraction = $state(0);
  let lastClientX = 0;
  let pointerStartX = 0;
  let pointerMoved = false;
  let pendingMarkerSelect: (() => void) | undefined;
  let markerPointerDown = false;
  let trackRect: DOMRect | null = null;

  /** Height of the minimap strip along the track's bottom edge, px. */
  const MINIMAP_PX = 3;

  let displayFraction = $derived(dragging ? dragFraction : fraction);

  // ── Minimap: where the visible window sits in the whole mission ──
  //
  // Drag the viewport to pan the zoom window; press elsewhere on the line to
  // bring the window there, then keep dragging.
  let minimapEl: HTMLDivElement | undefined = $state();
  let minimapDrag: { id: number; x: number } | null = null;
  function onMinimapDown(e: PointerEvent) {
    if (!isZoomed || !minimapEl || e.button !== 0) return;
    e.stopPropagation();
    const rect = minimapEl.getBoundingClientRect();
    const f = (e.clientX - rect.left) / rect.width;
    if (f < viewportStart || f > viewportEnd) onViewportCenter?.(clampFraction(f));
    minimapEl.setPointerCapture(e.pointerId);
    minimapDrag = { id: e.pointerId, x: e.clientX };
  }
  function onMinimapMove(e: PointerEvent) {
    if (!minimapDrag || minimapDrag.id !== e.pointerId || !minimapEl) return;
    const width = minimapEl.getBoundingClientRect().width;
    if (width > 0) onViewportPan?.((e.clientX - minimapDrag.x) / width);
    minimapDrag.x = e.clientX;
  }
  function onMinimapUp(e: PointerEvent) {
    if (minimapDrag?.id !== e.pointerId) return;
    minimapDrag = null;
    if (minimapEl?.hasPointerCapture(e.pointerId)) minimapEl.releasePointerCapture(e.pointerId);
  }

  function onPointerDown(e: PointerEvent) {
    if (!trackEl) return;
    markerPointerDown = e.target instanceof Element && !!e.target.closest('.event-marker');
    if (!markerPointerDown) {
      pendingMarkerSelect = undefined;
    }
    trackRect = trackEl.getBoundingClientRect();
    trackEl.setPointerCapture(e.pointerId);
    dragFraction = clampFraction((e.clientX - trackRect.left) / trackRect.width);
    lastClientX = e.clientX;
    pointerStartX = e.clientX;
    pointerMoved = false;
    dragging = true;
    if (!markerPointerDown) {
      onScrubStart?.();
      onScrub(dragFraction);
    }
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging || !trackRect) return;
    const dx = e.clientX - lastClientX;
    if (Math.abs(e.clientX - pointerStartX) > 3) pointerMoved = true;
    if (markerPointerDown && pointerMoved) {
      markerPointerDown = false;
      onScrubStart?.();
    }
    lastClientX = e.clientX;
    dragFraction = clampFraction(dragFraction + dx / trackRect.width);
    if (!markerPointerDown) onScrub(dragFraction);
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
    if (!markerPointerDown) onScrubEnd?.();
    const select = pendingMarkerSelect;
    pendingMarkerSelect = undefined;
    markerPointerDown = false;
    if (!pointerMoved) select?.();
  }

  function onKeyDown(e: KeyboardEvent) {
    let newFraction: number | null = null;
    switch (e.key) {
      case 'ArrowLeft':
        newFraction = clampFraction(clampFraction(fraction) - KEYBOARD_STEP);
        break;
      case 'ArrowRight':
        newFraction = clampFraction(clampFraction(fraction) + KEYBOARD_STEP);
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
  aria-valuenow={Math.round(clampFraction(displayFraction) * 100)}
  aria-label="Time scrubber — scroll to zoom, Shift+scroll to pan"
  onkeydown={onKeyDown}
>
  <div class="scrubber-row">
    {#if startLabel && layout === 'inline'}<span class="date-label">{startLabel}</span>{/if}

    <div class="track-column">
      <!-- One instrument of fixed geometry: the event overview above, the
           mission minimap as its bottom strip. Zooming changes what they
           show, never their layout. -->
      <div
        bind:this={trackEl}
        class="track"
        style="height: {trackHeight}px; --mini: {MINIMAP_PX}px"
        class:banded={bands > 1}
        class:dense
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
      >
        <div class="marks">
          {#each markers as marker}
            {@const lifted = marker.selected || marker.preview || marker.previewed}
            {@const banded = bands > 1 && marker.band != null && !lifted}
            <!-- No native title: the timeline's own callout names the event. -->
            <button
              type="button"
              class="event-marker"
              class:interval={(marker.endFraction ?? marker.fraction) > marker.fraction}
              class:selected={marker.selected}
              class:preview={marker.preview}
              class:active={marker.active}
              class:previewed={marker.previewed}
              data-ev-kind={marker.kind ?? ''}
              data-ev-state={marker.state}
              style="left: {marker.fraction * 100}%; width: {Math.max(0, (marker.endFraction ?? marker.fraction) - marker.fraction) * 100}%;{banded
                ? ` top: ${(marker.band! / bands) * 100}%; height: ${100 / bands}%; bottom: auto;`
                : ''}"
              aria-label={marker.title ?? 'Select timeline event'}
              onpointerdown={() => { pendingMarkerSelect = marker.onSelect; }}
              onfocus={marker.onPreview}
              onblur={marker.onPreviewEnd}
              onclick={(event) => onMarkerClick(event, marker.onSelect)}
            ></button>
          {/each}
          {#if ghostLine && hoverFraction != null && !dragging && hoverFraction >= 0 && hoverFraction <= 1}
            <div class="ghost-playhead" style="left: {hoverFraction * 100}%"></div>
          {/if}
          {#if inWindow(displayFraction)}
            <div class="playhead" style="left: {displayFraction * 100}%"></div>
          {/if}
        </div>

        <!-- Minimap: the whole mission, the visible window as a neutral
             viewport — full width until zoomed, then a draggable segment —
             and the playhead. Navigation context, not an event. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          bind:this={minimapEl}
          class="minimap"
          class:interactive={isZoomed}
          onpointerdown={onMinimapDown}
          onpointermove={onMinimapMove}
          onpointerup={onMinimapUp}
          onpointercancel={onMinimapUp}
        >
          <div class="minimap-line">
            <div
              class="minimap-viewport"
              style="left: {(isZoomed ? viewportStart : 0) * 100}%; width: {(isZoomed ? viewportEnd - viewportStart : 1) * 100}%"
            ></div>
            <div class="minimap-playhead" style="left: {globalPlayhead * 100}%"></div>
          </div>
        </div>
      </div>
      {#if hoverLabel && hoverFraction != null && !dragging && hoverFraction >= 0 && hoverFraction <= 1}
        <div class="ghost-label" style="left: {hoverFraction * 100}%">{hoverLabel}</div>
      {/if}
    </div>

    {#if layout === 'inline'}
      {#if endLabel}<span class="date-label">{endLabel}</span>{/if}
      <RangeControl label={rangeLabel ?? ''} {fitOptions} {onSetZoom} {onResetZoom} />
    {/if}
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
    position: relative;
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

  /* ── Ghost playhead: preview, never commit. Thinner and dimmer than the
     real one, so the two read apart by weight rather than by colour. ── */

  .ghost-playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--color-text-secondary);
    opacity: 0.7;
    transform: translateX(-50%);
    pointer-events: none;
  }

  .ghost-label {
    position: absolute;
    bottom: calc(100% + 3px);
    transform: translateX(-50%);
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--color-panel);
    border: 1px solid var(--color-chrome-divider);
    color: var(--color-text-secondary);
    font-family: var(--font-mono);
    font-size: var(--text-section);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    pointer-events: none;
    /* A transient label: above every structural piece of timeline chrome. */
    z-index: var(--tl-z-label, 10);
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
    background: var(--ev);
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
  .event-marker.preview {
    opacity: 1;
    filter: brightness(1.45);
    box-shadow: 0 0 0 1px rgba(230, 240, 247, 0.45);
  }

  .event-marker.previewed {
    opacity: 1;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.55);
  }

  /* Overview: a sub-band per family packs them without overlap; selected
     and previewed rise out of their band to full height. */
  .event-marker.selected,
  .event-marker.preview,
  .event-marker.previewed {
    z-index: 1;
  }
  .track.dense .event-marker {
    opacity: 0.3;
  }
  .track.dense .event-marker.interval {
    opacity: 0.22;
  }

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

  /* ── Minimap: the track's bottom strip ──
     Neutral grey, low salience. While zoomed its hit area rises a few px
     over the marks, so the viewport can be dragged. */

  .marks {
    position: absolute;
    inset: 0 0 var(--mini) 0;
  }

  .minimap {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: var(--mini);
  }
  .minimap.interactive {
    z-index: 2;
    height: calc(var(--mini) + 4px);
    cursor: pointer;
    touch-action: none;
  }

  .minimap-line {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: var(--mini);
    border-top: 1px solid var(--color-chrome-divider);
    background: rgba(0, 0, 0, 0.22);
  }

  .minimap-viewport {
    position: absolute;
    top: 0;
    bottom: 0;
    min-width: 4px;
    background: rgba(220, 224, 232, 0.2);
    transition: background var(--duration-chrome) var(--ease-chrome);
  }
  .minimap.interactive .minimap-viewport {
    background: rgba(220, 224, 232, 0.4);
    cursor: grab;
  }
  .minimap.interactive:hover .minimap-viewport {
    background: rgba(220, 224, 232, 0.6);
  }

  .minimap-playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--color-text-primary);
    opacity: 0.75;
    transform: translateX(-50%);
    pointer-events: none;
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
