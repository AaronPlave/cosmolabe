<script lang="ts">
  import type { SurfacePoint } from '@cosmolabe/core';
  import { science, rasterSamples, outlineShadowRegion } from '../lib/surface-rasters.svelte';

  let { point }: { point: Pick<SurfacePoint, 'bodyName' | 'frame' | 'bodyFixedPositionKm'> } = $props();
  let readings = $state<Awaited<ReturnType<typeof rasterSamples>>>([]);
  let scienceError = $state('');
  $effect(() => {
    void science.revision;
    const pin = point;
    readings = [];
    scienceError = '';
    let current = true;
    void rasterSamples(pin).then(samples => {
      if (current) readings = samples;
    });
    return () => { current = false; };
  });

  async function outline(id: string, gid: number) {
    scienceError = '';
    try { await outlineShadowRegion(id, gid); }
    catch (cause) { scienceError = cause instanceof Error ? cause.message : String(cause); }
  }
</script>

{#each readings as { product, value, feature, error } (product.definition.id)}
  <div class="mt-2 ui-meta">
    <div class="font-semibold">{product.definition.name}</div>
    {#if error}
      <span>{error}</span>
    {:else if feature}
      <span>{feature.name} · {feature.area_km2.toLocaleString()} km²</span>
      <button type="button" class="ml-1 underline" onclick={() => outline(product.definition.id, feature.gid)}>Show exact boundary</button>
    {:else if value === null}
      <span>Outside mapped coverage or no observation</span>
    {:else if product.manifest?.features}
      <span>No mapped region over 1 km² at this sample</span>
    {:else}
      <span>{Number(value.toPrecision(7))} {product.definition.unit}</span>
    {/if}
  </div>
{/each}
{#if scienceError}<p class="ui-meta" role="status">{scienceError}</p>{/if}
