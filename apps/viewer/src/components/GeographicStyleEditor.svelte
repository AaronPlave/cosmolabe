<script lang="ts">
  /**
   * The selected geographic layer's presentation (#199), inside Surface layers:
   * Style, Data and Labels. Style edits preview live and are kept in this
   * browser for this catalog; nothing here changes the layer's data or its
   * catalog. Imported properties are listed read-only.
   *
   * Controls appear only for the geometry types the layer has. A property rule
   * colours every part; per-part colours then show as set by the rule.
   */
  import { ArrowDown, ArrowUp, RotateCcw, Undo2, X } from 'lucide-svelte';
  import {
    describeGeographicCoordinates, geographicCategoricalRule, geographicFeatureExtent, geographicFeatureFields,
    geographicGeometryPositions, geographicSequentialRule, geographicStyleLegend, formatGeographicPosition,
    resolveGeographicStyle, GEOGRAPHIC_COLOR_RAMPS, GEOGRAPHIC_STYLE_LIMITS,
    type GeographicColorRamp, type GeographicFeature, type GeographicLayer, type GeographicPointShape,
  } from '@cosmolabe/core';
  import * as Select from '$lib/components/ui/select';
  import SegmentedControl from '$lib/components/ui/segmented-control.svelte';
  import { layerVisible, setLayerVisible } from '../lib/geographic-layers.svelte';
  import {
    geoStyles, layerStyle, updateLayerStyle, openStyleEditor, editedSinceOpen, revertStyleEdits, resetLayerStyle,
    hasLocalStyle, featureOverrideCount, moveLayer, layerRank,
  } from '../lib/geographic-styles.svelte';

  interface Props { layer: GeographicLayer }
  let { layer }: Props = $props();

  type Tab = 'style' | 'data' | 'labels';
  let tab = $state<Tab>('style');

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
  /** What the first feature draws with, as the controls' displayed values. */
  let resolved = $derived(layer.features[0] ? resolveGeographicStyle(layer, { ...style, rule: null, features: undefined }, layer.features[0]) : null);
  let ruleMode = $derived(style.rule?.kind === 'categorical' ? 'category' : style.rule?.kind === 'sequential' ? 'number' : 'single');
  let legend = $derived(style.rule ? geographicStyleLegend(layer, style.rule) : null);
  let rank = $derived((void geoStyles.order, layerRank(layer.id)));
  let edited = $derived((void geoStyles.byLayer, editedSinceOpen()));
  let exceptions = $derived((void geoStyles.byLayer, featureOverrideCount(layer.id)));

  const edit = (change: Parameters<typeof updateLayerStyle>[1]) => updateLayerStyle(layer.id, change);
  const num = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);
  const str = (e: Event) => (e.currentTarget as HTMLInputElement).value;
  const checked = (e: Event) => (e.currentTarget as HTMLInputElement).checked;

  function setRuleMode(mode: string) {
    if (mode === 'single') { edit((s) => { s.rule = null; }); return; }
    const candidates = mode === 'number' ? numericFields : fields;
    const field = style.rule?.field && candidates.some((f) => f.key === style.rule!.field) ? style.rule.field : candidates[0]?.key;
    if (field) setRuleField(mode, field);
  }
  function setRuleField(mode: string, field: string) {
    const rule = mode === 'number' ? geographicSequentialRule(layer, field) : geographicCategoricalRule(layer, field);
    if (rule) edit((s) => { s.rule = rule; });
  }

  // Data tab: counts by geometry type, the overall extent, the property schema.
  let counts = $derived.by(() => {
    const c = new Map<string, number>();
    for (const f of layer.features) c.set(f.geometry.type, (c.get(f.geometry.type) ?? 0) + 1);
    return [...c];
  });
  let extentText = $derived.by(() => {
    const all = layer.features.flatMap((f) => geographicGeometryPositions(f.geometry));
    if (!all.length) return '—';
    const extent = geographicFeatureExtent({ geometry: { type: 'MultiPoint', coordinates: all } } as GeographicFeature);
    if (extent.kind !== 'box') return 'Encloses a pole';
    const sw = formatGeographicPosition({ latDeg: extent.south, lonDeg: extent.west }, layer.coordinates, 3);
    const ne = formatGeographicPosition({ latDeg: extent.north, lonDeg: extent.east }, layer.coordinates, 3);
    return `${sw} to ${ne}`;
  });
  let license = $derived.by(() => {
    const p = layer.definition.provenance ?? {};
    for (const key of ['license', 'licence', 'rights', 'attribution', 'citation']) if (typeof p[key] === 'string') return { key, value: p[key] as string };
    return null;
  });

  let labels = $derived(style.labels ?? null);
  const shapes: GeographicPointShape[] = ['circle', 'square', 'diamond'];
