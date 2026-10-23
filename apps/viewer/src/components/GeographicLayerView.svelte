<script lang="ts">
  /**
   * One layer (#198): its features or its style (#199), then its information
   * behind a disclosure. Showing, hiding, "show only this layer" and draw
   * order stay one step away in the header; everything about where the data
   * comes from is under *About this layer*.
   */
  import { ChevronLeft, Ellipsis, Eye, EyeOff } from 'lucide-svelte';
  import { describeGeographicCoordinates, type GeographicLayer } from '@cosmolabe/core';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import SegmentedControl from '$lib/components/ui/segmented-control.svelte';
  import GeographicFeatureBrowser from './GeographicFeatureBrowser.svelte';
  import GeographicStyleEditor from './GeographicStyleEditor.svelte';
  import { geoStyles, openStyleEditor, layerRank, moveLayer } from '../lib/geographic-styles.svelte';
  import { geo, layerVisible, setLayerVisible, isolateLayer, isIsolated, showAllLayers, showLayerList } from '../lib/geographic-layers.svelte';
  import { layerIssue, layerOrigin, layerSwatch } from '../lib/geographic-layer-labels';

  interface Props { layer: GeographicLayer }
  let { layer }: Props = $props();

  let visible = $derived(layerVisible(layer.id));
  let origin = $derived(layerOrigin(layer));
  let issue = $derived(layerIssue(layer));
  let about = $state(false);
  /** Features or Style; Style is the layer the style editor has open. */
  let tab = $derived(geoStyles.editing === layer.id ? 'style' : 'features');
  let rank = $derived((void geoStyles.order, layerRank(layer.id)));
  // "About this layer" from a row's menu opens it once.
  $effect(() => {
    if (geo.showAbout) { about = true; geo.showAbout = false; }
  });

  const plural = (n: number, noun: string) => `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
</script>

<section class="layer-view" aria-label="Layer {layer.name}">
  <nav><button class="surface-crumb-back" onclick={showLayerList}><ChevronLeft size={13} /> Layers</button></nav>
  <div class="title-row">
    <span class="swatch" style:background={layerSwatch(layer)} aria-hidden="true"></span>
    <h3 class="title">{layer.name}</h3>
    <button class="icon-action" onclick={() => setLayerVisible(layer.id, !visible)} aria-pressed={visible}
      aria-label="{visible ? 'Hide' : 'Show'} {layer.name}" title={visible ? 'Hide layer' : 'Show layer'}>
      {#if visible}<Eye size={14} />{:else}<EyeOff size={14} />{/if}
    </button>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger class="icon-action" aria-label="More for {layer.name}" title="More"><Ellipsis size={14} /></DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        {#if isIsolated(layer.id)}
          <DropdownMenu.Item onSelect={() => showAllLayers(layer.body)}>Show all {layer.body} layers</DropdownMenu.Item>
        {:else}
          <DropdownMenu.Item onSelect={() => isolateLayer(layer.id)}>Show only this layer</DropdownMenu.Item>
        {/if}
        {#if rank.count > 1}
          <DropdownMenu.Item disabled={rank.index <= 0} onSelect={() => moveLayer(layer.id, true)}>Draw above other layers</DropdownMenu.Item>
          <DropdownMenu.Item disabled={rank.index >= rank.count - 1} onSelect={() => moveLayer(layer.id, false)}>Draw below other layers</DropdownMenu.Item>
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
  <p class="ui-meta meta">
    {layer.body} · {plural(layer.features.length, 'feature')} · <span title={origin.title}>{origin.label}</span>
    {#if issue}· <button class="issue" data-tone={issue.tone} onclick={() => (about = true)} title={issue.title}>{layer.skippedFeatures ? `${layer.skippedFeatures} not shown` : 'import notes'}</button>{/if}
  </p>

  <SegmentedControl value={tab} options={['features', 'style']} label="Layer section" onValueChange={(v) => openStyleEditor(v === 'style' ? layer.id : null)} />
  {#if tab === 'style'}
    <GeographicStyleEditor {layer} />
  {:else}
    <GeographicFeatureBrowser {layer} />
  {/if}

  <details class="disclosure" bind:open={about}>
    <summary>About this layer</summary>
    <dl class="facts ui-meta">
      <dt>Data</dt><dd>{origin.label}. {origin.title}</dd>
      <dt>Coordinates</dt><dd>{describeGeographicCoordinates(layer.coordinates)} · {layer.frame}</dd>
      <dt>Source</dt><dd class="mono break">{layer.source.identity}</dd>
      {#if layer.source.catalog}<dt>Catalog</dt><dd class="mono break">{layer.source.catalog}</dd>{/if}
      <dt>Layer ID</dt><dd class="mono break">{layer.id}</dd>
      {#each Object.entries(layer.definition.provenance ?? {}) as [key, value] (key)}
        <dt>{key}</dt><dd class="break">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
      {/each}
    </dl>
    {#if layer.diagnostics.length}
      <div class="ui-section-label sub">Import notes</div>
      <ul class="diagnostics ui-meta" aria-label="{layer.name} import notes">
        {#each layer.diagnostics.slice(0, 8) as d, i (i)}
          <li data-tone={d.severity}>{#if d.featureIndex !== undefined}Feature {d.featureIndex + 1}: {/if}{d.message}</li>
        {/each}
        {#if layer.diagnostics.length > 8}<li>…and {layer.diagnostics.length - 8} more in <code>universe.geographicLayers.loads</code></li>{/if}
      </ul>
    {/if}
  </details>
</section>

<style>
  .layer-view {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .swatch {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 2px;
  }
  .title {
    flex: 1;
    min-width: 0;
    margin: 0 0 0 2px;
    overflow: hidden;
    color: var(--color-text-primary);
    font-size: var(--text-body, 13px);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta { margin: 0; }
  .issue {
    border: none;
    background: none;
    padding: 0;
    color: var(--color-warning);
    cursor: pointer;
    text-decoration: underline dotted;
  }
  .issue[data-tone='error'] { color: var(--color-error); }
  :global(.disclosure) {
    border-top: 1px solid var(--color-border);
    padding-top: 6px;
  }
  :global(.disclosure > summary) {
    color: var(--color-text-secondary);
    font-size: var(--text-metadata);
    cursor: pointer;
    user-select: none;
  }
  :global(.disclosure > summary:hover) { color: var(--color-text-primary); }
  :global(.disclosure[open] > summary) { margin-bottom: 6px; }
  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 8px;
    margin: 0;
  }
  .facts dt { color: var(--color-text-secondary); }
  .facts dd { margin: 0; min-width: 0; color: var(--color-text-primary); }
  .sub { margin-top: 6px; }
  .mono { font-family: var(--font-mono, ui-monospace, monospace); }
  .break { overflow-wrap: anywhere; }
  .diagnostics { display: flex; flex-direction: column; gap: 2px; }
  .diagnostics li[data-tone='error'] { color: var(--color-error); }
  .diagnostics li[data-tone='warning'] { color: var(--color-warning); }
</style>
