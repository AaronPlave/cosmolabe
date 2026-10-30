<script lang="ts">
  import type { Place, PlaceSort } from '@cosmolabe/core';
  import { onDestroy } from 'svelte';
  import { ArrowLeft, ChevronDown, ChevronRight, Copy, X } from 'lucide-svelte';
  import * as Popover from '$lib/components/ui/popover';
  import NavigationView from './NavigationView.svelte';
  import NavigationActions from './NavigationActions.svelte';
  import { navigationRange } from '../lib/navigation-view.svelte';
  import { vs, resolveCoordinateTarget } from '../lib/viewer-state.svelte';
  import { navigateToPlace, selectPlace, placeCoordinates, placeCategory, placeDiameter, searchPlaces, isPlaceAvailable, placeFrameUnavailable, placeNavigationCoordinates } from '../lib/places';
  import { formatLatitude, formatLongitude } from '@cosmolabe/three';
  import { shell, minimizePanel } from '../lib/shell.svelte';
  const place = $derived(vs.selectedPlaceRef ? vs.places?.byRef.get(vs.selectedPlaceRef) : undefined);
  const frameError = $derived.by(() => { void vs.frameTick; return place ? placeFrameUnavailable(place) : null; });
  const bodies = $derived([...new Set(vs.places?.places.filter(isPlaceAvailable).map(p => p.layer.body) ?? [])]);
  let query = $state('');
  let filtersOpen = $state(false);
  // null follows tracking; an explicit choice (including All) is retained.
  let bodyChoice = $state<string | null>(null);
  const body = $derived(bodyChoice ?? (bodies.includes(vs.trackedBodyName ?? '') ? vs.trackedBodyName! : ''));
  let sort = $state<PlaceSort>('relevance');
  let kind = $state('');
  let origin = $state<Place['origin'] | ''>('');
  const origins = $derived(new Set(vs.places?.places.filter(isPlaceAvailable).map(p => p.origin) ?? []));
  const kinds = $derived.by(() => {
    const options = new Map<string, string>();
    for (const p of vs.places?.places.filter(isPlaceAvailable) ?? []) {
      if ((!body || p.layer.body === body) && (!origin || p.origin === origin)) options.set(p.kind, placeCategory(p));
    }
    return [...options].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  });
  // A tracked-body/source change must not leave an unavailable type selected.
  $effect(() => { if (kind && !kinds.some(([value]) => value === kind)) kind = ''; });
  const range = $derived(navigationRange(place?.diameterKm));
  const target = $derived(place?.feature.geometry.type === 'Point' ? resolveCoordinateTarget({bodyName: place.layer.body, ...placeNavigationCoordinates(place), latitude: 'planetocentric', longitudeDirection: 'east'}) : null);
  const results = $derived(searchPlaces(query, { body: body || undefined, kind: kind || undefined, origin: origin || undefined, sort, activeBody: vs.trackedBodyName ?? undefined, limit: 'all' }));
  let renderedCount = $state(100);
  let resultList = $state<HTMLUListElement>();
  const visibleResults = $derived(results.slice(0, renderedCount));
  $effect(() => {
    // Every new search/filter/order starts at the beginning of the full result set.
    void results;
    renderedCount = 100;
    if (resultList) resultList.scrollTop = 0;
  });
  function revealMore() { renderedCount = Math.min(renderedCount + 100, results.length); }
  function onResultsScroll(e: Event) {
    const el = e.currentTarget as HTMLElement;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) revealMore();
  }
  const filterSummary = $derived([kind ? kinds.find(([value]) => value === kind)?.[1] : '', origin === 'nomenclature' ? 'Official names' : origin ? 'Mission / user sites' : '', sort === 'relevance' ? '' : ({'name-asc':'Name A–Z','name-desc':'Name Z–A','diameter-desc':'Largest first','diameter-asc':'Smallest first'}[sort])].filter(Boolean).join(' · '));
  const fields = $derived.by(() => {
    const value = place?.feature.properties?.sourceFields;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  });
  const about = $derived(typeof fields.origin === 'string' ? fields.origin : 'Named point from the catalog. The diameter is approximate; it does not define a feature boundary.');
  let copyStatus = $state('');
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(copyTimer));
  async function copyText(text: string, success: string) {
    clearTimeout(copyTimer);
    copyStatus = '';
    try { await navigator.clipboard.writeText(text); copyStatus = success; }
    catch { copyStatus = 'Clipboard unavailable'; }
    finally { copyTimer = setTimeout(() => { copyStatus = ''; }, 6000); }
  }
  let navError = $state('');
  async function copySource() {
    if (!place) return;
    await copyText(JSON.stringify({ref:place.ref,frame:place.layer.frame,provenance:place.layer.definition.provenance,datum:place.layer.datum,source:place.layer.source.identity,fields},null,2), 'Source details copied');
  }
  async function copy() {
    if (!place) return;
    await copyText(placeCoordinates(place), 'Coordinates copied');
  }
  function navigate(action: 'fly' | 'jump') {
    navError = frameError ?? (!range.ok ? range.error : place && navigateToPlace(place, action) ? '' : 'The place body is unavailable or hidden.');
    if (!navError && shell.layout === 'compact') minimizePanel('navigate');
  }
