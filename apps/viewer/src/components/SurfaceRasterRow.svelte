<script lang="ts">
  import { Eye, EyeOff } from 'lucide-svelte';
  import type { SurfaceRasterDefinition } from '@cosmolabe/core';
  import { rasterProduct, toggleRaster } from '../lib/surface-rasters.svelte';
  import { goToCoordinates, setProbeActive } from '../lib/viewer-state.svelte';

  let { definition }: { definition: SurfaceRasterDefinition } = $props();
  const product = $derived.by(() => {
    const instance = rasterProduct(definition.id);
    return instance && { instance, status: instance.status, manifest: instance.manifest, error: instance.error };
  });
  const first = $derived(definition.colorScale[0]);
  const last = $derived(definition.colorScale.at(-1)!);
  const gradient = $derived(definition.colorScale.map(stop =>
    `${stop.color} ${100 * (stop.value - first.value) / (last.value - first.value)}%`).join(', '));
  let error = $state('');
  let opacity = $state(0);
  $effect(() => { opacity = product?.instance.opacity ?? definition.opacity; });

  async function toggle() {
    error = '';
    try { await toggleRaster(definition); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  }

  function jumpToObservation() {
    const observation = definition.observation;
    if (!observation) return;
    const result = goToCoordinates({
      ...observation, bodyName: definition.body, latitude: 'planetocentric', longitudeDirection: 'east',
    }, { preset: 'overhead', animate: false, rangeKm: 35 });
    error = result.ok ? '' : result.error;
  }
</script>

<div class="science-row">
  <button class="visibility" onclick={toggle} aria-pressed={product?.status === 'ready'}
    aria-label="{product?.status === 'error' ? 'Retry' : product ? 'Hide' : 'Show'} {definition.name}">
    {#if product?.status === 'ready'}<Eye size={14} />{:else}<EyeOff size={14} />{/if}
  </button>
  <details>
    <summary>{definition.name}</summary>
    <p class="ui-meta">{definition.description}</p>
    {#if product?.manifest?.features}
      <p class="ui-meta">Teal marks mapped permanently shadowed regions.</p>
    {:else if definition.unit}
      <div class="legend" style:background="linear-gradient(to right, {gradient})"></div>
      <div class="legend-labels ui-meta"><span>{first.value}</span><span>{definition.unit}</span><span>{last.value}</span></div>
    {/if}
    {#if product?.status === 'ready' && product.manifest}
      <p class="ui-meta">
        {definition.quantity} · {product.manifest.source.originalResolutionM} m source sampling<br />
        <a href={product.manifest.source.url} target="_blank" rel="noreferrer">{product.manifest.source.reference}</a>
      </p>
      <label class="ui-meta opacity">
        Opacity
        <input type="range" min="0" max="1" step="0.01" bind:value={opacity}
          oninput={(e) => { if (product) product.instance.opacity = e.currentTarget.valueAsNumber; }} />
      </label>
      <div class="science-actions">
        {#if definition.observation}
          <button class="probe ui-meta" onclick={jumpToObservation}
            aria-label="Jump to observation for {definition.name}">Jump to observation</button>
        {/if}
        <button class="probe ui-meta" onclick={() => setProbeActive(true)}
          aria-label="Inspect {definition.name} with Point Probe">Inspect with Point Probe</button>
      </div>
    {/if}
  </details>
</div>
{#if product?.status === 'loading'}
  <p class="ui-meta status" role="status">Loading science layer…</p>
{:else if product?.status === 'error' || error}
  <p class="ui-meta status" role="status">{error || product?.error}</p>
{/if}

<style>
  .science-row { display: flex; align-items: flex-start; gap: 0.5rem; padding: 0.25rem 0; }
  .visibility { display: grid; place-items: center; min-width: 1.75rem; min-height: 1.5rem; color: var(--text-muted); }
  details { flex: 1; min-width: 0; }
  summary { cursor: pointer; padding: 0.15rem 0; }
  p { margin: 0.35rem 0; }
  .legend { height: 0.5rem; border-radius: 0.25rem; }
  .legend-labels { display: flex; justify-content: space-between; }
  .opacity { display: flex; align-items: center; gap: 0.5rem; }
  .opacity input { width: 6rem; }
  .science-actions { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; }
  .probe, a { text-decoration: underline; }
  .status { margin-left: 2.25rem; }
</style>
