<script lang="ts">
  /**
   * The selected feature: what it is, where it is in its layer's own
   * coordinate convention, its stable reference and source, and its
   * properties. Fly and Frame use the shared navigation (docs/navigation.md);
   * they are disabled, with the reason, where the body cannot be flown over.
   *
   * Property values are text. A value is a link only when it parses as an
   * http(s) URL, and it opens without access to this page.
   */
  import { Check, Copy, Plane, Scan, X } from 'lucide-svelte';
  import {
    describeGeographicCoordinates, formatGeographicPosition, geographicFeatureAnchor, geographicFeatureExtent,
    geographicFeatureName, geographicPropertyLabel, geographicVertexCount, type JsonValue,
  } from '@cosmolabe/core';
  import { Button } from '$lib/components/ui/button';
  import { geo, findFeature, goToFeature, navigationUnavailable, selectFeature } from '../lib/geographic-layers.svelte';
  import { geoStyles, featureOverride, setFeatureOverride, layerStyle } from '../lib/geographic-styles.svelte';
  import { resolveGeographicStyle } from '@cosmolabe/core';
  import GeographicFeatureEditor from './GeographicFeatureEditor.svelte';

  let found = $derived(findFeature(geo.selected));
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
    if (!found) return null;
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
    if (!found || !location) return '';
    const { layer, feature } = found;
    const convention = `${describeGeographicCoordinates(layer.coordinates)}; ${layer.body}`;
    const original = (feature.original.geometry as { type?: string; coordinates?: JsonValue } | null);
    if (original?.type === 'Point' && Array.isArray(original.coordinates)) {
      return `${location.anchor} [lon, lat${original.coordinates.length === 3 ? ', Z' : ''}] = [${original.coordinates.join(', ')}] (${convention})`;
    }
    return `${location.anchor} (centre of extent; ${convention})`;
  }

  let unavailable = $derived(found ? navigationUnavailable(found.layer) : null);
  /** This feature's exception, if one was set; otherwise it follows its layer. */
  let exception = $derived((void geoStyles.byLayer, featureOverride(geo.selected)));
  /** The colour it draws with now, for the control's starting value. */
  let drawn = $derived.by(() => {
    void geoStyles.byLayer;
    if (!found) return null;
    const r = resolveGeographicStyle(found.layer, layerStyle(found.layer.id), found.feature);
    const t = found.feature.geometry.type;
    return t.includes('Point') ? r.point.color : t.includes('Line') ? r.line.color : r.fill.color;
  });
  let properties = $derived(found ? Object.entries(found.feature.properties ?? {}) : []);
</script>