</script>

<div class="places-content">
<div class="place-browser" class:inactive={!!place}>
  <label class="grid gap-1"><span class="text-text-secondary">Search places</span>
    <input class="ui-control w-full rounded border border-border bg-surface-3 px-2 py-1" placeholder="Name or alias…" bind:value={query} />
  </label>
  <label class="flex items-center gap-2"><span class="w-10 shrink-0 text-text-secondary">Body</span>
    <select aria-label="Search place body" class="ui-control min-w-0 flex-1 rounded bg-surface-3 p-1" value={body} onchange={e => bodyChoice = e.currentTarget.value}>
      <option value="">All bodies</option>{#each bodies as name}<option value={name}>{name}</option>{/each}
    </select>
  </label>
  <Popover.Root bind:open={filtersOpen}>
    <Popover.Trigger class="ui-control flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded px-1 py-1 text-left text-text-secondary hover:bg-surface-3" title={filterSummary || 'Filter places and choose ordering'}>
      <ChevronDown size={13} class="shrink-0" /><span class="shrink-0 whitespace-nowrap text-xs">Filters and sort</span>{#if filterSummary}<span class="min-w-0 flex-1 truncate text-right text-xs text-text-muted">{filterSummary}</span>{/if}
    </Popover.Trigger>
    <Popover.Portal><Popover.Content side="bottom" align="start" sideOffset={4} class="w-64 max-w-[calc(100vw-32px)] p-3 ui-body space-y-2">
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
    </Popover.Content></Popover.Portal>
  </Popover.Root>
  <p class="text-xs text-text-secondary" role="status">{results.length.toLocaleString()} {results.length === 1 ? 'place' : 'places'}{results.length > renderedCount ? ` · showing ${renderedCount}, scroll for more` : ''}</p>
  {#if results.length}
    <ul bind:this={resultList} onscroll={onResultsScroll} aria-label="Named places" class="place-results space-y-1">
      {#each visibleResults as item (item.ref)}<li><button class="w-full rounded px-2 py-1 text-left hover:bg-surface-3" aria-pressed={place?.ref === item.ref} onclick={() => { filtersOpen = false; selectPlace(item); }}><span class="block">{item.name}</span><span class="flex flex-wrap justify-between gap-x-2 text-xs text-text-secondary"><span>{item.layer.body} · {placeCategory(item)}</span><span class="tabular-nums" title="Approximate diameter from the source; not a feature boundary">{placeDiameter(item)}</span></span></button></li>{/each}
      {#if renderedCount < results.length}<li><button class="w-full rounded px-2 py-2 text-text-secondary hover:bg-surface-3" onclick={revealMore}>Show more places ({visibleResults.length.toLocaleString()} of {results.length.toLocaleString()})</button></li>{/if}
    </ul>
  {:else}<p class="text-text-secondary">{bodies.length ? 'No places match this search and filters.' : 'No named places loaded in this scene.'}</p>{/if}
  </div>
  {#if place}{#key place.ref}
    <form class="place-inspector" onsubmit={e => { e.preventDefault(); navigate('fly'); }}>
      <button type="button" class="ui-control mb-2 flex shrink-0 cursor-pointer items-center gap-1 rounded py-1 text-xs text-text-secondary hover:text-text-primary" onclick={() => selectPlace(null)}><ArrowLeft size={13} />Back to places</button>
      <div class="inspector-scroll grid content-start gap-2.5">
      <div class="flex items-center justify-between gap-2">
        <h3 class="font-medium text-text-primary">{place.name}</h3>
        <button type="button" class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-secondary hover:bg-surface-3" aria-label="Clear selected place" title="Clear place information; the camera target stays active" onclick={() => selectPlace(null)}><X size={14} /></button>
      </div>
      <p class="text-text-secondary">{place.layer.body} · {placeCategory(place)}</p>
      <div class="flex items-center gap-1">
        <span class="font-mono text-xs" title="Planetocentric latitude · east longitude; matches Coordinates by default">{placeCoordinates(place, 4)}</span>
        <button type="button" class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-secondary hover:bg-surface-3" aria-label="Copy coordinates" title="Copy planetocentric coordinates for Navigate" onclick={copy}><Copy size={13} /></button>
      </div>
      <NavigationView scaleKm={target?.ok ? target.target.scaleKm : undefined} diameterKm={place.diameterKm} featureFraming />
      {#if !range.ok || navError}<p role="status">{!range.ok ? range.error : navError}</p>{/if}
      {#if copyStatus}<p role="status">{copyStatus}</p>{/if}
      <details>
        <summary class="ui-control flex cursor-pointer items-center gap-1 rounded py-1 text-text-secondary hover:text-text-primary"><ChevronRight class="details-chevron" size={13} />Place details</summary>
        <p class="mt-2 text-text-secondary">{about}</p>
        {#if place.diameterKm}
          <p class="mt-2 text-text-secondary">Indicative diameter: {place.diameterKm.toFixed(2)} km; not a boundary.</p>

        {/if}
        <p class="mt-2 text-text-secondary">Displayed and copied: planetocentric latitude, east longitude. Coordinates accepts these N/S/E/W pairs with its default latitude convention.</p>
        {#if place.feature.geometry.type === 'Point'}
          <p class="mt-2 text-text-secondary">Normalized catalog point (planetographic): {formatLatitude(place.feature.geometry.coordinates.latDeg, 8)}, {formatLongitude(place.feature.geometry.coordinates.lonDeg, 8)}. Original source coordinates and convention are retained below.</p>
        {/if}
        <p class="mt-2 text-text-secondary">Source type: {place.kind} · {place.origin === 'nomenclature' ? 'Official nomenclature' : 'Mission / user catalog'}</p>
        <button type="button" class="ui-control mt-2 min-h-7 cursor-pointer rounded px-2 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:cursor-default disabled:opacity-50" onclick={copySource}>Copy source details</button>
        <dl class="mt-2 space-y-1 break-words text-xs">
          <dt class="text-text-secondary">Provenance</dt><dd>{String(place.layer.definition.provenance?.attribution ?? 'Catalog-defined site')}</dd>
          <dt class="text-text-secondary">Source</dt><dd>{place.layer.source.identity}</dd>
          {#if place.layer.definition.provenance?.sourceUrl}
            <dt class="text-text-secondary">Original source</dt><dd>{String(place.layer.definition.provenance.sourceUrl)}</dd>
          {/if}
          {#if place.layer.definition.provenance?.sourceSha256}
            <dt class="text-text-secondary">Archive SHA-256</dt><dd>{String(place.layer.definition.provenance.sourceSha256)}</dd>
          {/if}
          <dt class="text-text-secondary">Frame</dt><dd>{place.layer.frame}</dd>
          <dt class="text-text-secondary">Reference</dt><dd>{JSON.stringify(place.layer.datum.referenceShape)} · geodetic latitude</dd>
          <dt class="text-text-secondary">Label anchor</dt><dd>Rendered surface when available; otherwise a supported terrain sample or the declared reference shape. Explicit source heights are preserved.</dd>
          <dt class="text-text-secondary">Place reference</dt><dd>{place.ref}</dd>
          {#each Object.entries(fields) as [key, value]}
            <dt class="text-text-secondary">{key}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
          {/each}
        </dl>
      </details>
      </div>
      {#if frameError}<p class="text-xs text-text-muted">{frameError}</p>{/if}
      <div class="mt-2 shrink-0 border-t border-border pt-2"><NavigationActions disabled={!!frameError || !target?.ok || !range.ok} onJump={() => navigate('jump')} /></div>
    </form>
  {/key}{/if}
  {#each [...vs.placeFailures, ...(vs.places?.diagnostics ?? [])] as message}
    <p class="mt-2 text-status-warning" role="status">{message}</p>
  {/each}
</div>

<style>
  .places-content, .place-browser, .place-inspector { display: flex; flex: 1; min-height: 0; flex-direction: column; overflow: hidden; }
  .place-browser { gap: .5rem; padding: 2px; margin: -2px; }
  .place-browser > :global(*) { flex-shrink: 0; }
  .place-browser.inactive { display: none; }
  .place-browser > .place-results { flex: 1; min-height: 0; overflow-y: auto; }
  .place-results, .inspector-scroll { padding: 2px; }
  .inspector-scroll { flex: 1; min-height: 0; overflow-y: auto; }
  .places-content { padding: 2px; margin: -2px; }
  summary { list-style: none; } summary::-webkit-details-marker { display: none; }
  details[open] :global(.details-chevron) { transform: rotate(90deg); }
  dd { overflow-wrap: anywhere; user-select: text; } dt { margin-top: .5rem; }
</style>
