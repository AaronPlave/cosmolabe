<script lang="ts">
  /**
   * One configured event query as a lane on the timeline — the middle depth
   * between the transport strip and the continuous profiles.
   *
   * The transport track is an overview of every visible result; a lane
   * separates one query's results onto its own row, on the same axis, so
   * families can be read, compared and hidden independently. Hiding a lane
   * flips the query's shared `visible` flag, which the track, the event
   * finder and this lane all read, so no surface disagrees about it.
   *
   * The lane draws marks only. Hover, the ghost and playhead lines, seeking
   * and panning belong to the dock's one interaction surface; clicking a mark
   * goes through `selectEvent`, the same call the track's marks make.
   */
  import type { ConfiguredEventQuery, GeometryEvent } from '@cosmolabe/core';
  import { eventDuration } from '@cosmolabe/core';
  import { vs } from '../../lib/viewer-state.svelte';
  import { analysis } from '../../lib/analysis.svelte';
  import {
    ef, selectEvent, setConfiguredQueryVisible, removeConfiguredQuery, openConfiguredQuery,
    EVENT_KINDS, isSelectedEvent,
  } from '../../lib/event-finder.svelte';
  import {
    activeEventsAtTime, eventContainsTime, eventTimelineFractions, formatSeconds,
  } from '../../lib/event-query';
  import { timeline, eventKey, ghostEt, TL_HEAD_PX } from '../../lib/timeline.svelte';
  import { openTool } from '../../lib/shell.svelte';
  import { Eye, EyeOff, Trash2 } from 'lucide-svelte';
  import PlotCursor from './PlotCursor.svelte';

  interface Props {
    item: ConfiguredEventQuery;
    /**
     * Desktop: a label gutter and a readout rail around the axis. Otherwise
     * (a phone) the row stacks: a header line — label, readout, controls —
     * over a full-width track.
     */
    wide: boolean;
  }

  let { item, wide }: Props = $props();

  /** Lanes are categorical and stay compact; profiles get the height. */
  const H = $derived(wide ? 20 : TL_HEAD_PX + 22);
  const rowId = $derived(`lane:${item.id}`);

  const events = $derived<readonly GeometryEvent[]>(analysis.eventResults[item.id] ?? []);

  const marks = $derived.by(() => {
    if (!item.visible) return [];
    const range = { start: vs.scrubMin, end: vs.scrubMax };
    return events.flatMap((event) => {
      const span = eventTimelineFractions(event, range);
      return span ? [{ event, start: span.start, end: span.end }] : [];
    });
  });

  // Label: what the lane finds, then between whom. A default query label
  // ("Closest approach: Earth / Mars") repeats the bodies the secondary text
  // already names, so it is cut back to the kind.
  const relation = $derived.by(() => {
    const b = item.query.bodies ?? {};
    if (b.observer && b.target) return `${b.observer} → ${b.target}`;
    if (b.front && b.back) return b.observer ? `${b.front} / ${b.back} from ${b.observer}` : `${b.front} / ${b.back}`;
    return '';
  });
  // The timeline favours scanability: a default label's kind name gets its
  // short form here ("Range", not "Distance / range"); the Event Finder keeps
  // the explicit one. A label the user wrote is left alone.
  const SHORT_KIND: Record<string, string> = {
    'distance-range': 'Range',
    occultation: 'Occultation',
  };
  const title = $derived.by(() => {
    const cut = item.label.indexOf(': ');
    const suffix = cut > 0 ? item.label.slice(cut + 2) : '';
    const bodies = Object.values(item.query.bodies ?? {}).join(' / ');
    const base = cut > 0 && suffix === bodies ? item.label.slice(0, cut) : item.label;
    const kindLabel = EVENT_KINDS.find((k) => k.kind === item.query.kind)?.label;
    return base === kindLabel ? SHORT_KIND[item.query.kind] ?? base : base;
  });

  const isSelected = isSelectedEvent;
  const isPreviewed = (event: GeometryEvent) =>
    timeline.previewEventId === eventKey(event)
    || (ef.previewId === event.id && ef.previewQueryId === event.queryId);

  // Rail: compact state at the inspected instant — never an event's name,
  // which the callout, the selection and the list carry. Every event the
  // instant is inside counts; none is "the" active one.
  const inspected = $derived(ghostEt());
  const active = $derived(item.visible ? activeEventsAtTime(events, inspected ?? vs.et) : []);
  const readout = $derived.by(() => {
    if (active.length > 1) return { text: `${active.length} active`, value: true };
    if (active.length === 1) {
      const d = eventDuration(active[0]);
      return { text: d > 0 ? formatSeconds(d) : 'Active', value: true };
    }
    return { text: `${events.length} ${events.length === 1 ? 'event' : 'events'}`, value: false };
  });

  // The label opens this category in the Event Finder, to browse or edit.
  // That changes what the form edits, not what is selected.
  function edit() {
    if (ef.configuredId !== item.id) openConfiguredQuery(item.id);
    openTool('events');
  }

  // The lane rises a little while one of its events is selected or previewed.
  const emphasised = $derived(marks.some((m) => isSelected(m.event) || isPreviewed(m.event)));
