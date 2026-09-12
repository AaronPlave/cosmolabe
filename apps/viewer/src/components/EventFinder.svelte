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
  import { X, Loader2, Search } from 'lucide-svelte';
  import { eventStart, eventDuration, isIntervalEvent, type GeometryEvent } from '@cosmolabe/core';
  import { vs, etToUtcString } from '../lib/viewer-state.svelte';
  import { getSpice } from '../lib/loader';
  import {
    EVENT_KINDS, ef, clearSelection, currentKind, resetForm, runSearch,
    selectEvent, setKind, setParam, setRole, setSort, setStep, setWindow,
  } from '../lib/event-finder.svelte';
  import {
    eventSummary, faultMessage, formatMetric, formatSeconds, missingRoles,
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
  let canSearch = $derived(!!form && unfilledRoles.length === 0 && !ef.running);

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

<div class="absolute top-3 left-3 z-15 bg-black/90 backdrop-blur-md border border-border rounded-lg p-3 w-96 text-[12px] animate-fade-in">
  <div class="flex items-center justify-between mb-2">
    <span class="text-text-secondary text-[10px] uppercase tracking-wider font-semibold">Event finder</span>
    <button class="bg-transparent border-none text-text-muted cursor-pointer p-0.5 rounded hover:text-text-primary transition-colors" onclick={onClose}>
      <X size={13} />
    </button>
  </div>

  <!-- Event type -->
  <div class="flex items-center gap-2 mb-1.5">
    <span class="text-text-muted text-[11px] w-20 shrink-0">Event</span>
    <select
      class="flex-1 bg-surface-3 text-text-primary border border-border rounded px-1.5 py-1 text-[11px] cursor-pointer outline-none"
      value={ef.kind}
      onchange={(e) => setKind((e.target as HTMLSelectElement).value)}
    >
      {#each EVENT_KINDS as k}
        <option value={k.kind}>{k.label}</option>
      {/each}
    </select>
  </div>

  <!-- What the selected kind actually searches for. Its own words: the panel
       cannot write this sentence for a kind it has never heard of. -->
  {#if kind.description}
    <p class="text-[10px] text-text-muted leading-snug mb-2 ml-22">{kind.description}</p>
  {/if}

  {#if form}
    <!-- Bodies, one picker per role the kind declares -->
    {#each kind.roles as role}
      <div class="flex items-center gap-2 mb-1.5">
        <span class="text-text-muted text-[11px] w-20 shrink-0">{role.label}</span>
        <select
          class="flex-1 bg-surface-3 text-text-primary border rounded px-1.5 py-1 text-[11px] cursor-pointer outline-none
                 {unfilledRoles.includes(role.role) ? 'border-warning' : 'border-border'}"
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
        <span class="text-text-muted text-[11px] w-20 shrink-0" title={param.help}>{param.label}</span>
        {#if param.kind === 'choice'}
          <select
            class="flex-1 bg-surface-3 text-text-primary border border-border rounded px-1.5 py-1 text-[11px] cursor-pointer outline-none"
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
            class="flex-1 bg-surface-3 text-text-primary border border-border rounded px-1.5 py-1 text-[11px] font-mono outline-none"
            placeholder={param.required === false ? 'optional' : ''}
            min={param.min}
            max={param.max}
            step={param.increment}
            value={form.params[param.key] ?? ''}
            oninput={(e) => setParam(param.key, (e.target as HTMLInputElement).value)}
          />
          {#if param.unit}<span class="text-text-muted text-[10px] w-6">{param.unit}</span>{/if}
        {/if}
      </div>
    {/each}

    <!-- Search window -->
    <div class="flex items-center gap-2 mb-1.5">
      <span class="text-text-muted text-[11px] w-20 shrink-0">From</span>
      <input
        class="flex-1 bg-surface-3 text-text-primary border rounded px-1.5 py-1 text-[11px] font-mono outline-none
               {startBad ? 'border-warning' : 'border-border'}"
        bind:value={startText}
        onblur={commitStart}
        onkeydown={(e) => { if (e.key === 'Enter') commitStart(); }}
      />
    </div>
    <div class="flex items-center gap-2 mb-1.5">
      <span class="text-text-muted text-[11px] w-20 shrink-0">To</span>
      <input
        class="flex-1 bg-surface-3 text-text-primary border rounded px-1.5 py-1 text-[11px] font-mono outline-none
               {endBad ? 'border-warning' : 'border-border'}"
        bind:value={endText}
        onblur={commitEnd}
        onkeydown={(e) => { if (e.key === 'Enter') commitEnd(); }}
      />
    </div>
    <div class="flex items-center gap-2 mb-2">
      <span class="text-text-muted text-[11px] w-20 shrink-0">Step</span>
      <select
        class="flex-1 bg-surface-3 text-text-primary border border-border rounded px-1.5 py-1 text-[11px] cursor-pointer outline-none"
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

    <!-- Run -->
    <button
      class="w-full flex items-center justify-center gap-1.5 rounded border border-border bg-surface-3 px-2 py-1.5 text-[11px] text-text-primary
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

    {#if unfilledRoles.length > 0}
      <div class="mt-1.5 text-[11px] text-text-muted">
        Choose a body for {kind.roles.filter((r) => unfilledRoles.includes(r.role)).map((r) => r.label.toLowerCase()).join(' and ')}.
      </div>
    {/if}
  {/if}

  <!-- Results -->
  {#if ef.fault}
    <!-- A fault is "we could not look", which reads differently from a search
         that ran and matched nothing. -->
    <div class="mt-2 pt-2 border-t border-border text-[11px] text-warning">
      {faultMessage(ef.fault)}
    </div>
  {:else if ef.searched && ef.events.length === 0}
    <div class="mt-2 pt-2 border-t border-border text-[11px] text-text-muted">
      No matching events in this window. Try a wider window, a looser condition, or a shorter step.
    </div>
  {:else if ef.events.length > 0}
    <div class="mt-2 pt-2 border-t border-border">
      <div class="flex items-center justify-between gap-2 mb-1">
        <span class="text-text-secondary text-[11px]">
          {ef.events.length} event{ef.events.length === 1 ? '' : 's'}
        </span>
        <div class="flex items-center gap-1.5">
          {#if metricSortLabel}
            <span class="text-[10px] text-text-muted">sort</span>
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
      <div class="flex flex-col gap-0.5 max-h-64 overflow-y-auto">
        {#each shownEvents as event}
          <button
            class="text-left rounded px-1.5 py-1 border transition-colors cursor-pointer
                   {ef.selectedId === event.id ? 'border-accent bg-surface-3' : 'border-transparent hover:bg-surface-3'}"
            onclick={() => selectEvent(event)}
            title={event.label}
          >
            <div class="flex justify-between gap-2 items-baseline">
              <span class="font-mono text-[11px] text-text-primary">{eventTime(event)}</span>
              <!-- A bare "2.5 d" beside a date reads as an offset from it.
                   Say which quantity it is. -->
              <span
                class="text-[10px] text-text-muted"
                title={isIntervalEvent(event)
                  ? 'How long this event lasted, start to end'
                  : 'This event is a single instant, not a span'}
              >
                {isIntervalEvent(event) ? `lasts ${formatSeconds(eventDuration(event))}` : 'instant'}
              </span>
            </div>
            <div class="text-[10px] text-text-secondary">{eventSummary(event)}</div>
            {#if ef.selectedId === event.id}
              <div class="mt-1 flex flex-col gap-0.5">
                {#each detailMetrics(event) as metric}
                  <div class="flex justify-between gap-2 text-[10px]">
                    <span class="text-text-muted">{metric.label}</span>
                    <span class="font-mono text-text-primary">{formatMetric(metric)}</span>
                  </div>
                {/each}
                {#if isIntervalEvent(event)}
                  <div class="flex justify-between gap-2 text-[10px]">
                    <span class="text-text-muted">Duration</span>
                    <span class="font-mono text-text-primary">{formatSeconds(eventDuration(event))}</span>
                  </div>
                  <div class="flex justify-between gap-2 text-[10px]">
                    <span class="text-text-muted">Ends</span>
                    <span class="font-mono text-text-primary">{etToUtcString(event.end).replace(' UTC', '')}</span>
                  </div>
                {/if}
              </div>
            {/if}
          </button>
        {/each}
      </div>
    </div>
  {/if}
</div>

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
</style>
