<script lang="ts">
  /**
   * A layer's appearance (#199), the Style tab of its Layer view. Preset
   * colours and the few adjustments most annotations need come first: colour,
   * opacity, size or width, fill, labels. Colouring by a property, point
   * shapes, dashes, hatching, separate fill and outline colours and label
   * details wait under *More options*. Changes preview live by restyling in
   * place (no rebuild), are kept in this browser for this catalog, and never
   * change the layer's data or catalog.
   */
  import { Check, RotateCcw } from 'lucide-svelte';
  import {
    geographicCategoricalRule, geographicFeatureFields, geographicSequentialRule, geographicStyleLegend,
    resolveGeographicStyle, GEOGRAPHIC_COLOR_RAMPS, GEOGRAPHIC_STYLE_LIMITS,
    type GeographicColorRamp, type GeographicLayer, type GeographicPointShape,
  } from '@cosmolabe/core';
  import * as Select from '$lib/components/ui/select';
  import SegmentedControl from '$lib/components/ui/segmented-control.svelte';
  import {
    geoStyles, layerStyle, updateLayerStyle, resetLayerStyle, hasLocalStyle, featureOverrideCount,
    STYLE_PRESETS, setLayerColor, layerColor, setLayerLineWidth,
  } from '../lib/geographic-styles.svelte';

  interface Props { layer: GeographicLayer }
  let { layer }: Props = $props();

  let style = $derived(layerStyle(layer.id));
  let fields = $derived(geographicFeatureFields(layer));
  let numericFields = $derived(fields.filter((f) => f.type === 'number'));
  let kinds = $derived.by(() => {
    const has = { point: false, line: false, polygon: false };
    for (const f of layer.features) {
      const t = f.geometry.type;
      if (t.includes('Point')) has.point = true; else if (t.includes('Line')) has.line = true; else has.polygon = true;
    }
    return has;
  });
  /** What the first feature draws with, as the advanced controls' displayed values. */
  let resolved = $derived(layer.features[0] ? resolveGeographicStyle(layer, { ...style, rule: null, features: undefined }, layer.features[0]) : null);
  let color = $derived((void geoStyles.byLayer, layerColor(layer)));
  let ruleMode = $derived(style.rule?.kind === 'categorical' ? 'category' : style.rule?.kind === 'sequential' ? 'number' : 'one colour');
  let legend = $derived(style.rule ? geographicStyleLegend(layer, style.rule) : null);
  let ownColours = $derived((void geoStyles.byLayer, featureOverrideCount(layer.id)));
  let labels = $derived(style.labels ?? null);
  let more = $state(false);

  const edit = (change: Parameters<typeof updateLayerStyle>[1]) => updateLayerStyle(layer.id, change);
  const num = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);
  const str = (e: Event) => (e.currentTarget as HTMLInputElement).value;
  const checked = (e: Event) => (e.currentTarget as HTMLInputElement).checked;

  function setRuleMode(mode: string) {
    if (mode === 'one colour') { edit((s) => { s.rule = null; }); return; }
    const candidates = mode === 'number' ? numericFields : fields;
    const field = style.rule?.field && candidates.some((f) => f.key === style.rule!.field) ? style.rule.field : candidates[0]?.key;
    if (field) setRuleField(mode, field);
  }
  function setRuleField(mode: string, field: string) {
    const rule = mode === 'number' ? geographicSequentialRule(layer, field) : geographicCategoricalRule(layer, field);
    if (rule) edit((s) => { s.rule = rule; });
  }
  const shapes: GeographicPointShape[] = ['circle', 'square', 'diamond'];
</script>

