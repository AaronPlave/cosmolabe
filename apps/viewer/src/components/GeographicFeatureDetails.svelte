<script lang="ts">
  /**
   * The selected feature (the panel's Feature view): what it is and where,
   * Fly to, and its properties. Stepping to the previous or next feature
   * follows the layer's list. Framing and copying are in the "…" menu; the
   * coordinate convention, stable reference and source wait under *Location
   * and source*. Fly and Frame use the shared navigation (docs/navigation.md)
   * and are disabled, with the reason, where the body cannot be flown over.
   *
   * Property values are text. A value is a link only when it parses as an
   * http(s) URL, and it opens without access to this page.
   */
  import { Check, ChevronLeft, ChevronRight, Copy, Ellipsis, Plane } from 'lucide-svelte';
  import {
    describeGeographicCoordinates, formatGeographicPosition, geographicFeatureAnchor, geographicFeatureExtent,
    geographicFeatureName, geographicPropertyLabel, geographicVertexCount,
    type GeographicFeature, type GeographicLayer, type JsonValue,
  } from '@cosmolabe/core';
  import { Button } from '$lib/components/ui/button';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import { geo, goToFeature, navigationUnavailable, backToLayer, stepFeature, featureSteps } from '../lib/geographic-layers.svelte';
  import { layerOrigin } from '../lib/geographic-layer-labels';

  interface Props { layer: GeographicLayer; feature: GeographicFeature }
  let props: Props = $props();
  let found = $derived({ layer: props.layer, feature: props.feature });
  let steps = $derived(featureSteps());
  let copied = $state<string | null>(null);
  let copiedTimer = 0;

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = key;
      clearTimeout(copiedTimer);
      copiedTimer = window.setTimeout(() => (copied = null), 1500);
    } catch (err) {
      console.warn('[Cosmolabe] Copy failed:', err);
    }
  }

  /** http(s) only; anything else (javascript:, data:, relative paths) stays text. */
  function safeUrl(value: JsonValue): string | null {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return null;
    try {
      const url = new URL(value.trim());
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch { return null; }
  }

  function valueText(value: JsonValue): string {
    if (value === null) return 'null';
    if (typeof value === 'object') {
      const text = JSON.stringify(value);
      return text.length > 240 ? `${text.slice(0, 240)}…` : text;
    }
    return String(value);
  }

  let location = $derived.by(() => {
    const { layer, feature } = found;
    const extent = geographicFeatureExtent(feature);
    const anchor = formatGeographicPosition(geographicFeatureAnchor(feature), layer.coordinates);
    let extentText: string;
    if (feature.geometry.type === 'Point') extentText = '';
    else if (extent.kind === 'polar') extentText = `Encloses the ${extent.pole} pole to ${Math.abs(extent.boundaryLatDeg).toFixed(4)}°${extent.pole === 'north' ? 'N' : 'S'}`;
    else {
      const sw = formatGeographicPosition({ latDeg: extent.south, lonDeg: extent.west }, layer.coordinates);
      const ne = formatGeographicPosition({ latDeg: extent.north, lonDeg: extent.east }, layer.coordinates);
      extentText = `${sw} to ${ne}`;
    }
    return { anchor, extentText, isPoint: feature.geometry.type === 'Point' };
  });

  /** A Point copies its source numbers exactly; anything else, its extent's centre in the declared convention. */
  function coordinatesText(): string {
    const { layer, feature } = found;
    const convention = `${describeGeographicCoordinates(layer.coordinates)}; ${layer.body}`;
    const original = (feature.original.geometry as { type?: string; coordinates?: JsonValue } | null);
    if (original?.type === 'Point' && Array.isArray(original.coordinates)) {
      return `${location.anchor} [lon, lat${original.coordinates.length === 3 ? ', Z' : ''}] = [${original.coordinates.join(', ')}] (${convention})`;
    }
    return `${location.anchor} (centre of extent; ${convention})`;
  }

  let unavailable = $derived(navigationUnavailable(found.layer));
  let properties = $derived(Object.entries(found.feature.properties ?? {}));
  const copyReference = () => copy('ref', JSON.stringify({ layerId: found.layer.id, featureId: found.feature.id, bodyName: found.layer.body }));
</script>

{#if location}
  {@const { layer, feature } = found}
  <section class="details" aria-label="Selected feature">
    <nav class="crumb">
      <button class="surface-crumb-back" onclick={backToLayer} title="Back to {layer.name} (Esc)"><ChevronLeft size={13} /> {layer.name}</button>
      <span class="steps">
        <button class="icon-button" disabled={!steps[0]} onclick={() => stepFeature(-1)} aria-label="Previous feature" title="Previous feature"><ChevronLeft size={14} /></button>
        <button class="icon-button" disabled={!steps[1]} onclick={() => stepFeature(1)} aria-label="Next feature" title="Next feature"><ChevronRight size={14} /></button>
      </span>
    </nav>
    <div>
      <h3 class="name">{geographicFeatureName(feature)}</h3>
      <div class="ui-meta">{feature.geometry.type} · {layer.body}{#if !location.isPoint}{` · ${geographicVertexCount(feature).toLocaleString()} vertices`}{/if}</div>
      <div class="ui-meta mono position">{location.anchor}</div>
    </div>

    <div class="actions">
      <Button size="sm" class="ui-control flex-1" disabled={!!unavailable} title={unavailable ?? 'Fly over this feature'} onclick={() => geo.selected && goToFeature(geo.selected)}>
        <Plane size={13} /> Fly to
      </Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger class="icon-action" aria-label="More for this feature" title="More"><Ellipsis size={14} /></DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          <DropdownMenu.Item disabled={!!unavailable} onSelect={() => geo.selected && goToFeature(geo.selected, { cut: true })}>Frame (no flight)</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => copy('coordinates', coordinatesText())}>Copy coordinates</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={copyReference}>Copy reference</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => copy('geometry', JSON.stringify(feature.original.geometry))}>Copy source geometry</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
    {#if unavailable}<p class="ui-helper text-text-muted">{unavailable}</p>{/if}
    {#if copied}<p class="ui-helper copied" role="status"><Check size={11} /> Copied {copied === 'coordinates' ? 'coordinates' : copied === 'ref' ? 'reference' : copied === 'geometry' ? 'source geometry' : 'value'}</p>{/if}

    <div class="ui-section-label props-label">Properties</div>
    {#if properties.length === 0}
      <p class="ui-helper text-text-muted">No properties.</p>
    {:else}
      <dl class="props ui-meta">
        {#each properties as [key, value] (key)}
          {@const url = safeUrl(value)}
          <dt title={key}>{geographicPropertyLabel(key)}</dt>
          <dd>
            {#if url}
              <a href={url} target="_blank" rel="noopener noreferrer nofollow" class="break">{valueText(value)}</a>
            {:else}
              <span class="break">{valueText(value)}</span>
            {/if}
            <button class="icon-button small copy-prop" onclick={() => copy(`p:${key}`, typeof value === 'string' ? value : JSON.stringify(value))} aria-label="Copy {geographicPropertyLabel(key)}" title="Copy value">
              {#if copied === `p:${key}`}<Check size={11} />{:else}<Copy size={11} />{/if}
            </button>
          </dd>
        {/each}
      </dl>
    {/if}

    <details class="disclosure">
      <summary>Location and source</summary>
      <dl class="facts ui-meta">
        <dt>{location.isPoint ? 'Position' : 'Centre'}</dt><dd class="mono">{location.anchor}</dd>
        {#if location.extentText}<dt>Extent</dt><dd class="mono">{location.extentText}</dd>{/if}
        <dt>Convention</dt><dd>{describeGeographicCoordinates(layer.coordinates)} · {layer.frame}</dd>
        <dt>Reference</dt><dd class="mono break">{layer.id} / {feature.id}</dd>
        {#if feature.id.startsWith('index:')}<dt></dt><dd class="warn">No source ID: this reference follows source order and changes if the file is reordered.</dd>{/if}
        <dt>Source</dt><dd class="mono break">{layer.source.identity}</dd>
        <dt>Data</dt><dd>{layerOrigin(layer).label}</dd>
      </dl>
    </details>
  </section>
{/if}

<style>
  .details {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .crumb {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    min-width: 0;
  }
  .crumb :global(.surface-crumb-back) { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .steps { display: inline-flex; flex: none; }
  .position { margin-top: 2px; }
  .copied { display: flex; align-items: center; gap: 4px; color: var(--color-text-secondary); }
  .name {
    margin: 0;
    color: var(--color-text-primary);
    font-size: var(--text-body, 13px);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .facts,
  .props {
    display: grid;
    grid-template-columns: minmax(70px, auto) 1fr;
    gap: 3px 8px;
    margin: 0;
  }
  dt {
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  dd {
    margin: 0;
    min-width: 0;
    color: var(--color-text-primary);
  }
  .props dd {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 4px;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .break {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .warn {
    color: var(--color-warning);
  }
  .props-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 4px;
  }
  a {
    color: var(--color-text-primary);
    text-decoration: underline;
  }
  .icon-button {
    display: inline-flex;
    flex: none;
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
  .icon-button.small {
    width: 20px;
    height: 18px;
  }
  .icon-button:disabled { opacity: 0.35; cursor: default; }
  .icon-button:hover:not(:disabled) {
    color: var(--color-text-primary);
    background: var(--color-surface-3);
  }
  .copy-prop {
    opacity: 0.5;
  }
  .props dd:hover .copy-prop {
    opacity: 1;
  }
</style>
