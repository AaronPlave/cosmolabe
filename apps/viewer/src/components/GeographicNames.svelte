<script lang="ts">
  import { vs } from '../lib/viewer-state.svelte';
  import { showPlaceBody, showPlaceDataset } from '../lib/places';
  import Checkbox from '$lib/components/ui/checkbox/checkbox.svelte';
  const bodies = $derived([...new Set(vs.places?.places.map(p => p.layer.body) ?? [])]);
  const layers = $derived([...new Map(vs.places?.places.map(p => [p.layer.id,p.layer]) ?? []).values()]);
</script>
{#if bodies.length}
<details class="my-3"><summary class="cursor-pointer">Geographic names</summary>
  <div class="mt-2 space-y-2">
    {#each bodies as body}<label class="flex items-center gap-2"><Checkbox checked={vs.placeBodies.includes(body)} onCheckedChange={checked => showPlaceBody(body, checked === true)} /><span>{body} geographic names</span></label>{/each}
    <details><summary class="cursor-pointer">Datasets ({layers.length})</summary>
      {#each layers as layer}<label class="flex items-center gap-2 my-2"><Checkbox checked={!vs.hiddenPlaceLayers.includes(layer.id)} onCheckedChange={checked => showPlaceDataset(layer.id, checked === true)} /><span class="min-w-0 break-words">{layer.name} ({layer.features.length})</span></label>{/each}
    </details>
  </div>
</details>
{/if}
