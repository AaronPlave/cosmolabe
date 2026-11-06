<script lang="ts">
  /**
   * Surface data planner (#250): authoring a #248 desired plan over the scene.
   * Opt-in: nothing here runs, draws or loads until a plan is started, and it
   * leaves Surface layers in charge of everyday visibility and styling.
   * docs/surface-planner.md describes the workflow and its boundaries.
   */
  import { onDestroy } from 'svelte';
  import { Ellipsis, LocateFixed, PenLine, Plus, Trash2, RefreshCw } from 'lucide-svelte';
  import {
    SURFACE_FIDELITY_PRESETS, featureLabel, matchingSurfacePreset, surfaceRegionChannels, surfaceRegionIntent,
    type EstimateRange, type SurfaceChannel, type SurfaceFidelityAssessment, type SurfaceOutputIntent, type SurfacePlanRegion,
  } from '@cosmolabe/core';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';
  import { vs } from '../lib/viewer-state.svelte';
  import { geo } from '../lib/geographic-layers.svelte';
  import {
    PLANNER_LEGEND, addSelectedRegion, cancelDrawRegion, chooseAlternative, chosenAlternative, clearFeedback, clearSources, closePlan, combinationSuitability,
    drawRegion, exportDesired, exportLock, focusRegion, importPlannerText, loadJezeroExample, planChanges, planner, plannerBodies, plannerBodyStatus, plannerProgress,
    refreshRegion, regionAlternatives, regionBuildStatus, regionDrifted, regionRefusal, removeRegion, selectedSourceFeature,
    selectionChanged, setBudget, setFocusChannel, setPolicy, startPlan, updateRegion, installOverlay,
  } from '../lib/surface-planner.svelte';

  interface Props { onClose: () => void; }
  let { onClose }: Props = $props();

  const fieldClass = 'ui-control min-w-0 w-full bg-surface-3 text-text-primary border border-border rounded px-2 py-1 outline-none';

  let bodies = $derived((void vs.assetsReady, void vs.bodies.length, plannerBodies()));
  let chosenBody = $state('');
  let startBody = $derived(chosenBody || planner.body || (bodies.includes('Mars') ? 'Mars' : bodies[0] ?? ''));
  let plan = $derived((void planner.revision, planner.plan));
  let status = $derived((void vs.assetsReady, plan ? plannerBodyStatus(plan.body) : startBody ? plannerBodyStatus(startBody) : null));
  let changes = $derived(planChanges());
  let selected = $derived((void geo.revision, void geo.selected, plan ? selectedSourceFeature() : null));
  let refusal = $derived(selected ? regionRefusal(selected.layer, selected.feature) : null);
  let focused = $derived(plan?.regions.find((r) => r.id === planner.focused) ?? null);
  let estimate = $derived((void planner.revision, planner.estimate));
  let unlockedChoice = $derived(selectionChanged());
  let progress = $derived((void planner.revision, plannerProgress()));
  /** The one action the panel suggests next. */
  let next = $derived<'draw' | 'desired' | 'sources' | 'lock' | null>(!progress ? null : !progress.regions ? 'draw'
    : progress.desired !== 'saved' ? 'desired' : progress.sources === 'none' ? 'sources' : progress.lockable && (progress.sources === 'demonstrated' || (progress.sources === 'locked' && unlockedChoice)) ? 'lock' : null);

  let fileInput = $state<HTMLInputElement | null>(null);
  async function openFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { planner.message = `${file.name}: planner files are limited to 2 MiB.`; return; }
    await importPlannerText(await file.text(), file.name);
  }

  function close() {
    onClose();
  }
  // However the panel goes away, a region drawing it started ends with it.
  onDestroy(cancelDrawRegion);

  // ── Formatting ──

  const sig = (n: number) => n.toLocaleString('en-US', { maximumSignificantDigits: 3 });
  function bytes(n: number): string {
    return n >= 1e12 ? `${sig(n / 1e12)} TB` : n >= 1e9 ? `${sig(n / 1e9)} GB` : n >= 1e6 ? `${sig(n / 1e6)} MB` : n >= 1e3 ? `${sig(n / 1e3)} kB` : `${sig(n)} B`;
  }
  function range(r: EstimateRange, unit: (n: number) => string = bytes): string {
    if (r.max === null) return `≥ ${unit(r.min)} (upper bound unknown)`;
    return r.min === r.max ? unit(r.min) : `${unit(r.min)} – ${unit(r.max)}`;
  }
  const count = (n: number) => sig(n);
  const pct = (f: number) => `${(f * 100).toFixed(f > 0 && f < 0.01 ? 2 : 0)}%`;
  const area = (m2: number) => m2 >= 1e6 ? `${sig(m2 / 1e6)} km²` : `${sig(m2)} m²`;
  const meters = (m: number) => m >= 1000 ? `${sig(m / 1000)} km` : `${sig(m)} m`;

  const INTENTS: { id: SurfaceOutputIntent; label: string }[] = [
    { id: 'imagery', label: 'Imagery' }, { id: 'imagery-elevation', label: 'Imagery + elevation' }, { id: 'elevation', label: 'Elevation' },
  ];

  function summary(r: SurfacePlanRegion): string {
    return surfaceRegionChannels(r).map((c) => `${c === 'imagery' ? 'img' : 'elev'} ${meters(r[c]!.gsdM)}`).join(' · ');
  }
  function changeOf(id: string): 'added' | 'modified' | null {
    return changes?.added.includes(id) ? 'added' : changes?.modified.includes(id) ? 'modified' : null;
  }
  function numberInput(e: Event): number | undefined {
    const v = (e.currentTarget as HTMLInputElement).valueAsNumber;
    return Number.isFinite(v) && v > 0 ? v : undefined;
  }
  function setGsd(region: SurfacePlanRegion, channel: SurfaceChannel, e: Event) {
    const gsdM = numberInput(e);
    if (gsdM !== undefined) updateRegion(region.id, { [channel]: { ...region[channel]!, gsdM } });
  }
  function setAccuracy(region: SurfacePlanRegion, e: Event) {
    const accuracyM = numberInput(e);
    updateRegion(region.id, { elevation: { gsdM: region.elevation!.gsdM, ...(accuracyM !== undefined ? { accuracyM } : {}) } });
  }
  function budgetInput(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).valueAsNumber;
    setBudget(Number.isFinite(v) && v > 0 ? Math.round(v * 1e6) : null);
  }
  const fidelityLabel: Record<string, string> = {
    satisfied: 'Target met by source metadata', partial: 'Partly met', unsatisfied: 'Known shortfall', unknown: 'Unknown',
  };
  function fidelityText(f: SurfaceFidelityAssessment, c: SurfaceChannel): string {
    const a = f[c];
    const label = fidelityLabel[a.requestedAreaM2 === 0 ? 'unknown' : a.adequateAreaM2 >= a.requestedAreaM2 * 0.999999 ? 'satisfied'
      : a.adequateAreaM2 > 0 ? 'partial' : a.unsatisfiedAreaM2 > 0 ? 'unsatisfied' : 'unknown'];
    return `${label}: ${area(a.adequateAreaM2)} adequate, ${area(a.unknownAreaM2)} unknown, ${area(a.unsatisfiedAreaM2)} short`;
  }
  const buildLabel: Record<string, string> = {
    published: 'Published product suffices', 'published-unproven': 'Published; fit not proved', built: 'Built, not published',
    coarser: 'Built below target', 'needs-build': 'Needs a new build', unknown: 'Unknown',
  };
  const sourcesChip: Record<string, string> = {
    none: 'No sources loaded', unproven: 'Sources not validated', demonstrated: 'Sources meet request (metadata)', locked: 'Imported lock',
  };
  const coverageLabel: Record<string, string> = {
    'verified-complete': 'Valid pixels confirmed over the whole region', 'verified-partial': 'Valid pixels confirmed over part of the region',
    unknown: 'Footprints overlap; pixel validity unknown', 'verified-empty': 'Selected products do not cover the region',
  };