<section class="appearance" aria-label="Style of {layer.name}">
  {#if geoStyles.warnings[layer.id]}
    <p class="ui-helper warn">Parts of the saved style were ignored: {geoStyles.warnings[layer.id].join('; ')}.</p>
  {/if}

  <div class="field-row" role="group" aria-label="Colour">
    <span class="label">Colour</span>
    <div class="presets">
      {#each STYLE_PRESETS as preset (preset.color)}
        <button class="preset" style:background={preset.color} aria-label={preset.label} title={preset.label}
          aria-pressed={!style.rule && color === preset.color} onclick={() => setLayerColor(layer.id, preset.color)}>
          {#if !style.rule && color === preset.color}<Check size={11} />{/if}
        </button>
      {/each}
      <input type="color" class="custom" value={color} aria-label="Custom colour" title="Custom colour"
        oninput={(e) => setLayerColor(layer.id, str(e))} />
    </div>
  </div>
  {#if style.rule}
    <p class="ui-helper">Coloured by “{fields.find((f) => f.key === style.rule!.field)?.label ?? style.rule.field}”; picking a colour above returns to one colour.</p>
  {/if}

  {@render slider('Opacity', style.opacity ?? 1, 0, 1, 0.05, '%', (v) => edit((s) => { s.opacity = v; }))}
  {#if kinds.point}
    {@render slider('Point size', style.point?.sizePx ?? 7, GEOGRAPHIC_STYLE_LIMITS.sizePx[0], GEOGRAPHIC_STYLE_LIMITS.sizePx[1], 1, 'px', (v) => edit((s) => { s.point = { ...s.point, sizePx: v }; }))}
  {/if}
  {#if kinds.line || kinds.polygon}
    {@render slider('Line width', style.line?.widthPx ?? style.polygon?.outlineWidthPx ?? 2, GEOGRAPHIC_STYLE_LIMITS.widthPx[0], GEOGRAPHIC_STYLE_LIMITS.widthPx[1], 0.5, 'px', (v) => setLayerLineWidth(layer.id, v))}
  {/if}
  {#if kinds.polygon}
    {@render slider('Fill', style.polygon?.fillOpacity ?? 0.14, 0, 1, 0.02, '%', (v) => edit((s) => { s.polygon = { ...s.polygon, fillOpacity: v }; }))}
  {/if}

  <label class="inline">
    <input type="checkbox" checked={!!labels} onchange={(e) => edit((s) => { s.labels = checked(e) ? { field: null, maxLabels: 40, sizePx: 11, halo: true } : null; })} />
    Labels
  </label>
  {#if labels && fields.length}
    <Select.Root type="single" value={labels.field ?? ''} onValueChange={(v) => edit((s) => { if (s.labels) s.labels = { ...s.labels, field: v || null }; })}>
      <Select.Trigger size="sm" class="ui-control h-7 w-full rounded border-border bg-surface-3 px-2 text-text-primary" aria-label="Label text">
        <Select.Value>{labels.field ? `Label with ${fields.find((f) => f.key === labels.field)?.label ?? labels.field}` : 'Label with name'}</Select.Value>
      </Select.Trigger>
      <Select.Content align="start" class="max-h-64 rounded border border-border-strong bg-surface-2 p-1">
        <Select.Item value="" label="Name" />
        {#each fields as f (f.key)}<Select.Item value={f.key} label={f.label} />{/each}
      </Select.Content>
    </Select.Root>
  {/if}

  <details class="disclosure" bind:open={more}>
    <summary>More options</summary>
    <div class="more">
      <div class="group" role="group" aria-label="Colour by">
        <div class="ui-section-label">Colour by</div>
        <SegmentedControl value={ruleMode} options={['one colour', 'category', 'number']} label="Colour by" onValueChange={setRuleMode} />
        {#if ruleMode !== 'one colour'}
          {@const candidates = ruleMode === 'number' ? numericFields : fields}
          {#if candidates.length === 0}
            <p class="ui-helper warn">No {ruleMode === 'number' ? 'numeric ' : ''}properties to colour by.</p>
          {:else}
            <Select.Root type="single" value={style.rule?.field ?? ''} onValueChange={(v) => v && setRuleField(ruleMode, v)}>
              <Select.Trigger size="sm" class="ui-control h-7 w-full rounded border-border bg-surface-3 px-2 text-text-primary" aria-label="Property">
                <Select.Value>{fields.find((f) => f.key === style.rule?.field)?.label ?? 'Property…'}</Select.Value>
              </Select.Trigger>
              <Select.Content align="start" class="max-h-64 rounded border border-border-strong bg-surface-2 p-1">
                {#each candidates as f (f.key)}<Select.Item value={f.key} label={f.label}>{f.label} <span class="ui-meta">· {f.count}</span></Select.Item>{/each}
              </Select.Content>
            </Select.Root>
          {/if}
          {#if style.rule?.kind === 'sequential'}
            {@const rule = style.rule}
            <SegmentedControl value={rule.ramp} options={GEOGRAPHIC_COLOR_RAMPS} label="Colour ramp" onValueChange={(v) => edit((s) => { if (s.rule?.kind === 'sequential') s.rule.ramp = v as GeographicColorRamp; })} />
            <div class="row">
              <label class="field">From <input class="num" type="number" value={rule.min} onchange={(e) => { const v = num(e); if (Number.isFinite(v) && v <= rule.max) edit((s) => { if (s.rule?.kind === 'sequential') s.rule.min = v; }); }} /></label>
              <label class="field">to <input class="num" type="number" value={rule.max} onchange={(e) => { const v = num(e); if (Number.isFinite(v) && v >= rule.min) edit((s) => { if (s.rule?.kind === 'sequential') s.rule.max = v; }); }} /></label>
            </div>
          {/if}
          {#if legend}
            <ul class="legend" aria-label="Legend">
              {#each legend.entries as entry (entry.label)}
                <li>
                  {#if style.rule?.kind === 'categorical' && entry.label in style.rule.colors}
                    <input type="color" class="swatch-input" value={entry.color} aria-label="Colour for {entry.label}"
                      oninput={(e) => { const c = str(e); edit((s) => { if (s.rule?.kind === 'categorical') s.rule.colors = { ...s.rule.colors, [entry.label]: c }; }); }} />
                  {:else}
                    <span class="swatch" style:background={entry.color} aria-hidden="true"></span>
                  {/if}
                  <span class="legend-label">{entry.label}</span>
                  <span class="ui-meta">{entry.count.toLocaleString()}</span>
                </li>
              {/each}
            </ul>
            {#each legend.warnings as warning (warning)}<p class="ui-helper warn">{warning}</p>{/each}
          {/if}
        {/if}
      </div>

      {#if kinds.point && resolved}
        <div class="group" role="group" aria-label="Points">
          <div class="ui-section-label">Points</div>
          <SegmentedControl value={style.point?.shape ?? 'circle'} options={shapes} label="Point shape" onValueChange={(v) => edit((s) => { s.point = { ...s.point, shape: v as GeographicPointShape }; })} />
          {@render toggle('Halo', style.point?.halo ?? false, (v) => edit((s) => { s.point = { ...s.point, halo: v }; }))}
        </div>
      {/if}
      {#if kinds.line && resolved}
        <div class="group" role="group" aria-label="Lines">
          <div class="ui-section-label">Lines</div>
          <div class="row">
            {@render toggle('Dashed', style.line?.dashed ?? false, (v) => edit((s) => { s.line = { ...s.line, dashed: v }; }))}
            {@render toggle('Dark outline', style.line?.outline ?? false, (v) => edit((s) => { s.line = { ...s.line, outline: v }; }))}
          </div>
        </div>
      {/if}
      {#if kinds.polygon && resolved}
        <div class="group" role="group" aria-label="Areas">
          <div class="ui-section-label">Areas</div>
          {@render colorInput('Fill colour', resolved.fill.color, (c) => edit((s) => { s.polygon = { ...s.polygon, fillColor: c }; }))}
          {@render colorInput('Outline colour', resolved.outline.color, (c) => edit((s) => { s.polygon = { ...s.polygon, outlineColor: c }; }))}
          {@render toggle('Hatch', style.polygon?.hatch ?? false, (v) => edit((s) => { s.polygon = { ...s.polygon, hatch: v }; }))}
        </div>
      {/if}
      {#if labels}
        <div class="group" role="group" aria-label="Label details">
          <div class="ui-section-label">Labels</div>
          {@render slider('Text size', labels.sizePx ?? 11, GEOGRAPHIC_STYLE_LIMITS.labelSizePx[0], GEOGRAPHIC_STYLE_LIMITS.labelSizePx[1], 1, 'px', (v) => edit((s) => { if (s.labels) s.labels = { ...s.labels, sizePx: v }; }))}
          {@render slider('At most', labels.maxLabels ?? 40, 1, GEOGRAPHIC_STYLE_LIMITS.maxLabels[1], 1, '', (v) => edit((s) => { if (s.labels) s.labels = { ...s.labels, maxLabels: v }; }))}
          <label class="field">Hide beyond
            <input class="num" type="number" min="0" placeholder="any" value={labels.maxRangeKm ?? ''}
              onchange={(e) => { const v = num(e); edit((s) => { if (s.labels) s.labels = { ...s.labels, maxRangeKm: str(e) === '' || !(v > 0) ? undefined : v }; }); }} /> km
          </label>
          {@render toggle('Contrast halo', labels.halo ?? true, (v) => edit((s) => { if (s.labels) s.labels = { ...s.labels, halo: v }; }))}
        </div>
      {/if}
      {#if ownColours}
        <div class="row ui-meta">
          <span>{ownColours} {ownColours === 1 ? 'feature has its' : 'features have their'} own colour.</span>
          <button class="text-button" onclick={() => edit((s) => { s.features = undefined; })}>Use the layer's</button>
        </div>
      {/if}
    </div>
  </details>

  <div class="footer">
    <button class="text-button" disabled={!hasLocalStyle(layer.id)} onclick={() => resetLayerStyle(layer.id)} title="Back to the catalog’s style, single features’ colours included">
      <RotateCcw size={11} /> Reset to catalog style
    </button>
    {#if !geoStyles.persistent}<span class="ui-meta warn">Not saved: this browser refused storage.</span>{/if}
  </div>
</section>

{#snippet slider(label: string, value: number, min: number, max: number, step: number, unit: string, set: (v: number) => void)}
  <label class="slider">
    <span class="label">{label}</span>
    <input type="range" {min} {max} {step} {value} aria-label={label} oninput={(e) => set(num(e))} />
    <span class="ui-readout readout">{unit === '%' ? `${Math.round(value * 100)}%` : `${value}${unit ? ` ${unit}` : ''}`}</span>
  </label>
{/snippet}

{#snippet colorInput(label: string, value: string, set: (c: string) => void)}
  <label class="slider">
    <span class="label">{label}</span>
    {#if style.rule}
      <span class="ui-meta">Set by the property colours</span>
    {:else}
      <input type="color" class="swatch-input" {value} aria-label={label} oninput={(e) => set(str(e))} />
    {/if}
  </label>
{/snippet}

{#snippet toggle(label: string, value: boolean, set: (v: boolean) => void)}
  <label class="inline ui-meta"><input type="checkbox" checked={value} onchange={(e) => set(checked(e))} /> {label}</label>
{/snippet}

<style>
  .appearance {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .field-row {
    display: grid;
    grid-template-columns: 72px 1fr;
    align-items: center;
    gap: 8px;
  }
  .label {
    color: var(--color-text-secondary);
    font-size: var(--text-metadata);
  }
  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .preset, .custom {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 1px solid #0006;
    border-radius: 50%;
    color: #111;
    cursor: pointer;
  }
  .preset[aria-pressed='true'] { box-shadow: 0 0 0 2px var(--color-surface-1, #111), 0 0 0 3px var(--color-text-primary); }
  .custom { background: none; border: 1px dashed var(--color-border-strong); }
  .custom::-webkit-color-swatch-wrapper { padding: 2px; }
  .custom::-webkit-color-swatch { border: none; border-radius: 50%; }
  .slider {
    display: grid;
    grid-template-columns: 72px 1fr 44px;
    align-items: center;
    gap: 8px;
  }
  .slider input[type='range'] { width: 100%; }
  .readout { text-align: right; }
  .inline {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--color-text-primary);
    font-size: var(--text-metadata);
    cursor: pointer;
  }
  .more { display: flex; flex-direction: column; gap: 10px; }
  .group { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
  .field { display: inline-flex; align-items: center; gap: 4px; font-size: var(--text-metadata); color: var(--color-text-secondary); }
  .num {
    width: 72px;
    padding: 2px 4px;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    background: var(--color-surface-3);
    color: var(--color-text-primary);
  }
  .legend { display: flex; flex-direction: column; gap: 2px; }
  .legend li { display: flex; align-items: center; gap: 6px; }
  .legend-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-metadata); }
  .swatch { width: 12px; height: 12px; border-radius: 2px; }
  .swatch-input { width: 22px; height: 18px; padding: 0; border: none; background: none; cursor: pointer; }
  .footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px solid var(--color-border); padding-top: 6px; }
  .text-button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: none;
    background: none;
    padding: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-metadata);
    cursor: pointer;
  }
  .text-button:hover:not(:disabled) { color: var(--color-text-primary); }
  .text-button:disabled { opacity: 0.4; cursor: default; }
  .warn { color: var(--color-warning); }
</style>
