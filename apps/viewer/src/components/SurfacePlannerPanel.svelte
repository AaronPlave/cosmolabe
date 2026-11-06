<script lang="ts">
  /**
   * Surface data planner (#250) as a short guided flow over the scene:
   * area → detail → what is available → finish. Opt-in: nothing runs, draws or
   * loads until a plan is started. It authors a #248 plan and never builds;
   * docs/surface-planner.md describes the flow and its boundaries.
   */
  import { onDestroy } from 'svelte';
  import { Ellipsis, LocateFixed, PenLine, Plus, Trash2, RefreshCw } from 'lucide-svelte';
  import {
    SURFACE_FIDELITY_PRESETS, featureLabel, surfaceRegionChannels,
    type EstimateRange, type SurfaceChannel, type SurfacePlanRegion,
  } from '@cosmolabe/core';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';
  import { vs } from '../lib/viewer-state.svelte';
  import { geo } from '../lib/geographic-layers.svelte';
  import {
    PLANNER_LEGEND, addSelectedRegion, canFindSources, cancelDrawRegion, channelFinding, chooseAlternative, chosenAlternative, clearFeedback,
    closePlan, drawRegion, exportDesired, exportLock, findSources, focusRegion, handoffReadiness, importPlannerText, installOverlay,
    loadJezeroExample, planner, plannerBodies, plannerBodyStatus, refreshRegion, regionAlternatives, regionBuildStatus, regionDrifted,
    regionRefusal, removeRegion, sceneProducts, selectedSourceFeature, setBudget, setFocusChannel, startPlan, updateRegion,
  } from '../lib/surface-planner.svelte';

  interface Props { onClose: () => void; }
  let { onClose }: Props = $props();

  const fieldClass = 'ui-control min-w-0 w-full bg-surface-3 text-text-primary border border-border rounded px-2 py-1 outline-none';

  const STEPS = [
    { id: 'area', label: 'Area' }, { id: 'detail', label: 'Detail' }, { id: 'available', label: 'Available data' }, { id: 'finish', label: 'Finish' },
  ] as const;
  type Step = (typeof STEPS)[number]['id'];
  let step = $state<Step>('area');

  let bodies = $derived((void vs.assetsReady, void vs.bodies.length, plannerBodies()));
  let chosenBody = $state('');
  let startBody = $derived(chosenBody || planner.body || (bodies.includes('Mars') ? 'Mars' : bodies[0] ?? ''));
  let plan = $derived((void planner.revision, planner.plan));
  let status = $derived((void vs.assetsReady, plan ? plannerBodyStatus(plan.body) : startBody ? plannerBodyStatus(startBody) : null));
  let selected = $derived((void geo.revision, void geo.selected, plan ? selectedSourceFeature() : null));
  let refusal = $derived(selected ? regionRefusal(selected.layer, selected.feature) : null);
  let current = $derived(plan?.regions.find((r) => r.id === planner.focused) ?? plan?.regions[0] ?? null);
  let estimate = $derived((void planner.revision, planner.estimate));
  let handoff = $derived((void planner.revision, handoffReadiness()));
  // Steps after the area need one.
  $effect(() => { if (plan && !plan.regions.length) step = 'area'; });

  let fileInput = $state<HTMLInputElement | null>(null);
  async function openFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { planner.message = `${file.name}: planner files are limited to 2 MiB.`; return; }
    await importPlannerText(await file.text(), file.name);
  }
  // However the panel goes away, a region drawing it started ends with it.
  onDestroy(cancelDrawRegion);

  function start(then?: () => void) {
    if (startPlan(startBody)) { step = 'area'; then?.(); }
  }

  // ── Formatting ──

  const sig = (n: number) => n.toLocaleString('en-US', { maximumSignificantDigits: 3 });
  function bytes(n: number): string {
    return n >= 1e12 ? `${sig(n / 1e12)} TB` : n >= 1e9 ? `${sig(n / 1e9)} GB` : n >= 1e6 ? `${sig(n / 1e6)} MB` : n >= 1e3 ? `${sig(n / 1e3)} kB` : `${sig(n)} B`;
  }
  function range(r: EstimateRange): string {
    if (r.max === null) return `at least ${bytes(r.min)}`;
    return r.min === r.max ? bytes(r.min) : `${bytes(r.min)} – ${bytes(r.max)}`;
  }
  const pct = (f: number) => `${(f * 100).toFixed(f > 0 && f < 0.01 ? 2 : 0)}%`;
  const meters = (m: number) => m >= 1000 ? `${sig(m / 1000)} km` : `${sig(m)} m`;

  const CHANNEL = {
    imagery: { name: 'Imagery', detail: 'Image detail', unit: 'per pixel', explain: 'Smaller is sharper and larger to store.' },
    elevation: { name: '3D terrain', detail: '3D terrain detail', unit: 'per sample', explain: 'How finely heights are sampled, not how accurate they are.' },
  } as const;
  const PRESET_NAME: Record<string, string> = { 'orbit-context': 'Regional', descent: 'Landing', 'local-operations': 'Close-up' };
  const VERDICT: Record<string, string> = {
    proven: 'Proven', partial: 'Partly proven', coarser: 'Coarser than requested', unknown: 'Unknown — needs verification',
    none: 'Not found', 'not-searched': 'Not searched',
  };
  const buildLabel: Record<string, string> = {
    published: 'Already published and sufficient', 'published-unproven': 'Published; fit not proved', built: 'Built, not published',
    coarser: 'Built below the requested detail', 'needs-build': 'Needs a new build', unknown: 'Unknown',
  };

  function setNeeds(region: SurfacePlanRegion, channel: SurfaceChannel, on: boolean) {
    const imagery = channel === 'imagery' ? on : !!region.imagery, elevation = channel === 'elevation' ? on : !!region.elevation;
    if (!imagery && !elevation) return;
    updateRegion(region.id, { intent: imagery && elevation ? 'imagery-elevation' : imagery ? 'imagery' : 'elevation' });
  }
  function setDetail(region: SurfacePlanRegion, channel: SurfaceChannel, gsdM: number) {
    if (Number.isFinite(gsdM) && gsdM > 0) updateRegion(region.id, { [channel]: { ...region[channel]!, gsdM } });
  }
  function setAccuracy(region: SurfacePlanRegion, e: Event) {
    const v = (e.currentTarget as HTMLInputElement).valueAsNumber;
    updateRegion(region.id, { elevation: { gsdM: region.elevation!.gsdM, ...(Number.isFinite(v) && v > 0 ? { accuracyM: v } : {}) } });
  }
  function budgetInput(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).valueAsNumber;
    setBudget(Number.isFinite(v) && v > 0 ? Math.round(v * 1e6) : null);
  }
  const stepIndex = (s: Step) => STEPS.findIndex((x) => x.id === s);
  function go(delta: number) { step = STEPS[Math.max(0, Math.min(STEPS.length - 1, stepIndex(step) + delta))].id; }
