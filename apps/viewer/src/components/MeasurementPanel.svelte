<script lang="ts">
  import { Eye, EyeOff, MousePointer2, Scan, MoreHorizontal, X } from 'lucide-svelte';
  import { endpointLabel, type SpatialRelationship } from '@cosmolabe/core';
  import { Button } from '$lib/components/ui/button';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';
  import { vs } from '../lib/viewer-state.svelte';
  import {
    cancelMeasurementEdit, editMeasurement, hoverMeasurement, measurementDescription, measurementValue,
    measurements, removeMeasurement, resetMeasurementDraft, saveMeasurement, startMeasurementPick,
    syncMeasurements, toggleMeasurementSelection, type Slot,
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
    measurements.pickFeedback = '';
    if (next !== 'angle') measurements.draft.vertex = null;
  }
  function setEntity(slot: Slot, bodyName: string) {
    measurements.draft[slot] = bodyName ? { kind: 'entity', bodyName } : null;
    if (measurements.pendingPickSlot === slot) measurements.pendingPickSlot = null;
  }
  function close() { resetMeasurementDraft(); onClose(); }
  function toggle(item: SpatialRelationship) { item.visible = item.visible === false; syncMeasurements(); }
  function slotLabel(slot: Slot): string {
    return kind === 'angle' ? slot === 'vertex' ? 'At' : 'Toward' : slot === 'source' ? 'Source' : 'Target';
  }
</script>