</script>

<section class="style-editor" aria-label="Style and properties of {layer.name}">
  <div class="head">
    <div class="min-w-0">
      <div class="name">{layer.name}</div>
      <div class="ui-meta">{layer.body} · {layer.features.length.toLocaleString()} features{#if layer.skippedFeatures}{` · ${layer.skippedFeatures} skipped`}{/if}</div>
    </div>
    <button class="icon-button" onclick={() => openStyleEditor(null)} aria-label="Close style editor" title="Close style editor"><X size={13} /></button>
  </div>
  <div class="row ui-meta">
    <label class="inline"><input type="checkbox" checked={layerVisible(layer.id)} onchange={(e) => setLayerVisible(layer.id, checked(e))} /> Visible</label>
    {#if rank.count > 1}
      <span class="order" role="group" aria-label="Draw order">
        Order {rank.index + 1}/{rank.count}
        <button class="icon-button small" disabled={rank.index <= 0} onclick={() => moveLayer(layer.id, true)} aria-label="Draw {layer.name} above the previous layer" title="Draw above"><ArrowUp size={11} /></button>
        <button class="icon-button small" disabled={rank.index >= rank.count - 1} onclick={() => moveLayer(layer.id, false)} aria-label="Draw {layer.name} below the next layer" title="Draw below"><ArrowDown size={11} /></button>
      </span>
    {/if}
  </div>
  <div class="row ui-meta status">
    <span class="chip" data-local={hasLocalStyle(layer.id)}>
      {hasLocalStyle(layer.id) ? `Local style${exceptions ? ` · ${exceptions} feature exception${exceptions === 1 ? '' : 's'}` : ''}` : 'Catalog defaults'}
    </span>
    <button class="text-button" disabled={!edited} onclick={revertStyleEdits} title="Undo changes since this editor opened"><Undo2 size={11} /> Revert</button>
    <button class="text-button" disabled={!hasLocalStyle(layer.id)} onclick={() => resetLayerStyle(layer.id)} title="Back to the catalog’s display defaults, exceptions included"><RotateCcw size={11} /> Reset</button>
  </div>
  <p class="ui-helper note">
    {#if geoStyles.persistent}Kept in this browser for this catalog. The layer’s data and catalog are not changed.{:else}This browser refused storage: styles last for this session only.{/if}
  </p>
  {#if geoStyles.warnings[layer.id]}
    <p class="ui-helper warn">Parts of the saved style were ignored: {geoStyles.warnings[layer.id].join('; ')}.</p>
  {/if}

  <SegmentedControl value={tab} options={['style', 'data', 'labels']} label="Style editor section" onValueChange={(v) => (tab = v as Tab)} />

  {#if tab === 'style'}
    {@render slider('Layer opacity', style.opacity ?? 1, 0, 1, 0.05, '%', (v) => edit((s) => { s.opacity = v; }))}

    <div class="group">
      <div class="ui-section-label">Colour by</div>
      <SegmentedControl value={ruleMode} options={['single', 'category', 'number']} label="Colour by" onValueChange={setRuleMode} />
      {#if ruleMode !== 'single'}
        {@const candidates = ruleMode === 'number' ? numericFields : fields}
        {#if candidates.length === 0}
          <p class="ui-helper warn">No {ruleMode === 'number' ? 'numeric ' : ''}properties to colour by.</p>
        {:else}
          <Select.Root type="single" value={style.rule?.field ?? ''} onValueChange={(v) => v && setRuleField(ruleMode, v)}>
            <Select.Trigger size="sm" class="ui-control h-7 w-full rounded border-border bg-surface-3 px-2 text-text-primary" aria-label="Property">
              <Select.Value>{fields.find((f) => f.key === style.rule?.field)?.label ?? 'Property…'}</Select.Value>
            </Select.Trigger>
            <Select.Content align="start" class="max-h-64 rounded border border-border-strong bg-surface-2 p-1">
              {#each candidates as f (f.key)}<Select.Item value={f.key} label={f.label}>{f.label} <span class="ui-meta">· {f.type}, {f.count}</span></Select.Item>{/each}
            </Select.Content>
          </Select.Root>
        {/if}
        {#if style.rule?.kind === 'sequential'}
          {@const rule = style.rule}
          <SegmentedControl value={rule.ramp} options={GEOGRAPHIC_COLOR_RAMPS} label="Colour ramp" onValueChange={(v) => edit((s) => { if (s.rule?.kind === 'sequential') s.rule.ramp = v as GeographicColorRamp; })} />
          <div class="row">
            <label class="field">Min <input class="num" type="number" value={rule.min} onchange={(e) => { const v = num(e); if (Number.isFinite(v) && v <= rule.max) edit((s) => { if (s.rule?.kind === 'sequential') s.rule.min = v; }); }} /></label>
            <label class="field">Max <input class="num" type="number" value={rule.max} onchange={(e) => { const v = num(e); if (Number.isFinite(v) && v >= rule.min) edit((s) => { if (s.rule?.kind === 'sequential') s.rule.max = v; }); }} /></label>
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
        {@render color('Colour', resolved.point.color, (c) => edit((s) => { s.point = { ...s.point, color: c }; }))}
        {@render slider('Size', style.point?.sizePx ?? 7, GEOGRAPHIC_STYLE_LIMITS.sizePx[0], GEOGRAPHIC_STYLE_LIMITS.sizePx[1], 1, 'px', (v) => edit((s) => { s.point = { ...s.point, sizePx: v }; }))}
        {@render slider('Opacity', style.point?.opacity ?? 1, 0, 1, 0.05, '%', (v) => edit((s) => { s.point = { ...s.point, opacity: v }; }))}
        <SegmentedControl value={style.point?.shape ?? 'circle'} options={shapes} label="Point shape" onValueChange={(v) => edit((s) => { s.point = { ...s.point, shape: v as GeographicPointShape }; })} />
        {@render toggle('Halo', style.point?.halo ?? false, (v) => edit((s) => { s.point = { ...s.point, halo: v }; }))}
        <p class="ui-helper">Sizes are screen pixels at every distance.</p>
      </div>
    {/if}
    {#if kinds.line && resolved}
      <div class="group" role="group" aria-label="Lines">
        <div class="ui-section-label">Lines</div>
        {@render color('Colour', resolved.line.color, (c) => edit((s) => { s.line = { ...s.line, color: c }; }))}
        {@render slider('Width', style.line?.widthPx ?? 2, GEOGRAPHIC_STYLE_LIMITS.widthPx[0], GEOGRAPHIC_STYLE_LIMITS.widthPx[1], 0.5, 'px', (v) => edit((s) => { s.line = { ...s.line, widthPx: v }; }))}
        {@render slider('Opacity', style.line?.opacity ?? 1, 0, 1, 0.05, '%', (v) => edit((s) => { s.line = { ...s.line, opacity: v }; }))}
        <div class="row">
          {@render toggle('Dashed', style.line?.dashed ?? false, (v) => edit((s) => { s.line = { ...s.line, dashed: v }; }))}
          {@render toggle('Dark outline', style.line?.outline ?? false, (v) => edit((s) => { s.line = { ...s.line, outline: v }; }))}
        </div>
      </div>
    {/if}
    {#if kinds.polygon && resolved}
      <div class="group" role="group" aria-label="Polygons">
        <div class="ui-section-label">Polygons</div>
        {@render color('Fill', resolved.fill.color, (c) => edit((s) => { s.polygon = { ...s.polygon, fillColor: c }; }))}
        {@render slider('Fill opacity', style.polygon?.fillOpacity ?? 0.14, 0, 1, 0.02, '%', (v) => edit((s) => { s.polygon = { ...s.polygon, fillOpacity: v }; }))}
        {@render toggle('Hatch', style.polygon?.hatch ?? false, (v) => edit((s) => { s.polygon = { ...s.polygon, hatch: v }; }))}
        {@render color('Outline', resolved.outline.color, (c) => edit((s) => { s.polygon = { ...s.polygon, outlineColor: c }; }))}
        {@render slider('Outline width', style.polygon?.outlineWidthPx ?? 2, GEOGRAPHIC_STYLE_LIMITS.widthPx[0], GEOGRAPHIC_STYLE_LIMITS.widthPx[1], 0.5, 'px', (v) => edit((s) => { s.polygon = { ...s.polygon, outlineWidthPx: v }; }))}
        {@render slider('Outline opacity', style.polygon?.outlineOpacity ?? 1, 0, 1, 0.05, '%', (v) => edit((s) => { s.polygon = { ...s.polygon, outlineOpacity: v }; }))}
        <p class="ui-helper">Holes stay open whatever the fill.</p>
      </div>
    {/if}
    {#if exceptions}
      <div class="row ui-meta">
        <span>{exceptions} feature exception{exceptions === 1 ? '' : 's'} override colour or opacity.</span>
        <button class="text-button" onclick={() => edit((s) => { s.features = undefined; })}>Clear</button>
      </div>
    {/if}
  {:else if tab === 'data'}
    <dl class="facts ui-meta">
      <dt>Source</dt><dd class="mono break">{layer.source.identity}</dd>
      {#if layer.source.catalog}<dt>Catalog</dt><dd class="mono break">{layer.source.catalog}</dd>{/if}
      <dt>Data</dt><dd>{layer.ownership === 'catalog' ? 'Catalog' : 'Imported file'} · read-only</dd>
      <dt>Body</dt><dd>{layer.body} · {layer.frame}</dd>
      <dt>Convention</dt><dd>{describeGeographicCoordinates(layer.coordinates)}</dd>
      <dt>Features</dt><dd>{counts.map(([t, n]) => `${n.toLocaleString()} ${t}`).join(' · ') || 'none'}</dd>
      <dt>Extent</dt><dd class="mono">{extentText}</dd>
      {#if license}<dt>{license.key}</dt><dd class="break">{license.value}</dd>{/if}
    </dl>
    <div class="ui-section-label mt">Properties (read-only)</div>
    {#if fields.length === 0}
      <p class="ui-helper">No scalar properties.</p>
    {:else}
      <table class="schema ui-meta">
        <thead><tr><th>Property</th><th>Type</th><th>Present</th></tr></thead>
        <tbody>
          {#each fields as f (f.key)}
            <tr>
              <td title={f.key}>{f.label}</td>
              <td>{f.type}{#if f.categories}{` · ${f.categories.length} values`}{:else if f.min !== undefined}{` · ${Number(f.min.toPrecision(4))}–${Number(f.max!.toPrecision(4))}`}{/if}</td>
              <td>{f.count.toLocaleString()}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      <p class="ui-helper">Imported properties are shown as they are; styling never changes them.</p>
    {/if}
  {:else}
    {@render toggle('Show labels', !!labels, (v) => edit((s) => { s.labels = v ? { field: null, maxLabels: 40, sizePx: 11, halo: true } : null; }))}
    {#if labels}
      <Select.Root type="single" value={labels.field ?? ''} onValueChange={(v) => edit((s) => { if (s.labels) s.labels = { ...s.labels, field: v || null }; })}>
        <Select.Trigger size="sm" class="ui-control h-7 w-full rounded border-border bg-surface-3 px-2 text-text-primary" aria-label="Label text">
          <Select.Value>{labels.field ? fields.find((f) => f.key === labels.field)?.label ?? labels.field : 'Feature name'}</Select.Value>
        </Select.Trigger>
        <Select.Content align="start" class="max-h-64 rounded border border-border-strong bg-surface-2 p-1">
          <Select.Item value="" label="Feature name" />
          {#each fields as f (f.key)}<Select.Item value={f.key} label={f.label} />{/each}
        </Select.Content>
      </Select.Root>
      {@render slider('Text size', labels.sizePx ?? 11, GEOGRAPHIC_STYLE_LIMITS.labelSizePx[0], GEOGRAPHIC_STYLE_LIMITS.labelSizePx[1], 1, 'px', (v) => edit((s) => { if (s.labels) s.labels = { ...s.labels, sizePx: v }; }))}
      {@render slider('At most', labels.maxLabels ?? 40, 1, GEOGRAPHIC_STYLE_LIMITS.maxLabels[1], 1, '', (v) => edit((s) => { if (s.labels) s.labels = { ...s.labels, maxLabels: v }; }))}
      <label class="field">Hide beyond
        <input class="num" type="number" min="0" placeholder="any" value={labels.maxRangeKm ?? ''}
          onchange={(e) => { const v = num(e); edit((s) => { if (s.labels) s.labels = { ...s.labels, maxRangeKm: str(e) === '' || !(v > 0) ? undefined : v }; }); }} /> km from the surface
      </label>
      {@render toggle('Contrast halo', labels.halo ?? true, (v) => edit((s) => { if (s.labels) s.labels = { ...s.labels, halo: v }; }))}
      <p class="ui-helper">Overlapping labels are dropped, keeping those already shown; labels past the horizon hide.</p>
    {/if}
  {/if}
</section>

{#snippet slider(label: string, value: number, min: number, max: number, step: number, unit: string, set: (v: number) => void)}
  <label class="slider">
    <span class="slider-label">{label}</span>
    <input type="range" {min} {max} {step} {value} aria-label={label} oninput={(e) => set(num(e))} />
    <span class="ui-readout readout">{unit === '%' ? `${Math.round(value * 100)}%` : `${value}${unit ? ` ${unit}` : ''}`}</span>
  </label>
{/snippet}

{#snippet color(label: string, value: string, set: (c: string) => void)}
  <label class="slider">
    <span class="slider-label">{label}</span>
    {#if style.rule}
      <span class="ui-meta set-by">Set by “{fields.find((f) => f.key === style.rule!.field)?.label ?? style.rule.field}”</span>
    {:else}
      <input type="color" class="swatch-input" {value} aria-label={label} oninput={(e) => set(str(e))} />
      <span class="ui-readout readout mono">{value}</span>
    {/if}
  </label>
{/snippet}

{#snippet toggle(label: string, value: boolean, set: (v: boolean) => void)}
  <label class="inline ui-meta"><input type="checkbox" checked={value} onchange={(e) => set(checked(e))} /> {label}</label>
{/snippet}

<style>
  .style-editor {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid var(--color-border);
  }
  .head, .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    flex-wrap: wrap;
  }
  .head { flex-wrap: nowrap; align-items: flex-start; }
  .name { color: var(--color-text-primary); font-weight: 600; overflow-wrap: anywhere; }
  .group {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--color-border);
  }
  .inline { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
  .order { display: inline-flex; align-items: center; gap: 2px; }
  .chip {
    border-radius: 3px;
    padding: 0 6px;
    background: var(--color-control);
    color: var(--color-text-secondary);
  }
  .chip[data-local='true'] { color: var(--color-warning); }
  .note { color: var(--color-text-muted); }
  .warn { color: var(--color-warning); }
  .slider {
    display: grid;
    grid-template-columns: 92px 1fr 52px;
    align-items: center;
    gap: 6px;
  }
  .slider-label { color: var(--color-text-secondary); }
  .slider input[type='range'] { min-width: 0; }
  .readout { text-align: right; color: var(--color-text-secondary); }
  .set-by { grid-column: span 2; }
  .swatch-input {
    width: 32px;
    height: 20px;
    padding: 0;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    background: none;
    cursor: pointer;
  }
  .field { display: inline-flex; align-items: center; gap: 4px; color: var(--color-text-secondary); }
  .num {
    width: 84px;
    height: 24px;
    padding: 0 4px;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    background: var(--color-surface-3);
    color: var(--color-text-primary);
  }
  .legend { display: flex; flex-direction: column; gap: 2px; }
  .legend li { display: flex; align-items: center; gap: 6px; }
  .legend-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-primary); }
  .swatch { width: 32px; height: 12px; border-radius: 2px; flex: none; }
  .facts {
    display: grid;
    grid-template-columns: minmax(70px, auto) 1fr;
    gap: 3px 8px;
    margin: 0;
  }
  .facts dt { color: var(--color-text-secondary); }
  .facts dd { margin: 0; min-width: 0; color: var(--color-text-primary); }
  .mono { font-family: var(--font-mono, ui-monospace, monospace); }
  .break { overflow-wrap: anywhere; }
  .mt { margin-top: 4px; }
  .schema { width: 100%; border-collapse: collapse; }
  .schema th { text-align: left; font-weight: 500; color: var(--color-text-secondary); }
  .schema td, .schema th { padding: 2px 4px 2px 0; }
  .schema td:first-child { color: var(--color-text-primary); max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .icon-button, .text-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    border: none;
    border-radius: 3px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
  }
  .icon-button { width: 24px; height: 24px; flex: none; }
  .icon-button.small { width: 20px; height: 18px; }
  .text-button { padding: 2px 6px; }
  .icon-button:hover:not(:disabled), .text-button:hover:not(:disabled) { color: var(--color-text-primary); background: var(--color-surface-3); }
  .icon-button:disabled, .text-button:disabled { opacity: 0.35; cursor: default; }
</style>
