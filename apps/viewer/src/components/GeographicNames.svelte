<script lang="ts">
  import { vs } from '../lib/viewer-state.svelte';
  import { showPlaceBody, showPlaceDataset, setPlaceSourceEnabled } from '../lib/places';
  import Checkbox from '$lib/components/ui/checkbox/checkbox.svelte';
  const bodies = $derived([...new Set(vs.places?.places.map(p => p.layer.body) ?? [])]);
  // Group by explicit provenance rather than filenames or chunk suffixes.
  // Sources without shared provenance retain their catalog layer identity.
  const sources = $derived.by(() => {
    const groups = new Map<string, { name: string; attribution: string; layers: Set<string>; count: number }>();
    for (const p of vs.places?.places ?? []) {
      const provenance = p.layer.definition.provenance;
      const official = p.origin === 'nomenclature';
      const identity = provenance?.sourceUrl ?? provenance?.sourceSha256 ?? p.layer.id;
      const key = JSON.stringify([p.layer.body, p.origin, identity]);
      let group = groups.get(key);
      if (!group) {
        group = { name: official ? `${p.layer.body} Gazetteer` : p.layer.name,
          attribution: String(provenance?.attribution ?? 'Mission / user catalog'), layers: new Set(), count: 0 };
        groups.set(key, group);
      }
      group.layers.add(p.layer.id); group.count++;
    }
    return [...groups.values()];
  });
  const noSources = $derived(sources.length > 0 && sources.every(source => [...source.layers].every(id => (vs.hiddenPlaceLayers.includes(id) || vs.excludedPlaceLayers.includes(id)))));
  const allVisible = $derived(bodies.every(b => vs.placeBodies.includes(b)));
</script>
{#if bodies.length}
  <label class="ui-body flex items-center gap-2 px-3 py-1 cursor-pointer hover:bg-surface-3">
    <Checkbox class="h-3.5 w-3.5" checked={allVisible} indeterminate={!allVisible && bodies.some(b => vs.placeBodies.includes(b))} onCheckedChange={checked => bodies.forEach(b => showPlaceBody(b, checked === true))} />
    <span>Geographic names</span>
  </label>
  {#if noSources}<p class="px-3 py-1 ui-meta text-text-muted" role="status">No name sources enabled</p>{/if}
  <details class="px-3 py-1 ui-body">
    <summary class="cursor-pointer text-text-secondary">By body</summary>
    <div class="ml-4 mt-1">
      {#each bodies as body}<label class="flex items-center gap-2 py-1 cursor-pointer"><Checkbox class="h-3.5 w-3.5" checked={vs.placeBodies.includes(body)} onCheckedChange={checked => showPlaceBody(body, checked === true)} /><span>{body} geographic names</span></label>{/each}
    </div>
  </details>
  <details class="px-3 py-1 ui-body">
    <summary class="cursor-pointer text-text-secondary">Name sources</summary>
    <div class="ml-4 mt-1 space-y-2">
      <p class="ui-meta text-text-muted">Include sources in search and navigation. Show labels controls only the 3D names.</p>
      {#each sources as source}
        {@const included = [...source.layers].filter(id => !vs.excludedPlaceLayers.includes(id)).length}
        {@const visible = [...source.layers].filter(id => !vs.hiddenPlaceLayers.includes(id)).length}
        <div>
          <p class="text-text-secondary">{source.name} ({source.count.toLocaleString()})</p>
          <div class="flex flex-wrap gap-x-3">
            <label class="flex cursor-pointer items-center gap-1.5 py-1"><Checkbox class="h-3.5 w-3.5" aria-label={`Include ${source.name}`} checked={included === source.layers.size} indeterminate={included > 0 && included < source.layers.size} onCheckedChange={checked => setPlaceSourceEnabled([...source.layers], checked === true)} /><span>Include source</span></label>
            <label class="flex cursor-pointer items-center gap-1.5 py-1"><Checkbox class="h-3.5 w-3.5" aria-label={`Show labels for ${source.name}`} disabled={included === 0} checked={visible === source.layers.size} indeterminate={visible > 0 && visible < source.layers.size} onCheckedChange={checked => source.layers.forEach(id => showPlaceDataset(id, checked === true))} /><span>Show labels</span></label>
          </div>
          <p class="ml-5 ui-meta text-text-muted break-words">{source.attribution}</p>
        </div>
      {/each}
    </div>
  </details>
{/if}
