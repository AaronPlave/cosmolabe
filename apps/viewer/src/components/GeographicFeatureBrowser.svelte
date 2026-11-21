<script lang="ts">
  /**
   * One layer's features: search, then a virtualized list; the property and
   * in-view filters wait behind *Filter*. Only the rows in view are rendered,
   * so a 5,000-feature layer costs the same DOM as a ten-feature one; searching
   * scans an in-memory index built once per layer.
   *
   * Click (or Enter) opens the feature, without moving the camera; its Feature
   * view has Fly to. Arrow keys move through the list and highlight each feature in
   * the scene, so a layer can be skimmed without leaving it.
   */
  import { MapPin, Spline, Hexagon, X } from 'lucide-svelte';
  import { geographicFeatureFields, type GeographicLayer, type GeographicFieldFilter, type GeographicSearchEntry } from '@cosmolabe/core';
  import { sameGeographicFeature } from '@cosmolabe/three';
  import * as Select from '$lib/components/ui/select';
  import { geometryLabel } from '../lib/geographic-layer-labels';
  import { Input } from '$lib/components/ui/input';
  import {
    geo, listedFeatures, selectFeature, hoverFeature, featureRef, setInViewOnly, syncSceneFilter,
  } from '../lib/geographic-layers.svelte';

  interface Props { layer: GeographicLayer }
  let { layer }: Props = $props();

  const ROW = 28;
  const HEIGHT = 336;
  let scroller = $state<HTMLElement | null>(null);
  let scrollTop = $state(0);

  let fields = $derived(geographicFeatureFields(layer));
  let field = $derived(geo.field ? fields.find((f) => f.key === geo.field!.key) ?? null : null);
  let rows = $derived(listedFeatures(layer));
  let first = $derived(Math.max(0, Math.floor(scrollTop / ROW) - 4));
  let visibleRows = $derived(rows.slice(first, first + Math.ceil(HEIGHT / ROW) + 8));
  /** The keyboard's row, highlighted in the list and the scene; it starts on the feature last opened. */
  let cursor = $state(-1);
  let recentIndex = $derived(geo.recent?.layerId === layer.id ? rows.findIndex((r) => r.feature.id === geo.recent!.featureId) : -1);
  let filtering = $derived(!!geo.field || geo.inViewOnly || geo.sceneFilter);
  let filterOpen = $state(false);

  function scrollTo(index: number) {
    if (!scroller || index < 0) return;
    const top = index * ROW;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + ROW > scroller.scrollTop + HEIGHT) scroller.scrollTop = top + ROW - HEIGHT;
  }
  // Back from a feature lands on it.
  $effect(() => {
    void geo.reveal;
    const index = recentIndex;
    if (index < 0) return;
    cursor = index;
    scrollTo(index);
  });

  // The list's search applies to the scene too while that is on.
  $effect(() => {
    void geo.query; void geo.field; void geo.sceneFilter; void layer;
    syncSceneFilter();
  });

  function setField(key: string) {
    const f = fields.find((x) => x.key === key);
    if (!f) { geo.field = null; return; }
    const next: GeographicFieldFilter = f.categories
      ? { key, kind: 'category', values: [] }
      : f.type === 'number' ? { key, kind: 'range' }
      : f.type === 'boolean' ? { key, kind: 'boolean', value: true }
      : { key, kind: 'text', contains: '' };
    geo.field = next;
  }

  function setCategory(value: string) {
    if (geo.field?.kind !== 'category') return;
    geo.field = { ...geo.field, values: value ? [value] : [] };
  }

  function setRange(bound: 'min' | 'max', text: string) {
    if (geo.field?.kind !== 'range') return;
    const value = text.trim() === '' ? undefined : Number(text);
    geo.field = { ...geo.field, [bound]: Number.isFinite(value) ? value : undefined };
  }

  function icon(entry: GeographicSearchEntry) {
    const type = entry.feature.geometry.type;
    return type.includes('Point') ? MapPin : type.includes('Line') ? Spline : Hexagon;
  }

  function select(entry: GeographicSearchEntry) {
    selectFeature(featureRef(layer, entry.feature));
  }

  function onKeydown(e: KeyboardEvent) {
    if (!rows.length) return;
    const move = (index: number) => {
      e.preventDefault();
      cursor = Math.max(0, Math.min(rows.length - 1, index));
      hoverFeature(featureRef(layer, rows[cursor].feature));
      scrollTo(cursor);
    };
    if (e.key === 'ArrowDown') move(cursor + 1);
    else if (e.key === 'ArrowUp') move(cursor < 0 ? rows.length - 1 : cursor - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(rows.length - 1);
    else if (e.key === 'Enter' && rows[cursor]) { e.preventDefault(); select(rows[cursor]); }
  }

  const fieldValueLabel = (n: number) => n.toLocaleString();
</script>

<section class="feature-browser" aria-label="Features of {layer.name}">
  <Input
    type="search"
    class="ui-control h-7 w-full"
    placeholder="Search this layer"
    aria-label="Search features"
    value={geo.query}
    oninput={(e) => (geo.query = (e.target as HTMLInputElement).value)}
  />

  <details class="disclosure filter" bind:open={filterOpen}>
    <summary>Filter{#if filtering}<span class="on"> · on</span>{/if}</summary>
    <div class="filters">
      <Select.Root type="single" value={geo.field?.key ?? ''} onValueChange={setField}>
        <Select.Trigger size="sm" class="ui-control h-7 min-w-0 flex-1 rounded border-border bg-surface-3 px-2 text-text-primary" aria-label="Filter field">
          <Select.Value>{field ? field.label : 'By property…'}</Select.Value>
        </Select.Trigger>
        <Select.Content align="start" class="max-h-64 rounded border border-border-strong bg-surface-2 p-1">
          <Select.Item value="" label="Any property" />
          {#each fields as f (f.key)}
            <Select.Item value={f.key} label={f.label}>{f.label}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      {#if geo.field}
        <button class="icon-button" onclick={() => (geo.field = null)} aria-label="Clear property filter" title="Clear property filter"><X size={12} /></button>
      {/if}
    </div>
    {#if geo.field && field}
      <div class="filters">
        {#if geo.field.kind === 'category'}
          <Select.Root type="single" value={geo.field.values[0] ?? ''} onValueChange={setCategory}>
            <Select.Trigger size="sm" class="ui-control h-7 min-w-0 flex-1 rounded border-border bg-surface-3 px-2 text-text-primary" aria-label="{field.label} value">
              <Select.Value>{geo.field.values[0] ?? 'Any value'}</Select.Value>
            </Select.Trigger>
            <Select.Content align="start" class="max-h-64 rounded border border-border-strong bg-surface-2 p-1">
              <Select.Item value="" label="Any value" />
              {#each field.categories ?? [] as value (value)}<Select.Item {value} label={value} />{/each}
            </Select.Content>
          </Select.Root>
        {:else if geo.field.kind === 'range'}
          <Input type="number" class="ui-control h-7 min-w-0 flex-1" placeholder="min {field.min !== undefined ? fieldValueLabel(field.min) : ''}" aria-label="{field.label} minimum"
            value={geo.field.min ?? ''} oninput={(e) => setRange('min', (e.target as HTMLInputElement).value)} />
          <Input type="number" class="ui-control h-7 min-w-0 flex-1" placeholder="max {field.max !== undefined ? fieldValueLabel(field.max) : ''}" aria-label="{field.label} maximum"
            value={geo.field.max ?? ''} oninput={(e) => setRange('max', (e.target as HTMLInputElement).value)} />
        {:else if geo.field.kind === 'boolean'}
          <Select.Root type="single" value={String(geo.field.value)} onValueChange={(v) => geo.field?.kind === 'boolean' && (geo.field = { ...geo.field, value: v === 'true' })}>
            <Select.Trigger size="sm" class="ui-control h-7 min-w-0 flex-1 rounded border-border bg-surface-3 px-2 text-text-primary" aria-label="{field.label} value">
              <Select.Value>{geo.field.value ? 'Yes' : 'No'}</Select.Value>
            </Select.Trigger>
            <Select.Content align="start" class="rounded border border-border-strong bg-surface-2 p-1">
              <Select.Item value="true" label="Yes" /><Select.Item value="false" label="No" />
            </Select.Content>
          </Select.Root>
        {:else}
          <Input type="text" class="ui-control h-7 min-w-0 flex-1" placeholder="{field.label} contains…" aria-label="{field.label} contains"
            value={geo.field.contains} oninput={(e) => geo.field?.kind === 'text' && (geo.field = { ...geo.field, contains: (e.target as HTMLInputElement).value })} />
        {/if}
      </div>
    {/if}
    <label class="toggle ui-meta" title="List only features with a vertex in the current view">
      <input type="checkbox" checked={geo.inViewOnly} onchange={(e) => setInViewOnly((e.target as HTMLInputElement).checked)} /> Only features in view
    </label>
    <label class="toggle ui-meta" title="Features that do not match are not drawn, and cannot be clicked, until this is off">
      <input type="checkbox" checked={geo.sceneFilter} onchange={(e) => (geo.sceneFilter = (e.target as HTMLInputElement).checked)} /> Hide non-matching features in 3D
    </label>
  </details>
  {#if rows.length !== layer.features.length}
    <div class="ui-meta count" aria-live="polite">{rows.length.toLocaleString()} of {layer.features.length.toLocaleString()} features</div>
  {/if}

  <div
    class="scroller"
    bind:this={scroller}
    style:height="{Math.min(HEIGHT, Math.max(rows.length, 1) * ROW)}px"
    onscroll={(e) => (scrollTop = (e.target as HTMLElement).scrollTop)}
    onkeydown={onKeydown}
    onmouseleave={() => hoverFeature(null)}
    tabindex="0"
    role="listbox"
    aria-label="Features"
    aria-activedescendant={cursor >= 0 && cursor < rows.length ? `geo-row-${cursor}` : undefined}
  >
    {#if rows.length === 0}
      <p class="ui-helper empty">{layer.features.length ? 'No features match.' : 'This layer has no valid features.'}</p>
    {:else}
      <div style:height="{rows.length * ROW}px" class="spacer">
        {#each visibleRows as entry, i (entry.feature.id)}
          {@const index = first + i}
          {@const ref = featureRef(layer, entry.feature)}
          {@const Icon = icon(entry)}
          <!-- Keys go to the listbox, which moves the selection (aria-activedescendant); options take clicks only. -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div
            id="geo-row-{index}"
            class="row"
            class:selected={index === cursor}
            class:hovered={sameGeographicFeature(geo.hovered, ref)}
            style:top="{index * ROW}px"
            role="option"
            aria-selected={index === cursor}
            tabindex="-1"
            onclick={() => select(entry)}
            onmouseenter={() => hoverFeature(ref)}
          >
            <Icon size={12} />
            <span class="name">{entry.name}</span>
            <span class="ui-meta kind">{geometryLabel(entry.feature.geometry.type)}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</section>

<style>
  .feature-browser {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .filter { border-top: none; padding-top: 0; display: flex; flex-direction: column; gap: 4px; }
  .filter[open] { display: flex; }
  .filter > :global(*:not(summary)) { margin-top: 4px; }
  .on { color: #f0c040; }
  .toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .filters {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .count {
    font-variant-numeric: tabular-nums;
  }
  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 3px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
  }
  .scroller {
    position: relative;
    overflow-y: auto;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    outline: none;
  }
  .scroller:focus-visible {
    border-color: var(--color-border-strong);
  }
  .spacer {
    position: relative;
  }
  .empty {
    padding: 6px 8px;
    color: var(--color-text-muted);
  }
  .row {
    position: absolute;
    left: 0;
    right: 0;
    height: 28px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    color: var(--color-text-secondary);
    cursor: pointer;
  }
  .row.hovered {
    background: var(--color-surface-3);
  }
  .row.selected {
    background: var(--color-control);
    color: var(--color-text-primary);
    box-shadow: inset 2px 0 0 #f0c040;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text-primary);
  }
  .kind {
    flex: none;
  }
</style>
