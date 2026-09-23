<script lang="ts">
  /**
   * One continuous profile on the timeline.
   *
   * The plot is laid over the transport track's exact horizontal extent and
   * reads the same window (`vs.scrubMin`/`scrubMax`), playhead (`vs.et`) and
   * ghost playhead (`timeline.hoverEt`) as the track does. It owns no time
   * state of its own: its gestures are `timelineGestures`, the same ones the
   * event lanes use — wheel zooms the shared window about the pointer, a press
   * or drag seeks the shared playhead, and a hover sets the shared ghost —
   * which is what lets the ruler's private zoom window, playhead and hover
   * scrub go away rather than move here.
   */
  import type { ConfiguredContinuousProfile, ContinuousProfileConfiguration } from '@cosmolabe/core';
  import { vs, getRenderer } from '../../lib/viewer-state.svelte';
  import {
    resolveProfile, setConfiguredItemVisible, updateConfiguredProfile,
    moveConfiguredProfile, removeConfiguredItem,
  } from '../../lib/analysis.svelte';
  import {
    timeline, timelineFraction, timelineGestures, type ProfileEventTick,
  } from '../../lib/timeline.svelte';
  import {
    profileQuantity, sampleProfile, sampleCountFor, profilePath, quantityAt, valueY,
    type PositionOf, type ProfileBodies,
  } from '../../lib/profile-sampling';
  import { Eye, EyeOff } from 'lucide-svelte';
  import * as Popover from '$lib/components/ui/popover';
  import ProfileConfig from './ProfileConfig.svelte';

  interface Props {
    item: ConfiguredContinuousProfile;
    /** The track's left edge and width, in px, relative to the lane region. */
    axisLeft: number;
    axisWidth: number;
    /** Room for a label gutter left of the axis and a readout right of it. */
    wide: boolean;
    ticks: readonly ProfileEventTick[];
    first: boolean;
    last: boolean;
  }

  let { item, axisLeft, axisWidth, wide, ticks, first, last }: Props = $props();

  const W = 1000; // viewBox width; fractions map onto it directly
  const H = $derived(wide ? 30 : 34);

  const spec = $derived(profileQuantity(item.profile.quantity));

  const bodies = $derived.by((): ProfileBodies | null => {
    const resolved = resolveProfile(item).bodies;
    // With no observer anywhere, follow the tracked body — the ruler's
    // default, and still the most useful one for a fresh scene.
    const observer = resolved.observer ?? vs.trackedBodyName ?? '';
    const target = resolved.target ?? '';
    if (!observer || !target || observer === target) return null;
    return { observer, target, illuminator: resolved.illuminator };
  });

  function positionOf(): PositionOf | null {
    const r = getRenderer();
    if (!r) return null;
    const universe = r.getContext().universe;
    return (body, et) => universe.absolutePositionOf(body, et);
  }

  const series = $derived.by(() => {
    // `getRenderer()` is not reactive; the scene flag is what changes with it.
    void vs.sceneLoaded;
    const pos = positionOf();
    if (!item.visible || !spec || !bodies || !pos || !(axisWidth > 0)) return null;
    return sampleProfile(
      spec, bodies, { start: vs.scrubMin, end: vs.scrubMax },
      sampleCountFor(axisWidth), pos, item.profile.window,
    );
  });

  const path = $derived(series ? profilePath(series, W, H) : '');
  const hasData = $derived(!!series && series.values.some((v) => v != null));

  // Readout: the ghost instant when previewing, otherwise the committed one.
  // Computed exactly at that instant rather than read off the nearest sample.
  const readoutEt = $derived(timeline.hoverEt ?? vs.et);
  const readout = $derived.by(() => {
    const pos = positionOf();
    if (!item.visible || !spec || !bodies || !pos) return null;
    return quantityAt(spec.id, bodies, readoutEt, pos);
  });

  const playheadFrac = $derived(timelineFraction(vs.et));
  const ghostFrac = $derived(timeline.hoverEt == null ? null : timelineFraction(timeline.hoverEt));
  const inView = (f: number | null): f is number => f != null && f >= 0 && f <= 1;

  const dotY = $derived(readout != null && series && hasData ? valueY(readout, series, H) : null);

  const snapTargets = $derived(
    ticks.flatMap((t) => t.endFraction > t.fraction
      ? [{ fraction: t.fraction, id: t.id }, { fraction: t.endFraction, id: t.id }]
      : [{ fraction: t.fraction, id: t.id }]),
  );

  let configOpen = $state(false);

  function apply(profile: ContinuousProfileConfiguration) {
    updateConfiguredProfile(item.id, profile, profileQuantity(profile.quantity)?.label ?? profile.quantity);
    configOpen = false;
  }

  const pair = $derived(bodies ? `${bodies.observer} → ${bodies.target}` : 'choose bodies');
  const rangeText = $derived(series && hasData && spec ? `${spec.format(series.min)} – ${spec.format(series.max)}` : '');
  const readoutText = $derived(readout != null && spec ? spec.format(readout) : '—');
  const closing = $derived(spec?.id === 'range-rate' && readout != null && readout < 0);
