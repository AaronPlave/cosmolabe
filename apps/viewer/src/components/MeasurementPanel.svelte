<script lang="ts">
  import { Eye, EyeOff, MousePointer2, Scan, MoreHorizontal, X } from 'lucide-svelte';
  import { endpointLabel, type SpatialRelationship } from '@cosmolabe/core';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import { Button } from '$lib/components/ui/button';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';
  import { vs } from '../lib/viewer-state.svelte';
  import {
    cancelMeasurementEdit, editMeasurement, hoverMeasurement, measurementColors, measurementDescription, measurementValue, newMeasurement, pickInstruction, renderedMeasurements, draftMeasurement,
    measurements, removeMeasurement, cancelMeasurementPick, saveMeasurement, startMeasurementPick,
    syncMeasurements, toggleMeasurementSelection, type Slot,
  } from '../lib/spatial-measurements.svelte';

  interface Props { onClose: () => void; }
  let { onClose }: Props = $props();
  let openMenuId = $state<string | null>(null);
  $effect(() => { renderedMeasurements(); syncMeasurements(); });
  const kind = $derived(measurements.draftKind);
  const bodies = $derived(vs.bodies.map(body => body.name).sort());
  const canCreate = $derived(!!measurements.draft.source && !!measurements.draft.target &&
    (kind !== 'angle' || !!measurements.draft.vertex));

  function changeKind(next: typeof kind) {
    measurements.draftKind = next;
    cancelMeasurementPick();
    if (next !== 'angle') measurements.draft.vertex = null;
  }
  function setEntity(slot: Slot, bodyName: string) {
    measurements.draft[slot] = bodyName ? { kind: 'entity', bodyName } : null;
    if (measurements.pendingPickSlot === slot) cancelMeasurementPick();
  }
  function close() { cancelMeasurementPick(); openMenuId = null; onClose(); }
  function toggle(item: SpatialRelationship) {
    const saved = measurements.items.find(value => value.id === item.id);
    if (saved) saved.visible = saved.visible === false;
    syncMeasurements();
  }
</script>