</script>

<InstrumentPanel key="planner" title="Surface planner" width={380} onClose={close} expandable>
  {#if !vs.assetsReady}
    <p class="ui-helper text-text-muted">Loading the scene…</p>
  {:else if !plan}
    <p class="ui-helper text-text-muted intro">
      Author a surface data plan: regions on a body, the imagery and physical terrain each needs, the sources that could
      supply them, and what it would cost. Offline only — nothing is downloaded or built.
    </p>
    <div class="field">
      <label class="ui-label" for="planner-body">Body</label>
      <select id="planner-body" class={fieldClass} value={startBody} onchange={(e) => (chosenBody = (e.currentTarget as HTMLSelectElement).value)}>
        {#each bodies as b (b)}<option value={b}>{b}</option>{/each}
      </select>
    </div>
    {#if status}{@render bodyStatus()}{/if}
    <div class="actions">
      <button class="primary" disabled={!startBody || !!status?.blocked} onclick={() => startPlan(startBody)}>New plan</button>
      <button class="secondary" onclick={() => fileInput?.click()}>Open plan…</button>
      <button class="secondary" onclick={() => void loadJezeroExample()} title="Synthetic Jezero ROIs and the offline discovery inventory">Jezero example</button>
    </div>
  {:else}
    <div class="plan-head">
      <span class="ui-section-label">{plan.body} plan</span>
      <span class="spacer"></span>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger class="icon-action" aria-label="Plan actions" title="Plan actions"><Ellipsis size={14} /></DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          <DropdownMenu.Item disabled={!plan.regions.length} onSelect={exportDesired}>Export desired plan…</DropdownMenu.Item>
          <DropdownMenu.Item disabled={!plan.regions.length} onSelect={() => void exportLock()}>Export locked plan…</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => fileInput?.click()}>Open plan, sources or build feedback…</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={closePlan}>Close plan</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
    {#if progress}{@render progressView(progress)}{/if}
    {#if status}{@render bodyStatus()}{/if}

    <!-- Regions -->
    <section class="section" aria-label="Regions">
      <div class="section-head"><span class="ui-section-label">Regions</span><span class="ui-meta">{plan.regions.length} / 32</span></div>
      <ul class="regions">
        {#each plan.regions as region (region.id)}
          {@const change = changeOf(region.id)}
          <li class="region" class:focused={region.id === planner.focused}>
            <button class="region-name" onclick={() => focusRegion(region.id === planner.focused ? null : region.id)} aria-expanded={region.id === planner.focused}>
              <span class="swatch" aria-hidden="true"></span>
              <span class="label">{region.id}</span>
              {#if change}<span class="dot" title={change === 'added' ? 'Added since last export' : 'Changed since last export'}></span>{/if}
              <span class="ui-meta">{summary(region)}</span>
            </button>
            <button class="icon-action" title="Fly to region" aria-label="Fly to {region.id}" onclick={() => focusRegion(region.id, { fly: true })}><LocateFixed size={13} /></button>
          </li>
          {#if region.id === planner.focused}{@render regionEditor(region)}{/if}
        {:else}
          <li class="ui-helper text-text-muted">No regions yet. Select a polygon (catalog, imported or drawn), or draw one.</li>
        {/each}
      </ul>
      <div class="actions">
        <button class="secondary" disabled={!selected || !!refusal} onclick={() => addSelectedRegion()}
          title={refusal ?? (selected ? `Add ${featureLabel(selected.feature)}` : 'Select a polygon first')}>
          <Plus size={13} /> {selected ? `Add “${featureLabel(selected.feature)}”` : 'Add selected'}
        </button>
        <button class="secondary" onclick={drawRegion} disabled={planner.awaitingDraw || !!status?.blocked}><PenLine size={13} /> Draw region</button>
      </div>
      {#if refusal}<p class="ui-helper warn">{refusal}</p>{/if}
    </section>

    <!-- Sources -->
    <section class="section" aria-label="Sources">
      <div class="section-head">
        <span class="ui-section-label">Sources</span>
        {#if planner.sources.kind === 'inventory'}
          <select class="policy ui-meta" value={planner.policy} aria-label="Ranking policy" onchange={(e) => setPolicy((e.currentTarget as HTMLSelectElement).value as typeof planner.policy)}>
            <option value="consistent">Consistent products</option>
            <option value="finest-imagery">Finest imagery</option>
            <option value="physical-accuracy">Terrain accuracy</option>
          </select>
        {/if}
      </div>
      {#if planner.sources.kind === 'none'}
        <p class="ui-helper text-text-muted">No source inventory loaded. The scene's configured layers are display data, not assessed sources: coverage is <strong>unknown</strong>, not absent, and the estimate is geometry-only.</p>
        <button class="text-link ui-meta" onclick={() => fileInput?.click()}>Load an inventory or source descriptors…</button>
      {:else}
        <p class="ui-meta text-text-muted source-label">
          {planner.sources.label} · {planner.sources.kind === 'inventory' ? `${planner.sources.records.length} records` : `${planner.sources.sources.length} descriptors (estimate evidence only)`}
          <button class="text-link" onclick={clearSources}>Clear</button>
        </p>
        {#if planner.sources.kind === 'inventory' && focused}{@render alternatives(focused)}
        {:else if planner.sources.kind === 'inventory'}<p class="ui-helper text-text-muted">Focus a region to compare its candidate sources.</p>{/if}
      {/if}
      {#if planner.feedback}
        <p class="ui-meta text-text-muted source-label">Build feedback: {planner.feedback.label} <button class="text-link" onclick={clearFeedback}>Clear</button></p>
      {/if}
    </section>

    <!-- Estimate -->
    <section class="section" aria-label="Estimate">
      <div class="section-head">
        <span class="ui-section-label">Estimate</span>
        {#if estimate}<span class="ui-meta">{estimate.stage === 'source-aware' ? 'Source-aware' : 'Geometry only'}{planner.busy ? ' · updating…' : ''}</span>{/if}
      </div>
      {#if estimate}{@render estimateView()}
      {:else if plan.regions.length}<p class="ui-helper text-text-muted">{planner.busy ? 'Estimating…' : 'No estimate.'}</p>
      {:else}<p class="ui-helper text-text-muted">Add a region to estimate sizes.</p>{/if}
      <div class="field inline">
        <label class="ui-label" for="planner-budget" title="Limits the published (hosted) output, not source downloads">Output budget (MB)</label>
        <input id="planner-budget" type="number" min="1" step="1" class={fieldClass} value={plan.budget ? plan.budget.publishedBytes / 1e6 : ''} placeholder="None" onchange={budgetInput} />
      </div>
    </section>

    {#if planner.problems.length}
      <details class="section problems">
        <summary class="ui-meta">{planner.problems.length} diagnostics</summary>
        <ul>{#each planner.problems as d, i (i)}<li class="ui-meta" data-severity={d.severity}><code>{d.code}</code> {d.path}: {d.message}</li>{/each}</ul>
      </details>
    {/if}
  {/if}
  {#if planner.message && !plan}<p class="ui-helper message" role="status">{planner.message}</p>{/if}
  <input bind:this={fileInput} type="file" accept=".json,application/json" class="hidden" onchange={openFile} />
</InstrumentPanel>

{#snippet bodyStatus()}
  <dl class="body-status ui-meta">
    {#if status!.blocked}
      <dt>Georegistration</dt><dd class="warn">Blocked — {status!.blocked}</dd>
    {:else}
      <dt>Reference</dt><dd>{status!.referenceShape} · {plan?.frame ?? status!.frame}</dd>
      <dt>Current scene</dt>
      <dd>{status!.imageryLayers} imagery {status!.imageryLayers === 1 ? 'layer' : 'layers'} ·
        {status!.measuredTerrain ? 'measured terrain loaded' : 'reference shape only (no measured relief)'}
        <br /><span class="text-text-muted">Read-only baseline: a plan changes nothing in the scene.</span></dd>
    {/if}
  </dl>
{/snippet}

{#snippet regionEditor(region: SurfacePlanRegion)}
  {@const intent = surfaceRegionIntent(region)}
  {@const preset = matchingSurfacePreset(region)}
  <li class="editor">
    {#if regionDrifted(region.id)}
      <p class="ui-helper warn drift">The source shape changed after it was added. <button class="text-link" onclick={() => refreshRegion(region.id)}><RefreshCw size={11} /> Use current shape</button></p>
    {/if}
    <div class="segmented" role="radiogroup" aria-label="Output">
      {#each INTENTS as option (option.id)}
        <button role="radio" aria-checked={intent === option.id} class:on={intent === option.id} onclick={() => updateRegion(region.id, { intent: option.id })}>{option.label}</button>
      {/each}
    </div>
    <div class="field">
      <label class="ui-label" for="preset-{region.id}">Preset</label>
      <select id="preset-{region.id}" class={fieldClass} value={preset?.id ?? ''} onchange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; if (v) updateRegion(region.id, { preset: v as never }); }}>
        <option value="" disabled>Custom</option>
        {#each SURFACE_FIDELITY_PRESETS as p (p.id)}<option value={p.id} title={p.description}>{p.label}</option>{/each}
      </select>
    </div>
    <div class="grid">
      {#if region.imagery}
        <label class="ui-label" for="img-{region.id}">Imagery GSD (m)</label>
        <input id="img-{region.id}" type="number" min="0" step="any" class={fieldClass} value={region.imagery.gsdM} onchange={(e) => setGsd(region, 'imagery', e)} />
      {/if}
      {#if region.elevation}
        <label class="ui-label" for="dem-{region.id}">Terrain GSD (m)</label>
        <input id="dem-{region.id}" type="number" min="0" step="any" class={fieldClass} value={region.elevation.gsdM} onchange={(e) => setGsd(region, 'elevation', e)} />
      {/if}
    </div>
    <p class="ui-meta text-text-muted">Requested output sampling, not achieved source accuracy.</p>
    <details class="advanced">
      <summary class="ui-meta">Advanced</summary>
      <div class="grid">
      {#if region.elevation}
        <label class="ui-label" for="acc-{region.id}" title="Maximum physical source uncertainty; not mesh error or pixel size">Max source error (m)</label>
        <input id="acc-{region.id}" type="number" min="0" step="any" placeholder="Any" class={fieldClass} value={region.elevation.accuracyM ?? ''} onchange={(e) => setAccuracy(region, e)} />
      {/if}
      <label class="ui-label" for="pri-{region.id}">Priority</label>
      <input id="pri-{region.id}" type="number" min="0" step="1" class={fieldClass} value={region.priority ?? 0}
        onchange={(e) => { const v = (e.currentTarget as HTMLInputElement).valueAsNumber; if (Number.isSafeInteger(v) && v >= 0) updateRegion(region.id, { priority: v }); }} />
      <label class="ui-label" for="fb-{region.id}">If unmet</label>
      <select id="fb-{region.id}" class={fieldClass} value={region.fallback ?? 'require-target'} onchange={(e) => updateRegion(region.id, { fallback: (e.currentTarget as HTMLSelectElement).value as never })}>
        <option value="require-target">Require target</option>
        <option value="allow-coarser">Allow coarser</option>
        <option value="leave-unavailable">Leave unavailable</option>
      </select>
      </div>
    </details>
    {#if planner.feedback}
    <dl class="estimate ui-meta" aria-label="Built products">
      {#each surfaceRegionChannels(region) as c (c)}
        {@const b = regionBuildStatus(region.id, c)}
        {#if b}<dt>{c === 'imagery' ? 'Built imagery' : 'Built terrain'}</dt><dd data-build={b.status} title={b.detail}>{buildLabel[b.status]}<br /><span class="text-text-muted">{b.detail}</span></dd>{/if}
      {/each}
    </dl>
    {/if}
    <div class="actions end">
      <button class="text-link ui-meta danger" onclick={() => removeRegion(region.id)}><Trash2 size={12} /> Remove region</button>
    </div>
  </li>
{/snippet}

{#snippet alternatives(region: SurfacePlanRegion)}
  {@const list = regionAlternatives(region.id)}
  {@const chosen = chosenAlternative(region.id)}
  {@const channels = surfaceRegionChannels(region)}
  {#if channels.length > 1}
    <div class="segmented small" role="radiogroup" aria-label="Channel shown">
      {#each channels as c (c)}
        <button role="radio" aria-checked={planner.focusChannel === c} class:on={planner.focusChannel === c} onclick={() => setFocusChannel(c)}>{c === 'imagery' ? 'Imagery' : 'Physical terrain'}</button>
      {/each}
    </div>
  {/if}
  {#if !list.length}
    <p class="ui-helper text-text-muted">No compatible candidate in this inventory for {region.id}. Coverage is unknown, not proven absent.</p>
  {:else}
    <ol class="alternatives" aria-label="Source combinations for {region.id}">
      {#each list as alt, i (alt.id)}
        {@const ch = alt.channels[planner.focusChannel]}
        {@const fit = combinationSuitability(alt, channels)}
        <li>
          <label class="alt" class:on={alt === chosen}>
            <input type="radio" name="alt-{region.id}" checked={alt === chosen} onchange={() => chooseAlternative(region.id, i)} />
            <span class="alt-body">
              <span class="alt-title">{i === 0 ? 'Top-ranked' : `Alternative ${i}`} · <span data-fit={fit.demonstrated}>{fit.demonstrated ? 'meets the request' : 'suitability unverified'}</span></span>
              <span class="ui-meta">{fit.reason}</span>
              {#if ch}
                {#if ch.sourceIds.length}<span class="ui-meta">{ch.sourceIds.join(', ')}</span>{/if}
                <span class="bar" aria-hidden="true">
                  <span style:width={pct(ch.coverage.verifiedFraction)} style:background={PLANNER_LEGEND[2].color}></span>
                  <span style:width={pct(ch.coverage.unknownFraction)} style:background={PLANNER_LEGEND[3].color}></span>
                  <span style:width={pct(ch.coverage.gapFraction)} style:background={PLANNER_LEGEND[4].color}></span>
                </span>
              {:else}
                <span class="ui-meta">This combination has no {planner.focusChannel} source.</span>
              {/if}
              <span class="ui-meta" title="Input acquisition; separate from the output budget">Source download (input): {range(alt.cost.downloadBytes)}</span>
              <details class="warnings"><summary class="ui-meta">Evidence details{alt.warnings.length ? ` · ${alt.warnings.length} warnings` : ''}</summary>
                {#if ch}
                  <p class="ui-meta">{coverageLabel[ch.coverage.status]} — {pct(ch.coverage.verifiedFraction)} valid, {pct(ch.coverage.unknownFraction)} unknown, {pct(ch.coverage.gapFraction)} gap;
                    target met over {pct(ch.coverage.targetVerifiedFraction)} (requested {meters(ch.requestedGsdM)}{ch.coarserSourceIds.length ? `; coarser: ${ch.coarserSourceIds.length}` : ''}{ch.unknownGsdSourceIds.length ? `; unknown sampling: ${ch.unknownGsdSourceIds.length}` : ''})</p>
                {/if}
                <p class="ui-meta">Registration {alt.compatibility === 'evidenced' ? 'evidenced' : 'unverified'}.</p>
                {#if alt.warnings.length}<ul>{#each alt.warnings as w (w)}<li class="ui-meta">{w}</li>{/each}</ul>{/if}
              </details>
            </span>
          </label>
        </li>
      {/each}
    </ol>
  {/if}
  <label class="ui-meta check"><input type="checkbox" checked={planner.showCoverage} onchange={(e) => { planner.showCoverage = (e.currentTarget as HTMLInputElement).checked; installOverlay(); }} /> Show this combination on the globe</label>
  <details class="warnings"><summary class="ui-meta">Legend</summary>
    <ul class="legend" aria-label="Legend">
      {#each PLANNER_LEGEND as item (item.id)}
        <li class="ui-meta" title={item.detail}><span class="key" style:background={item.color}></span>{item.label}</li>
      {/each}
    </ul>
    <p class="ui-meta text-text-muted">Built products come only from loaded build feedback; tiles displayed in the scene are not treated as sources.</p>
  </details>
{/snippet}

{#snippet estimateView()}
  {@const e = estimate!}
  {@const t = e.totals}
  <dl class="estimate ui-meta">
    {#each (['imagery', 'elevation'] as const) as c (c)}
      {#if t[c].areaM2 > 0}<dt>{c === 'imagery' ? 'Imagery' : 'Physical terrain'}</dt><dd>{area(t[c].areaM2)} · output {range(t[c].publishedBytes)}</dd>{/if}
    {/each}
    {#if t.elevation.areaM2 === 0}<dt>Physical terrain</dt><dd class="text-text-muted">Not requested — no elevation inputs or work.</dd>{/if}
    <dt>Published output</dt><dd>{range(t.publishedBytes)}</dd>
    {#if e.budget}
      <dt>Output budget</dt>
      <dd data-budget={e.budget.status}>{e.budget.status === 'within' ? 'Within' : e.budget.status === 'over' ? 'Over' : 'Uncertain against'} {bytes(e.budget.publishedBytes)}</dd>
    {/if}
    <dt>Source download (input)</dt><dd>{planner.sources.kind === 'none' ? 'Unknown: no sources loaded' : range(t.rawSourceDownloadBytes)}{e.sourceDownload.unknownSizeIds.length ? ` · ${e.sourceDownload.unknownSizeIds.length} sizes unknown` : ''}</dd>
  </dl>
  <p class="ui-meta text-text-muted">The output budget limits what is published and hosted. Source download is input acquisition, a separate cost.</p>
  <details class="warnings">
    <summary class="ui-meta">Details and assumptions</summary>
    <dl class="estimate ui-meta">
      {#each (['imagery', 'elevation'] as const) as c (c)}
        {#if t[c].areaM2 > 0}
          <dt>{c === 'imagery' ? 'Imagery' : 'Physical terrain'}</dt>
          <dd>{range(t[c].objects, count)} objects
            {#if planner.selectedFidelity}
              {#each plan!.regions.filter((r) => r[c] && planner.selectedFidelity![r.id]) as r (r.id)}<br /><span class="text-text-muted">{r.id} (selected sources): {fidelityText(planner.selectedFidelity[r.id], c)}</span>{/each}
            {:else}
              <br /><span class="text-text-muted" title="Pools every loaded descriptor across regions; not a per-region selection">{planner.sources.kind === 'none' ? 'No sources loaded' : 'Any loaded source'}: {fidelityText(e.fidelity, c)}</span>
            {/if}</dd>
        {/if}
      {/each}
      <dt>Hosted objects</dt><dd>{range(t.publishedObjects, count)}</dd>
      <dt>Work disk</dt><dd>{range(t.peakWorkDiskBytes)}</dd>
      {#each e.budget?.comparisons ?? [] as cmp (cmp.gsdMultiplier)}
        <dt>If coarser</dt><dd>{cmp.regionIds.join(', ')} at {cmp.gsdMultiplier}×: {range(cmp.publishedBytes)} ({cmp.status}). Comparison only; the plan is unchanged.</dd>
      {/each}
    </dl>
    <p class="ui-meta text-text-muted">Uncalibrated scenario bounds (tile packing, compression, scratch). No build or download was performed.</p>
  </details>
{/snippet}

{#snippet progressView(p: NonNullable<typeof progress>)}
  <ul class="chips" aria-label="Plan status">
    {#if p.desired !== 'empty'}<li data-ok={p.desired === 'saved'}>{p.desired === 'saved' ? 'Desired plan saved' : 'Desired plan not saved'}</li>{/if}
    {#if p.regions}<li data-ok={p.sources === 'demonstrated' || p.sources === 'locked'}>{sourcesChip[p.sources]}</li>{/if}
    {#if p.regions}<li data-ok={p.lockable && !unlockedChoice}>{!p.lockable ? 'Lock not exportable' : unlockedChoice ? 'Lock exportable · choice not locked' : 'Lock exportable'}</li>{/if}
  </ul>
  <div class="next">
    <p class="ui-helper">
      {#if !p.regions}Start with a region: draw one on {plan!.body}, or select a polygon in the scene and add it below.
      {:else if next === 'desired'}Set each region's imagery or terrain target below, then export the desired plan. It records what you want and changes nothing in the scene.
      {:else if p.sources === 'none'}To see what could supply this plan, load a source inventory. Without one, source coverage is unknown.
      {:else if p.sources === 'unproven'}Source evidence does not show the request is met for {p.unprovenRegions.join(', ')}. Focus a region to see why. A lock records a choice; it does not prove suitability.
      {:else if p.sources === 'locked' && !unlockedChoice}Imported lock held unchanged. Load build feedback to see what is already built.
      {:else}The chosen sources meet the request by discovery metadata. Export a locked plan to hand off.{/if}
    </p>
    <div class="actions">
      {#if !p.regions}
        <button class="primary" onclick={drawRegion} disabled={planner.awaitingDraw || !!status?.blocked}><PenLine size={13} /> Draw region</button>
      {:else}
        <button class={next === 'desired' ? 'primary' : 'secondary'} onclick={exportDesired}>Export desired plan</button>
        {#if p.sources === 'none'}<button class={next === 'sources' ? 'primary' : 'secondary'} onclick={() => fileInput?.click()}>Load source inventory…</button>{/if}
        <button class={next === 'lock' ? 'primary' : 'secondary'} disabled={!p.lockable} onclick={() => void exportLock()}
          title={p.lockable ? 'Validated on export' : 'Load an inventory and choose a source for every region first'}>Export locked plan</button>
      {/if}
    </div>
    {#if p.unselectedRegions.length}<p class="ui-meta warn">Not lockable: no source is chosen for {p.unselectedRegions.join(', ')} (no compatible candidate for a requested channel).</p>{/if}
    {#if p.lockProblem}<p class="ui-meta warn">Not lockable: {p.lockProblem}</p>{/if}
    {#if planner.message}<p class="ui-helper message" role="status">{planner.message}</p>{/if}
    {#if p.lockable}<p class="ui-meta text-text-muted">A locked plan is a handoff, not a build: an executor preparation step (terrain, imagery and gate parameters, pinned source bytes, runtime bindings) must complete it before <code>build:surface</code> can run.</p>{/if}
  </div>
{/snippet}

<style>
  .intro { margin-bottom: 8px; }
  .field { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
  .field.inline { margin-top: 8px; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .actions.end { justify-content: flex-end; margin-top: 2px; }
  .primary, .secondary {
    display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px; border-radius: 4px;
    font-size: var(--text-metadata); cursor: pointer;
  }
  .primary { border: none; background: var(--color-text-primary); color: var(--color-surface-1, #0d1117); font-weight: 600; }
  .secondary { border: 1px solid var(--color-border); background: var(--color-surface-2); color: var(--color-text-primary); }
  .primary:disabled, .secondary:disabled { opacity: 0.45; cursor: default; }
  .plan-head, .section-head { display: flex; align-items: center; gap: 6px; }
  .section-head { justify-content: space-between; margin-bottom: 4px; }
  .spacer { flex: 1; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
  .chips li { padding: 0 6px; border-radius: 8px; border: 1px solid var(--color-warning); font-size: var(--text-metadata); color: var(--color-warning); }
  .chips li[data-ok='true'] { border-color: var(--color-border); color: var(--color-text-secondary); }
  .next { margin-top: 8px; padding: 6px 8px; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-surface-2); }
  .next .actions { margin-top: 6px; }
  .next p + .actions + p { margin-top: 6px; }
  .advanced summary { cursor: pointer; color: var(--color-text-secondary); }
  [data-fit='true'] { color: var(--color-success, #4cc38a); }
  [data-fit='false'] { color: var(--color-warning); }
  .warnings summary { cursor: pointer; color: var(--color-text-secondary); }
  .section { margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--color-border); }
  .body-status { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; margin-top: 6px; color: var(--color-text-secondary); }
  .body-status dt, .estimate dt { color: var(--color-text-muted); }
  .regions { display: flex; flex-direction: column; }
  .region { display: flex; align-items: center; border-radius: 4px; }
  .region:hover, .region.focused { background: var(--color-surface-3); }
  .region-name { display: flex; flex: 1; align-items: center; gap: 6px; min-width: 0; min-height: 28px; border: none; background: none; padding: 0 4px; color: var(--color-text-primary); text-align: left; cursor: pointer; }
  .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .swatch { flex: none; width: 9px; height: 9px; border: 2px solid #f2c14e; border-radius: 2px; }
  .dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--color-warning); }
  .editor { display: flex; flex-direction: column; gap: 4px; margin: 2px 0 6px; padding: 6px 8px; border: 1px solid var(--color-border); border-radius: 4px; }
  .grid { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 8px; align-items: center; margin-top: 4px; }
  .segmented { display: flex; border: 1px solid var(--color-border); border-radius: 4px; overflow: hidden; }
  .segmented.small { margin-bottom: 6px; }
  .segmented button { flex: 1; min-height: 24px; border: none; background: none; color: var(--color-text-secondary); font-size: var(--text-metadata); cursor: pointer; }
  .segmented button + button { border-left: 1px solid var(--color-border); }
  .segmented button.on { background: var(--color-surface-3); color: var(--color-text-primary); font-weight: 600; }
  .policy { border: 1px solid var(--color-border); border-radius: 3px; background: var(--color-surface-3); color: var(--color-text-primary); }
  .source-label { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; overflow-wrap: anywhere; }
  .alternatives { display: flex; flex-direction: column; gap: 4px; }
  .alt { display: flex; gap: 6px; padding: 4px 6px; border: 1px solid var(--color-border); border-radius: 4px; cursor: pointer; }
  .alt.on { border-color: var(--color-text-secondary); background: var(--color-surface-2); }
  .alt-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
  .alt-title { font-size: var(--text-metadata); color: var(--color-text-primary); }
  .bar { display: flex; height: 5px; border-radius: 2px; overflow: hidden; background: var(--color-surface-3); }
  .bar span { display: block; height: 100%; }
  .warnings ul { margin: 2px 0 0 12px; list-style: disc; }
  .check { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
  .legend { display: flex; flex-wrap: wrap; gap: 2px 10px; margin-top: 4px; }
  .legend li { display: inline-flex; align-items: center; gap: 4px; color: var(--color-text-secondary); }
  .key { width: 9px; height: 9px; border-radius: 2px; }
  .estimate { display: grid; grid-template-columns: auto 1fr; gap: 4px 8px; color: var(--color-text-secondary); }
  .estimate dd[data-budget='over'] { color: var(--color-error); }
  .estimate dd[data-budget='uncertain'] { color: var(--color-warning); }
  .estimate dd[data-build='published'] { color: var(--color-success, #4cc38a); }
  .estimate dd[data-build='needs-build'], .estimate dd[data-build='coarser'], .estimate dd[data-build='published-unproven'] { color: var(--color-warning); }
  .problems summary { cursor: pointer; color: var(--color-text-secondary); }
  .problems li { overflow-wrap: anywhere; margin-top: 2px; }
  .problems li[data-severity='error'] { color: var(--color-error); }
  .text-link { display: inline-flex; align-items: center; gap: 3px; border: none; background: none; padding: 0; color: var(--color-text-secondary); cursor: pointer; text-decoration: underline; }
  .text-link:hover { color: var(--color-text-primary); }
  .danger { color: var(--color-error); }
  .warn { color: var(--color-warning); }
  .drift { display: flex; gap: 6px; flex-wrap: wrap; }
  .message { margin-top: 8px; color: var(--color-text-secondary); overflow-wrap: anywhere; }
  .hidden { display: none; }
</style>