</script>

<div
  class="tl-row event-lane"
  class:stacked={!wide}
  class:hidden-row={!item.visible}
  class:inspected={timeline.hoverRow === rowId}
  class:emphasised
  data-tl-row={rowId}
  style="height: {item.visible ? H : TL_HEAD_PX}px"
>
  <!-- One grammar for every row: the label opens it for editing, the eye
       shows or hides it, the trash removes it. -->
  <div class="tl-label">
    <button
      class="tl-label-main"
      onclick={edit}
      title="{relation ? `${title} · ${relation}` : title} — edit in Event Finder"
    >
      <span class="tl-primary">{title}</span>
      {#if relation}<span class="tl-secondary">{relation}</span>{/if}
    </button>
    <span class="tl-label-controls">
      <button
        class="tl-icon-btn"
        onclick={() => setConfiguredQueryVisible(item.id, !item.visible)}
        aria-label={item.visible ? `Hide ${item.label} lane` : `Show ${item.label} lane`}
        title={item.visible ? 'Hide lane' : 'Show lane'}
      >
        {#if item.visible}<Eye size={wide ? 11 : 13} />{:else}<EyeOff size={wide ? 11 : 13} />{/if}
      </button>
      <button
        class="tl-icon-btn danger"
        onclick={() => removeConfiguredQuery(item.id)}
        aria-label="Remove {item.label}"
        title="Remove category"
      >
        <Trash2 size={wide ? 11 : 13} />
      </button>
    </span>
  </div>

  {#if item.visible}
    <div class="tl-plot lane-plot" data-tl-plot role="group" aria-label="{item.label} events">
      {#each marks as mark (eventKey(mark.event))}
        <button
          type="button"
          class="lane-mark"
          class:interval={mark.end > mark.start}
          class:selected={isSelected(mark.event)}
          class:active={eventContainsTime(mark.event, vs.et)}
          class:previewed={isPreviewed(mark.event)}
          data-ev-kind={mark.event.kind}
          data-ev-state={mark.event.state}
          style="left: {mark.start * 100}%; width: {Math.max(0, mark.end - mark.start) * 100}%"
          aria-label={mark.event.label}
          onclick={() => selectEvent(mark.event)}
        ></button>
      {/each}
      {#if !wide}<PlotCursor />{/if}
    </div>
  {/if}

  <div class="tl-readout">
    {#if readout.value && item.visible}
      <span class="tl-num" class:preview={inspected != null}>{readout.text}</span>
    {:else}
      <span class="tl-secondary">{readout.text}</span>
    {/if}
  </div>
</div>

<style>
  /* Inset inside the row's own allocation: the plot stretches to its grid
     cell, so these margins shrink it rather than push past the row. */
  .lane-plot {
    margin-block: 3px;
    border-radius: 2px;
  }

  /* Marks speak the shared event vocabulary (`--ev`): an instant is a line,
     an interval a span. Active, selected and previewed raise them; several
     can be active at once. */
  .lane-mark {
    position: absolute;
    top: 0;
    bottom: 0;
    min-width: 2px;
    padding: 0;
    border: 0;
    border-radius: 1px;
    background: var(--ev);
    opacity: 0.55;
    transform: translateX(-50%);
    cursor: pointer;
  }
  .lane-mark.interval {
    min-width: 4px;
    opacity: 0.62;
    transform: none;
  }
  .lane-mark.active {
    opacity: 0.9;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.45);
  }
  .lane-mark:hover,
  .lane-mark.previewed {
    z-index: 1;
    opacity: 1;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.55);
  }
  .lane-mark.selected {
    z-index: 2;
    opacity: 1;
    box-shadow: inset 0 0 0 1px var(--color-text-primary), 0 0 4px var(--ev);
  }

</style>
