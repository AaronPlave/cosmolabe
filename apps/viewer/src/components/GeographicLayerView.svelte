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
  import { Button } from '$lib/components/ui/button';
  import { PenLine } from 'lucide-svelte';
  import GeographicLayerMenuItems from './GeographicLayerMenuItems.svelte';
  import { geoStyles, openStyleEditor } from '../lib/geographic-styles.svelte';
  import { geo, layerVisible, setLayerVisible, showLayerList } from '../lib/geographic-layers.svelte';
  import { edits, isEditable, renameLayer, deleteLayer, startDrawing, annotationLayerName } from '../lib/geographic-editing.svelte';
  import { layerIssue, layerOrigin, layerSwatch } from '../lib/geographic-layer-labels';

  interface Props { layer: GeographicLayer }
  let { layer }: Props = $props();

  let visible = $derived(layerVisible(layer.id));
  let origin = $derived(layerOrigin(layer));
  let issue = $derived(layerIssue(layer));
  let about = $state(false);
  /** Features or Style; Style is the layer the style editor has open. */
  let tab = $derived(geoStyles.editing === layer.id ? 'style' : 'features');
  let editable = $derived((void edits.revision, isEditable(layer.id)));
  /** Rename or delete, asked for from this layer's menu. */
  let action = $derived(edits.layerAction?.id === layer.id ? edits.layerAction.kind : null);
  let titleInput = $state<HTMLInputElement | null>(null);
  $effect(() => { if (action === 'rename' && titleInput) { titleInput.focus(); titleInput.select(); } });
  function finishRename(text: string) {
    if (text.trim() && text.trim() !== layer.name) renameLayer(layer.id, text);
    edits.layerAction = null;
  }
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
    {#if editable}
      <input bind:this={titleInput} class="title title-input" value={layer.name} aria-label="Layer name"
        onkeydown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
        onblur={(e) => finishRename((e.currentTarget as HTMLInputElement).value)} />
    {:else}
      <h3 class="title">{layer.name}</h3>
    {/if}
    <button class="icon-action" onclick={() => setLayerVisible(layer.id, !visible)} aria-pressed={visible}
      aria-label="{visible ? 'Hide' : 'Show'} {layer.name}" title={visible ? 'Hide layer' : 'Show layer'}>
      {#if visible}<Eye size={14} />{:else}<EyeOff size={14} />{/if}
    </button>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger class="icon-action" aria-label="More for {layer.name}" title="More"><Ellipsis size={14} /></DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        <GeographicLayerMenuItems {layer} inView />
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
  <p class="ui-meta meta">
    {layer.body} · {plural(layer.features.length, 'feature')} · <span title={origin.title}>{origin.label}</span>
    {#if issue}· <button class="issue" data-tone={issue.tone} onclick={() => (about = true)} title={issue.title}>{layer.skippedFeatures ? `${layer.skippedFeatures} not shown` : 'import notes'}</button>{/if}
  </p>

  {#if action === 'delete'}
    <div class="confirm" role="alertdialog" aria-label="Delete this layer?">
      <span class="ui-meta">Delete {layer.name} and its {plural(layer.features.length, 'feature')} from this browser? Export it first to keep a copy.</span>
      <Button variant="destructive" size="sm" class="ui-control" onclick={() => { edits.layerAction = null; deleteLayer(layer.id); showLayerList(); }}>Delete</Button>
      <Button variant="secondary" size="sm" class="ui-control" onclick={() => (edits.layerAction = null)}>Keep</Button>
    </div>
  {/if}
  <Button size="sm" class="ui-control" onclick={() => startDrawing()} title={editable ? 'New shapes go into this layer' : `New shapes go into ${annotationLayerName(layer.body)}; ${layer.name} stays unchanged`}>
    <PenLine size={13} /> {editable ? 'Draw in this layer' : 'Draw'}
  </Button>

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
  .title-input {
    padding: 1px 4px;
    border: 1px solid transparent;
    border-radius: 3px;
    background: none;
  }
  .title-input:hover { border-color: var(--color-border); }
  .title-input:focus { border-color: var(--color-border-strong); background: var(--color-surface-3); outline: none; }
  .confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
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
