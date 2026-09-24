<script lang="ts">
  /**
   * One configured event query as a lane on the timeline — the middle depth
   * between the transport strip and the continuous profiles.
   *
   * The transport track still carries every visible result merged into one
   * strip; a lane separates one query's results onto its own row, on the same
   * axis, so families can be read, compared and hidden independently. Hiding
   * a lane flips the query's shared `visible` flag, which the track, the event
   * finder and this lane all read, so no surface disagrees about it.
   *
   * Clicking a mark goes through `selectEvent`, the same call the track's
   * marks make; this lane adds no selection or 3D behavior of its own.
   */
  import type { ConfiguredEventQuery, GeometryEvent } from '@cosmolabe/core';
  import { vs } from '../../lib/viewer-state.svelte';
  import { analysis } from '../../lib/analysis.svelte';
  import { ef, selectEvent, setConfiguredQueryVisible } from '../../lib/event-finder.svelte';
  import { activeEventAtTime, eventContainsTime, eventTimelineFractions } from '../../lib/event-query';
  import { timeline, timelineFraction, timelineGestures, eventKey, eventHoverTargets } from '../../lib/timeline.svelte';
  import { inWindow } from '../../lib/scrubber-math';
  import { Eye, EyeOff } from 'lucide-svelte';

  interface Props {
    item: ConfiguredEventQuery;
    axisLeft: number;
    axisWidth: number;
    wide: boolean;
  }

  let { item, axisLeft, axisWidth, wide }: Props = $props();

  const H = $derived(wide ? 18 : 22);

  const events = $derived<readonly GeometryEvent[]>(analysis.eventResults[item.id] ?? []);

  const marks = $derived.by(() => {
    if (!item.visible) return [];
    const range = { start: vs.scrubMin, end: vs.scrubMax };
    return events.flatMap((event) => {
      const span = eventTimelineFractions(event, range);
      return span ? [{ event, start: span.start, end: span.end }] : [];
    });
  });

  const hoverTargets = $derived(
    eventHoverTargets(marks.map((m) => ({ id: eventKey(m.event), fraction: m.start, endFraction: m.end }))),
  );

  // Header: the kind of result, then how the query relates its bodies.
  const kindLabel = $derived(item.label);
  const relation = $derived.by(() => {
    const b = item.query.bodies ?? {};
    if (b.observer && b.target) return `${b.observer} → ${b.target}`;
    if (b.front && b.back) return `${b.front} / ${b.back}`;
    return '';
  });

  const playheadFrac = $derived(timelineFraction(vs.et));
  const ghostFrac = $derived(timeline.hoverEt == null ? null : timelineFraction(timeline.hoverEt));
  const inView = inWindow;

  // Readout: the event under the ghost (or the playhead), else the count.
  const readoutEt = $derived(timeline.hoverEt ?? vs.et);
  const current = $derived(
    item.visible
      ? activeEventAtTime(events, readoutEt, ef.selectedId ? { id: ef.selectedId, queryId: ef.configuredId ?? '' } : null)
      : undefined,
  );
  const readout = $derived(current ? current.label : `${events.length} ${events.length === 1 ? 'event' : 'events'}`);

  function onMarkClick(event: GeometryEvent) {
    selectEvent(event);
  }
</script>

