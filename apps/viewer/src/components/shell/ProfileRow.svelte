<script lang="ts">
  /**
   * One continuous profile on the timeline.
   *
   * A row of the dock's grid: its label in the gutter, its trace in the axis
   * column — which is the transport track's exact extent, window
   * (`vs.scrubMin`/`scrubMax`) and playhead — and its value in the readout
   * rail. It owns no time state and no gestures: hover, seek, pan, playhead
   * scrub and zoom belong to the dock's one interaction surface, and the
   * ghost and playhead lines are drawn once, through every row, by the dock.
   *
   * Normal rows are a signal: the trace and the value. Expanded rows get
   * three faint gridlines with values, so they can be read quantitatively
   * without turning into a dashboard. On a phone the row stacks its label,
   * value and controls in a header line over a full-width plot.
   */
  import type { ConfiguredContinuousProfile, ContinuousProfileConfiguration } from '@cosmolabe/core';
  import { vs, getRenderer } from '../../lib/viewer-state.svelte';
  import {
    resolveProfile, setConfiguredItemVisible, updateConfiguredProfile,
    moveConfiguredProfile, removeConfiguredItem,
  } from '../../lib/analysis.svelte';
  import {
    timeline, timelineFraction, toggleRowExpanded, ghostEt, TL_HEAD_PX,
    type ProfileEventTick,
  } from '../../lib/timeline.svelte';
  import {
    profileQuantity, sampleProfile, sampleCountFor, profilePath, quantityAt, valueY, gridValues,
    seriesValueAt, eventRelevantToProfile,
    type PositionOf, type ProfileBodies,
  } from '../../lib/profile-sampling';
  import { inWindow } from '../../lib/scrubber-math';
  import { Eye, EyeOff, ChevronsUpDown, ChevronsDownUp, Trash2 } from 'lucide-svelte';
  import PlotCursor from './PlotCursor.svelte';
  import * as Popover from '$lib/components/ui/popover';
  import ProfileConfig from './ProfileConfig.svelte';

  interface Props {
    item: ConfiguredContinuousProfile;
    /** The axis column's width, px — how densely to sample. */
    axisWidth: number;
    /** Desktop: a label gutter and a readout rail around the axis. */
    wide: boolean;
    /** Row height, px: the row's mode (normal or expanded), set by the stack. */
    height: number;
    ticks: readonly ProfileEventTick[];
    first: boolean;
    last: boolean;
    /** The first profile after the event lanes: a slightly firmer rule. */
    boundary?: boolean;
  }

  let { item, axisWidth, wide, height, ticks, first, last, boundary = false }: Props = $props();

  const W = 1000; // viewBox width; fractions map onto it directly
  const rowId = $derived(`profile:${item.id}`);
  const expanded = $derived(!!timeline.expandedRows[item.id]);
  const H = $derived(height);
  // The plot's own height, measured: the row owns its allocation, and the
  // plot is whatever the grid leaves it (less a stacked row's header). The
  // estimate only covers the first frame.
  let measuredH = $state(0);
  const PH = $derived(measuredH > 0 ? measuredH : Math.max(1, H - 1 - (wide ? 0 : TL_HEAD_PX)));
  // Expanded is the one mode with a labelled scale; nothing else implies it.
  const tall = $derived(expanded);
  const inspectedRow = $derived(timeline.hoverRow === rowId);

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

  // The trace is inset from the row's edges, so the scale labels of
  // neighbouring rows do not meet at the rule between them.
  const PAD = $derived(tall ? 8 : 3);
  const IH = $derived(Math.max(1, PH - 2 * PAD));
  const yOf = (value: number) => PAD + valueY(value, series!, IH);
  const path = $derived(series ? profilePath(series, W, IH) : '');
  const hasData = $derived(!!series && series.values.some((v) => v != null));
  const grid = $derived(tall && series && hasData ? gridValues(series) : []);

  // Value at the ghost when previewing, otherwise at committed time —
  // computed exactly at that instant rather than read off the nearest sample.
  const ghost = $derived(ghostEt());
  const readout = $derived.by(() => {
    const pos = positionOf();
    if (!item.visible || !spec || !bodies || !pos) return null;
    return quantityAt(spec.id, bodies, ghost ?? vs.et, pos);
  });

  // The readout is exact; the dot sits on the *drawn* trace at the cursor, so
  // at wide spans, where the display sampling smooths fast oscillation, the
  // dot never floats off the line the user can see.
  const dotFrac = $derived(timelineFraction(ghost ?? vs.et));
  const dotY = $derived.by(() => {
    if (!series || !hasData) return null;
    const drawn = seriesValueAt(series, ghost ?? vs.et);
    return drawn == null ? null : yOf(drawn);
  });

  // Events drawn behind this trace: by default only those between its own
  // bodies, so a profile does not become a barcode of every family. A
  // selected or previewed event shows on every profile.
  const shownTicks = $derived(
    ticks.filter((t) => t.selected || t.previewed || (bodies != null && eventRelevantToProfile(t.participants, bodies))),
  );

  let configOpen = $state(false);

  function apply(profile: ContinuousProfileConfiguration) {
    updateConfiguredProfile(item.id, profile, profileQuantity(profile.quantity)?.label ?? profile.quantity);
    configOpen = false;
  }

  const pair = $derived(bodies ? `${bodies.observer} → ${bodies.target}` : 'choose bodies');
  const rangeText = $derived(series && hasData && spec ? `${spec.format(series.min)} – ${spec.format(series.max)}` : '');
  const readoutText = $derived(readout != null && spec ? spec.format(readout) : '—');
  const icon = $derived(wide ? 11 : 13);
  const closing = $derived(spec?.id === 'range-rate' && readout != null && readout < 0);
