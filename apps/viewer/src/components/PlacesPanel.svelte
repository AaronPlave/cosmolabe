<script lang="ts">
  import InstrumentPanel from './shell/InstrumentPanel.svelte';
  import Checkbox from '$lib/components/ui/checkbox/checkbox.svelte';
  import { Button } from '$lib/components/ui/button';
  import { vs, getRenderer } from '../lib/viewer-state.svelte';
  import { showPlaceBody, showPlaceDataset, navigateToPlace, selectPlace, placeCoordinates } from '../lib/places';
  let { onClose }: { onClose: () => void } = $props();
  const place = $derived(vs.selectedPlaceRef ? vs.places?.byRef.get(vs.selectedPlaceRef) : undefined);
  const bodies = $derived([...new Set(vs.places?.places.map(p => p.layer.body) ?? [])]);
  const layers = $derived([...new Map(vs.places?.places.map(p => [p.layer.id, p.layer]) ?? []).values()]);
  let copyStatus = $state('');
  let navError = $state('');
  async function copy() {
    if (!place) return;
    try { await navigator.clipboard.writeText(placeCoordinates(place)); copyStatus = 'Coordinates copied'; }
    catch { copyStatus = 'Clipboard unavailable'; }
  }
  function navigate(action: 'fly' | 'jump') {
    navError = place && navigateToPlace(place, action) ? '' : 'The place body is unavailable or hidden.';
  }
</script>

<InstrumentPanel key="places" title="Places" width={300} {onClose}>
  <p class="mb-3 text-text-secondary">Search names in the command palette (⌘/Ctrl K). Select a result to show its source and navigate.</p>
  {#if !bodies.length}
    <p>No named point datasets loaded. Open a scene with geographic place layers.</p>
  {/if}
  {#each bodies as body}
    <label class="flex items-center gap-2 mb-2">
      <Checkbox checked={vs.placeBodies.includes(body)} onCheckedChange={(checked) => showPlaceBody(body, checked === true)} />
      <span>{body} geographic names</span>
    </label>
  {/each}
  {#if layers.length}
    <details class="mb-3">
      <summary>Datasets ({layers.length})</summary>
      {#each layers as layer}
        <label class="flex items-center gap-2 my-2">
          <Checkbox checked={!vs.hiddenPlaceLayers.includes(layer.id)} onCheckedChange={(checked) => showPlaceDataset(layer.id, checked === true)} />
          <span class="min-w-0 break-words">{layer.name} ({layer.features.length})</span>
        </label>
      {/each}
    </details>
  {/if}
  {#if place}
    <div class="border-t border-border pt-3 space-y-2">
      <div class="flex justify-between gap-2"><strong>{place.name}</strong><button aria-label="Clear selected place" onclick={() => selectPlace(null)}>×</button></div>
      <p>{place.layer.body} · {place.kind} · {place.origin}</p>
      {#if place.feature.geometry.type === 'Point'}
        <p class="font-mono text-xs">{place.feature.geometry.coordinates.latDeg.toFixed(5)}° N, {place.feature.geometry.coordinates.lonDeg.toFixed(5)}° E</p>
      {/if}
      <p class="text-text-secondary">Source point anchor. Height and feature boundary are not implied.</p>
      {#if place.diameterKm}<p>Indicative diameter: {place.diameterKm.toFixed(2)} km</p>{/if}
      <div class="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onclick={() => navigate('fly')}>Fly to</Button>
        <Button size="sm" variant="secondary" onclick={() => navigate('jump')}>Jump to</Button>
        <Button size="sm" variant="secondary" onclick={copy}>Copy coordinates</Button>
      </div>
      <p class="text-xs text-text-secondary">Copy uses planetocentric latitude for Navigate.</p>
      {#if navError}<p role="status">{navError}</p>{/if}
      {#if copyStatus}<p role="status">{copyStatus}</p>{/if}
      <details open>
        <summary>Show details</summary>
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
          <dt class="text-text-secondary">Label anchor</dt><dd>{getRenderer()?.getBodyMesh(place.layer.body)?.hasTerrain ? 'Physical terrain sample when resident; reference shape fallback' : 'Declared reference shape fallback'}</dd>
          <dt class="text-text-secondary">Place reference</dt><dd>{place.ref}</dd>
          {#each Object.entries(place.feature.properties?.sourceFields ?? {}) as [key, value]}
            <dt class="text-text-secondary">{key}</dt><dd>{String(value)}</dd>
          {/each}
        </dl>
      </details>
    </div>
  {/if}
  {#each [...vs.placeFailures, ...(vs.places?.diagnostics ?? [])] as message}
    <p class="mt-2 text-status-warning" role="status">{message}</p>
  {/each}
</InstrumentPanel>