</script>

<InstrumentPanel key="planner" title="Surface planner" width={380} onClose={onClose} expandable>
  {#if !vs.assetsReady}
    <p class="ui-helper text-text-muted">Loading the scene…</p>
  {:else if !plan}
    <p class="ui-helper">Plan which imagery and 3D terrain an area needs, and see what existing data can supply it. Nothing is downloaded or built.</p>
    <div class="field">
      <label class="ui-label" for="planner-body">Body</label>
      <select id="planner-body" class={fieldClass} value={startBody} onchange={(e) => (chosenBody = (e.currentTarget as HTMLSelectElement).value)}>
        {#each bodies as b (b)}<option value={b}>{b}</option>{/each}
      </select>
    </div>
    {#if status?.blocked}<p class="ui-helper warn">{status.blocked}</p>{/if}
    <div class="actions">
      <button class="primary" disabled={!startBody || !!status?.blocked} onclick={() => start(drawRegion)}><PenLine size={13} /> Draw an area</button>
      <button class="secondary" disabled={!startBody || !!status?.blocked} onclick={() => start()}>Start without drawing</button>
    </div>
    <div class="actions">
      <button class="text-link ui-meta" onclick={() => fileInput?.click()}>Open a saved plan…</button>
      <button class="text-link ui-meta" onclick={() => void loadJezeroExample()}>Try the Jezero example</button>
    </div>
  {:else}
    <div class="plan-head">
      <span class="ui-section-label">{plan.body} plan</span>
      <span class="spacer"></span>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger class="icon-action" aria-label="More plan actions" title="More plan actions"><Ellipsis size={14} /></DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          <DropdownMenu.Item onSelect={() => fileInput?.click()}>Open plan, inventory or build feedback…</DropdownMenu.Item>
          <DropdownMenu.Item disabled={!plan.regions.length} onSelect={() => void exportLock()}>Save build handoff (lock JSON)…</DropdownMenu.Item>
          {#if planner.feedback}<DropdownMenu.Item onSelect={clearFeedback}>Clear build feedback</DropdownMenu.Item>{/if}
          <DropdownMenu.Item onSelect={closePlan}>Close plan</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>

    <ol class="steps" aria-label="Steps">
      {#each STEPS as s, i (s.id)}
        <li><button class:on={step === s.id} aria-current={step === s.id ? 'step' : undefined} disabled={i > 0 && !plan.regions.length} onclick={() => (step = s.id)}>
          <span class="num">{i + 1}</span>{s.label}</button></li>
      {/each}
    </ol>

    {#if step === 'area'}{@render areaStep()}
    {:else if current && step === 'detail'}{@render detailStep(current)}
    {:else if current && step === 'available'}{@render availableStep(current)}
    {:else if step === 'finish'}{@render finishStep()}{/if}

    {#if planner.message}<p class="ui-helper message" role="status">{planner.message}</p>{/if}

    {#if plan.regions.length}
      <div class="nav">
        <button class="secondary" disabled={step === 'area'} onclick={() => go(-1)}>Back</button>
        {#if step !== 'finish'}<button class="primary" onclick={() => go(1)}>Next: {STEPS[stepIndex(step) + 1].label}</button>{/if}
      </div>
    {/if}
  {/if}
  {#if planner.message && !plan}<p class="ui-helper message" role="status">{planner.message}</p>{/if}
  <input bind:this={fileInput} type="file" accept=".json,application/json" class="hidden" onchange={openFile} />
</InstrumentPanel>

{#snippet areaPicker()}
  {#if plan!.regions.length > 1}
    <select class="{fieldClass} picker" aria-label="Area" value={current?.id} onchange={(e) => focusRegion((e.currentTarget as HTMLSelectElement).value)}>
      {#each plan!.regions as r (r.id)}<option value={r.id}>{r.id}</option>{/each}
    </select>
  {/if}
{/snippet}

{#snippet areaStep()}
  <p class="ui-helper">Draw the area you need data for, or select a shape in the scene and use it.</p>
  <ul class="regions">
    {#each plan!.regions as region (region.id)}
      <li class="region" class:focused={region.id === current?.id}>
        <button class="region-name" onclick={() => focusRegion(region.id)}>
          <span class="swatch" aria-hidden="true"></span><span class="label">{region.id}</span>
        </button>
        <button class="icon-action" title="Fly to area" aria-label="Fly to {region.id}" onclick={() => focusRegion(region.id, { fly: true })}><LocateFixed size={13} /></button>
        <button class="icon-action" title="Remove area" aria-label="Remove {region.id}" onclick={() => removeRegion(region.id)}><Trash2 size={13} /></button>
      </li>
      {#if regionDrifted(region.id)}
        <li class="ui-meta warn drift">The source shape changed. <button class="text-link" onclick={() => refreshRegion(region.id)}><RefreshCw size={11} /> Use current shape</button></li>
      {/if}
    {/each}
  </ul>
  <div class="actions">
    <button class={plan!.regions.length ? 'secondary' : 'primary'} onclick={drawRegion} disabled={planner.awaitingDraw || !!status?.blocked}><PenLine size={13} /> Draw an area</button>
    <button class="secondary" disabled={!selected || !!refusal} onclick={() => addSelectedRegion()}
      title={refusal ?? (selected ? `Use ${featureLabel(selected.feature)}` : 'Select a polygon in the scene first')}>
      <Plus size={13} /> {selected ? `Use “${featureLabel(selected.feature)}”` : 'Use selected shape'}
    </button>
  </div>
  {#if refusal}<p class="ui-helper warn">{refusal}</p>{/if}
  {#if status && !status.blocked}
    <p class="ui-meta text-text-muted context">In this scene: {status.imageryLayers} imagery {status.imageryLayers === 1 ? 'layer' : 'layers'},
      {status.measuredTerrain ? 'measured 3D terrain' : 'no 3D terrain (smooth reference shape)'}. Planning doesn't change the scene.</p>
  {/if}
{/snippet}

{#snippet detailStep(region: SurfacePlanRegion)}
  {@render areaPicker()}
  <p class="ui-helper">What does <strong>{region.id}</strong> need, and how detailed?</p>
  {#each (['imagery', 'elevation'] as const) as c (c)}
    {@const f = region[c]}
    <div class="card">
      <label class="need"><input type="checkbox" checked={!!f} disabled={!!f && surfaceRegionChannels(region).length === 1}
        onchange={(e) => setNeeds(region, c, (e.currentTarget as HTMLInputElement).checked)} /> {CHANNEL[c].name}</label>
      {#if f}
        <div class="detail-row" role="group" aria-label={CHANNEL[c].detail}>
          {#each SURFACE_FIDELITY_PRESETS as p (p.id)}
            <button class="chip" class:on={f.gsdM === p[c].gsdM} title={p.description} onclick={() => setDetail(region, c, p[c].gsdM)}>{PRESET_NAME[p.id]} · {meters(p[c].gsdM)}</button>
          {/each}
        </div>
        <label class="ui-meta exact">{CHANNEL[c].detail}
          <input type="number" min="0" step="any" class="{fieldClass} num-input" value={f.gsdM} aria-label="{CHANNEL[c].detail} in meters {CHANNEL[c].unit}"
            onchange={(e) => setDetail(region, c, (e.currentTarget as HTMLInputElement).valueAsNumber)} /> m {CHANNEL[c].unit}</label>
        <p class="ui-meta text-text-muted">{CHANNEL[c].explain}</p>
      {/if}
    </div>
  {/each}
  <details class="more">
    <summary class="ui-meta">Advanced</summary>
    <div class="grid">
      {#if region.elevation}
        <label class="ui-label" for="acc-{region.id}" title="Maximum physical source uncertainty; not sample spacing">Max terrain source error (m)</label>
        <input id="acc-{region.id}" type="number" min="0" step="any" placeholder="Any" class={fieldClass} value={region.elevation.accuracyM ?? ''} onchange={(e) => setAccuracy(region, e)} />
      {/if}
      <label class="ui-label" for="pri-{region.id}">Priority</label>
      <input id="pri-{region.id}" type="number" min="0" step="1" class={fieldClass} value={region.priority ?? 0}
        onchange={(e) => { const v = (e.currentTarget as HTMLInputElement).valueAsNumber; if (Number.isSafeInteger(v) && v >= 0) updateRegion(region.id, { priority: v }); }} />
      <label class="ui-label" for="fb-{region.id}">If unmet</label>
      <select id="fb-{region.id}" class={fieldClass} value={region.fallback ?? 'require-target'} onchange={(e) => updateRegion(region.id, { fallback: (e.currentTarget as HTMLSelectElement).value as never })}>
        <option value="require-target">Require the requested detail</option>
        <option value="allow-coarser">Allow coarser</option>
        <option value="leave-unavailable">Leave unavailable</option>
      </select>
    </div>
  </details>
{/snippet}

{#snippet availableStep(region: SurfacePlanRegion)}
  {@render areaPicker()}
  {#if planner.sources.kind === 'none' && !planner.importedLock}
    {#if canFindSources(plan!.body)}
      <p class="ui-helper">Check which archive products could supply <strong>{region.id}</strong> at the requested detail.</p>
      <div class="actions"><button class="primary" onclick={() => void findSources()}>Find available imagery and terrain</button></div>
      <p class="ui-meta text-text-muted">Searches archive product metadata bundled with the viewer. Nothing is downloaded.</p>
    {:else}
      <p class="ui-helper warn">No archive product metadata for {plan!.body} is available in the viewer, so what exists here is unknown — it needs source verification.</p>
      <p class="ui-meta text-text-muted">To check, run <code>npm run discover:surface</code> with an archive query and open its inventory from the ⋯ menu.</p>
    {/if}
  {:else}
    {#if planner.sources.kind !== 'none'}<p class="ui-meta text-text-muted">Searched: {planner.sources.label}</p>{/if}
    {#each surfaceRegionChannels(region) as c (c)}
      {@const f = channelFinding(region.id, c)}
      {#if f}
        <div class="card">
          <div class="card-head"><strong>{CHANNEL[c].name}</strong><span class="verdict" data-verdict={f.verdict}>{VERDICT[f.verdict]}</span></div>
          <dl class="compare ui-meta">
            <dt>Requested</dt><dd>{meters(f.requestedM)} {CHANNEL[c].unit}</dd>
            <dt>Best candidate</dt><dd>{f.sourceIds.length ? (f.nativeM !== null ? `${meters(f.nativeM)} ${CHANNEL[c].unit} at source` : 'resolution unknown') : '—'}</dd>
            <dt>Proven coverage</dt><dd>{f.sourceIds.length ? `${pct(f.targetVerified)} of the area at the requested detail` : '—'}</dd>
          </dl>
          <p class="ui-meta">{f.summary}</p>
          {#if f.sourceIds.length}
            <button class="text-link ui-meta" onclick={() => { setFocusChannel(c); planner.showCoverage = true; installOverlay(); }}>Show on the globe</button>
          {/if}
        </div>
      {/if}
    {/each}
    {@const alts = regionAlternatives(region.id)}
    {#if alts.some((a) => a.sourceIds.length)}
      {@const chosen = chosenAlternative(region.id)}
      <details class="more">
        <summary class="ui-meta">Candidates and evidence ({alts.length})</summary>
        <ol class="alternatives">
          {#each alts as alt, i (alt.id)}
            <li>
              <label class="alt" class:on={alt === chosen}>
                <input type="radio" name="alt-{region.id}" checked={alt === chosen} onchange={() => chooseAlternative(region.id, i)} />
                <span class="alt-body ui-meta">
                  <span>{i === 0 ? 'Top-ranked' : `Option ${i + 1}`} · registration {alt.compatibility === 'evidenced' ? 'evidenced' : 'unverified'}</span>
                  {#each surfaceRegionChannels(region) as c (c)}
                    {@const ch = alt.channels[c]}
                    <span>{CHANNEL[c].name}: {ch?.sourceIds.length ? ch.sourceIds.join(', ') : 'none'}{ch ? ` — ${pct(ch.coverage.verifiedFraction)} valid, ${pct(ch.coverage.unknownFraction)} unknown, ${pct(ch.coverage.gapFraction)} gap` : ''}</span>
                  {/each}
                  <span>Source download: {range(alt.cost.downloadBytes)}</span>
                  {#if alt.warnings.length}<ul class="warnings">{#each alt.warnings as w (w)}<li>{w}</li>{/each}</ul>{/if}
                </span>
              </label>
            </li>
          {/each}
        </ol>
        <label class="ui-meta check"><input type="checkbox" checked={planner.showCoverage} onchange={(e) => { planner.showCoverage = (e.currentTarget as HTMLInputElement).checked; installOverlay(); }} /> Show coverage on the globe</label>
        <ul class="legend" aria-label="Legend">
          {#each PLANNER_LEGEND as item (item.id)}<li class="ui-meta" title={item.detail}><span class="key" style:background={item.color}></span>{item.label}</li>{/each}
        </ul>
      </details>
    {/if}
  {/if}
  {@const scene = sceneProducts(region.id)}
  {#if scene.length}
    <details class="more">
      <summary class="ui-meta">Shown in this scene ({scene.length})</summary>
      <ul class="ui-meta scene">{#each scene as p (p.name)}<li>{p.name}{p.resolutionM ? ` · about ${meters(p.resolutionM)} per pixel` : ''}</li>{/each}</ul>
      <p class="ui-meta text-text-muted">Display products, for context. They are not verified as sources for a rebuild.</p>
    </details>
  {/if}
{/snippet}

{#snippet finishStep()}
  <ul class="summary">
    {#each plan!.regions as r (r.id)}
      <li><strong>{r.id}</strong>
        {#each surfaceRegionChannels(r) as c (c)}
          {@const f = channelFinding(r.id, c)}
          {@const b = planner.feedback ? regionBuildStatus(r.id, c) : null}
          <span class="ui-meta">{CHANNEL[c].name} {meters(r[c]!.gsdM)}: <span class="verdict" data-verdict={f?.verdict}>{VERDICT[f?.verdict ?? 'not-searched']}</span>{b ? ` · ${buildLabel[b.status]}` : ''}</span>
        {/each}
      </li>
    {/each}
  </ul>
  {#if estimate}
    {@const t = estimate.totals}
    <dl class="compare ui-meta">
      <dt>Storage when published</dt><dd>{range(t.publishedBytes)}{estimate.budget ? ` · ${estimate.budget.status === 'within' ? 'within' : estimate.budget.status === 'over' ? 'over' : 'uncertain against'} the ${bytes(estimate.budget.publishedBytes)} limit` : ''}</dd>
      <dt>Source download</dt><dd>{planner.sources.kind === 'none' ? 'unknown until sources are found' : range(t.rawSourceDownloadBytes)}</dd>
    </dl>
  {/if}
  <div class="actions"><button class="primary" onclick={exportDesired}>Save plan</button></div>
  <p class="ui-meta text-text-muted">Saves the areas and requested detail as a plan file you can reopen here or use with the command-line tools.</p>

  <div class="card">
    <strong class="ui-meta">Prepare a build</strong>
    <p class="ui-meta">The planner doesn't build anything. A build handoff pins the chosen sources; the command-line build still needs a preparation step (processing settings, downloaded source files) before it can run.</p>
    <div class="actions">
      <button class="secondary" disabled={!handoff.ready} onclick={() => void exportLock()}>Save build handoff</button>
    </div>
    {#if !handoff.ready}<p class="ui-meta warn">{handoff.reason}</p>{/if}
  </div>

  <details class="more">
    <summary class="ui-meta">Details</summary>
    <div class="field inline">
      <label class="ui-label" for="planner-budget" title="Limits published storage, not source download">Storage limit (MB)</label>
      <input id="planner-budget" type="number" min="1" step="1" class={fieldClass} value={plan!.budget ? plan!.budget.publishedBytes / 1e6 : ''} placeholder="None" onchange={budgetInput} />
    </div>
    {#if estimate}
      <dl class="compare ui-meta">
        <dt>Work disk</dt><dd>{range(estimate.totals.peakWorkDiskBytes)}</dd>
        {#each estimate.budget?.comparisons ?? [] as cmp (cmp.gsdMultiplier)}
          <dt>{cmp.gsdMultiplier}× coarser</dt><dd>{cmp.regionIds.join(', ')}: {range(cmp.publishedBytes)} ({cmp.status}). Comparison only.</dd>
        {/each}
      </dl>
      <p class="ui-meta text-text-muted">Uncalibrated estimates (tile packing, compression, scratch space).</p>
    {/if}
    {#if planner.feedback}<p class="ui-meta text-text-muted">Build feedback: {planner.feedback.label}</p>{/if}
    {#if planner.problems.length}
      <ul class="problems">{#each planner.problems as d, i (i)}<li class="ui-meta" data-severity={d.severity}><code>{d.code}</code> {d.path}: {d.message}</li>{/each}</ul>
    {/if}
  </details>
{/snippet}

<style>
  .field { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
  .field.inline { margin-top: 4px; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .primary, .secondary {
    display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px; border-radius: 4px;
    font-size: var(--text-metadata); cursor: pointer;
  }
  .primary { border: none; background: var(--color-text-primary); color: var(--color-surface-1, #0d1117); font-weight: 600; }
  .secondary { border: 1px solid var(--color-border); background: var(--color-surface-2); color: var(--color-text-primary); }
  .primary:disabled, .secondary:disabled { opacity: 0.45; cursor: default; }
  .plan-head { display: flex; align-items: center; gap: 6px; }
  .spacer { flex: 1; }
  .steps { display: flex; gap: 2px; margin: 6px 0 10px; border-bottom: 1px solid var(--color-border); }
  .steps li { flex: 1; }
  .steps button { width: 100%; display: flex; align-items: center; justify-content: center; gap: 4px; padding: 4px 0 6px; border: none; border-bottom: 2px solid transparent;
    background: none; color: var(--color-text-secondary); font-size: var(--text-metadata); cursor: pointer; }
  .steps button.on { border-bottom-color: var(--color-text-primary); color: var(--color-text-primary); font-weight: 600; }
  .steps button:disabled { opacity: 0.4; cursor: default; }
  .num { display: inline-grid; place-items: center; width: 15px; height: 15px; border-radius: 50%; border: 1px solid currentColor; font-size: 10px; }
  .nav { display: flex; justify-content: space-between; margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--color-border); }
  .picker { margin-bottom: 6px; }
  .regions { display: flex; flex-direction: column; margin-top: 6px; }
  .region { display: flex; align-items: center; border-radius: 4px; }
  .region:hover, .region.focused { background: var(--color-surface-3); }
  .region-name { display: flex; flex: 1; align-items: center; gap: 6px; min-width: 0; min-height: 28px; border: none; background: none; padding: 0 4px; color: var(--color-text-primary); text-align: left; cursor: pointer; }
  .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .swatch { flex: none; width: 9px; height: 9px; border: 2px solid #f2c14e; border-radius: 2px; }
  .context { margin-top: 10px; }
  .card { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; padding: 6px 8px; border: 1px solid var(--color-border); border-radius: 4px; }
  .card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
  .need { display: flex; align-items: center; gap: 6px; font-weight: 600; color: var(--color-text-primary); }
  .detail-row { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { padding: 2px 8px; border: 1px solid var(--color-border); border-radius: 12px; background: none; color: var(--color-text-secondary); font-size: var(--text-metadata); cursor: pointer; }
  .chip.on { border-color: var(--color-text-primary); color: var(--color-text-primary); background: var(--color-surface-3); }
  .exact { display: flex; align-items: center; gap: 6px; color: var(--color-text-secondary); }
  .num-input { width: 6em; flex: none; }
  .grid { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 8px; align-items: center; margin-top: 4px; }
  .more { margin-top: 8px; }
  .more summary { cursor: pointer; color: var(--color-text-secondary); }
  .compare { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; margin-top: 4px; color: var(--color-text-secondary); }
  .compare dt { color: var(--color-text-muted); }
  .verdict { font-size: var(--text-metadata); color: var(--color-warning); }
  .verdict[data-verdict='proven'] { color: var(--color-success, #4cc38a); }
  .verdict[data-verdict='not-searched'] { color: var(--color-text-muted); }
  .summary { display: flex; flex-direction: column; gap: 4px; }
  .summary li { display: flex; flex-direction: column; }
  .alternatives { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
  .alt { display: flex; gap: 6px; padding: 4px 6px; border: 1px solid var(--color-border); border-radius: 4px; cursor: pointer; }
  .alt.on { border-color: var(--color-text-secondary); background: var(--color-surface-2); }
  .alt-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; overflow-wrap: anywhere; color: var(--color-text-secondary); }
  .warnings { margin: 2px 0 0 12px; list-style: disc; }
  .scene { margin: 4px 0 0 12px; list-style: disc; color: var(--color-text-secondary); }
  .check { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
  .legend { display: flex; flex-wrap: wrap; gap: 2px 10px; margin-top: 4px; }
  .legend li { display: inline-flex; align-items: center; gap: 4px; color: var(--color-text-secondary); }
  .key { width: 9px; height: 9px; border-radius: 2px; }
  .problems li { overflow-wrap: anywhere; margin-top: 2px; }
  .problems li[data-severity='error'] { color: var(--color-error); }
  .text-link { display: inline-flex; align-items: center; gap: 3px; border: none; background: none; padding: 0; color: var(--color-text-secondary); cursor: pointer; text-decoration: underline; }
  .text-link:hover { color: var(--color-text-primary); }
  .warn { color: var(--color-warning); }
  .drift { display: flex; gap: 6px; flex-wrap: wrap; padding: 0 4px 4px; }
  .message { margin-top: 8px; color: var(--color-text-secondary); overflow-wrap: anywhere; }
  .hidden { display: none; }
</style>
