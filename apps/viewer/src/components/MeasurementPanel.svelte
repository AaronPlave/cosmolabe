<script lang="ts">
  import { Eye, EyeOff, MousePointer2, Trash2, X } from 'lucide-svelte';
  import { endpointLabel, type SpatialEndpoint, type SpatialRelationship } from '@cosmolabe/core';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';
  import { vs } from '../lib/viewer-state.svelte';
  import {
    addMeasurement, measurementValue, measurements, removeMeasurement,
    resetMeasurementDraft, syncMeasurements,
  } from '../lib/spatial-measurements.svelte';

  interface Props { onClose: () => void; }
  let { onClose }: Props = $props();
  let kind = $state<'distance' | 'angle' | 'direction'>('distance');
  const bodies = $derived(vs.bodies.map(body => body.name).sort());
  const canCreate = $derived(!!measurements.draft.source && !!measurements.draft.target &&
    (kind !== 'angle' || !!measurements.draft.vertex));

  function changeKind(next: typeof kind) {
    kind = next;
    measurements.pendingPickSlot = null;
    if (next !== 'angle') measurements.draft.vertex = null;
  }
  function setEntity(slot: 'source'|'target'|'vertex', bodyName: string) {
    measurements.draft[slot] = bodyName ? { kind: 'entity', bodyName } : null;
    if (measurements.pendingPickSlot === slot) measurements.pendingPickSlot = null;
  }
  function create() {
    const source = measurements.draft.source, target = measurements.draft.target;
    if (!canCreate || !source || !target) return;
    const base = { id: crypto.randomUUID(), source, target, color: colorFor(measurements.items.length) };
    if (kind === 'angle') addMeasurement({ ...base, kind, vertex: measurements.draft.vertex! });
    else addMeasurement({ ...base, kind, showDistance: true });
  }
  function close() { resetMeasurementDraft(); onClose(); }
  function toggle(item: SpatialRelationship) { item.visible = item.visible === false; syncMeasurements(); }
  function describe(endpoint: SpatialEndpoint | null): string {
    if (!endpoint) return 'Choose entity…';
    if (endpoint.kind !== 'body-fixed') return endpointLabel(endpoint);
    const [x,y,z] = endpoint.positionKm;
    return `${endpoint.bodyName} point (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)} km)`;
  }
  function colorFor(index: number): string { return ['#82aabd','#c6a66b','#9ab58d','#b493ad'][index % 4]; }
</script>

<InstrumentPanel key="measure" title="Measurements" width={344} onClose={close}>
  <p class="ui-helper mb-3 text-text-secondary">Distances are 3D Euclidean chords. Surface points remain fixed to their body.</p>
  <div class="flex gap-1" aria-label="Measurement type">
    {#each ['distance','angle','direction'] as option}
      <button class="ui-control type-btn" class:active={kind === option} aria-pressed={kind === option} onclick={() => changeKind(option as typeof kind)}>{option}</button>
    {/each}
  </div>
  {@render endpointRow('source', 'Source')}
  {#if kind === 'angle'}{@render endpointRow('vertex', 'Vertex')}{/if}
  {@render endpointRow('target', 'Target')}
  {#if measurements.pendingPickSlot}
    <div class="ui-helper pick-instruction">Pick {measurements.pendingPickSlot} point in the scene · Esc to cancel</div>
  {/if}
  <button class="ui-control add-btn" disabled={!canCreate} onclick={create}>Add {kind}</button>

  {#if measurements.items.length}<div class="divider"></div>{/if}
  {#each measurements.items as item (item.id)}
    {@const value = measurementValue(item, vs.et)}
    <div class="item" class:unavailable={value.includes('Unavailable') || value.includes('Undefined')}>
      <span class="swatch" style:background={item.color ?? '#82aabd'}></span>
      <div class="min-w-0 flex-1"><strong>{item.kind}</strong><small>{endpointLabel(item.source)} → {item.kind === 'angle' ? `${endpointLabel(item.vertex)} → ` : ''}{endpointLabel(item.target)}</small><span class="value">{value}</span></div>
      <button class="icon-btn" aria-label={item.visible === false ? `Show ${item.kind}` : `Hide ${item.kind}`} title={item.visible === false ? 'Show' : 'Hide'} onclick={() => toggle(item)}>{#if item.visible === false}<Eye size={14}/>{:else}<EyeOff size={14}/>{/if}</button>
      <button class="icon-btn" aria-label={`Remove ${item.kind}`} title="Remove" onclick={() => removeMeasurement(item.id)}><Trash2 size={14}/></button>
    </div>
  {/each}
</InstrumentPanel>

{#snippet endpointRow(slot: 'source'|'target'|'vertex', title: string)}
  {@const endpoint = measurements.draft[slot]}
  <div class="field"><span class="ui-label">{title}</span><div class="endpoint">
    {#if endpoint?.kind === 'body-fixed'}
      <div class="ui-control picked" title={describe(endpoint)}>{describe(endpoint)}</div>
      <button class="icon-btn" aria-label={`Clear picked ${slot}`} title="Clear picked point" onclick={() => measurements.draft[slot] = null}><X size={14}/></button>
    {:else}
      <select class="ui-control" value={endpoint?.kind === 'entity' ? endpoint.bodyName : ''} onchange={(e) => setEntity(slot, e.currentTarget.value)}><option value="">Choose entity…</option>{#each bodies as body}<option value={body}>{body}</option>{/each}</select>
    {/if}
    <button class="icon-btn" class:active={measurements.pendingPickSlot === slot} aria-label={`Pick ${slot} surface point`} title={`Pick ${slot} surface point`} onclick={() => measurements.pendingPickSlot = slot}><MousePointer2 size={14}/></button>
  </div></div>
{/snippet}

<style>
  .type-btn,.add-btn,.icon-btn,select,.picked{border:1px solid var(--color-chrome-border);border-radius:4px;background:var(--color-surface-3);color:var(--color-text-secondary)}.type-btn{flex:1;text-transform:capitalize}.type-btn.active,.icon-btn.active{color:var(--color-text-primary);border-color:var(--color-text-muted);background:var(--color-control-hover)}.field{margin-top:9px}.endpoint{display:flex;gap:5px;margin-top:3px}select,.picked{min-width:0;flex:1;padding:5px 7px}.picked{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.icon-btn{display:grid;place-items:center;width:29px;min-width:29px}.icon-btn:hover{color:var(--color-text-primary);background:var(--color-control-hover)}.pick-instruction{margin-top:8px;color:var(--color-chrome-active)}.add-btn{width:100%;margin-top:10px;padding:6px;color:var(--color-text-primary)}.add-btn:disabled{cursor:not-allowed;opacity:.4}.divider{border-top:1px solid var(--color-chrome-border);margin:14px 0 5px}.item{display:flex;align-items:center;gap:6px;padding:7px 0}.item.unavailable .value{color:var(--color-warning)}.swatch{width:3px;height:30px;border-radius:2px}.item strong,.item small,.value{display:block}.item strong{text-transform:capitalize;color:var(--color-text-primary)}.item small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-text-muted)}.value{font-family:var(--font-mono);font-size:var(--text-metadata);color:var(--color-text-secondary)}
</style>
