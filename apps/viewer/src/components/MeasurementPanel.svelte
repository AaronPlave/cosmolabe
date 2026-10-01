<script lang="ts">
  import { Eye, EyeOff, MousePointer2, Trash2, X } from 'lucide-svelte';
  import { endpointLabel, type SpatialEndpoint, type SpatialRelationship } from '@cosmolabe/core';
  import { Button } from '$lib/components/ui/button';
  import * as Select from '$lib/components/ui/select';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';
  import { vs } from '../lib/viewer-state.svelte';
  import {
    addMeasurement, measurementValue, measurements, removeMeasurement,
    resetMeasurementDraft, syncMeasurements,
  } from '../lib/spatial-measurements.svelte';

  interface Props { onClose: () => void; }
  let { onClose }: Props = $props();
  const kind = $derived(measurements.draftKind);
  const bodies = $derived(vs.bodies.map(body => body.name).sort());
  const canCreate = $derived(!!measurements.draft.source && !!measurements.draft.target &&
    (kind !== 'angle' || !!measurements.draft.vertex));

  function changeKind(next: typeof kind) {
    measurements.draftKind = next;
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
    const base = { id: crypto.randomUUID(), source, target, color: colorFor(measurements.nextColor) };
    if (kind === 'angle') addMeasurement({ ...base, kind, vertex: measurements.draft.vertex! });
    else addMeasurement({ ...base, kind, showDistance: true });
  }
  function close() { resetMeasurementDraft(); onClose(); }
  function toggle(item: SpatialRelationship) { item.visible = item.visible === false; syncMeasurements(); }
  function describe(endpoint: SpatialEndpoint | null): string {
    if (!endpoint) return 'Choose entity…';
    return endpointLabel(endpoint);
  }
  function emphasize(id: string | null, hover = false) {
    if (hover) measurements.hoveredId = id;
    else measurements.selectedId = id;
    syncMeasurements();
  }
  function setColor(item: SpatialRelationship, color: string) { item.color = color; syncMeasurements(); }
  function colorFor(index: number): string { return ['#82aabd','#c6a66b','#9ab58d','#b493ad'][index % 4]; }
</script>

