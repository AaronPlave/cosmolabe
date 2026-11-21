<script lang="ts">
  /**
   * The "…" menu entries of a vector layer (#198–#200), shared by its row in
   * the list and its Layer view, so rare actions live in one place: showing
   * only this layer, style, draw order and information for every layer; for
   * your own layers rename, export and delete; for read-only ones, an editable
   * copy of the whole layer.
   */
  import type { GeographicLayer } from '@cosmolabe/core';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import { isolateLayer, isIsolated, showAllLayers, openLayer } from '../lib/geographic-layers.svelte';
  import { openStyleEditor, layerRank, moveLayer } from '../lib/geographic-styles.svelte';
  import { edits, isEditable, exportLayer, exportCompanionCatalog, makeWorkingCopy } from '../lib/geographic-editing.svelte';

  interface Props { layer: GeographicLayer; inView?: boolean }
  let { layer, inView = false }: Props = $props();
  let rank = $derived(layerRank(layer.id));
  let editable = $derived((void edits.revision, isEditable(layer.id)));
</script>

{#if isIsolated(layer.id)}
  <DropdownMenu.Item onSelect={() => showAllLayers(layer.body)}>Show all {layer.body} layers</DropdownMenu.Item>
{:else}
  <DropdownMenu.Item onSelect={() => isolateLayer(layer.id)}>Show only this layer</DropdownMenu.Item>
{/if}
{#if !inView}
  <DropdownMenu.Item onSelect={() => { openLayer(layer.id); openStyleEditor(layer.id); }}>Style</DropdownMenu.Item>
{/if}
{#if rank.count > 1}
  <DropdownMenu.Item disabled={rank.index <= 0} onSelect={() => moveLayer(layer.id, true)}>Draw above other layers</DropdownMenu.Item>
  <DropdownMenu.Item disabled={rank.index >= rank.count - 1} onSelect={() => moveLayer(layer.id, false)}>Draw below other layers</DropdownMenu.Item>
{/if}
{#if editable}
  <DropdownMenu.Item onSelect={() => { openLayer(layer.id); edits.layerAction = { id: layer.id, kind: 'rename' }; }}>Rename…</DropdownMenu.Item>
  <DropdownMenu.Item onSelect={() => exportLayer(layer.id)}>Export GeoJSON</DropdownMenu.Item>
  <DropdownMenu.Item onSelect={() => exportCompanionCatalog(layer.id)}>Export catalog for it</DropdownMenu.Item>
  <DropdownMenu.Item onSelect={() => { openLayer(layer.id); edits.layerAction = { id: layer.id, kind: 'delete' }; }}>Delete layer…</DropdownMenu.Item>
{:else}
  <DropdownMenu.Item onSelect={() => { const id = makeWorkingCopy(layer); if (id) openLayer(id); }}>Edit a copy of this layer</DropdownMenu.Item>
{/if}
{#if !inView}
  <DropdownMenu.Item onSelect={() => openLayer(layer.id, { about: true })}>About this layer</DropdownMenu.Item>
{/if}
