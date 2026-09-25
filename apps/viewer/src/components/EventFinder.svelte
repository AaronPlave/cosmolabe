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
  import { Loader2, Search, Ban, Plus, Trash2 } from 'lucide-svelte';
  import { tick } from 'svelte';
  import * as Select from '$lib/components/ui/select/index.js';
  import { eventStart, eventDuration, isIntervalEvent, type GeometryEvent } from '@cosmolabe/core';
  import { vs, etToUtcString } from '../lib/viewer-state.svelte';
  import { toolDef } from '../lib/shell.svelte';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';
  import { getSpice } from '../lib/loader';
  import {
    EVENT_KINDS, cancelSearch, ef, clearSelection, currentKind, resetForm, runSearch,
    selectEvent, previewEvent, removeConfiguredQuery, setKind, setParam, setRole, setSort, setStep, setWindow, resetWindow,
    currentConfiguredQuery, setCurrentQueryVisible,
    configuredEventQueries, createNewSearch, openConfiguredQuery,
    setConfiguredQueryEnabled, setConfiguredQueryVisible,
  } from '../lib/event-finder.svelte';
  import {
    eventSummary, faultMessage, formatMetric, formatSeconds, headlineMetric, missingRoles,
    eventContainsTime, sortEvents, sortMetricLabel,
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
  let mixedTemporality = $derived(
    ef.events.some(isIntervalEvent) && ef.events.some((event) => !isIntervalEvent(event)),
  );
  let metricSortLabel = $derived(sortMetricLabel(ef.events));
  let unfilledRoles = $derived(form ? missingRoles(kind, form) : []);
  let configured = $derived(currentConfiguredQuery());
  let configuredQueries = $derived(configuredEventQueries());
  let canSearch = $derived(!!form && unfilledRoles.length === 0 && !ef.running);
  let resultsListEl = $state<HTMLDivElement>();

  // Scene and timeline markers can select a result outside the list's current
  // scroll window. Reveal its row so the time jump has an obvious explanation.
  $effect(() => {
    const selectedId = ef.selectedId;
    const queryId = ef.configuredId;
    if (!selectedId) return;
    void tick().then(() => {
      if (ef.selectedId !== selectedId || ef.configuredId !== queryId) return;
      const list = resultsListEl;
      const selected = list?.querySelector<HTMLElement>('.event-result.selected');
      if (!list || !selected) return;
      const listBox = list.getBoundingClientRect();
      const rowBox = selected.getBoundingClientRect();
      if (rowBox.top < listBox.top) list.scrollTop -= listBox.top - rowBox.top;
      else if (rowBox.bottom > listBox.bottom) list.scrollTop += rowBox.bottom - listBox.bottom;
    });
  });
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

  function roleLabel(role: string): string {
    return kind.roles.find((spec) => spec.role === role)?.label ?? role;
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
          <!-- No percentage here. The fraction is of the geometry call running
               right now, not of the search, so a number on the primary control
               would claim a completeness nothing can measure — and would count
               up and start over within one "Find events". The bar below says the
               same thing without promising it. -->
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

    <!-- A determinate bar, from CSPICE's own progress reporter running inside
         the search. It measures the step in progress: the fraction is of the
         geometry call currently running — monotonic within it, since the call's
         pass count is known up front — and it restarts when the search moves to
         its next call. So it reads as "still moving, and here is how far through
         this piece", never as a prediction of the whole, which is why no number
         is shown beside it. Absent on the main-thread path, where the simplified
         wrappers report nothing and the spinner is all there is. -->
    {#if ef.running && ef.progress}
      <div
        class="mt-1.5 h-1 w-full overflow-hidden rounded bg-surface-3"
        role="progressbar"
        aria-label="Progress of the current search step"
        title="Progress of the step running now. A search runs in several steps, so this restarts."
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ef.progress.fraction * 100)}
      >
        <div
          class="h-full bg-accent transition-[width] duration-200"
          style={`width: ${Math.round(ef.progress.fraction * 100)}%`}
        ></div>
      </div>
    {/if}

    {#if configured}
      <div class="mt-1.5 flex items-center gap-3 ui-helper">
        <label class="flex items-center gap-1 cursor-pointer" title="Include this configured event category in analysis">
          <input
            type="checkbox"
            class="accent-accent"
            checked={configured.enabled}
            onchange={(e) => setConfiguredQueryEnabled(configured.id, (e.target as HTMLInputElement).checked)}
          />
          Enabled
        </label>
        <label class="flex items-center gap-1 cursor-pointer" title="Show this category's cached results on the shared timeline">
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

  {#if configuredQueries.length > 1}
    <div class="mt-2 pt-2 border-t border-border">
      <div class="flex items-center justify-between gap-2 mb-1">
        <span class="ui-section-label">Event categories</span>
        <button class="ctrl-link flex items-center gap-0.5" onclick={createNewSearch}>
          <Plus size={10} /> New
        </button>
      </div>
      <div class="flex flex-col gap-0.5">
        {#each configuredQueries as query (query.id)}
          <div class="configured-query flex items-center gap-1 rounded px-1.5 py-1" class:active={query.id === ef.configuredId}>
            <button class="min-w-0 flex-1 truncate text-left ui-helper" onclick={() => openConfiguredQuery(query.id)} title={query.label}>
              {query.label}
            </button>
            <label title="Enabled in analysis" class="ui-meta flex items-center gap-0.5 cursor-pointer">
              <input type="checkbox" checked={query.enabled} onchange={(e) => setConfiguredQueryEnabled(query.id, (e.target as HTMLInputElement).checked)} /> on
            </label>
            <label title="Visible on timeline" class="ui-meta flex items-center gap-0.5 cursor-pointer">
              <input type="checkbox" checked={query.visible} onchange={(e) => setConfiguredQueryVisible(query.id, (e.target as HTMLInputElement).checked)} /> time
            </label>
            <button
              class="remove-query"
              onclick={() => removeConfiguredQuery(query.id)}
              aria-label="Remove {query.label}"
              title="Remove category"
            ><Trash2 size={11} /></button>
          </div>
        {/each}
      </div>
    </div>
  {:else if configuredQueries.length === 1 && ef.searched}
    <div class="mt-1 flex justify-end">
      <button class="ctrl-link flex items-center gap-0.5" onclick={createNewSearch}>
        <Plus size={10} /> Add event category
      </button>
    </div>
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
      <div class="event-marker-legend ui-helper" aria-label="3D event marker legend">
        <span><i class="event-marker-diamond" aria-hidden="true"></i>Instant</span>
        <span><i class="event-marker-span" aria-hidden="true"></i>Interval</span>
      </div>
      <div bind:this={resultsListEl} class="flex flex-col gap-1 max-h-64 overflow-y-auto">
        {#each shownEvents as event}
          {@const headline = headlineMetric(event)}
          {@const atPlayhead = eventContainsTime(event, vs.et)}
          <button
            class="event-result text-left rounded px-2 py-2 border cursor-pointer"
            class:selected={ef.selectedId === event.id && ef.configuredId === event.queryId}
            class:preview={ef.previewId === event.id && ef.previewQueryId === event.queryId}
            class:at-playhead={atPlayhead}
            onclick={() => selectEvent(event)}
            onpointerenter={() => previewEvent(event)}
            onpointerleave={() => previewEvent(null)}
            onfocus={() => previewEvent(event)}
            onblur={() => previewEvent(null)}
            title={event.label}
          >
            <div class="flex justify-between gap-2 items-baseline">
              <span class="ui-readout event-time">{eventTime(event)}</span>
              <!-- A bare "2.5 d" beside a date reads as an offset from it.
                   Say which quantity it is. -->
              <span class="flex items-center gap-1.5">
                {#if atPlayhead}<span class="ui-meta event-now">at playhead</span>{/if}
                {#if isIntervalEvent(event)}
                  <span class="ui-meta" title="How long this event lasted, start to end">
                    lasts {formatSeconds(eventDuration(event))}
                  </span>
                {:else if mixedTemporality}
                  <!-- Only worth saying when the list mixes instants and
                       spans; otherwise the legend already says it. -->
                  <span class="ui-meta" title="This event is a single instant, not a span">instant</span>
                {/if}
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
            {#if ef.selectedId === event.id && ef.configuredId === event.queryId}
              <div class="mt-1 flex flex-col gap-0.5">
                {#if event.state}
                  <div class="ui-data-row">
                    <span class="ui-label">State</span>
                    <span class="ui-readout capitalize">{event.state}</span>
                  </div>
                {/if}
                {#if event.kind === 'occultation' && ef.activeId === event.id && ef.activeQueryId === event.queryId}
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
                {:else if event.kind === 'occultation'}
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
                    <span
                      class="ctrl-link ui-readout"
                      role="button"
                      tabindex="0"
                      onclick={(click) => { click.stopPropagation(); selectEvent(event, 'end'); }}
                      onkeydown={(key) => {
                        if (key.key === 'Enter' || key.key === ' ') {
                          key.preventDefault();
                          key.stopPropagation();
                          selectEvent(event, 'end');
                        }
                      }}
                    >
                      {etToUtcString(event.end).replace(' UTC', '')}
                    </span>
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
  /* Inline text controls. */
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

  .configured-query {
    border: 1px solid transparent;
  }
  /* Quiet until the row is hovered or focused; red only on its own hover. */
  .remove-query {
    display: flex;
    padding: 2px;
    border: none;
    border-radius: 3px;
    background: none;
    color: var(--color-text-muted);
    cursor: pointer;
    opacity: 0;
  }
  .configured-query:hover .remove-query,
  .configured-query:focus-within .remove-query {
    opacity: 1;
  }
  .remove-query:hover {
    color: var(--color-error);
    background: var(--color-control-hover);
  }
  .configured-query.active {
    border-color: var(--color-border-strong);
    background: var(--color-chrome-active-bg);
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
  /* Quieter than a full gold frame, matching the in-scene treatment: a gold
     keyline carries the selection, the frame stays neutral chrome. */
  .event-result.selected {
    border-color: var(--color-border-strong);
    background: color-mix(in srgb, var(--color-event-accent) 5%, transparent);
    box-shadow: inset 2px 0 0 var(--color-event-accent);
  }
  .event-result.preview:not(.selected) {
    border-color: color-mix(in srgb, var(--color-primary-accent) 45%, transparent);
    background: color-mix(in srgb, var(--color-primary-accent) 7%, transparent);
  }
  .event-result.at-playhead:not(.selected) {
    box-shadow: inset 1px 0 0 color-mix(in srgb, var(--color-event-accent) 60%, transparent);
  }
  .event-now {
    color: var(--color-event-accent);
  }
  .geometry-standby {
    margin: 3px 0 2px;
    padding: 4px 6px;
    border-left: 1px solid color-mix(in srgb, var(--color-event-accent) 52%, transparent);
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
  .event-marker-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 3px 10px;
    margin: 2px 0 6px;
    color: var(--color-text-secondary);
  }
  .event-marker-legend span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }
  .event-marker-diamond,
  .event-marker-span {
    display: inline-block;
    flex: none;
    width: 12px;
    height: 12px;
    position: relative;
    color: #70b7d7;
  }
  .event-marker-diamond::after {
    content: '';
    position: absolute;
    width: 7px;
    height: 7px;
    border: 1px solid currentColor;
    transform: rotate(45deg);
    top: 2px;
    left: 2px;
  }
  .event-marker-span::before {
    content: '';
    position: absolute;
    top: 5px;
    left: 1px;
    width: 10px;
    border-top: 1px solid currentColor;
  }
  .event-marker-span::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 1px;
    width: 10px;
    height: 7px;
    border-left: 1px solid currentColor;
    border-right: 1px solid currentColor;
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