<div class="tl-row event-lane" class:hidden-row={!item.visible} style="height: {item.visible ? H : 18}px">
  <div
    class="tl-header"
    class:overlay={!wide}
    style={wide
      ? `width: ${Math.max(0, axisLeft - 10)}px`
      : `left: ${axisLeft + 3}px; max-width: ${Math.max(0, axisWidth * 0.5)}px`}
  >
    <span class="tl-header-main" title={item.label}>
      <span class="tl-h-primary">{kindLabel}</span>
      {#if relation && wide}<span class="tl-h-secondary">{relation}</span>{/if}
    </span>
    <span class="tl-header-controls">
      <button
        class="tl-icon-btn"
        onclick={() => setConfiguredQueryVisible(item.id, !item.visible)}
        aria-label={item.visible ? `Hide ${item.label} lane` : `Show ${item.label} lane`}
        title={item.visible ? 'Hide lane' : 'Show lane'}
      >
        {#if item.visible}<Eye size={11} />{:else}<EyeOff size={11} />{/if}
      </button>
    </span>
  </div>

  {#if item.visible}
    <div
      class="lane-plot tl-plot"
      style="left: {axisLeft}px; width: {axisWidth}px"
      role="group"
      aria-label="{item.label} events"
      use:timelineGestures={hoverTargets}
    >
      {#each marks as mark (eventKey(mark.event))}
        <button
          type="button"
          class="lane-mark"
          class:interval={mark.end > mark.start}
          class:selected={ef.selectedId === mark.event.id && ef.configuredId === mark.event.queryId}
          class:active={eventContainsTime(mark.event, vs.et)}
          class:previewed={timeline.previewEventId === eventKey(mark.event)
            || (ef.previewId === mark.event.id && ef.previewQueryId === mark.event.queryId)}
          class:partial={mark.event.state === 'partial'}
          class:full={mark.event.state === 'full'}
          class:annular={mark.event.state === 'annular'}
          data-kind={mark.event.kind}
          style="left: {mark.start * 100}%; width: {Math.max(0, mark.end - mark.start) * 100}%"
          aria-label={mark.event.label}
          onpointerdown={(e) => e.stopPropagation()}
          onclick={() => onMarkClick(mark.event)}
        ></button>
      {/each}
      {#if inView(ghostFrac)}
        <div class="ghost" style="left: {ghostFrac * 100}%"></div>
      {/if}
      {#if inView(playheadFrac)}
        <div class="playhead" style="left: {playheadFrac * 100}%"></div>
      {/if}
      {#if !wide}
        <span class="overlay-readout" class:preview={ghostFrac != null}>{readout}</span>
      {/if}
    </div>

    {#if wide}
      <div class="lane-readout" class:preview={ghostFrac != null} style="left: {axisLeft + axisWidth + 8}px" title={readout}>
        {readout}
      </div>
    {/if}
  {/if}
</div>

<style>
  .hidden-row {
    opacity: 0.55;
  }

  .lane-plot {
    position: absolute;
    top: 3px;
    bottom: 3px;
    overflow: hidden;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.025);
    cursor: crosshair;
    /* Vertical swipes scroll the lane region; see `timelineGestures`. */
    touch-action: pan-y;
    user-select: none;
  }

  /* Marks follow the track's event-marker language — same colours, same
     instant/interval/selected/active states — at lane height. */
  .lane-mark {
    position: absolute;
    top: 0;
    bottom: 0;
    min-width: 2px;
    padding: 0;
    border: 0;
    border-radius: 1px;
    background: var(--color-event-accent);
    opacity: 0.55;
    transform: translateX(-50%);
    cursor: pointer;
  }
  .lane-mark.interval {
    min-width: 4px;
    opacity: 0.72;
    transform: none;
  }
  .lane-mark:hover,
  .lane-mark.previewed {
    opacity: 1;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.55);
  }
  .lane-mark.selected {
    opacity: 1;
    box-shadow: inset 0 0 0 1px var(--color-text-primary);
  }
  .lane-mark.active {
    opacity: 1;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.72), 0 0 4px currentColor;
  }
  .lane-mark[data-kind='closest-approach'] { background: #72b7d8; }
  .lane-mark[data-kind='distance-range'] { background: #71b896; }
  .lane-mark[data-kind='occultation'] { background: #8c72d8; }
  .lane-mark.partial { background: #e0a84c; }
  .lane-mark.full { background: #8c72d8; }
  .lane-mark.annular { background: #d96f4c; }

  .playhead,
  .ghost {
    position: absolute;
    top: 0;
    bottom: 0;
    transform: translateX(-50%);
    pointer-events: none;
  }
  .playhead {
    width: 2px;
    background: var(--color-text-primary);
    opacity: 0.9;
  }
  .ghost {
    width: 1px;
    background: var(--color-text-secondary);
    opacity: 0.7;
  }

  .lane-readout {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    overflow: hidden;
    color: var(--color-text-secondary);
    font-size: var(--text-metadata);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .overlay-readout {
    position: absolute;
    top: 50%;
    right: 3px;
    transform: translateY(-50%);
    color: var(--color-text-secondary);
    font-size: var(--text-metadata);
    white-space: nowrap;
    pointer-events: none;
  }
  .preview {
    color: var(--color-text-muted);
  }
</style>