<InstrumentPanel key="measure" title="Measurements" width={344} onClose={close}>
  <p class="ui-helper mb-3 text-text-secondary">Distances are 3D Euclidean chords. Surface points remain fixed to their body.</p>
  <div class="flex gap-1" aria-label="Measurement type">
    {#each ['distance','angle','direction'] as option}
      <Button variant={kind === option ? "secondary" : "outline"} size="sm" class="ui-control flex-1 capitalize" aria-pressed={kind === option} onclick={() => changeKind(option as typeof kind)}>{option}</Button>
    {/each}
  </div>
  {@render endpointRow('source', 'Source')}
  {#if kind === 'angle'}{@render endpointRow('vertex', 'Vertex')}{/if}
  {@render endpointRow('target', 'Target')}
  {#if measurements.pendingPickSlot}
    <div class="ui-helper pick-instruction">Pick {measurements.pendingPickSlot} point in the scene · Esc to cancel</div>
  {/if}
  <Button variant="secondary" size="sm" class="ui-control w-full mt-3" disabled={!canCreate} onclick={create}>Add {kind}</Button>

  {#if measurements.items.length}<div class="divider"></div>{/if}
  {#each measurements.items as item (item.id)}
    {@const value = measurementValue(item, vs.et)}
    <div class="item" role="group" aria-label={`${item.kind} measurement`} onmouseenter={() => emphasize(item.id, true)} onmouseleave={() => emphasize(null, true)} class:selected={measurements.selectedId === item.id} class:unavailable={value.includes('Unavailable') || value.includes('Undefined')}>
      <input type="color" class="swatch" value={item.color ?? '#82aabd'} aria-label={`Color for ${item.kind}`} title="Measurement color" oninput={(e) => setColor(item, e.currentTarget.value)} />
      <div class="min-w-0 flex-1"><Button variant="ghost" size="xs" class="ui-label justify-start px-0 capitalize" aria-label={`Select ${item.kind} measurement`} aria-pressed={measurements.selectedId === item.id} onclick={() => emphasize(measurements.selectedId === item.id ? null : item.id)}>{item.kind}</Button><small>{endpointLabel(item.source)} → {item.kind === 'angle' ? `${endpointLabel(item.vertex)} → ` : ''}{endpointLabel(item.target)}</small><span class="value">{value}</span></div>
      <Button variant="ghost" size="icon-sm" aria-label={item.visible === false ? `Show ${item.kind}` : `Hide ${item.kind}`} title={item.visible === false ? 'Show' : 'Hide'} onclick={() => toggle(item)}>{#if item.visible === false}<Eye size={14}/>{:else}<EyeOff size={14}/>{/if}</Button>
      <Button variant="ghost" size="icon-sm" aria-label={`Remove ${item.kind}`} title="Remove" onclick={() => removeMeasurement(item.id)}><Trash2 size={14}/></Button>
    </div>
  {/each}
</InstrumentPanel>

{#snippet endpointRow(slot: 'source'|'target'|'vertex', title: string)}
  {@const endpoint = measurements.draft[slot]}
  <div class="field"><span class="ui-label">{title}</span><div class="endpoint">
    {#if endpoint?.kind === 'body-fixed'}
      <div class="ui-control picked" title={describe(endpoint)}>{describe(endpoint)}</div>
      <Button variant="ghost" size="icon-sm" aria-label={`Clear picked ${slot}`} title="Clear picked point" onclick={() => measurements.draft[slot] = null}><X size={14}/></Button>
    {:else}
      <Select.Root type="single" value={endpoint?.kind === 'entity' ? endpoint.bodyName : ''} onValueChange={(value) => setEntity(slot, value)}>
        <Select.Trigger size="sm" class="ui-control min-w-0 flex-1 rounded border-border bg-surface-3 px-2 text-text-primary" aria-label={`${title} entity`}>
          <Select.Value placeholder="Choose entity…" />
        </Select.Trigger>
        <Select.Content class="max-w-[calc(100vw-24px)] rounded-md border border-border bg-panel p-1">
          {#each bodies as body}<Select.Item value={body} label={body} class="ui-control">{body}</Select.Item>{/each}
        </Select.Content>
      </Select.Root>
    {/if}
    <Button variant="ghost" size="icon-sm" class={measurements.pendingPickSlot === slot ? "bg-control-hover text-text-primary" : "text-text-secondary"} aria-label={`Pick ${slot} surface point`} title={`Pick ${slot} surface point`} onclick={() => measurements.pendingPickSlot = slot}><MousePointer2 size={14}/></Button>
  </div></div>
{/snippet}

<style>
  .field { margin-top: 10px; }
  .endpoint { display: flex; gap: 5px; margin-top: 3px; }
  .picked {
    min-width: 0;
    flex: 1;
    padding: 5px 7px;
    border: 1px solid var(--color-chrome-border);
    border-radius: 4px;
    background: var(--color-surface-3);
    color: var(--color-text-secondary);
    overflow-wrap: anywhere;
  }
  .pick-instruction { margin-top: 8px; color: var(--color-chrome-active); }
  .divider { border-top: 1px solid var(--color-chrome-border); margin: 14px 0 5px; }
  .item { display: flex; align-items: center; gap: 6px; padding: 7px 3px; border-radius: 4px; }
  .item:hover, .item.selected { background: var(--color-surface-3); }
  .item.unavailable .value { color: var(--color-warning); }
  .swatch { width: 18px; height: 24px; padding: 0; border: none; background: transparent; cursor: pointer; flex-shrink: 0; }
  .swatch::-webkit-color-swatch-wrapper { padding: 2px; }
  .swatch::-webkit-color-swatch { border: none; border-radius: 3px; }
  .swatch::-moz-color-swatch { border: none; border-radius: 3px; }
  .item small, .value { display: block; }
  .item small { overflow-wrap: anywhere; color: var(--color-text-muted); }
  .value { font-family: var(--font-mono); font-size: var(--text-metadata); color: var(--color-text-secondary); }
</style>