<InstrumentPanel key="measure" title="Measurements" width={344} onClose={close}>
  <p class="ui-helper mb-3 text-text-secondary">Straight-line distance between endpoints. Surface points move with their body.</p>
  {#if measurements.editingId}<p class="ui-label mb-2">{measurements.duplicating ? 'Duplicate measurement' : 'Edit measurement'}</p>{/if}
  <div class="flex gap-1" aria-label="Measurement type">
    {#each ['distance','angle','direction'] as option}
      <Button variant={kind === option ? "secondary" : "outline"} size="sm" class="ui-control flex-1 capitalize" aria-pressed={kind === option} onclick={() => changeKind(option as typeof kind)}>{option}</Button>
    {/each}
  </div>
  {#if kind === 'angle'}{@render endpointRow('vertex', 'At')}{/if}
  {@render endpointRow('source', kind === 'angle' ? 'Toward' : 'Source')}
  {@render endpointRow('target', kind === 'angle' ? 'Toward' : 'Target')}
  {#if measurements.pendingPickSlot}
    <div class="ui-helper pick-instruction" role="status">Pick {slotLabel(measurements.pendingPickSlot).toLowerCase()} {measurements.pickMode === 'object' ? 'object' : 'point'} in the scene · Esc to cancel</div>
    {#if measurements.pickFeedback}<p class="ui-helper mt-1" role="status">{measurements.pickFeedback}</p>{/if}
  {/if}
  {#if Object.values(measurements.draft).some(endpoint => endpoint?.kind === 'body-fixed')}
    <p class="ui-helper mt-2 text-text-muted">Surface measurements use straight lines, not distance along the surface.</p>
  {/if}
  <div class="settings">
    <label class="ui-label flex items-center gap-2">Color <input type="color" class="swatch" bind:value={measurements.draftColor} aria-label="Measurement color" /></label>
    {#if kind === 'direction'}
      <label class="ui-helper"><input type="checkbox" bind:checked={measurements.draftShowDistance} /> Show distance</label>
      <label class="ui-helper"><input type="checkbox" bind:checked={measurements.draftFullLength} /> Full-length connection</label>
    {/if}
  </div>
  <div class="flex gap-2 mt-3">
    <Button variant="secondary" size="sm" class="ui-control flex-1" disabled={!canCreate} onclick={saveMeasurement}>{measurements.editingId ? 'Save changes' : `Add ${kind}`}</Button>
    {#if measurements.editingId}<Button variant="outline" size="sm" class="ui-control" onclick={cancelMeasurementEdit}>Cancel</Button>{/if}
  </div>

  {#if measurements.items.length}<div class="divider"></div>{/if}
  {#each measurements.items as item (item.id)}
    {@const value = measurementValue(item, vs.et)}
    {@const selected = measurements.selectedId === item.id}
    <div class="item" role="group" aria-label={`${item.kind} measurement`} onmouseenter={() => hoverMeasurement(item.id)} onmouseleave={() => hoverMeasurement(null)} class:selected class:hovered={measurements.hoveredId === item.id} class:unavailable={value.includes('Unavailable') || value.includes('Undefined')}>
      <span class="list-swatch" style:background={item.color ?? '#82aabd'}></span>
      <button class="readout min-w-0 flex-1 text-left" aria-label={`Select ${item.kind} measurement`} aria-pressed={selected} onclick={() => toggleMeasurementSelection(item.id)}>
        <span class="ui-label capitalize">{item.kind}</span>
        {#if selected}<small>{measurementDescription(item)}</small>{/if}
        <span class="value">{value}</span>
      </button>
      <Button variant="ghost" size="icon-sm" aria-label={item.visible === false ? `Show ${item.kind}` : `Hide ${item.kind}`} title={item.visible === false ? 'Show measurement' : 'Hide measurement'} onclick={() => toggle(item)}>{#if item.visible === false}<EyeOff size={14}/>{:else}<Eye size={14}/>{/if}</Button>
      <details class="row-menu">
        <summary aria-label={`Actions for ${item.kind}`} title="Measurement actions"><MoreHorizontal size={16}/></summary>
        <div class="menu">
          <button class="ui-control" onclick={(e) => { editMeasurement(item.id); e.currentTarget.closest('details')?.removeAttribute('open'); }}>Edit</button>
          <button class="ui-control" onclick={(e) => { editMeasurement(item.id, true); e.currentTarget.closest('details')?.removeAttribute('open'); }}>Duplicate</button>
          <button class="ui-control" onclick={() => removeMeasurement(item.id)}>Delete</button>
        </div>
      </details>
    </div>
  {/each}
</InstrumentPanel>

{#snippet endpointRow(slot: Slot, title: string)}
  {@const endpoint = measurements.draft[slot]}
  <div class="field" class:picking={measurements.pendingPickSlot === slot}>
    <span class="ui-label">{title}</span>
    <div class="endpoint">
      {#if endpoint?.kind === 'body-fixed' || endpoint?.kind === 'coordinate'}
        <div class="ui-control picked" title={endpointLabel(endpoint)}>{endpointLabel(endpoint)}</div>
        <Button variant="ghost" size="icon-sm" aria-label={`Clear picked ${slot}`} title="Clear picked point" onclick={() => measurements.draft[slot] = null}><X size={14}/></Button>
      {:else}
        <select class="ui-control min-w-0 flex-1 bg-surface-3 text-text-primary border border-border rounded px-1.5 py-1 cursor-pointer outline-none" aria-label={`${title} entity`} value={endpoint?.bodyName ?? ''} onchange={(e) => setEntity(slot, e.currentTarget.value)}>
          <option value="">Select body…</option>
          {#each bodies as body}<option value={body}>{body}{body === vs.trackedBodyName ? ' (tracked)' : ''}</option>{/each}
        </select>
      {/if}
      <Button variant="ghost" size="icon-sm" class={measurements.pendingPickSlot === slot && measurements.pickMode === 'object' ? 'bg-control-hover' : ''} aria-label={`Pick ${slot} object`} title="Pick object: body center, marker, or label" onclick={() => startMeasurementPick(slot, 'object')}><MousePointer2 size={14}/></Button>
      <Button variant="ghost" size="icon-sm" class={measurements.pendingPickSlot === slot && measurements.pickMode === 'surface' ? 'bg-control-hover' : ''} aria-label={`Pick ${slot} surface point`} title="Pick exact point on a visible surface" onclick={() => startMeasurementPick(slot, 'surface')}><Scan size={14}/></Button>
    </div>
  </div>
{/snippet}

<style>
  .field { margin-top: 10px; border-left: 2px solid transparent; padding-left: 4px; }
  .field.picking { border-left-color: var(--color-chrome-active); }
  .endpoint { display: flex; gap: 3px; margin-top: 3px; }
  .picked { min-width: 0; flex: 1; padding: 5px 7px; border: 1px solid var(--color-chrome-border); border-radius: 4px; background: var(--color-surface-3); color: var(--color-text-secondary); overflow-wrap: anywhere; }
  .pick-instruction { margin-top: 8px; color: var(--color-chrome-active); }
  .settings { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; margin-top: 10px; }
  .divider { border-top: 1px solid var(--color-chrome-border); margin: 14px 0 5px; }
  .item { display: flex; align-items: center; gap: 6px; padding: 7px 3px; border-radius: 4px; }
  .item.hovered { background: var(--color-surface-2); }
  .item.selected { background: var(--color-surface-3); }
  .item.unavailable .value { color: var(--color-warning); }
  .swatch { width: 22px; height: 22px; padding: 0; border: none; background: transparent; cursor: pointer; }
  .list-swatch { width: 3px; height: 24px; border-radius: 2px; flex-shrink: 0; }
  .readout { cursor: pointer; border-radius: 3px; }
  .readout:focus-visible, summary:focus-visible, .menu button:focus-visible { outline: 1px solid var(--color-chrome-active); outline-offset: 2px; }
  .item small, .value { display: block; }
  .item small { overflow-wrap: anywhere; color: var(--color-text-muted); }
  .value { font-family: var(--font-mono); font-size: var(--text-metadata); color: var(--color-text-secondary); overflow-wrap: anywhere; }
  .row-menu { position: relative; }
  summary { list-style: none; cursor: pointer; padding: 5px; border-radius: 4px; }
  summary::-webkit-details-marker { display: none; }
  summary:hover, .menu button:hover { background: var(--color-surface-3); }
  .menu { position: absolute; z-index: 5; right: 0; top: 28px; min-width: 110px; padding: 3px; border: 1px solid var(--color-chrome-border); background: var(--color-panel); border-radius: 4px; }
  .menu button { display: block; width: 100%; text-align: left; padding: 5px 8px; cursor: pointer; }
</style>
