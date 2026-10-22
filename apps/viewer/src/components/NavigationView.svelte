<script lang="ts">
  import { defaultSurfaceRangeKm, type SurfaceViewPreset } from '@cosmolabe/core';
  import SegmentedControl from '$lib/components/ui/segmented-control.svelte';
  import { navigationView as view } from '../lib/navigation-view.svelte';
  let { scaleKm }: { scaleKm?: number } = $props();
  const unit = $derived(view.preset === 'surface' ? 'm' : 'km');
  const label = $derived(view.preset === 'overhead' ? 'Altitude' : view.preset === 'oblique' ? 'Slant range' : 'Eye height');
  const placeholder = $derived(scaleKm ? `${Number((defaultSurfaceRangeKm(view.preset, scaleKm) * (unit === 'm' ? 1000 : 1)).toPrecision(3))} ${unit} (auto)` : 'auto');
</script>
<div class="grid gap-2.5">
  <div class="grid gap-1"><span class="text-text-secondary">View</span>
    <SegmentedControl label="View" value={view.preset} options={['overhead', 'oblique', 'surface']} onValueChange={v => { view.preset = v as SurfaceViewPreset; view.rangeText = ''; }} />
  </div>
  <label class="grid gap-1"><span class="text-text-secondary">{label} ({unit})</span>
    <input class="ui-control min-w-0 w-full bg-surface-3 text-text-primary border border-border rounded px-2 py-1 outline-none font-mono" bind:value={view.rangeText} {placeholder} inputmode="decimal" autocomplete="off" />
  </label>
</div>
