<script lang="ts">
  /**
   * Geometry event finder.
   *
   * The panel is deliberately kind-agnostic: the body pickers come from the
   * selected kind's declared roles and the inputs from its declared params, so
   * the occultation, eclipse and FOV kinds that follow appear here without the
   * panel growing a branch for each. Only the results list knows anything
   * concrete, and only that an event has a time, a label and metrics.
   */
  import { Loader2, Search, Ban } from 'lucide-svelte';
  import * as Select from '$lib/components/ui/select/index.js';
  import { eventStart, eventDuration, isIntervalEvent, type GeometryEvent } from '@cosmolabe/core';
  import { vs, etToUtcString } from '../lib/viewer-state.svelte';
  import { toolDef } from '../lib/shell.svelte';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';
  import { getSpice } from '../lib/loader';
  import {
    EVENT_KINDS, cancelSearch, ef, clearSelection, currentKind, resetForm, runSearch,
    selectEvent, setKind, setParam, setRole, setSort, setStep, setWindow, resetWindow,
    currentConfiguredQuery, setCurrentQueryVisible,
  } from '../lib/event-finder.svelte';
  import {
    eventSummary, faultMessage, formatMetric, formatSeconds, headlineMetric, missingRoles,
    sortEvents, sortMetricLabel,
  } from '../lib/event-query';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  // The form is built from the catalog's own time span, which is not known
  // until a scene has loaded — so it is built on mount, not at module scope.
  $effect(() => {
    if (!ef.form) resetForm();
  });

  let kind = $derived(currentKind());
  let form = $derived(ef.form);
  /** Display order is a view concern: the search's own order is chronological. */
  let shownEvents = $derived(sortEvents(ef.events, ef.sort));
  let metricSortLabel = $derived(sortMetricLabel(ef.events));
  let unfilledRoles = $derived(form ? missingRoles(kind, form) : []);
  let configured = $derived(currentConfiguredQuery());
  let canSearch = $derived(!!form && unfilledRoles.length === 0 && !ef.running);
  const eventKindItems = EVENT_KINDS.map(({ kind, label }) => ({ value: kind, label }));

  /** Window fields are edited as UTC text and only committed when they parse. */
  let startText = $state('');
  let endText = $state('');
  let startBad = $state(false);
  let endBad = $state(false);

  $effect(() => {
    if (!form) return;
    startText = etToUtcString(form.startEt).replace(' UTC', '');
    endText = etToUtcString(form.endEt).replace(' UTC', '');
  });

  function parseUtc(text: string): number | null {
    const spice = getSpice();
    if (!spice) return null;
    try {
      const et = spice.str2et(text.trim());
      return Number.isFinite(et) ? et : null;
    } catch {
      return null;
    }
  }

  function commitStart() {
    const et = parseUtc(startText);
    startBad = et === null;
    if (et !== null && form) setWindow(et, form.endEt);
  }

  function commitEnd() {
    const et = parseUtc(endText);
    endBad = et === null;
    if (et !== null && form) setWindow(form.startEt, et);
  }

  /** Snap the window to the whole catalog, or to what the scrubber shows. */
  function useRange(start: number, end: number) {
    startBad = false;
    endBad = false;
    setWindow(start, end);
  }

  const STEP_PRESETS = [
    { label: '1 min', seconds: 60 },
    { label: '10 min', seconds: 600 },
    { label: '1 hr', seconds: 3600 },
    { label: '6 hr', seconds: 21600 },
    { label: '1 day', seconds: 86400 },
  ];

  function eventTime(event: GeometryEvent): string {
    return etToUtcString(eventStart(event)).replace(' UTC', '');
  }

  /** Metrics worth a second line under a result, in the kind's own order. */
  function detailMetrics(event: GeometryEvent) {
    return (event.metrics ?? []).filter((m) => m.key !== 'duration');
  }
</script>

