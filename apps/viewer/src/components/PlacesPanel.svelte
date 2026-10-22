<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { vs } from '../lib/viewer-state.svelte';
  import { navigateToPlace, selectPlace, placeCoordinates } from '../lib/places';
  import { formatLatitude, formatLongitude } from '@cosmolabe/three';
  import { openTool } from '../lib/shell.svelte';
  const place = $derived(vs.selectedPlaceRef ? vs.places?.byRef.get(vs.selectedPlaceRef) : undefined);
  const bodies = $derived([...new Set(vs.places?.places.map(p => p.layer.body) ?? [])]);
  let query = $state('');
  let body = $state(vs.trackedBodyName ?? '');
  const results = $derived(vs.places?.search(query, { body: body || undefined, activeBody: vs.trackedBodyName ?? undefined }).slice(0, 12) ?? []);
  const fields = $derived.by(() => {
    const value = place?.feature.properties?.sourceFields;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  });
  const about = $derived(typeof fields.origin === 'string' ? fields.origin : 'Named point from the catalog. The diameter is approximate; it does not define a feature boundary.');
  let copyStatus = $state('');
  let navError = $state('');
  async function copySource() {
    if (!place) return;
    try { await navigator.clipboard.writeText(JSON.stringify({ref:place.ref,provenance:place.layer.definition.provenance,datum:place.layer.datum,source:place.layer.source.identity,fields},null,2)); copyStatus = 'Source details copied'; }
    catch { copyStatus = 'Clipboard unavailable'; }
  }
  async function copy() {
    if (!place) return;
    try { await navigator.clipboard.writeText(placeCoordinates(place)); copyStatus = 'Coordinates copied'; }
    catch { copyStatus = 'Clipboard unavailable'; }
  }
  function navigate(action: 'fly' | 'jump') {
    navError = place && navigateToPlace(place, action) ? '' : 'The place body is unavailable or hidden.';
  }
</script>

<div class="space-y-3">
  <label class="grid gap-1"><span class="text-text-secondary">Search places</span>
    <input class="ui-control w-full rounded border border-border bg-surface-3 px-2 py-1" placeholder="Name or alias…" bind:value={query} />
  </label>
  <label class="flex items-center gap-2"><span class="text-text-secondary">Body</span>
    <select aria-label="Search place body" class="ui-control min-w-0 flex-1 rounded bg-surface-3 p-1" bind:value={body}>
      <option value="">All bodies</option>{#each bodies as name}<option value={name}>{name}</option>{/each}
    </select>
  </label>
  {#if results.length && (!place || query)}
    <ul aria-label="Named places" class="max-h-40 overflow-y-auto space-y-1">
      {#each results as item (item.ref)}<li><button class="w-full rounded px-2 py-1 text-left hover:bg-surface-3" aria-pressed={place?.ref === item.ref} onclick={() => { selectPlace(item); query = ''; }}><span class="block">{item.name}</span><span class="text-xs text-text-secondary">{item.layer.body} · {item.kind.split(',')[0]}</span></button></li>{/each}
    </ul>
  {:else if !place || query}<p class="text-text-secondary">{bodies.length ? 'No places match this search.' : 'No named places loaded in this scene.'}</p>{/if}
  {#if place}{#key place.ref}
    <div class="border-t border-border pt-3 space-y-2">
      <div class="flex justify-between gap-2"><strong>{place.name}</strong><button aria-label="Clear selected place" title="Clear place information; the camera target stays active" onclick={() => selectPlace(null)}>×</button></div>
      <p>{place.layer.body} · {place.kind.split(',')[0]} · {place.origin === 'nomenclature' ? 'official name' : 'catalog site'}</p>
      {#if place.feature.geometry.type === 'Point'}
        <p class="font-mono text-xs">{formatLatitude(place.feature.geometry.coordinates.latDeg,4)}, {formatLongitude(place.feature.geometry.coordinates.lonDeg,4)}</p>
      {/if}
      <p class="text-xs text-text-secondary">Planetographic latitude · east longitude</p>
      {#if place.diameterKm}<p>Approx. diameter: {place.diameterKm.toFixed(2)} km</p>{/if}
      <div class="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onclick={() => navigate('fly')}>Fly to</Button>
        <Button size="sm" variant="secondary" onclick={() => navigate('jump')}>Jump to</Button>
        <Button size="sm" variant="secondary" onclick={copy}>Copy coordinates</Button>
      </div>
      <p class="text-xs text-text-secondary">Copy uses planetocentric latitude for Navigate.</p>
      {#if navError}<p role="status">{navError}</p>{/if}
      {#if copyStatus}<p role="status">{copyStatus}</p>{/if}
      <details><summary>About this place</summary><p class="mt-2 text-text-secondary">{about}</p></details>
      <details>
        <summary>Source &amp; technical details</summary>
        <button class="mt-2 underline text-xs" onclick={copySource}>Copy source details</button>
        <dl class="mt-2 space-y-1 break-words text-xs">
          <dt class="text-text-secondary">Provenance</dt><dd>{String(place.layer.definition.provenance?.attribution ?? 'Catalog-defined site')}</dd>
          <dt class="text-text-secondary">Source</dt><dd>{place.layer.source.identity}</dd>
          {#if place.layer.definition.provenance?.sourceUrl}
            <dt class="text-text-secondary">Original source</dt><dd>{String(place.layer.definition.provenance.sourceUrl)}</dd>
          {/if}
          {#if place.layer.definition.provenance?.sourceSha256}
            <dt class="text-text-secondary">Archive SHA-256</dt><dd>{String(place.layer.definition.provenance.sourceSha256)}</dd>
          {/if}
          <dt class="text-text-secondary">Reference</dt><dd>{JSON.stringify(place.layer.datum.referenceShape)} · geodetic latitude</dd>
          <dt class="text-text-secondary">Label anchor</dt><dd>Physical terrain sample when supported and resident; declared reference-shape fallback</dd>
          <dt class="text-text-secondary">Place reference</dt><dd>{place.ref}</dd>
          {#each Object.entries(fields) as [key, value]}
            <dt class="text-text-secondary">{key}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
          {/each}
        </dl>
      </details>
    </div>
  {/key}{/if}
  <button class="text-xs text-text-secondary underline" onclick={() => openTool('display')}>Geographic name display settings</button>
  {#each [...vs.placeFailures, ...(vs.places?.diagnostics ?? [])] as message}
    <p class="mt-2 text-status-warning" role="status">{message}</p>
  {/each}
</div>

<style>dd { overflow-wrap:anywhere; user-select:text; } dt { margin-top: .5rem; } summary { cursor:pointer; } </style>
