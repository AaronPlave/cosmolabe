<script lang="ts">
  /**
   * The selected event, wherever it was selected — a timeline mark, a lane,
   * the scene, the Event Finder — and whether or not the Event Finder is
   * open. Selection is global state, so its detail is too.
   *
   * Compact by default: what the event is, its key metric and its time. The
   * rest (roles, state, other measurements) is one click away, from the same
   * `EventDetails` the Event Finder uses. It is the persistent counterpart of
   * the timeline's hover callout, which stays transient and brief.
   *
   * Positioned by the dock over the event's place on the track, in a
   * page-level layer (fixed, viewport coordinates), clamped by its measured
   * width.
   */
  import type { GeometryEvent } from '@cosmolabe/core';
  import { eventDuration, eventEnd, eventStart, isIntervalEvent } from '@cosmolabe/core';
  import { etToUtcString } from '../../lib/viewer-state.svelte';
  import { clearSelection, openConfiguredQuery } from '../../lib/event-finder.svelte';
  import { configuredItem } from '../../lib/analysis.svelte';
  import { eventCalloutTitle, formatMetric, formatSeconds, headlineMetric, utcSpan } from '../../lib/event-query';
  import { openTool } from '../../lib/shell.svelte';
  import { ChevronDown, ChevronUp, X } from 'lucide-svelte';
  import EventDetails from '../EventDetails.svelte';

  interface Props {
    event: GeometryEvent;
    /** Viewport x to centre on: the event's place on the track. */
    x: number;
    /** Distance from the viewport's bottom edge to sit above, px. */
    bottom: number;
  }

  let { event, x, bottom }: Props = $props();

  let open = $state(false);
  let width = $state(0);

  const title = $derived(eventCalloutTitle(event));
  const headline = $derived(headlineMetric(event));
  const category = $derived(configuredItem(event.queryId)?.label);
  const utc = (et: number) => etToUtcString(et);
  const left = $derived.by(() => {
    const half = (width || 280) / 2;
    return Math.max(half + 8, Math.min(window.innerWidth - half - 8, x));
  });

  function edit() {
    openConfiguredQuery(event.queryId);
    openTool('events');
  }

  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }
</script>

<div
  use:portal
  class="inspector"
  style="left: {left}px; bottom: {bottom}px"
  bind:clientWidth={width}
  role="region"
  aria-label="Selected event"
  data-scene-occluder
>
  <div class="head">
    <span class="glyph" data-ev-kind={event.kind} data-ev-state={event.state}></span>
    <span class="title">{title}</span>
    <button class="icon" onclick={clearSelection} aria-label="Clear selection" title="Clear selection (Esc)">
      <X size={13} />
    </button>
  </div>
  {#if headline}
    <div class="metric"><span class="ui-label">{headline.label}</span><span class="value">{formatMetric(headline)}</span></div>
  {/if}
  <div class="when">
    {#if isIntervalEvent(event)}
      <span>{utcSpan(eventStart(event), eventEnd(event), utc)}</span>
      <span class="duration">{formatSeconds(eventDuration(event))}</span>
    {:else}
      {utc(eventStart(event))}
    {/if}
  </div>
  {#if open}
    <div class="details"><EventDetails {event} /></div>
  {/if}
  <div class="actions">
    <button class="link" onclick={() => open = !open} aria-expanded={open}>
      {#if open}<ChevronUp size={11} /> Less{:else}<ChevronDown size={11} /> Details{/if}
    </button>
    <button class="link" onclick={edit} title={category ? `Edit “${category}” in Event Finder` : 'Open in Event Finder'}>
      Edit category
    </button>
  </div>
</div>

<style>
  .inspector {
    position: fixed;
    z-index: calc(var(--tl-z-callout) - 1);
    width: max-content;
    min-width: 220px;
    max-width: min(340px, calc(100vw - 16px));
    padding: 7px 9px 5px;
    border: 1px solid var(--color-chrome-border);
    border-radius: 5px;
    background: var(--color-panel);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
    font-family: var(--font-sans);
    transform: translateX(-50%);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .glyph {
    flex-shrink: 0;
    width: 8px;
    height: 8px;
    border-radius: 1px;
    background: var(--ev);
  }
  .title {
    flex: 1;
    min-width: 0;
    color: var(--color-text-primary);
    font-size: var(--text-section);
    font-weight: 560;
  }
  .icon {
    display: flex;
    margin: -3px -5px -3px 0;
    padding: 3px;
    border: none;
    border-radius: 3px;
    background: none;
    color: var(--color-text-muted);
    cursor: pointer;
  }
  .icon:hover {
    color: var(--color-text-primary);
    background: var(--color-control-hover);
  }
  .metric {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-top: 3px;
  }
  .value {
    color: var(--color-text-primary);
    font-family: var(--font-mono);
    font-size: var(--text-readout);
    font-variant-numeric: tabular-nums;
  }
  .when {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-top: 1px;
    color: var(--color-text-secondary);
    font-family: var(--font-mono);
    font-size: var(--text-metadata);
    font-variant-numeric: tabular-nums;
  }
  .duration {
    flex-shrink: 0;
    color: var(--color-text-muted);
  }
  .details {
    margin-top: 5px;
    padding-top: 5px;
    border-top: 1px solid var(--color-border);
  }
  .actions {
    display: flex;
    justify-content: space-between;
    margin-top: 4px;
  }
  .link {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 0;
    border: none;
    background: none;
    color: var(--color-text-muted);
    font-size: var(--text-metadata);
    cursor: pointer;
  }
  .link:hover {
    color: var(--color-text-primary);
  }
</style>