<InstrumentPanel key="measure" title="Measurements" width={344} onClose={close}>
  <p class="ui-helper mb-3 text-text-secondary">Straight-line distance between endpoints. Surface points move with their body.</p>
  <div class="flex items-center justify-between gap-2 mb-2">
    <span class="ui-label">{measurements.editingId ? measurements.duplicating ? 'Duplicate measurement' : 'Selected measurement' : 'New measurement'}</span>
    <Button variant="outline" size="sm" class="ui-control" onclick={newMeasurement}>New measurement</Button>
  </div>
  {#if measurements.editingId}<p class="ui-helper text-text-muted mb-2">Changes preview immediately. Save commits; Cancel restores the original. Switching or closing retains unfinished work.</p>{/if}
  <div class="flex gap-1" aria-label="Measurement type">
    {#each ['distance','angle','direction'] as option}
      <Button variant={kind === option ? "secondary" : "outline"} size="sm" class="ui-control flex-1 capitalize" aria-pressed={kind === option} onclick={() => changeKind(option as typeof kind)}>{option}</Button>
    {/each}
  </div>
  {#if kind === 'angle'}{@render endpointRow('vertex', 'At')}{/if}
  {@render endpointRow('source', kind === 'angle' ? 'Toward' : 'Source')}
  {@render endpointRow('target', kind === 'angle' ? 'Toward' : 'Target')}
  {#if measurements.pendingPickSlot}
    <div class="ui-helper pick-instruction" role="status">{pickInstruction()} · Esc to cancel</div>
    {#if measurements.pickFeedback}<p class="ui-helper mt-1" role="status">{measurements.pickFeedback}</p>{/if}
  {/if}
  {#if Object.values(measurements.draft).some(endpoint => endpoint?.kind === 'body-fixed')}
    <p class="ui-helper mt-2 text-text-muted">Surface measurements use straight lines, not distance along the surface.</p>
  {/if}
  <div class="settings">
    <div class="colors" role="group" aria-label="Measurement color presets">
      {#each measurementColors as preset}
        <button class="preset" class:chosen={measurements.draftColor.toLowerCase() === preset.color} style:background={preset.color} aria-label={`${preset.name} measurement color`} aria-pressed={measurements.draftColor.toLowerCase() === preset.color} title={preset.name} onclick={() => measurements.draftColor = preset.color}></button>
      {/each}
      <label class="custom-color ui-label" title="Custom measurement color">
        <input type="color" class="swatch" bind:value={measurements.draftColor} aria-label="Custom measurement color" />
        <span>Custom…</span>
      </label>
    </div>
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
  {#each measurements.items as saved (saved.id)}
    {@const item = saved.id === measurements.editingId ? draftMeasurement(saved.id) ?? saved : saved}
    {@const value = measurementValue(item, vs.et)}
    {@const selected = measurements.selectedId === item.id}
    <div class="item" role="group" aria-label={`${item.kind} measurement`} onmouseenter={() => hoverMeasurement(item.id)} onmouseleave={() => hoverMeasurement(null)} class:selected class:hovered={measurements.hoveredId === item.id} class:unavailable={value.includes('Unavailable') || value.includes('Undefined') || value.includes('Incomplete')}>
      <span class="list-swatch" style:background={item.color ?? '#82aabd'}></span>
      <button class="readout min-w-0 flex-1 text-left" aria-label={`Select ${item.kind} measurement`} aria-pressed={selected} onclick={() => toggleMeasurementSelection(item.id)}>
        <span class="ui-label capitalize">{item.kind}</span>
        {#if selected && !value.includes('Incomplete')}<small>{measurementDescription(item)}</small>{/if}
        <span class="value">{value}</span>
      </button>
      <Button variant="ghost" size="icon-sm" aria-label={item.visible === false ? `Show ${item.kind}` : `Hide ${item.kind}`} title={item.visible === false ? 'Show measurement' : 'Hide measurement'} onclick={() => toggle(item)}>{#if item.visible === false}<EyeOff size={14}/>{:else}<Eye size={14}/>{/if}</Button>
      <DropdownMenu.Root open={openMenuId === item.id} onOpenChange={(open) => { if (open) openMenuId = item.id; else if (openMenuId === item.id) openMenuId = null; }}>
        <DropdownMenu.Trigger class="rounded p-1.5 hover:bg-control-hover focus-visible:outline focus-visible:outline-chrome-active" aria-label={`Actions for ${item.kind}`} title="Measurement actions"><MoreHorizontal size={16}/></DropdownMenu.Trigger>
        <DropdownMenu.Content>
          <DropdownMenu.Item onSelect={() => editMeasurement(item.id)}>Select / edit</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => editMeasurement(item.id, true)}>Duplicate</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => removeMeasurement(item.id)}>Delete</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
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
  .colors { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .preset, .swatch { width: 36px; height: 24px; border: 1px solid var(--color-chrome-border); border-radius: 4px; cursor: pointer; }
  .preset.chosen { outline: 2px solid var(--color-chrome-active); outline-offset: 2px; }
  .preset:focus-visible, .swatch:focus-visible { outline: 2px solid var(--color-chrome-active); outline-offset: 2px; }
  .swatch { padding: 2px; background: var(--color-surface-3); }
  .swatch::-webkit-color-swatch-wrapper { padding: 0; }
  .swatch::-webkit-color-swatch { border: 0; border-radius: 2px; }
  .swatch::-moz-color-swatch { border: 0; border-radius: 2px; }
  .custom-color { display: flex; align-items: center; gap: 5px; cursor: pointer; }
  .list-swatch { width: 3px; height: 24px; border-radius: 2px; flex-shrink: 0; }
  .readout { cursor: pointer; border-radius: 3px; }
  .readout:focus-visible { outline: 1px solid var(--color-chrome-active); outline-offset: 2px; }
  .item small, .value { display: block; }
  .item small { overflow-wrap: anywhere; color: var(--color-text-muted); }
  .value { font-family: var(--font-mono); font-size: var(--text-metadata); color: var(--color-text-secondary); overflow-wrap: anywhere; }
</style>
