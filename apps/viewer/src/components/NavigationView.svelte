<script lang="ts">
  import { defaultSurfaceRangeKm, type SurfaceViewPreset } from '@cosmolabe/core';
  import SegmentedControl from '$lib/components/ui/segmented-control.svelte';
  import { navigationView as view } from '../lib/navigation-view.svelte';
  let { scaleKm, diameterKm }: { scaleKm?: number; diameterKm?: number } = $props();
  const unit = $derived(view.preset === 'surface' ? 'm' : 'km');
  const label = $derived(view.preset === 'overhead' ? 'Altitude' : view.preset === 'oblique' ? 'Slant range' : 'Eye height');
  const placeholder = $derived(scaleKm ? `${Number((defaultSurfaceRangeKm(view.preset, scaleKm) * (unit === 'm' ? 1000 : 1)).toPrecision(3))} ${unit} (auto)` : 'auto');
</script>
<div class="grid gap-2.5">
  <div class="grid gap-1"><span class="text-text-secondary">View</span>
    <SegmentedControl label="View" value={view.preset} options={['overhead', 'oblique', 'surface']} onValueChange={v => { view.preset = v as SurfaceViewPreset; view.rangeText = ''; }} />
  </div>
  <div class="grid gap-1"><span class="flex items-center justify-between gap-1"><span class="text-text-secondary">{label} ({unit})</span><span class="flex gap-1">
    <button type="button" class="ui-control cursor-pointer rounded px-1.5 text-xs text-text-secondary hover:bg-surface-3" aria-label="Auto" title="Automatic body-scale range" onclick={() => view.rangeText = ''}>Auto</button>
    {#if diameterKm}<button type="button" class="ui-control cursor-pointer rounded px-1.5 text-xs text-text-secondary hover:bg-surface-3" aria-label="Fit feature" title="Approximate framing using 1.5 × the indicative diameter; not a feature boundary" onclick={() => { view.preset = 'overhead'; view.rangeText = String(Math.max(5, diameterKm * 1.5)); }}>Fit feature</button>{/if}
    </span></span>
    <input class="ui-control min-w-0 w-full bg-surface-3 text-text-primary border border-border rounded px-2 py-1 outline-none font-mono" aria-label={`Custom ${label.toLowerCase()} (${unit})`} bind:value={view.rangeText} {placeholder} inputmode="decimal" autocomplete="off" />
  </div>
</div>
