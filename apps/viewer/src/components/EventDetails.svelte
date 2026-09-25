<script lang="ts">
  /**
   * The detail of one event result: its state, who takes part in which role,
   * its measurements and, for an interval, when it starts and ends and how
   * long it lasts. One component for every place a selected event is
   * inspected — the Event Finder's selected row and the global selected-event
   * inspector — so they cannot drift apart.
   *
   * The headline metric is the caller's (it leads the row or the inspector),
   * so it is left out here rather than repeated.
   */
  import type { GeometryEvent } from '@cosmolabe/core';
  import { eventDuration, eventEnd, eventStart, isIntervalEvent } from '@cosmolabe/core';
  import { etToUtcString } from '../lib/viewer-state.svelte';
  import { EVENT_KINDS, ef, selectEvent } from '../lib/event-finder.svelte';
  import { formatMetric, formatSeconds, headlineMetric } from '../lib/event-query';

  interface Props {
    event: GeometryEvent;
    /** Include the start (the Event Finder's row already leads with it). */
    showStart?: boolean;
    /** The occultation's 3D geometry legend. */
    legend?: boolean;
  }

  let { event, showStart = false, legend = false }: Props = $props();

  const roles = $derived(EVENT_KINDS.find((k) => k.kind === event.kind)?.roles ?? []);
  const roleLabel = (role: string) => roles.find((spec) => spec.role === role)?.label ?? role;
  const headline = $derived(headlineMetric(event));
  // Duration has its own row below; the headline leads elsewhere.
  const metrics = $derived((event.metrics ?? []).filter((m) => m.key !== 'duration' && m.key !== headline?.key));
  const utc = (et: number) => etToUtcString(et).replace(' UTC', '');

  function seekEnd(e: Event) {
    e.stopPropagation();
    selectEvent(event, 'end');
  }
</script>

<div class="event-details flex flex-col gap-0.5">
  {#if event.state}
    <div class="ui-data-row">
      <span class="ui-label">State</span>
      <span class="ui-readout capitalize">{event.state}</span>
    </div>
  {/if}
  {#if legend && event.kind === 'occultation' && ef.activeId === event.id && ef.activeQueryId === event.queryId}
    <div class="geometry-legend ui-helper" aria-label="3D geometry legend">
      <span><i class="legend-line sightline"></i>{event.bodies.back?.toLowerCase() === 'sun' ? 'Observer sightline' : 'Background line of sight'}</span>
      {#if event.bodies.back?.toLowerCase() === 'sun'}
        <span><i class="legend-fill inner-shadow"></i>Umbra / antumbra boundary</span>
        <span><i class="legend-line penumbra"></i>Penumbra boundary</span>
        <small>End rings are shadow cross-sections at the {event.bodies.observer} plane; volumes are to scale.</small>
      {:else}
        <span><i class="legend-line tangent-guide"></i>Tangent guides</span>
        <span><i class="legend-fill inner-shadow"></i>Occulted region</span>
        <small>Guides converge at {event.bodies.observer}; shading begins where they touch the {event.bodies.front} limb.</small>
      {/if}
    </div>
  {:else if legend && event.kind === 'occultation'}
    <div class="geometry-standby ui-helper">
      3D geometry follows the event under the playhead.
    </div>
  {/if}
  {#each Object.entries(event.bodies) as [role, body]}
    <div class="ui-data-row">
      <span class="ui-label">{roleLabel(role)}</span>
      <span class="ui-readout">{body}</span>
    </div>
  {/each}
  {#if !event.metrics?.length}
    <!-- A closest approach with no range is a thin answer; say the
         measurement is missing rather than showing a blank. -->
    <div class="ui-helper">
      No measurements — this SPICE provider cannot report distances.
    </div>
  {/if}
  {#each metrics as metric}
    <div class="ui-data-row">
      <span class="ui-label">{metric.label}</span>
      <span class="ui-readout">{formatMetric(metric)}</span>
    </div>
  {/each}
  {#if isIntervalEvent(event)}
    {#if showStart}
      <div class="ui-data-row">
        <span class="ui-label">Starts</span>
        <span class="ui-readout">{utc(eventStart(event))}</span>
      </div>
    {/if}
    <div class="ui-data-row">
      <span class="ui-label">Ends</span>
      <span
        class="ctrl-link ui-readout"
        role="button"
        tabindex="0"
        title="Go to the end"
        onclick={seekEnd}
        onkeydown={(key) => {
          if (key.key === 'Enter' || key.key === ' ') {
            key.preventDefault();
            seekEnd(key);
          }
        }}
      >
        {utc(eventEnd(event))}
      </span>
    </div>
    <div class="ui-data-row">
      <span class="ui-label">Duration</span>
      <span class="ui-readout">{formatSeconds(eventDuration(event))}</span>
    </div>
  {:else if showStart}
    <div class="ui-data-row">
      <span class="ui-label">Time</span>
      <span class="ui-readout">{utc(eventStart(event))}</span>
    </div>
  {/if}
</div>

<style>
  .geometry-standby {
    margin: 3px 0 2px;
    padding: 4px 6px;
    border-left: 1px solid color-mix(in srgb, var(--color-event-accent) 52%, transparent);
  }
  .geometry-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 3px 10px;
    margin: 3px 0 2px;
    padding: 5px 6px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--color-surface-3) 58%, transparent);
  }
  .geometry-legend span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .geometry-legend small {
    flex-basis: 100%;
    color: var(--color-text-faint);
    font-size: inherit;
    line-height: 1.3;
  }
  .legend-line,
  .legend-fill {
    display: inline-block;
    width: 12px;
    height: 2px;
    border-radius: 1px;
  }
  .legend-line.sightline { background: #7cc7e8; }
  .legend-line.penumbra { background: #e0a84c; }
  .legend-line.tangent-guide { background: #8c72d8; }
  .legend-fill.inner-shadow {
    height: 7px;
    border: 1px solid #8c72d8;
    background: color-mix(in srgb, #8c72d8 22%, transparent);
  }
  .ctrl-link {
    color: var(--color-text-muted);
    cursor: pointer;
    transition: color 0.1s;
  }
  .ctrl-link:hover {
    color: var(--color-text-primary);
  }
</style>
