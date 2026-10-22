<script lang="ts">
  import type { Place, PlaceSort } from '@cosmolabe/core';
  import { Copy, X } from 'lucide-svelte';
  import NavigationView from './NavigationView.svelte';
  import NavigationActions from './NavigationActions.svelte';
  import { navigationView, navigationRange } from '../lib/navigation-view.svelte';
  import { vs, resolveCoordinateTarget } from '../lib/viewer-state.svelte';
  import { navigateToPlace, selectPlace, placeCoordinates, placeCategory, placeDiameter } from '../lib/places';
  import { formatLatitude, formatLongitude } from '@cosmolabe/three';
  import { shell, minimizePanel } from '../lib/shell.svelte';
  const place = $derived(vs.selectedPlaceRef ? vs.places?.byRef.get(vs.selectedPlaceRef) : undefined);
  const bodies = $derived([...new Set(vs.places?.places.map(p => p.layer.body) ?? [])]);
  let query = $state('');
  // null follows tracking; an explicit choice (including All) is retained.
  let bodyChoice = $state<string | null>(null);
  const body = $derived(bodyChoice ?? (bodies.includes(vs.trackedBodyName ?? '') ? vs.trackedBodyName! : ''));
  let sort = $state<PlaceSort>('relevance');
  let kind = $state('');
  let origin = $state<Place['origin'] | ''>('');
  const origins = $derived(new Set(vs.places?.places.map(p => p.origin) ?? []));
  const kinds = $derived.by(() => {
    const options = new Map<string, string>();
    for (const p of vs.places?.places ?? []) {
      if ((!body || p.layer.body === body) && (!origin || p.origin === origin)) options.set(p.kind, placeCategory(p));
    }
    return [...options].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  });
  // A tracked-body/source change must not leave an unavailable type selected.
  $effect(() => { if (kind && !kinds.some(([value]) => value === kind)) kind = ''; });
  const range = $derived(navigationRange());
  const target = $derived(place?.feature.geometry.type === 'Point' ? resolveCoordinateTarget({bodyName: place.layer.body, ...place.feature.geometry.coordinates, latitude: 'planetographic', longitudeDirection: 'east'}) : null);
  const results = $derived(vs.places?.search(query, { body: body || undefined, kind: kind || undefined, origin: origin || undefined, sort, activeBody: vs.trackedBodyName ?? undefined, limit: 100 }) ?? []);
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
    navError = !range.ok ? range.error : place && navigateToPlace(place, action) ? '' : 'The place body is unavailable or hidden.';
    if (!navError && shell.layout === 'compact') minimizePanel('navigate');
  }
</script>