</script>

<div
  class="tl-row"
  class:stacked={!wide}
  class:boundary
  class:hidden-row={!item.visible}
  class:inspected={inspectedRow}
  data-tl-row={rowId}
  data-tl-no-axis={!wide || undefined}
  style="height: {item.visible ? H : TL_HEAD_PX}px"
>
  <!-- One grammar for every row: the label opens its configuration; expand,
       the eye and the trash sit beside it. Units live with the value. -->
  <div data-tl-no-axis class="tl-label" class:top={tall && wide}>
    <Popover.Root bind:open={configOpen}>
      <Popover.Trigger class="tl-label-main" title="{spec?.label ?? item.profile.quantity} · {pair} — configure">
        <span class="tl-primary">{spec?.label ?? item.profile.quantity}</span>
        <span class="tl-secondary">{pair}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side={wide ? 'right' : 'top'} align="start" sideOffset={6} class="w-80 max-w-[calc(100vw-16px)] p-3">
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
    <span class="tl-label-controls">
      {#if item.visible}
        <button
          class="tl-icon-btn"
          onclick={() => toggleRowExpanded(item.id)}
          aria-pressed={expanded}
          aria-label={expanded ? 'Collapse profile row' : 'Expand profile row'}
          title={expanded ? 'Collapse row' : 'Expand row'}
        >
          {#if expanded}<ChevronsDownUp size={icon} />{:else}<ChevronsUpDown size={icon} />{/if}
        </button>
      {/if}
      <button
        class="tl-icon-btn"
        onclick={() => setConfiguredItemVisible(item.id, !item.visible)}
        aria-label={item.visible ? 'Hide profile' : 'Show profile'}
        title={item.visible ? 'Hide profile' : 'Show profile'}
      >
        {#if item.visible}<Eye size={icon} />{:else}<EyeOff size={icon} />{/if}
      </button>
      <button
        class="tl-icon-btn danger"
        onclick={() => removeConfiguredItem(item.id)}
        aria-label="Remove profile"
        title="Remove profile"
      >
        <Trash2 size={icon} />
      </button>
    </span>
  </div>

  {#if item.visible}
    <div
      class="tl-plot plot"
      data-tl-plot
      role="img"
      aria-label="{spec?.label ?? 'Profile'} {pair}: {readoutText}"
      bind:clientHeight={measuredH}
    >
      <svg viewBox="0 0 {W} {PH}" preserveAspectRatio="none" aria-hidden="true">
        {#each grid as value (value)}
          <line class="grid" x1="0" x2={W} y1={yOf(value)} y2={yOf(value)} />
        {/each}
        {#if spec?.symmetric && hasData && !tall}
          <line class="zero" x1="0" x2={W} y1={PH / 2} y2={PH / 2} />
        {/if}
        <!-- Events behind the trace, in the shared vocabulary but quiet, so
             the trace stays the row's content. Relationship-aware: see
             `shownTicks`. -->
        {#each shownTicks as tick (tick.id)}
          {#if tick.endFraction > tick.fraction}
            <rect
              class="event-span" class:emphasis={tick.selected || tick.previewed} class:active={tick.active}
              data-ev-kind={tick.kind} data-ev-state={tick.state}
              x={tick.fraction * W} width={(tick.endFraction - tick.fraction) * W} y="0" height={PH}
            />
          {:else}
            <line
              class="event-tick" class:emphasis={tick.selected || tick.previewed} class:active={tick.active}
              data-ev-kind={tick.kind} data-ev-state={tick.state}
              x1={tick.fraction * W} x2={tick.fraction * W} y1="0" y2={PH}
            />
          {/if}
        {/each}
        {#if path}
          <path class="trace" d={path} transform="translate(0 {PAD})" />
        {/if}
      </svg>
      {#each grid as value (value)}
        <span class="grid-label tl-secondary tl-num" style="top: {yOf(value)}px">{spec?.format(value)}</span>
      {/each}
      {#if dotY != null && inWindow(dotFrac)}
        <div class="value-dot" class:preview={ghost != null} style="left: {dotFrac * 100}%; top: {dotY}px"></div>
        {#if inspectedRow && ghost != null && wide}
          <!-- The inspected row's value, beside its dot. The rail keeps it too. -->
          <span
            class="dot-tip tl-num"
            class:flip={dotFrac > 0.8}
            class:below={dotY < 14}
            style="left: {dotFrac * 100}%; top: {dotY}px"
          >{readoutText}</span>
        {/if}
      {/if}
      {#if !bodies}
        <span class="plot-note tl-secondary">Choose a From and To body</span>
      {:else if series && !hasData}
        <span class="plot-note tl-secondary">No state for this pair in view</span>
      {/if}
      {#if !wide}<PlotCursor />{/if}
    </div>

    <div data-tl-no-axis class="tl-readout" class:top={tall && wide} title={rangeText ? `In view: ${rangeText}` : undefined}>
      <span class="tl-num" class:preview={ghost != null} class:closing>{readoutText}</span>
      {#if wide && rangeText && !tall && PH >= 40}<span class="tl-secondary tl-num range">{rangeText}</span>{/if}
    </div>
  {/if}
</div>

<style>
  .plot line,
  .plot path {
    vector-effect: non-scaling-stroke;
    fill: none;
  }
  /* The trace is the row's content; it reads above everything else in it. */
  .trace {
    stroke: var(--color-text-primary);
    stroke-opacity: 0.8;
    stroke-width: 1.4;
    stroke-linejoin: round;
    transition: stroke-opacity var(--duration-chrome) var(--ease-chrome);
  }
  :global(.tl-row.inspected) .trace {
    stroke-opacity: 0.96;
  }
  .zero {
    stroke: rgba(255, 255, 255, 0.1);
    stroke-width: 1;
  }
  .grid {
    stroke: rgba(255, 255, 255, 0.1);
    stroke-width: 1;
    stroke-dasharray: 2 3;
  }
  .grid-label {
    position: absolute;
    left: 3px;
    transform: translateY(-50%);
    padding: 0 2px;
    border-radius: 2px;
    background: var(--color-panel);
    font-size: var(--text-metadata);
    pointer-events: none;
  }
  /* Events behind a profile: the vocabulary's colour, desaturated by
     opacity. Selected, previewed and active raise it. */
  .event-tick {
    stroke: var(--ev);
    stroke-width: 1;
    opacity: 0.4;
  }
  .event-span {
    fill: var(--ev);
    opacity: 0.08;
  }
  .event-tick.active {
    opacity: 0.6;
  }
  .event-span.active {
    opacity: 0.14;
  }
  .event-tick.emphasis {
    stroke-width: 2;
    opacity: 0.95;
  }
  .event-span.emphasis {
    opacity: 0.22;
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
  :global(.tl-row.inspected) .value-dot {
    width: 7px;
    height: 7px;
    margin: -3.5px 0 0 -3.5px;
  }
  .dot-tip {
    position: absolute;
    padding: 0 4px;
    border-radius: 2px;
    background: var(--color-panel);
    color: var(--color-text-primary);
    transform: translate(8px, -120%);
    pointer-events: none;
    white-space: nowrap;
  }
  .dot-tip.flip {
    transform: translate(calc(-100% - 8px), -120%);
  }
  .dot-tip.below {
    transform: translate(8px, 20%);
  }
  .dot-tip.flip.below {
    transform: translate(calc(-100% - 8px), 20%);
  }

  .plot-note {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }

  .range {
    font-size: var(--text-metadata);
    color: var(--color-text-muted);
  }
  .closing,
  :global(.tl-readout) .closing {
    color: var(--color-success);
  }
</style>
