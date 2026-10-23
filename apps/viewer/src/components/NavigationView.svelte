<script lang="ts">
  import { defaultSurfaceRangeKm, type SurfaceViewPreset } from '@cosmolabe/core';
  import SegmentedControl from '$lib/components/ui/segmented-control.svelte';
  import { navigationView as view, featureRangeKm, setNavigationFraming } from '../lib/navigation-view.svelte';
  let { scaleKm, diameterKm, featureFraming = false }: { scaleKm?: number; diameterKm?: number; featureFraming?: boolean } = $props();
  const unit = $derived(view.preset === 'surface' ? 'm' : 'km');
  const label = $derived(view.preset === 'overhead' ? 'Altitude' : view.preset === 'oblique' ? 'Slant range' : 'Eye height');
  const fitKm = $derived(featureFraming ? featureRangeKm(diameterKm) : undefined);
  const framing = $derived(view.framing === 'feature' && featureFraming ? 'Fit feature' : view.framing === 'custom' ? 'Custom' : 'Auto');
  const rangeText = $derived(view.framing === 'custom' ? view.rangeText : view.framing === 'feature' && fitKm !== undefined ? String(fitKm) : '');
  const placeholder = $derived(scaleKm ? `${Number((defaultSurfaceRangeKm(view.preset, scaleKm) * (unit === 'm' ? 1000 : 1)).toPrecision(3))} ${unit} (auto)` : 'auto');
</script>
<div class="grid gap-2.5">
  <div class="grid gap-1"><span class="text-text-secondary">View</span>
    <SegmentedControl label="View" value={view.preset} options={['overhead', 'oblique', 'surface']} onValueChange={v => { view.preset = v as SurfaceViewPreset; setNavigationFraming('auto'); }} />
  </div>
  <div class="grid gap-1"><span class="text-text-secondary">Framing</span>
    <SegmentedControl label="Framing" value={framing} options={featureFraming ? ['Auto', 'Fit feature', 'Custom'] : ['Auto', 'Custom']} onValueChange={v => setNavigationFraming(v === 'Fit feature' ? 'feature' : v === 'Custom' ? 'custom' : 'auto', diameterKm)} />
    {#if featureFraming && view.framing === 'feature'}<p class="text-xs text-text-muted">{fitKm === undefined ? 'No indicative diameter; using Auto.' : 'Approximate fit from indicative diameter; not a feature boundary.'}</p>{/if}
  </div>
  <div class="grid gap-1"><span class="text-text-secondary">{label} ({unit})</span>
    <input class="ui-control min-w-0 w-full bg-surface-3 text-text-primary border border-border rounded px-2 py-1 outline-none font-mono" aria-label={`Custom ${label.toLowerCase()} (${unit})`} value={rangeText} oninput={e => { view.rangeText = e.currentTarget.value; view.framing = view.rangeText.trim() ? 'custom' : 'auto'; }} {placeholder} inputmode="decimal" autocomplete="off" />
  </div>
</div>
