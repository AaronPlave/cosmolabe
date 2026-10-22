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
  import { geoStyles, featureOverride, setFeatureOverride, layerStyle, openStyleEditor } from '../lib/geographic-styles.svelte';
  import { resolveGeographicStyle } from '@cosmolabe/core';
  import { geometryLabel, layerOrigin } from '../lib/geographic-layer-labels';
  import GeographicPropertiesEditor from './GeographicPropertiesEditor.svelte';
  import {
    edits, editFeatureOf, setFeatureProperties, duplicateFeature, deleteFeature, copyFeatureToAnnotations,
  } from '../lib/geographic-editing.svelte';
  import { geographicDatum, geographicPathLengthKm, geographicPolygonAreaKm2, normalizeGeographicPosition, type GeoPosition } from '@cosmolabe/core';

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
  /** This feature's own colour and opacity, if it has them; otherwise it follows its layer. */
  let own = $derived((void geoStyles.byLayer, featureOverride(geo.selected)));
  /** What it draws with now, layer style included. */
  let drawn = $derived.by(() => {
    void geoStyles.byLayer;
    const r = resolveGeographicStyle(found.layer, layerStyle(found.layer.id), found.feature);
    const t = found.feature.geometry.type;
    return t.includes('Point') ? r.point.color : t.includes('Line') ? r.line.color : r.outline.color;
  });
  function styleLayer() {
    const id = found.layer.id;
    backToLayer();
    openStyleEditor(id);
  }
  // ── Your own features: name, measurements, properties and shape (#200) ──
  let editable = $derived((void edits.revision, editFeatureOf(geo.selected)));
  let confirmDelete = $state(false);
  let nameInput = $state<HTMLInputElement | null>(null);
  $effect(() => { void props.feature.id; confirmDelete = false; });
  // A shape just drawn: the cursor waits in its name.
  $effect(() => {
    if (edits.focusName && nameInput) { nameInput.focus(); nameInput.select(); edits.focusName = false; }
  });
  function rename(text: string) {
    const name = text.trim();
    if (!editable || !geo.selected || !name || name === editable.properties?.name) return;
    setFeatureProperties(geo.selected.layerId, editable.id, { ...(editable.properties ?? {}), name });
  }
  /** Length or area along the drawn edges, on the reference shape. */
  let measure = $derived.by(() => {
    if (!editable) return '';
    const l = found.layer.coordinates;
    const datum = geographicDatum(l);
    const geoOf = (p: GeoPosition) => normalizeGeographicPosition(p, l);
    const km = (v: number) => v < 1 ? `${(v * 1000).toFixed(0)} m` : `${v.toFixed(v < 100 ? 2 : 0)} km`;
    const g = editable.geometry;
    if (g.type === 'LineString') return `${km(geographicPathLengthKm(g.coordinates.map(geoOf), datum))} long`;
    if (g.type === 'MultiLineString') return `${km(g.coordinates.reduce((n, line) => n + geographicPathLengthKm(line.map(geoOf), datum), 0))} long`;
    if (g.type === 'Polygon') return `${geographicPolygonAreaKm2(g.coordinates.map((r) => r.map(geoOf)), datum).toPrecision(4)} km²`;
    if (g.type === 'MultiPolygon') return `${g.coordinates.reduce((n, poly) => n + geographicPolygonAreaKm2(poly.map((r) => r.map(geoOf)), datum), 0).toPrecision(4)} km²`;
    return '';
  });

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
      {#if editable}
        <input bind:this={nameInput} class="name name-input" value={editable.properties?.name ?? geographicFeatureName(feature)} aria-label="Name"
          onkeydown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
          onblur={(e) => rename((e.currentTarget as HTMLInputElement).value)} />
      {:else}
        <h3 class="name">{geographicFeatureName(feature)}</h3>
      {/if}
      <div class="ui-meta">{geometryLabel(feature.geometry.type)} · {layer.body}{#if measure}{` · ${measure}`}{:else if !location.isPoint}{` · ${geographicVertexCount(feature).toLocaleString()} vertices`}{/if}{#if editable} · {layer.name}{/if}</div>
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
          {#if editable && geo.selected}
            <DropdownMenu.Item onSelect={() => duplicateFeature(geo.selected!.layerId, editable!.id)}>Duplicate</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => (confirmDelete = true)}>Delete…</DropdownMenu.Item>
          {:else}
            <DropdownMenu.Item onSelect={() => geo.selected && copyFeatureToAnnotations(geo.selected)}>Copy to my annotations</DropdownMenu.Item>
          {/if}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
    {#if confirmDelete && editable && geo.selected}
      <div class="confirm" role="alertdialog" aria-label="Delete this feature?">
        <span class="ui-meta">Delete this feature? Undo brings it back.</span>
        <Button variant="destructive" size="sm" class="ui-control" onclick={() => deleteFeature(geo.selected!.layerId, editable!.id)}>Delete</Button>
        <Button variant="secondary" size="sm" class="ui-control" onclick={() => (confirmDelete = false)}>Keep</Button>
      </div>
    {/if}
    {#if editable}
      <p class="ui-helper text-text-muted">Drag its points in the scene to change the shape.</p>
    {:else if layer.ownership !== 'user'}
      <button class="copy-link ui-meta" onclick={() => geo.selected && copyFeatureToAnnotations(geo.selected)} title="An editable copy of just this feature; {layer.name} stays unchanged">Edit a copy of this feature</button>
    {/if}
    {#if edits.message && geo.selected?.layerId === edits.target}<p class="ui-helper" role="status">{edits.message}</p>{/if}
    {#if unavailable}<p class="ui-helper text-text-muted">{unavailable}</p>{/if}
    {#if copied}<p class="ui-helper copied" role="status"><Check size={11} /> Copied {copied === 'coordinates' ? 'coordinates' : copied === 'ref' ? 'reference' : copied === 'geometry' ? 'source geometry' : 'value'}</p>{/if}

    <div class="ui-section-label props-label">Properties</div>
    {#if editable && geo.selected}
      <GeographicPropertiesEditor layerId={geo.selected.layerId} feature={editable} />
    {:else if properties.length === 0}
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

    <details class="disclosure" open={!!own}>
      <summary>Appearance</summary>
      <div class="appearance" role="group" aria-label="Feature style">
        <label class="own ui-meta">
          <input type="checkbox" checked={!!own} onchange={(e) => geo.selected && setFeatureOverride(geo.selected, (e.currentTarget as HTMLInputElement).checked ? { color: drawn } : null)} />
          Give this feature its own colour
        </label>
        {#if own}
          <div class="own-controls">
            <input type="color" class="swatch-input" value={own.color ?? drawn} aria-label="Feature colour"
              oninput={(e) => geo.selected && setFeatureOverride(geo.selected, { ...own, color: (e.currentTarget as HTMLInputElement).value })} />
            <input type="range" min="0" max="1" step="0.05" value={own.opacity ?? 1} aria-label="Feature opacity"
              oninput={(e) => geo.selected && setFeatureOverride(geo.selected, { ...own, opacity: Number((e.currentTarget as HTMLInputElement).value) })} />
            <span class="ui-readout">{Math.round((own.opacity ?? 1) * 100)}%</span>
          </div>
          <p class="ui-helper text-text-muted">Only this feature; the rest of {layer.name} is unchanged.</p>
        {/if}
        <button class="link ui-meta" onclick={styleLayer}>Style the whole layer…</button>
      </div>
    </details>

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
  .appearance { display: flex; flex-direction: column; gap: 6px; }
  .own { display: flex; align-items: center; gap: 6px; color: var(--color-text-primary); cursor: pointer; }
  .own-controls { display: grid; grid-template-columns: 26px 1fr 40px; align-items: center; gap: 8px; }
  .swatch-input { width: 24px; height: 20px; padding: 0; border: none; background: none; cursor: pointer; }
  .link { align-self: flex-start; border: none; background: none; padding: 0; color: var(--color-text-secondary); text-decoration: underline dotted; cursor: pointer; }
  .link:hover { color: var(--color-text-primary); }
  .name-input {
    width: 100%;
    margin: 0;
    padding: 1px 4px;
    border: 1px solid transparent;
    border-radius: 3px;
    background: none;
  }
  .name-input:hover { border-color: var(--color-border); }
  .name-input:focus { border-color: var(--color-border-strong); background: var(--color-surface-3); outline: none; }
  .confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .copy-link { align-self: flex-start; border: none; background: none; padding: 0; color: var(--color-text-secondary); text-decoration: underline dotted; cursor: pointer; }
  .copy-link:hover { color: var(--color-text-primary); }
  .copy-prop {
    opacity: 0.5;
  }
  .props dd:hover .copy-prop {
    opacity: 1;
  }
</style>