</script>

<div
  class="profile-row"
  class:hidden-row={!item.visible}
  style="height: {item.visible ? H : 18}px"
>
  <!-- Label: in the gutter left of the axis when there is one, otherwise
       overlaid at the plot's top-left. It is the configure affordance. -->
  <div
    class="row-label"
    class:overlay={!wide}
    style={wide
      ? `left: 0; width: ${Math.max(0, axisLeft - 8)}px`
      : `left: ${axisLeft + 3}px; max-width: ${Math.max(0, axisWidth * 0.6)}px`}
  >
    <Popover.Root bind:open={configOpen}>
      <Popover.Trigger class="label-btn" title="Configure profile">
        <span class="label-quantity">{spec?.label ?? item.profile.quantity}</span>
        <span class="label-pair">{pair}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" sideOffset={8} class="w-72 p-3">
          {#if configOpen}
          <ProfileConfig
            initial={item.profile}
            submitLabel="Apply"
            onSubmit={apply}
            visible={item.visible}
            onToggleVisible={() => { setConfiguredItemVisible(item.id, !item.visible); configOpen = false; }}
            onMoveUp={first ? undefined : () => moveConfiguredProfile(item.id, -1)}
            onMoveDown={last ? undefined : () => moveConfiguredProfile(item.id, 1)}
            onRemove={() => { configOpen = false; removeConfiguredItem(item.id); }}
          />
          {/if}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
    {#if wide}
      <button
        class="eye-btn"
        onclick={() => setConfiguredItemVisible(item.id, !item.visible)}
        aria-label={item.visible ? 'Hide profile' : 'Show profile'}
        title={item.visible ? 'Hide profile' : 'Show profile'}
      >
        {#if item.visible}<Eye size={11} />{:else}<EyeOff size={11} />{/if}
      </button>
    {/if}
  </div>

  {#if item.visible}
    <div
      class="plot"
      style="left: {axisLeft}px; width: {axisWidth}px"
      role="img"
      aria-label="{spec?.label ?? 'Profile'} {pair}: {readoutText}"
      use:timelineGestures={{ snapTargets }}
    >
      <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-hidden="true">
        {#if spec?.symmetric && hasData}
          <line class="zero" x1="0" x2={W} y1={H / 2} y2={H / 2} />
        {/if}
        {#each ticks as tick (tick.id)}
          {@const emphasis = tick.id === timeline.previewEventId || tick.selected}
          {#if tick.endFraction > tick.fraction}
            <rect
              class="event-span" class:emphasis class:active={tick.active}
              x={tick.fraction * W} width={(tick.endFraction - tick.fraction) * W} y="0" height={H}
            />
          {:else}
            <line
              class="event-tick" class:emphasis class:active={tick.active}
              x1={tick.fraction * W} x2={tick.fraction * W} y1="0" y2={H}
            />
          {/if}
        {/each}
        {#if path}
          <path class="trace" d={path} />
        {/if}
        {#if inView(ghostFrac)}
          <line class="ghost" x1={ghostFrac * W} x2={ghostFrac * W} y1="0" y2={H} />
        {/if}
        {#if inView(playheadFrac)}
          <line class="playhead" x1={playheadFrac * W} x2={playheadFrac * W} y1="0" y2={H} />
        {/if}
      </svg>
      {#if dotY != null}
        {@const dotFrac = ghostFrac ?? playheadFrac}
        {#if inView(dotFrac)}
          <div class="value-dot" class:preview={ghostFrac != null} style="left: {dotFrac * 100}%; top: {dotY}px"></div>
        {/if}
      {/if}
      {#if !bodies}
        <span class="plot-note">Choose a From and To body</span>
      {:else if series && !hasData}
        <span class="plot-note">No state for this pair in view</span>
      {/if}
      {#if !wide}
        <span class="overlay-readout" class:preview={ghostFrac != null} class:closing>{readoutText}</span>
      {/if}
    </div>

    {#if wide}
      <div class="row-readout" style="left: {axisLeft + axisWidth + 8}px" title={rangeText ? `View range ${rangeText}` : undefined}>
        <span class="readout-value" class:preview={ghostFrac != null} class:closing>{readoutText}</span>
        {#if rangeText}<span class="readout-range">{rangeText}</span>{/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .profile-row {
    position: relative;
    border-top: 1px solid var(--color-chrome-divider);
  }
  .hidden-row {
    opacity: 0.55;
  }

  .row-label {
    position: absolute;
    top: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
    min-width: 0;
    z-index: 1;
  }
  .row-label.overlay {
    bottom: auto;
    top: 1px;
    justify-content: flex-start;
  }
  :global(.label-btn) {
    display: flex;
    min-width: 0;
    align-items: baseline;
    gap: 6px;
    padding: 1px 4px;
    border: none;
    border-radius: 3px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    white-space: nowrap;
  }
  :global(.label-btn:hover) {
    color: var(--color-text-primary);
    background: var(--color-control-hover);
  }
  .label-quantity {
    font-size: var(--text-section);
  }
  .label-pair {
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--color-text-muted);
    font-size: var(--text-metadata);
  }
  .overlay .label-quantity,
  .overlay .label-pair {
    font-size: var(--text-metadata);
  }
  .eye-btn {
    display: flex;
    padding: 3px;
    border: none;
    border-radius: 3px;
    background: none;
    color: var(--color-text-muted);
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--duration-chrome) var(--ease-chrome);
  }
  .profile-row:hover .eye-btn,
  .hidden-row .eye-btn,
  .eye-btn:focus-visible {
    opacity: 1;
  }
  .eye-btn:hover {
    color: var(--color-text-primary);
  }

  .plot {
    position: absolute;
    top: 0;
    bottom: 0;
    cursor: crosshair;
    touch-action: none;
    user-select: none;
  }
  .plot svg {
    display: block;
    width: 100%;
    height: 100%;
  }
  .plot line,
  .plot path {
    vector-effect: non-scaling-stroke;
    fill: none;
  }
  .trace {
    stroke: var(--color-text-secondary);
    stroke-width: 1.25;
    stroke-linejoin: round;
  }
  .zero {
    stroke: var(--color-chrome-divider);
    stroke-width: 1;
  }
  /* Real playhead vs. preview: weight and opacity, not a new colour. */
  .playhead {
    stroke: var(--color-text-primary);
    stroke-width: 2;
    opacity: 0.9;
  }
  .ghost {
    stroke: var(--color-text-secondary);
    stroke-width: 1;
    stroke-dasharray: 2 2;
    opacity: 0.75;
  }
  .event-tick {
    stroke: var(--color-event-accent);
    stroke-width: 1;
    opacity: 0.35;
  }
  .event-span {
    fill: var(--color-event-accent);
    opacity: 0.07;
  }
  .event-tick.active,
  .event-span.active {
    opacity: 0.55;
  }
  .event-span.active {
    opacity: 0.13;
  }
  .event-tick.emphasis {
    stroke-width: 2;
    opacity: 0.95;
  }
  .event-span.emphasis {
    opacity: 0.2;
  }

  .value-dot {
    position: absolute;
    width: 5px;
    height: 5px;
    margin: -2.5px 0 0 -2.5px;
    border-radius: 50%;
    background: var(--color-text-primary);
    pointer-events: none;
  }
  .value-dot.preview {
    background: var(--color-panel);
    box-shadow: 0 0 0 1px var(--color-text-primary);
  }

  .plot-note {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-muted);
    font-size: var(--text-metadata);
    pointer-events: none;
  }

  .row-readout {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-width: 0;
    overflow: hidden;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .readout-value {
    color: var(--color-text-primary);
    font-size: var(--text-section);
    line-height: 1.2;
  }
  .readout-range {
    color: var(--color-text-muted);
    font-size: 9px;
    line-height: 1.2;
  }
  .overlay-readout {
    position: absolute;
    top: 1px;
    right: 3px;
    color: var(--color-text-primary);
    font-family: var(--font-mono);
    font-size: var(--text-metadata);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
  .preview {
    color: var(--color-text-secondary);
  }
  .closing {
    color: var(--color-success);
  }
</style>
