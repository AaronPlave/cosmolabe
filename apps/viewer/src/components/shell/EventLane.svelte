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
  import { timeline, timelineFraction, timelineGestures } from '../../lib/timeline.svelte';
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

  const snapTargets = $derived(
    marks.flatMap((m) => m.end > m.start
      ? [{ fraction: m.start, id: m.event.id }, { fraction: m.end, id: m.event.id }]
      : [{ fraction: m.start, id: m.event.id }]),
  );

  const playheadFrac = $derived(timelineFraction(vs.et));
  const ghostFrac = $derived(timeline.hoverEt == null ? null : timelineFraction(timeline.hoverEt));
  const inView = (f: number | null): f is number => f != null && f >= 0 && f <= 1;

  // Readout: the event under the ghost (or the playhead), else the count.
  const readoutEt = $derived(timeline.hoverEt ?? vs.et);
  const current = $derived(item.visible ? activeEventAtTime(events, readoutEt, ef.selectedId) : undefined);
  const readout = $derived(current ? current.label : `${events.length} ${events.length === 1 ? 'event' : 'events'}`);

  function onMarkClick(event: GeometryEvent) {
    selectEvent(event);
  }
</script>

<div class="event-lane" class:hidden-row={!item.visible} style="height: {item.visible ? H : 18}px">
  <div
    class="lane-label"
    class:overlay={!wide}
    style={wide
      ? `left: 0; width: ${Math.max(0, axisLeft - 8)}px`
      : `left: ${axisLeft + 3}px; max-width: ${Math.max(0, axisWidth * 0.5)}px`}
  >
    <span class="label-text" title={item.label}>{item.label}</span>
    <button
      class="eye-btn"
      onclick={() => setConfiguredQueryVisible(item.id, !item.visible)}
      aria-label={item.visible ? `Hide ${item.label} lane` : `Show ${item.label} lane`}
      title={item.visible ? 'Hide lane' : 'Show lane'}
    >
      {#if item.visible}<Eye size={11} />{:else}<EyeOff size={11} />{/if}
    </button>
  </div>

  {#if item.visible}
    <div
      class="lane-plot"
      style="left: {axisLeft}px; width: {axisWidth}px"
      role="group"
      aria-label="{item.label} events"
      use:timelineGestures={{ snapTargets }}
    >
      {#each marks as mark (mark.event.id)}
        <button
          type="button"
          class="lane-mark"
          class:interval={mark.end > mark.start}
          class:selected={ef.selectedId === mark.event.id}
          class:active={eventContainsTime(mark.event, vs.et)}
          class:previewed={timeline.previewEventId === mark.event.id}
          class:partial={mark.event.state === 'partial'}
          class:full={mark.event.state === 'full'}
          class:annular={mark.event.state === 'annular'}
          data-kind={mark.event.kind}
          style="left: {mark.start * 100}%; width: {Math.max(0, mark.end - mark.start) * 100}%"
          title={mark.event.label}
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
  .event-lane {
    position: relative;
    border-top: 1px solid var(--color-chrome-divider);
  }
  .hidden-row {
    opacity: 0.55;
  }

  .lane-label {
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
  .lane-label.overlay {
    justify-content: flex-start;
  }
  .label-text {
    overflow: hidden;
    padding: 0 4px;
    color: var(--color-text-secondary);
    font-size: var(--text-metadata);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .eye-btn {
    display: flex;
    flex-shrink: 0;
    padding: 3px;
    border: none;
    border-radius: 3px;
    background: none;
    color: var(--color-text-muted);
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--duration-chrome) var(--ease-chrome);
  }
  .event-lane:hover .eye-btn,
  .hidden-row .eye-btn,
  .eye-btn:focus-visible {
    opacity: 1;
  }
  .eye-btn:hover {
    color: var(--color-text-primary);
  }

  .lane-plot {
    position: absolute;
    top: 3px;
    bottom: 3px;
    overflow: hidden;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.025);
    cursor: crosshair;
    touch-action: none;
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
