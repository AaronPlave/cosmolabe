<script lang="ts">
  /**
   * Surface layers (#198): one panel with three views, chosen by the selection
   * (docs/design/surface-layers-ux.md). *Layers* lists each body's vector
   * layers and imagery, with a search across every layer; *Layer* shows one
   * layer's features, with its information behind a disclosure; *Feature*
   * shows the selected feature. Rare actions live in each row's "…" menu.
   */
  import { ChevronLeft, ChevronRight, Ellipsis, Eye, EyeOff, Images } from 'lucide-svelte';
  import type { GeographicLayer, GeographicLayerLoad } from '@cosmolabe/core';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import { Input } from '$lib/components/ui/input';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';
  import ImageryLayersSection from './ImageryLayersSection.svelte';
  import GeographicLayerView from './GeographicLayerView.svelte';
  import GeographicFeatureDetails from './GeographicFeatureDetails.svelte';
  import { vs, getRenderer } from '../lib/viewer-state.svelte';
  import {
    geo, geographicLoads, layerVisible, setLayerVisible, isolateLayer, isIsolated, showAllLayers, hoverFeature,
    surfacePanelView, openLayer, openImagery, showLayerList, searchAllFeatures, selectFeature, featureRef, goToFeature,
    GLOBAL_SEARCH_LIMIT,
  } from '../lib/geographic-layers.svelte';
  import { layerSwatch, layerIssue } from '../lib/geographic-layer-labels';

  interface Props { onClose: () => void; }
  let { onClose }: Props = $props();

  interface Group { body: string; imagery: number; layers: GeographicLayer[] }

  /** Imagery is polled the way its own section polls it; vector layers follow `geo.revision`. */
  let tick = $derived((void vs.frameTick, Math.floor(performance.now() / 1000)));

  let groups = $derived.by((): Group[] => {
    void tick;
    const r = getRenderer();
    const byBody = new Map<string, Group>();
    const group = (body: string) => {
      let g = byBody.get(body);
      if (!g) { g = { body, imagery: 0, layers: [] }; byBody.set(body, g); }
      return g;
    };
    for (const load of geographicLoads()) if (load.status === 'ready' && load.layer) group(load.layer.body).layers.push(load.layer);
    for (const { name } of vs.bodies) {
      const n = r?.getBodyMesh(name)?.imageryLayers.length ?? 0;
      if (n > 0) group(name).imagery = n;
    }
    return [...byBody.values()].sort((a, b) => a.body.localeCompare(b.body));
  });
  let failures = $derived(geographicLoads().filter((load) => load.status === 'error'));
  let view = $derived(surfacePanelView());
  let search = $derived(searchAllFeatures(geo.globalQuery));

  function close() {
    hoverFeature(null);
    onClose();
  }

  const failureLabel = (load: GeographicLayerLoad) => load.id || load.source.identity || 'Unnamed layer';
</script>