<div class="places-content space-y-2" class:results-only={!place}>
  <label class="grid gap-1"><span class="text-text-secondary">Search places</span>
    <input class="ui-control w-full rounded border border-border bg-surface-3 px-2 py-1" placeholder="Name or alias…" bind:value={query} />
  </label>
  <label class="flex items-center gap-2"><span class="w-10 shrink-0 text-text-secondary">Body</span>
    <select aria-label="Search place body" class="ui-control min-w-0 flex-1 rounded bg-surface-3 p-1" value={body} onchange={e => bodyChoice = e.currentTarget.value}>
      <option value="">All bodies</option>{#each bodies as name}<option value={name}>{name}</option>{/each}
    </select>
  </label>
  {#if !place || query}
  <label class="flex items-center gap-2"><span class="w-10 shrink-0 text-text-secondary">Type</span>
    <select aria-label="Search place type" class="ui-control min-w-0 flex-1 rounded bg-surface-3 p-1" bind:value={kind}>
      <option value="">All types</option>{#each kinds as [value, label]}<option {value}>{label}</option>{/each}
    </select>
  </label>
  {#if origins.size > 1}
    <label class="flex items-center gap-2"><span class="w-10 shrink-0 text-text-secondary">Origin</span>
      <select aria-label="Search place origin" class="ui-control min-w-0 flex-1 rounded bg-surface-3 p-1" bind:value={origin}>
        <option value="">All origins</option><option value="nomenclature">Official names</option><option value="mission/user">Mission / user sites</option>
      </select>
    </label>
  {/if}
  <label class="flex items-center gap-2"><span class="w-10 shrink-0 text-text-secondary">Sort</span>
    <select aria-label="Sort places" title="Relevance favors the tracked body, exact name matches, cartographic importance, then diameter. Explicit sorts apply across all matching places." class="ui-control min-w-0 flex-1 rounded bg-surface-3 p-1" bind:value={sort}>
      <option value="relevance">Relevance</option><option value="name-asc">Name A–Z</option><option value="name-desc">Name Z–A</option>
      <option value="diameter-desc">Diameter: largest first</option><option value="diameter-asc">Diameter: smallest first</option>
    </select>
  </label>
  {/if}
  {#if results.length && (!place || query)}
    <ul aria-label="Named places" class="place-results max-h-40 overflow-y-auto space-y-1">
      {#each results as item (item.ref)}<li><button class="w-full rounded px-2 py-1 text-left hover:bg-surface-3" aria-pressed={place?.ref === item.ref} onclick={() => { selectPlace(item); query = ''; }}><span class="block">{item.name}</span><span class="flex flex-wrap justify-between gap-x-2 text-xs text-text-secondary"><span>{item.layer.body} · {placeCategory(item)}</span><span class="tabular-nums" title="Approximate diameter from the source; not a feature boundary">{placeDiameter(item)}</span></span></button></li>{/each}
    </ul>
  {:else if !place || query}<p class="text-text-secondary">{bodies.length ? 'No places match this search and filters.' : 'No named places loaded in this scene.'}</p>{/if}
  {#if place}{#key place.ref}
    <form class="border-t border-border pt-3 grid gap-2.5" onsubmit={e => { e.preventDefault(); navigate('fly'); }}>
      <div class="flex items-center justify-between gap-2">
        <h3 class="font-medium text-text-primary">{place.name}</h3>
        <button type="button" class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-secondary hover:bg-surface-3" aria-label="Clear selected place" title="Clear place information; the camera target stays active" onclick={() => selectPlace(null)}><X size={14} /></button>
      </div>
      <p class="text-text-secondary">{place.layer.body} · {placeCategory(place)}</p>
      <div class="flex items-center gap-1">
        <span class="font-mono text-xs" title="Planetocentric latitude · east longitude; matches Coordinates by default">{placeCoordinates(place, 4)}</span>
        <button type="button" class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-secondary hover:bg-surface-3" aria-label="Copy coordinates" title="Copy planetocentric coordinates for Navigate" onclick={copy}><Copy size={13} /></button>
      </div>
      <NavigationView scaleKm={target?.ok ? target.target.scaleKm : undefined} />
      <NavigationActions disabled={!target?.ok || !range.ok} onJump={() => navigate('jump')} />
      {#if !range.ok || navError}<p role="status">{!range.ok ? range.error : navError}</p>{/if}
      {#if copyStatus}<p role="status">{copyStatus}</p>{/if}
      <details>
        <summary class="text-text-secondary">Place details</summary>
        <p class="mt-2 text-text-secondary">{about}</p>
        {#if place.diameterKm}
          <p class="mt-2 text-text-secondary">Indicative diameter: {place.diameterKm.toFixed(2)} km; not a boundary.</p>
          <button type="button" class="mt-1 underline" title="Use 1.5 times the indicative diameter as an overhead altitude" onclick={() => { navigationView.preset = 'overhead'; navigationView.rangeText = String(Math.max(5, place.diameterKm! * 1.5)); }}>Use suggested feature framing</button>
        {/if}
        <p class="mt-2 text-text-secondary">Displayed and copied: planetocentric latitude, east longitude. Coordinates accepts these N/S/E/W pairs with its default latitude convention.</p>
        {#if place.feature.geometry.type === 'Point'}
          <p class="mt-2 text-text-secondary">Normalized catalog point (planetographic): {formatLatitude(place.feature.geometry.coordinates.latDeg, 8)}, {formatLongitude(place.feature.geometry.coordinates.lonDeg, 8)}. Original source coordinates and convention are retained below.</p>
        {/if}
        <p class="mt-2 text-text-secondary">Source type: {place.kind} · {place.origin === 'nomenclature' ? 'Official nomenclature' : 'Mission / user catalog'}</p>
        <button type="button" class="mt-2 underline text-xs" onclick={copySource}>Copy source details</button>
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
    </form>
  {/key}{/if}
  {#each [...vs.placeFailures, ...(vs.places?.diagnostics ?? [])] as message}
    <p class="mt-2 text-status-warning" role="status">{message}</p>
  {/each}
</div>

<style>
  /* Leave room inside each scroll clip for the shared outside focus ring. */
  .places-content { min-height: 0; overflow-y: auto; padding: 2px; margin: -2px; }
  .place-results { padding: 2px; margin-inline: -2px; }
  .results-only { display: flex; flex: 1; flex-direction: column; }
  .results-only > :global(*) { flex-shrink: 0; }
  .results-only > .place-results { flex: 1; min-height: 0; max-height: none; }
  dd { overflow-wrap:anywhere; user-select:text; } dt { margin-top: .5rem; } summary { cursor:pointer; } </style>
