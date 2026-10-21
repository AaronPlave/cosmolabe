<script lang="ts">
  /**
   * Surface layers (#198): one place for every body's imagery stack and
   * geographic vector layers. Imagery reuses the info panel's section, so there
   * is still one imagery manager; physical surface appearance stays in the info
   * panel. Vector layers list their source and read-only status, and one layer
   * at a time is browsed feature by feature below.
   */
  import { ChevronDown, ChevronRight, Focus, List } from 'lucide-svelte';
  import { describeGeographicCoordinates, type GeographicLayer, type GeographicLayerLoad } from '@cosmolabe/core';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';
  import ImageryLayersSection from './ImageryLayersSection.svelte';
  import GeographicFeatureBrowser from './GeographicFeatureBrowser.svelte';
  import GeographicFeatureDetails from './GeographicFeatureDetails.svelte';
  import { vs, getRenderer } from '../lib/viewer-state.svelte';
  import {
    geo, geographicLoads, geographicLayer, layerVisible, setLayerVisible, isolateLayer, isIsolated, showAllLayers,
    browseLayer, hoverFeature,
  } from '../lib/geographic-layers.svelte';

  interface Props { onClose: () => void; }
  let { onClose }: Props = $props();

  interface Group { body: string; imagery: boolean; layers: GeographicLayer[] }

  /** Imagery is polled the way its own section polls it; vector layers follow `geo.revision`. */
  let tick = $derived((void vs.frameTick, Math.floor(performance.now() / 1000)));

  let groups = $derived.by((): Group[] => {
    void tick;
    const r = getRenderer();
    const byBody = new Map<string, Group>();
    const group = (body: string) => {
      let g = byBody.get(body);
      if (!g) { g = { body, imagery: false, layers: [] }; byBody.set(body, g); }
      return g;
    };
    for (const load of geographicLoads()) if (load.status === 'ready' && load.layer) group(load.layer.body).layers.push(load.layer);
    for (const { name } of vs.bodies) if ((r?.getBodyMesh(name)?.imageryLayers.length ?? 0) > 0) group(name).imagery = true;
    return [...byBody.values()].sort((a, b) => a.body.localeCompare(b.body));
  });
  let failures = $derived(geographicLoads().filter((load) => load.status === 'error'));
  let active = $derived(geographicLayer(geo.activeLayerId));

  /** Layers whose details are expanded, by id. */
  let expanded = $state(new Set<string>());
  function toggleExpanded(id: string) {
    const next = new Set(expanded);
    if (!next.delete(id)) next.add(id);
    expanded = next;
  }

  function close() {
    hoverFeature(null);
    onClose();
  }

  function ownership(layer: GeographicLayer): { label: string; title: string } {
    return layer.ownership === 'catalog'
      ? { label: 'Catalog · read-only', title: 'Published with the catalog. Presentation changes here are for this session; the data is never modified.' }
      : { label: 'Imported file · read-only', title: 'Opened from a local file for this session. It is not saved, and the data is never modified.' };
  }

  function provenanceLine(layer: GeographicLayer): string {
    const p = layer.definition.provenance ?? {};
    const parts = [ownership(layer).label];
    for (const key of ['mission', 'producer', 'attribution', 'productVersion']) {
      const value = p[key];
      if (typeof value === 'string' || typeof value === 'number') parts.push(`${key === 'productVersion' ? 'v' : ''}${value}`);
    }
    return parts.join(' · ');
  }

  function issueBadge(layer: GeographicLayer): { text: string; tone: 'warn' | 'error'; title: string } | null {
    const errors = layer.diagnostics.filter((d) => d.severity === 'error').length;
    if (layer.skippedFeatures > 0) return { text: `${layer.skippedFeatures} skipped`, tone: 'warn', title: `${layer.skippedFeatures} features failed validation and are not shown; open details for the reasons` };
    if (errors) return { text: `${errors} errors`, tone: 'error', title: 'See details' };
    const warnings = layer.diagnostics.length;
    return warnings ? { text: `${warnings} notes`, tone: 'warn', title: 'Import warnings; see details' } : null;
  }

  function failureLabel(load: GeographicLayerLoad): string {
    return load.id || load.source.identity || 'Unnamed layer';
  }

  const plural = (n: number, noun: string) => `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
</script>

<InstrumentPanel key="layers" title="Surface layers" width={340} onClose={close}>
  {#if !vs.assetsReady}
    <p class="ui-helper text-text-muted">Loading the scene…</p>
  {:else if groups.length === 0 && failures.length === 0}
    <p class="ui-helper text-text-muted">
      No imagery or geographic layers in this scene. Catalogs add vector data with
      <code>geographicLayers</code>; see docs/geographic-layers.md.
    </p>
  {:else}
    {#each groups as group (group.body)}
      <section class="body-group" aria-label="{group.body} surface layers">
        <div class="body-header">
          <span class="ui-section-label">{group.body}</span>
          {#if group.layers.some((l) => !layerVisible(l.id))}
            <button class="text-link ui-meta" onclick={() => showAllLayers(group.body)}>Show all vectors</button>
          {/if}
        </div>
        {#if group.imagery}
          <ImageryLayersSection bodyName={group.body} />
        {/if}
        {#if group.layers.length}
          <div class="ui-section-label sub-label">Vector layers</div>
          <ul class="flex flex-col" aria-label="{group.body} vector layers">
            {#each group.layers as layer (layer.id)}
              {@const visible = layerVisible(layer.id)}
              {@const badge = issueBadge(layer)}
              {@const isOpen = expanded.has(layer.id)}
              {@const browsing = geo.activeLayerId === layer.id}
              <li class="layer" class:off={!visible} class:browsing>
                <div class="flex items-center gap-1">
                  <input
                    type="checkbox"
                    class="layer-toggle"
                    checked={visible}
                    title={visible ? 'Hide layer' : 'Show layer'}
                    aria-label="Show {layer.name}"
                    onchange={(e) => setLayerVisible(layer.id, (e.target as HTMLInputElement).checked)}
                  />
                  <span class="swatch" style:background={layer.definition.display?.color ?? '#59c5dd'} aria-hidden="true"></span>
                  <button class="layer-name ui-body" title="List this layer’s features" onclick={() => browseLayer(browsing ? null : layer.id)} aria-pressed={browsing}>
                    {layer.name}
                  </button>
                  <span class="count ui-meta" title="Features">{layer.features.length.toLocaleString()}</span>
                  {#if badge}<span class="badge" data-tone={badge.tone} title={badge.title}>{badge.text}</span>{/if}
                  <button class="layer-action" class:on={isIsolated(layer.id)} onclick={() => isIsolated(layer.id) ? showAllLayers(layer.body) : isolateLayer(layer.id)}
                    title={isIsolated(layer.id) ? 'Show the other vector layers again' : 'Show only this vector layer'} aria-label="Isolate {layer.name}" aria-pressed={isIsolated(layer.id)}>
                    <Focus size={13} />
                  </button>
                  <button class="layer-action" onclick={() => browseLayer(browsing ? null : layer.id)} title="List features" aria-label="List features of {layer.name}">
                    <List size={13} />
                  </button>
                  <button class="layer-action" onclick={() => toggleExpanded(layer.id)} title={isOpen ? 'Hide details' : 'Source and details'}
                    aria-label="{layer.name} details" aria-expanded={isOpen}>
                    {#if isOpen}<ChevronDown size={13} />{:else}<ChevronRight size={13} />{/if}
                  </button>
                </div>
                <div class="ui-meta layer-indent layer-provenance" title={ownership(layer).title}>{provenanceLine(layer)}</div>
                {#if isOpen}
                  <dl class="layer-indent layer-facts ui-meta">
                    <dt>Layer ID</dt><dd class="mono">{layer.id}</dd>
                    <dt>Source</dt><dd class="mono break">{layer.source.identity}</dd>
                    {#if layer.source.catalog}<dt>Catalog</dt><dd class="mono break">{layer.source.catalog}</dd>{/if}
                    <dt>Coordinates</dt><dd>{describeGeographicCoordinates(layer.coordinates)} · {layer.frame}</dd>
                    <dt>Style</dt><dd>{layer.definition.display?.color ?? 'default'} · opacity {Math.round((layer.definition.display?.opacity ?? 1) * 100)}%</dd>
                    <dt>Features</dt><dd>{plural(layer.features.length, 'feature')}{#if layer.skippedFeatures} · {layer.skippedFeatures} skipped{/if}</dd>
                    {#each Object.entries(layer.definition.provenance ?? {}) as [key, value] (key)}
                      <dt>{key}</dt><dd class="break">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
                    {/each}
                  </dl>
                  {#if layer.diagnostics.length}
                    <ul class="layer-indent diagnostics ui-meta" aria-label="{layer.name} import diagnostics">
                      {#each layer.diagnostics.slice(0, 8) as d, i (i)}
                        <li data-tone={d.severity}>{#if d.featureIndex !== undefined}Feature {d.featureIndex + 1}: {/if}{d.message}</li>
                      {/each}
                      {#if layer.diagnostics.length > 8}<li>…and {layer.diagnostics.length - 8} more in <code>universe.geographicLayers.loads</code></li>{/if}
                    </ul>
                  {/if}
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}

    {#if failures.length}
      <section class="body-group" aria-label="Layers that failed to load">
        <div class="ui-section-label sub-label">Failed to load</div>
        <ul class="flex flex-col gap-1">
          {#each failures as load, i (i)}
            <li class="ui-meta failure">
              <span class="text-text-primary">{failureLabel(load)}</span>
              {#each load.diagnostics as d, j (j)}<div>{d.message}</div>{/each}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if active}
      <GeographicFeatureBrowser layer={active} />
    {:else if groups.some((g) => g.layers.length)}
      <p class="ui-helper text-text-muted mt-2">Choose a vector layer to list its features, or click a feature in the scene.</p>
    {/if}
    {#if geo.notice}<p class="ui-helper notice" role="status">{geo.notice}</p>{/if}
    <GeographicFeatureDetails />
  {/if}
</InstrumentPanel>

<style>
  .body-group + .body-group {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--color-border);
  }
  .body-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .sub-label {
    margin: 8px 0 2px;
    opacity: 0.8;
  }
  .text-link {
    border: none;
    background: none;
    color: var(--color-text-secondary);
    text-decoration: underline;
    cursor: pointer;
  }
  .layer {
    padding: 3px 0;
    border-radius: 3px;
  }
  .layer.browsing {
    background: var(--color-surface-3);
  }
  .layer.off .layer-name {
    color: var(--color-text-muted);
  }
  .layer-toggle {
    width: 14px;
    height: 14px;
    margin: 0 3px;
    cursor: pointer;
  }
  .swatch {
    flex: none;
    width: 9px;
    height: 9px;
    border-radius: 2px;
  }
  .layer-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    border: none;
    background: none;
    padding: 0 2px;
    color: var(--color-text-primary);
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  .count {
    flex: none;
    font-variant-numeric: tabular-nums;
  }
  .layer-indent {
    padding-left: 24px;
  }
  .layer-provenance {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .layer-facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 8px;
    margin: 4px 0 6px;
  }
  .layer-facts dt {
    color: var(--color-text-secondary);
  }
  .layer-facts dd {
    margin: 0;
    min-width: 0;
    color: var(--color-text-primary);
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .break {
    overflow-wrap: anywhere;
  }
  .diagnostics {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 6px;
  }
  .diagnostics li[data-tone='error'] { color: var(--color-error); }
  .diagnostics li[data-tone='warning'] { color: var(--color-warning); }
  .failure {
    color: var(--color-error);
    overflow-wrap: anywhere;
  }
  .badge {
    flex: none;
    border-radius: 3px;
    padding: 0 5px;
    background: var(--color-control);
    font-size: var(--text-metadata);
    line-height: 1.5;
    color: var(--color-text-secondary);
  }
  .badge[data-tone='warn'] { color: var(--color-warning); }
  .badge[data-tone='error'] { color: var(--color-error); }
  .layer-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    min-height: 24px;
    border: none;
    border-radius: 3px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
  }
  .layer-action:hover,
  .layer-action.on {
    color: var(--color-text-primary);
    background: var(--color-surface-3);
  }
  .notice {
    margin-top: 6px;
    color: var(--color-warning);
  }
</style>