<InstrumentPanel key="layers" title="Surface layers" width={340} onClose={close}>
  {#if !vs.assetsReady}
    <p class="ui-helper text-text-muted">Loading the scene…</p>
  {:else if view.kind === 'feature'}
    <GeographicFeatureDetails layer={view.layer} feature={view.feature} />
  {:else if view.kind === 'layer'}
    <GeographicLayerView layer={view.layer} />
  {:else if view.kind === 'imagery'}
    <nav class="crumb"><button class="back" onclick={showLayerList}><ChevronLeft size={13} /> Layers</button></nav>
    <ImageryLayersSection bodyName={view.body} startOpen />
  {:else if groups.length === 0 && failures.length === 0}
    <p class="ui-helper text-text-muted">
      No imagery or geographic layers in this scene. Catalogs add vector data with
      <code>geographicLayers</code>; see docs/geographic-layers.md.
    </p>
  {:else}
    {#if groups.some((g) => g.layers.length)}
      <Input
        type="search"
        class="ui-control h-7 w-full"
        placeholder="Search all features"
        aria-label="Search all features"
        value={geo.globalQuery}
        oninput={(e) => (geo.globalQuery = (e.target as HTMLInputElement).value)}
      />
    {/if}

    {#if geo.globalQuery.trim()}
      <ul class="results" aria-label="Search results">
        {#each search.matches as { layer, entry } (`${layer.id}/${entry.feature.id}`)}
          {@const ref = featureRef(layer, entry.feature)}
          <li>
            <button class="result" onclick={() => selectFeature(ref)} ondblclick={() => goToFeature(ref)}
              onmouseenter={() => hoverFeature(ref)} onmouseleave={() => hoverFeature(null)}>
              <span class="name">{entry.name}</span>
              <span class="ui-meta where">{layer.name} · {layer.body}</span>
            </button>
          </li>
        {:else}
          <li class="ui-helper text-text-muted">No features match.</li>
        {/each}
      </ul>
      {#if search.total > GLOBAL_SEARCH_LIMIT}
        <p class="ui-helper text-text-muted">{search.total.toLocaleString()} matches; the first {GLOBAL_SEARCH_LIMIT} are listed. Open a layer to see all of its matches.</p>
      {/if}
    {:else}
      {#each groups as group (group.body)}
        <section class="body-group" aria-label="{group.body} surface layers">
          <div class="body-header">
            <span class="ui-section-label">{group.body}</span>
            {#if group.layers.some((l) => !layerVisible(l.id))}
              <button class="text-link ui-meta" onclick={() => showAllLayers(group.body)}>Show all</button>
            {/if}
          </div>
          <ul class="flex flex-col" aria-label="{group.body} layers">
            {#each group.layers as layer (layer.id)}
              {@const visible = layerVisible(layer.id)}
              {@const issue = layerIssue(layer)}
              <li class="layer" class:off={!visible}>
                <button class="icon-action" onclick={() => setLayerVisible(layer.id, !visible)} aria-pressed={visible}
                  aria-label="{visible ? 'Hide' : 'Show'} {layer.name}" title={visible ? 'Hide layer' : 'Show layer'}>
                  {#if visible}<Eye size={14} />{:else}<EyeOff size={14} />{/if}
                </button>
                <span class="swatch" style:background={layerSwatch(layer)} aria-hidden="true"></span>
                <button class="layer-name" onclick={() => openLayer(layer.id)} aria-label="Open {layer.name}" title="Features, appearance and information">
                  <span class="label">{layer.name}</span>
                  {#if issue}<span class="dot" data-tone={issue.tone} title={issue.title}></span>{/if}
                  <span class="ui-meta count">{layer.features.length.toLocaleString()}</span>
                </button>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger class="icon-action" aria-label="More for {layer.name}" title="More"><Ellipsis size={14} /></DropdownMenu.Trigger>
                  <DropdownMenu.Content align="end">
                    {#if isIsolated(layer.id)}
                      <DropdownMenu.Item onSelect={() => showAllLayers(layer.body)}>Show all {layer.body} layers</DropdownMenu.Item>
                    {:else}
                      <DropdownMenu.Item onSelect={() => isolateLayer(layer.id)}>Show only this layer</DropdownMenu.Item>
                    {/if}
                    <DropdownMenu.Item onSelect={() => openLayer(layer.id, { about: true })}>About this layer</DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Root>
              </li>
            {/each}
            {#if group.imagery}
              <li class="layer">
                <span class="icon-action static" aria-hidden="true"><Images size={14} /></span>
                <button class="layer-name" onclick={() => openImagery(group.body)} aria-label="{group.body} imagery">
                  <span class="label">Imagery</span>
                  <span class="ui-meta count">{group.imagery}</span>
                  <ChevronRight size={13} />
                </button>
              </li>
            {/if}
          </ul>
        </section>
      {/each}

      {#if failures.length}
        <details class="body-group">
          <summary class="ui-meta failed-summary">{failures.length} {failures.length === 1 ? 'layer' : 'layers'} failed to load</summary>
          <ul class="flex flex-col gap-1" aria-label="Layers that failed to load">
            {#each failures as load, i (i)}
              <li class="ui-meta failure">
                <span class="text-text-primary">{failureLabel(load)}</span>
                {#each load.diagnostics as d, j (j)}<div>{d.message}</div>{/each}
              </li>
            {/each}
          </ul>
        </details>
      {/if}
    {/if}
  {/if}
  {#if geo.notice}<p class="ui-helper notice" role="status">{geo.notice}</p>{/if}
</InstrumentPanel>

<style>
  .body-group {
    margin-top: 10px;
  }
  .body-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .text-link {
    border: none;
    background: none;
    padding: 0;
    color: var(--color-text-secondary);
    cursor: pointer;
  }
  .text-link:hover { color: var(--color-text-primary); }
  .layer {
    display: flex;
    align-items: center;
    gap: 2px;
    min-height: 28px;
    border-radius: 4px;
  }
  .layer:hover { background: var(--color-surface-3); }
  .layer.off .label, .layer.off .swatch { opacity: 0.45; }
  .swatch {
    flex: none;
    width: 9px;
    height: 9px;
    margin: 0 4px 0 2px;
    border-radius: 2px;
  }
  .layer-name {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 6px;
    min-width: 0;
    min-height: 28px;
    border: none;
    background: none;
    padding: 0 2px;
    color: var(--color-text-primary);
    text-align: left;
    cursor: pointer;
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count { flex: none; font-variant-numeric: tabular-nums; }
  .dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-warning);
  }
  .dot[data-tone='error'] { background: var(--color-error); }
  :global(.icon-action) {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 3px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
  }
  :global(.icon-action:hover) { color: var(--color-text-primary); background: var(--color-control-hover, var(--color-surface-2)); }
  .static { cursor: default; }
  .static:hover { background: none; }
  .results {
    display: flex;
    flex-direction: column;
    margin-top: 6px;
  }
  .result {
    display: flex;
    width: 100%;
    flex-direction: column;
    align-items: flex-start;
    border: none;
    border-radius: 4px;
    background: none;
    padding: 4px 6px;
    color: var(--color-text-primary);
    text-align: left;
    cursor: pointer;
  }
  .result:hover { background: var(--color-surface-3); }
  .result .name { overflow-wrap: anywhere; }
  .where { color: var(--color-text-secondary); }
  .crumb { margin-bottom: 6px; }
  :global(.surface-crumb-back), .back {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    border: none;
    background: none;
    padding: 2px 0;
    color: var(--color-text-secondary);
    cursor: pointer;
  }
  .back:hover { color: var(--color-text-primary); }
  .failed-summary { color: var(--color-error); cursor: pointer; }
  .failure {
    color: var(--color-error);
    overflow-wrap: anywhere;
  }
  .notice {
    margin-top: 6px;
    color: var(--color-warning);
  }
</style>