<InstrumentPanel key="events" title="Event finder" width={toolDef('events').width} {onClose}>

  <!-- Event type -->
  <div class="flex items-center gap-2 mb-1.5">
    <span class="ui-label w-20 shrink-0">Event</span>
    <Select.Root
      type="single"
      items={eventKindItems}
      value={ef.kind}
      onValueChange={(value) => {
        if (value !== ef.kind) setKind(value);
      }}
    >
      <Select.Trigger size="sm" class="ui-control min-w-0 flex-1 rounded border-border bg-surface-3 px-2 text-text-primary">
        <Select.Value placeholder="Select event type" />
      </Select.Trigger>
      <Select.Content align="start" class="w-[360px] max-w-[calc(100vw-24px)] rounded-md border border-border bg-panel p-1">
        {#each EVENT_KINDS as k (k.kind)}
          <Select.Item
            value={k.kind}
            label={k.label}
            class="event-kind-option items-start py-2 pr-8 [&>span:last-child]:items-start [&>span:last-child]:whitespace-normal"
          >
            <div class="flex min-w-0 flex-col gap-0.5 pr-2">
              <span class="event-kind-label ui-body font-medium text-text-primary">{k.label}</span>
              <span class="event-kind-description ui-helper whitespace-normal">{k.description}</span>
            </div>
          </Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>

  {#if form}
    <!-- Bodies, one picker per role the kind declares -->
    {#each kind.roles as role}
      <div class="flex items-center gap-2 mb-1.5">
        <span class="ui-label w-20 shrink-0">{role.label}</span>
        <select
          class="ui-control flex-1 bg-surface-3 text-text-primary border border-border rounded px-1.5 py-1 cursor-pointer outline-none"
          value={form.bodies[role.role] ?? ''}
          onchange={(e) => setRole(role.role, (e.target as HTMLSelectElement).value)}
        >
          <option value="">Select body...</option>
          {#each vs.bodies as body}
            <option value={body.name}>{body.name}{body.name === vs.trackedBodyName ? ' (tracked)' : ''}</option>
          {/each}
        </select>
      </div>
    {/each}

    <!-- Kind-specific parameters -->
    {#each kind.params ?? [] as param}
      <div class="flex items-center gap-2 mb-1.5">
        <span class="ui-label w-20 shrink-0" title={param.help}>{param.label}</span>
        {#if param.kind === 'choice'}
          <select
            class="ui-control flex-1 bg-surface-3 text-text-primary border border-border rounded px-1.5 py-1 cursor-pointer outline-none"
            value={form.params[param.key] ?? ''}
            onchange={(e) => setParam(param.key, (e.target as HTMLSelectElement).value)}
          >
            {#each param.options as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        {:else if param.kind === 'boolean'}
          <input
            type="checkbox"
            class="accent-accent"
            checked={form.params[param.key] === 'true'}
            onchange={(e) => setParam(param.key, (e.target as HTMLInputElement).checked ? 'true' : 'false')}
          />
        {:else}
          <input
            type="number"
            class="ui-control flex-1 bg-surface-3 text-text-primary border border-border rounded px-1.5 py-1 font-mono outline-none"
            placeholder={param.required === false ? 'optional' : ''}
            min={param.min}
            max={param.max}
            step={param.increment}
            value={form.params[param.key] ?? ''}
            oninput={(e) => setParam(param.key, (e.target as HTMLInputElement).value)}
          />
          {#if param.unit}<span class="ui-meta w-6">{param.unit}</span>{/if}
        {/if}
      </div>
    {/each}

    <!-- Search window -->
    <div class="flex items-center gap-2 mb-1.5">
      <span class="ui-label w-20 shrink-0">From</span>
      <input
        class="ui-control flex-1 bg-surface-3 text-text-primary border rounded px-1.5 py-1 font-mono outline-none
               {startBad ? 'border-warning' : 'border-border'}"
        bind:value={startText}
        onblur={commitStart}
        onkeydown={(e) => { if (e.key === 'Enter') commitStart(); }}
      />
    </div>
    <div class="flex items-center gap-2 mb-1.5">
      <span class="ui-label w-20 shrink-0">To</span>
      <input
        class="ui-control flex-1 bg-surface-3 text-text-primary border rounded px-1.5 py-1 font-mono outline-none
               {endBad ? 'border-warning' : 'border-border'}"
        bind:value={endText}
        onblur={commitEnd}
        onkeydown={(e) => { if (e.key === 'Enter') commitEnd(); }}
      />
    </div>
    <div class="flex items-center gap-2 mb-2">
      <span class="ui-label w-20 shrink-0">Step</span>
      <select
        class="ui-control flex-1 bg-surface-3 text-text-primary border border-border rounded px-1.5 py-1 cursor-pointer outline-none"
        value={String(form.step)}
        onchange={(e) => setStep(Number((e.target as HTMLSelectElement).value))}
        title="Sampling interval. An event shorter than the step can be missed."
      >
        {#each STEP_PRESETS as preset}
          <option value={String(preset.seconds)}>{preset.label}</option>
        {/each}
        {#if !STEP_PRESETS.some((p) => p.seconds === form.step)}
          <option value={String(form.step)}>{formatSeconds(form.step)}</option>
        {/if}
      </select>
      <button class="ctrl-link shrink-0" onclick={() => useRange(vs.scrubBaseMin, vs.scrubBaseMax)}>all</button>
      <button class="ctrl-link shrink-0" onclick={() => useRange(vs.scrubMin, vs.scrubMax)}>visible</button>
    </div>

    <!-- Say when the window is not simply the catalog's span, so a default that
         differs from the scrubber is explained rather than merely odd. -->
    {#if ef.windowTrimmed}
      <p class="ui-helper event-helper mb-2 ml-22">
        Trimmed to the kernel coverage of the chosen bodies.
      </p>
    {:else if ef.windowPinned}
      <p class="ui-helper event-helper mb-2 ml-22">
        Using your window. <button class="ctrl-link underline" onclick={resetWindow}>Reset to kernel coverage</button>
      </p>
    {/if}

    <!-- Run. A long search is survivable now that it runs off the main thread,
         so it is also worth being able to give up on. -->
    <div class="flex items-center gap-1.5">
      <button
        class="ui-control flex-1 flex items-center justify-center gap-1.5 rounded border border-border bg-surface-3 px-2 py-1.5 text-text-primary
               hover:border-accent disabled:opacity-40 disabled:hover:border-border transition-colors cursor-pointer"
        disabled={!canSearch}
        onclick={runSearch}
      >
        {#if ef.running}
          <Loader2 size={12} class="animate-spin" /> Searching…
        {:else}
          <Search size={12} /> Find events
        {/if}
      </button>
      {#if ef.running}
        <button
          class="ui-control flex items-center justify-center gap-1.5 rounded border border-border bg-surface-3 px-2 py-1.5 text-text-secondary
                 hover:border-accent hover:text-text-primary transition-colors cursor-pointer"
          onclick={cancelSearch}
          title="Stop this search"
        >
          <Ban size={12} /> Cancel
        </button>
      {/if}
    </div>

    {#if configured}
      <div class="mt-1.5 flex items-center ui-helper">
        <label class="flex items-center gap-1 cursor-pointer" title="Show this query's results on the shared timeline">
          <input
            type="checkbox"
            class="accent-accent"
            checked={configured.visible}
            onchange={(e) => setCurrentQueryVisible((e.target as HTMLInputElement).checked)}
          />
          Timeline
        </label>
      </div>
    {/if}

    {#if unfilledRoles.length > 0}
      <div class="ui-label mt-1.5">
        Choose a body for {kind.roles.filter((r) => unfilledRoles.includes(r.role)).map((r) => r.label.toLowerCase()).join(' and ')}.
      </div>
    {/if}
  {/if}

  <!-- Results -->
  {#if ef.fault}
    <!-- A fault is "we could not look", which reads differently from a search
         that ran and matched nothing. -->
    <div class="ui-label mt-2 pt-2 border-t border-border text-warning">
      {faultMessage(ef.fault)}
    </div>
  {:else if ef.searched && ef.events.length === 0}
    <div class="ui-label mt-2 pt-2 border-t border-border">
      <p>No matching events in this window.</p>
      {#if ef.hint}
        <!-- The kind turning "nothing matched" into an actual measurement. -->
        <p class="mt-1 text-text-secondary">{ef.hint}</p>
      {/if}
      <p class="mt-1">Try a wider window, a looser condition, or a shorter step.</p>
    </div>
  {:else if ef.events.length > 0}
    <div class="mt-2 pt-2 border-t border-border">
      <div class="flex items-center justify-between gap-2 mb-1">
        <span class="ui-section-label">
          {ef.events.length} event{ef.events.length === 1 ? '' : 's'}
        </span>
        <div class="flex items-center gap-1.5">
          {#if metricSortLabel}
            <span class="ui-meta">sort</span>
            <button
              class="ctrl-link {ef.sort === 'time' ? 'text-text-primary' : ''}"
              onclick={() => setSort('time')}
            >time</button>
            <button
              class="ctrl-link {ef.sort === 'metric' ? 'text-text-primary' : ''}"
              onclick={() => setSort('metric')}
              title="Smallest first"
            >{metricSortLabel}</button>
          {/if}
          {#if ef.selectedId}
            <button class="ctrl-link" onclick={clearSelection}>clear</button>
          {/if}
        </div>
      </div>
      <div class="flex flex-col gap-1 max-h-64 overflow-y-auto">
        {#each shownEvents as event}
          {@const headline = headlineMetric(event)}
          <button
            class="event-result text-left rounded px-2 py-2 border cursor-pointer"
            class:selected={ef.selectedId === event.id}
            onclick={() => selectEvent(event)}
            title={event.label}
          >
            <div class="flex justify-between gap-2 items-baseline">
              <span class="ui-readout event-time">{eventTime(event)}</span>
              <!-- A bare "2.5 d" beside a date reads as an offset from it.
                   Say which quantity it is. -->
              <span
                class="ui-meta"
                title={isIntervalEvent(event)
                  ? 'How long this event lasted, start to end'
                  : 'This event is a single instant, not a span'}
              >
                {isIntervalEvent(event) ? `lasts ${formatSeconds(eventDuration(event))}` : 'instant'}
              </span>
            </div>
            {#if headline}
              <div class="event-summary">
                <span>{headline.label}</span>
                <span class="ui-readout event-value">{formatMetric(headline)}</span>
              </div>
            {:else}
              <div class="event-summary">{eventSummary(event)}</div>
            {/if}
            {#if ef.selectedId === event.id}
              <div class="mt-1 flex flex-col gap-0.5">
                {#if detailMetrics(event).length === 0}
                  <!-- A closest approach with no range is a thin answer; say the
                       measurement is missing rather than showing a blank. -->
                  <div class="ui-helper">
                    No measurements — this SPICE provider cannot report distances.
                  </div>
                {/if}
                {#each detailMetrics(event) as metric}
                  <div class="ui-data-row">
                    <span class="ui-label">{metric.label}</span>
                    <span class="ui-readout">{formatMetric(metric)}</span>
                  </div>
                {/each}
                {#if isIntervalEvent(event)}
                  <div class="ui-data-row">
                    <span class="ui-label">Duration</span>
                    <span class="ui-readout">{formatSeconds(eventDuration(event))}</span>
                  </div>
                  <div class="ui-data-row">
                    <span class="ui-label">Ends</span>
                    <span class="ui-readout">{etToUtcString(event.end).replace(' UTC', '')}</span>
                  </div>
                {/if}
              </div>
            {/if}
          </button>
        {/each}
      </div>
    </div>
  {/if}
</InstrumentPanel>

<style>
  /* Matches the measure tool's inline text controls. */
  .ctrl-link {
    font-size: 10px;
    color: var(--color-text-muted);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    transition: color 0.1s;
  }
  .ctrl-link:hover {
    color: var(--color-text-primary);
  }

  .event-result {
    border-color: transparent;
    background: transparent;
    transition:
      border-color var(--duration-chrome) var(--ease-chrome),
      background var(--duration-chrome) var(--ease-chrome);
  }
  .event-result:focus-visible {
    border-color: var(--color-primary-accent);
  }
  .event-result:hover {
    background: var(--color-hover);
  }
  .event-result.selected {
    border-color: color-mix(in srgb, var(--color-event-accent) 52%, transparent);
    background: color-mix(in srgb, var(--color-event-accent) 8%, transparent);
  }
  .event-summary {
    margin-top: 1px;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-ui-3);
    font-family: var(--font-sans);
    font-size: var(--text-label);
    color: var(--color-text-secondary);
  }
  .event-time {
    font-weight: 590;
  }
  .event-value {
    font-weight: 500;
    color: var(--color-text-secondary);
  }
  .event-helper {
    color: var(--color-text-faint);
  }
  .event-helper .ctrl-link {
    font-size: inherit;
  }
  :global(.event-kind-option:is(:focus, [data-highlighted])) {
    background: var(--color-control-hover);
    color: var(--color-text-primary);
  }
  :global(.event-kind-option:is(:focus, [data-highlighted]) .event-kind-label) {
    color: var(--color-text-primary);
  }
  :global(.event-kind-option:is(:focus, [data-highlighted]) .event-kind-description) {
    color: var(--color-text-secondary);
  }
</style>