{#if found && location}
  {@const { layer, feature } = found}
  <section class="details" aria-label="Selected feature">
    <div class="title-row">
      <div class="min-w-0">
        <div class="name">{geographicFeatureName(feature)}</div>
        <div class="ui-meta">{layer.name} · {layer.body} · {feature.geometry.type}{#if !location.isPoint}{` · ${geographicVertexCount(feature).toLocaleString()} vertices`}{/if}</div>
      </div>
      <button class="icon-button" onclick={() => selectFeature(null)} aria-label="Deselect feature" title="Deselect (Esc)"><X size={13} /></button>
    </div>

    <div class="actions">
      <Button variant="secondary" size="sm" class="ui-control flex-1" disabled={!!unavailable} title={unavailable ?? 'Fly over this feature'} onclick={() => geo.selected && goToFeature(geo.selected)}>
        <Plane size={13} /> Fly to
      </Button>
      <Button variant="secondary" size="sm" class="ui-control flex-1" disabled={!!unavailable} title={unavailable ?? 'Cut to a view that fits this feature'} onclick={() => geo.selected && goToFeature(geo.selected, { cut: true })}>
        <Scan size={13} /> Frame
      </Button>
      <Button variant="secondary" size="sm" class="ui-control flex-1" title="Copy coordinates with their convention" onclick={() => copy('coordinates', coordinatesText())}>
        {#if copied === 'coordinates'}<Check size={13} />{:else}<Copy size={13} />{/if} Coordinates
      </Button>
    </div>
    {#if unavailable}<p class="ui-helper text-text-muted">{unavailable}</p>{/if}

    <dl class="facts ui-meta">
      <dt>{location.isPoint ? 'Position' : 'Centre'}</dt><dd class="mono">{location.anchor}</dd>
      {#if location.extentText}<dt>Extent</dt><dd class="mono">{location.extentText}</dd>{/if}
      <dt>Convention</dt><dd>{describeGeographicCoordinates(layer.coordinates)} · {layer.frame}</dd>
      <dt>Reference</dt>
      <dd class="mono ref">
        <span class="break">{layer.id} / {feature.id}</span>
        <button class="icon-button small" onclick={() => copy('ref', JSON.stringify({ layerId: layer.id, featureId: feature.id, bodyName: layer.body }))} aria-label="Copy stable reference" title="Copy stable reference (layer, feature, body)">
          {#if copied === 'ref'}<Check size={11} />{:else}<Copy size={11} />{/if}
        </button>
      </dd>
      {#if feature.id.startsWith('index:')}<dt></dt><dd class="warn">No source ID: this reference follows source order and changes if the file is reordered.</dd>{/if}
      <dt>Source</dt><dd class="mono break">{layer.source.identity}</dd>
      <dt>Data</dt><dd>{layer.ownership === 'user' ? 'Authored here · editable' : `${layer.ownership === 'catalog' ? 'Catalog' : 'Imported file'} · read-only`}</dd>
    </dl>

    <GeographicFeatureEditor />

    <div class="feature-style" role="group" aria-label="Feature style">
      <span class="ui-meta label">Style</span>
      {#if exception}
        <input type="color" class="swatch-input" value={exception.color ?? drawn ?? '#59c5dd'} aria-label="Feature colour"
          oninput={(e) => geo.selected && setFeatureOverride(geo.selected, { ...exception, color: (e.currentTarget as HTMLInputElement).value })} />
        <input type="range" min="0" max="1" step="0.05" value={exception.opacity ?? 1} aria-label="Feature opacity"
          oninput={(e) => geo.selected && setFeatureOverride(geo.selected, { ...exception, opacity: Number((e.currentTarget as HTMLInputElement).value) })} />
        <button class="text-button" onclick={() => geo.selected && setFeatureOverride(geo.selected, null)} title="Follow the layer style again">Clear exception</button>
      {:else}
        <span class="ui-meta">Follows the layer style</span>
        <button class="text-button" onclick={() => geo.selected && setFeatureOverride(geo.selected, { color: drawn ?? '#59c5dd' })} title="Give this feature its own colour and opacity">Make exception</button>
      {/if}
    </div>

    <div class="ui-section-label props-label">
      Properties
      <button class="icon-button small" onclick={() => copy('geometry', JSON.stringify(feature.original.geometry))} title="Copy the feature’s source GeoJSON geometry, unmodified" aria-label="Copy source geometry">
        {#if copied === 'geometry'}<Check size={11} />{:else}<Copy size={11} />{/if}
      </button>
    </div>
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
  </section>
{/if}

<style>
  .details {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid var(--color-border);
  }
  .title-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 6px;
  }
  .name {
    color: var(--color-text-primary);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
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
  .ref {
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
  .icon-button:hover {
    color: var(--color-text-primary);
    background: var(--color-surface-3);
  }
  .feature-style {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .feature-style .label {
    min-width: 70px;
  }
  .feature-style input[type='range'] {
    flex: 1;
    min-width: 60px;
  }
  .swatch-input {
    width: 32px;
    height: 20px;
    padding: 0;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    background: none;
    cursor: pointer;
  }
  .text-button {
    border: none;
    border-radius: 3px;
    background: none;
    padding: 2px 6px;
    color: var(--color-text-secondary);
    text-decoration: underline;
    cursor: pointer;
  }
  .copy-prop {
    opacity: 0.5;
  }
  .props dd:hover .copy-prop {
    opacity: 1;
  }
</style>
