<script lang="ts">
  import { Eye, EyeOff, MousePointer2, Scan, MoreHorizontal, X, Plus, CircleHelp } from 'lucide-svelte';
  import { endpointLabel } from '@cosmolabe/core';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import { Button } from '$lib/components/ui/button';
  import SegmentedControl from '$lib/components/ui/segmented-control.svelte';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';
  import { vs } from '../lib/viewer-state.svelte';
  import {
    duplicateMeasurement, hoverMeasurement, measurementColors, measurementDescription, measurementValue, newMeasurement, pickInstruction, renderedMeasurements,
    measurements, removeMeasurement, cancelMeasurementPick, createMeasurement, startMeasurementPick,
    syncMeasurements, selectMeasurement, changeMeasurementKind, availableOperands, cloneVector, kindLabels, draftReady, draftFrameMessage, type MeasurementDefinition, type Slot,
  } from '../lib/spatial-measurements.svelte';
  import { bodyFixedFrameName, referenceVectorLabel, type ReferenceVector } from '@cosmolabe/core';
  import { getUniverse } from '../lib/loader';

  interface Props { onClose: () => void; }
  let { onClose }: Props = $props();
  let openMenuId = $state<string | null>(null);
  $effect(() => { renderedMeasurements(); syncMeasurements(); });
  $effect(() => { if (measurements.selectedId) document.querySelector('[data-measurement-editor]')?.scrollIntoView({ block: 'nearest' }); });
  const kind = $derived(measurements.draftKind);
  const bodies = $derived(vs.bodies.map(body => body.name).sort());
  const draft = $derived(measurements.draft);
  const canCreate = $derived(draftReady(vs.et));
  const frameMessage = $derived(kind === 'axes' && measurements.draftFrame.trim() ? draftFrameMessage(vs.et) : '');
  const operands = $derived(availableOperands());
  /** The origin's own body-fixed frame first, then inertial frames, then other bodies with attitude. */
  const frameSuggestions = $derived.by(() => {
    const origin = draft.source && draft.source.kind !== 'coordinate' ? draft.source.bodyName : null;
    const withAttitude = vs.bodies.length ? getUniverse()?.getAllBodies().filter(body => body.rotation).map(body => body.name) ?? [] : [];
    const own = origin && withAttitude.includes(origin) ? [bodyFixedFrameName(origin)] : [];
    return [...new Set([...own, 'ECLIPJ2000', 'J2000', ...withAttitude.filter(name => name !== origin).map(bodyFixedFrameName)])];
  });
  function setEntity(slot: Slot, bodyName: string) {
    measurements.draft[slot] = bodyName ? { kind: 'entity', bodyName } : null;
    if (measurements.pendingPickSlot === slot) cancelMeasurementPick();
  }
  function operandKey(vector: ReferenceVector | null): string {
    if (!vector) return '';
    return operands.find(option => JSON.stringify(option.vector) === JSON.stringify(vector))?.key ?? 'kept';
  }
  function setOperand(operand: 'first' | 'second', key: string) {
    const option = operands.find(option => option.key === key);
    measurements.draftOperands[operand] = option ? cloneVector(option.vector) : null;
  }
  function close() { cancelMeasurementPick(); openMenuId = null; onClose(); }
  function toggle(item: MeasurementDefinition) {
    const saved = measurements.items.find(value => value.id === item.id);
    if (saved) saved.visible = saved.visible === false;
    syncMeasurements();
  }
</script>

<InstrumentPanel key="measure" title="Measurements" width={344} onClose={close}>
  <div data-measurement-editor>
    <SegmentedControl value={kind === 'vector-angle' ? 'angle' : kind} options={['distance', 'angle', 'direction', 'velocity', 'axes']} label="Measurement type" onValueChange={next => changeMeasurementKind(next as typeof kind)} />
  </div>
  {#if kind === 'angle' || kind === 'vector-angle'}
    <div class="field">
      <span class="ui-label">Angle between</span>
      <div class="mt-1"><SegmentedControl value={kind === 'angle' ? 'points' : 'directions'} options={['points', 'directions']} label="Angle between" onValueChange={next => changeMeasurementKind(next === 'points' ? 'angle' : 'vector-angle')} /></div>
    </div>
  {/if}
  {#if kind === 'vector-angle'}
    {@render operandRow('first', 'First direction')}
    {@render operandRow('second', 'Second direction')}
    {#if operands.length < 2}
      <p class="ui-helper mt-2 text-text-muted">Add directions, velocities or axes first; their directions are offered here.</p>
    {:else}
      <p class="ui-helper mt-2 text-text-muted">Compared at the first direction’s origin.</p>
    {/if}
  {:else if kind === 'velocity'}
    {@render endpointRow('source', 'Object')}
    {@render endpointRow('target', 'Relative to', 'Central body')}
  {:else if kind === 'axes'}
    {@render endpointRow('source', 'Origin')}
    <label class="field block">
      <span class="ui-label">Frame</span>
      <input class="ui-control frame mt-1" list="measurement-frames" spellcheck="false" autocomplete="off" placeholder="IAU_EARTH, J2000, or a furnished frame" bind:value={measurements.draftFrame} aria-label="Axes frame" />
      <datalist id="measurement-frames">{#each frameSuggestions as frame}<option value={frame}></option>{/each}</datalist>
    </label>
    {#if frameMessage}<p class="ui-helper mt-1 frame-warning" role="status">{frameMessage}</p>{/if}
  {:else}
    {#if kind === 'angle'}{@render endpointRow('vertex', 'At')}{/if}
    {@render endpointRow('source', kind === 'angle' ? 'Toward' : 'Source')}
    {@render endpointRow('target', kind === 'angle' ? 'Toward' : 'Target')}
  {/if}
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
        <input type="color" class="swatch" class:chosen={!measurementColors.some(preset => preset.color === measurements.draftColor.toLowerCase())} bind:value={measurements.draftColor} aria-label="Custom measurement color" />
        <span>Custom…</span>
      </label>
    </div>
    {#if kind === 'direction'}
      <label class="ui-helper flex items-center gap-1 cursor-pointer"><input class="accent-accent" type="checkbox" bind:checked={measurements.draftShowDistance} /> Show distance</label>
      <label class="ui-helper flex items-center gap-1 cursor-pointer"><input class="accent-accent" type="checkbox" bind:checked={measurements.draftFullLength} /> Full-length connection</label>
    {/if}
  </div>
  {#if !measurements.editingId}
    <Button variant="secondary" size="sm" class="ui-control w-full mt-3" disabled={!canCreate} onclick={createMeasurement}>Add {kindLabels[kind].toLowerCase()}</Button>
  {/if}

  <div class="saved-header">
    <span class="ui-label">Measurements ({measurements.items.length})</span>
    <button class="help" aria-label="Measurement help" title="Distances are straight lines between endpoints, not paths along a surface. Surface points move with their body. Velocities are inertial, relative to the central body unless another is chosen; arrow lengths show direction, not magnitude."><CircleHelp size={13}/></button>
    <Button variant="ghost" size="sm" class="ui-control ml-auto" onclick={newMeasurement}><Plus size={13}/> New</Button>
  </div>
  {#each measurements.items as item (item.id)}
    {@const value = measurementValue(item, vs.et)}
    {@const selected = measurements.selectedId === item.id}
    <div class="item analysis-row" style:--row-accent={item.color ?? '#82aabd'} role="group" aria-label={`${kindLabels[item.kind]} measurement`} onmouseenter={() => hoverMeasurement(item.id)} onmouseleave={() => hoverMeasurement(null)} onfocusin={() => hoverMeasurement(item.id)} onfocusout={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) hoverMeasurement(null); }} class:selected class:hovered={measurements.hoveredId === item.id} class:unavailable={value.includes('Unavailable') || value.includes('Undefined') || value.includes('Incomplete')}>
      <span class="list-swatch" style:background={item.color ?? '#82aabd'}></span>
      <button data-measurement-row={item.id} class="readout min-w-0 flex-1 text-left" aria-label={`Select ${kindLabels[item.kind].toLowerCase()} measurement`} aria-pressed={selected} title={measurementDescription(item)} onclick={() => selectMeasurement(item.id)}>
        <span class="ui-label capitalize">{kindLabels[item.kind]}</span>
        <span class="value">{value}</span>
      </button>
      <Button variant="ghost" size="icon-sm" aria-label={item.visible === false ? `Show ${kindLabels[item.kind].toLowerCase()}` : `Hide ${kindLabels[item.kind].toLowerCase()}`} title={item.visible === false ? 'Show measurement' : 'Hide measurement'} onclick={() => toggle(item)}>{#if item.visible === false}<EyeOff size={14}/>{:else}<Eye size={14}/>{/if}</Button>
      <DropdownMenu.Root open={openMenuId === item.id} onOpenChange={(open) => { if (open) openMenuId = item.id; else if (openMenuId === item.id) openMenuId = null; }}>
        <DropdownMenu.Trigger class="rounded p-1.5 hover:bg-control-hover focus-visible:outline focus-visible:outline-chrome-active" aria-label={`Actions for ${kindLabels[item.kind].toLowerCase()}`} title="Measurement actions"><MoreHorizontal size={16}/></DropdownMenu.Trigger>
        <DropdownMenu.Content>
          <DropdownMenu.Item onSelect={() => duplicateMeasurement(item.id)}>Duplicate</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => removeMeasurement(item.id)}>Delete</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  {/each}
</InstrumentPanel>

{#snippet operandRow(operand: 'first' | 'second', title: string)}
  {@const vector = measurements.draftOperands[operand]}
  {@const key = operandKey(vector)}
  <label class="field block">
    <span class="ui-label">{title}</span>
    <select class="ui-control mt-1 w-full min-w-0 bg-surface-3 text-text-primary border border-border rounded px-1.5 py-1 cursor-pointer outline-none" aria-label={title} value={key} onchange={(e) => setOperand(operand, e.currentTarget.value)}>
      <option value="">Select direction…</option>
      {#if key === 'kept' && vector}<option value="kept">{referenceVectorLabel(vector)}</option>{/if}
      {#each operands as option (option.key)}<option value={option.key}>{option.label}</option>{/each}
    </select>
  </label>
{/snippet}

{#snippet endpointRow(slot: Slot, title: string, placeholder = 'Select body…')}
  {@const endpoint = measurements.draft[slot]}
  <div class="field" class:picking={measurements.pendingPickSlot === slot}>
    <span class="ui-label">{title}</span>
    <div class="endpoint">
      {#if endpoint?.kind === 'body-fixed' || endpoint?.kind === 'coordinate'}
        <div class="ui-control picked" title={endpointLabel(endpoint)}>{endpointLabel(endpoint)}</div>
        <Button variant="ghost" size="icon-sm" aria-label={`Clear picked ${slot}`} title="Clear picked point" onclick={() => measurements.draft[slot] = null}><X size={14}/></Button>
      {:else}
        <select class="ui-control min-w-0 flex-1 bg-surface-3 text-text-primary border border-border rounded px-1.5 py-1 cursor-pointer outline-none" aria-label={`${title} entity`} value={endpoint?.bodyName ?? ''} onchange={(e) => setEntity(slot, e.currentTarget.value)}>
          <option value="">{placeholder}</option>
          {#each bodies as body}<option value={body}>{body}{body === vs.trackedBodyName ? ' (tracked)' : ''}</option>{/each}
        </select>
      {/if}
      <Button variant="ghost" size="icon-sm" aria-pressed={measurements.pendingPickSlot === slot && measurements.pickMode === 'object'} class={measurements.pendingPickSlot === slot && measurements.pickMode === 'object' ? 'bg-control-hover border-border-strong' : ''} aria-label={`Pick ${slot} object`} title="Pick object: body center, marker, or label" onclick={() => startMeasurementPick(slot, 'object')}><MousePointer2 size={14}/></Button>
      <Button variant="ghost" size="icon-sm" aria-pressed={measurements.pendingPickSlot === slot && measurements.pickMode === 'surface'} class={measurements.pendingPickSlot === slot && measurements.pickMode === 'surface' ? 'bg-control-hover border-border-strong' : ''} aria-label={`Pick ${slot} surface point`} title="Pick exact point on a visible surface" onclick={() => startMeasurementPick(slot, 'surface')}><Scan size={14}/></Button>
    </div>
  </div>
{/snippet}

<style>
  .field { margin-top: 10px; border-left: 2px solid transparent; padding-left: 4px; }
  .field.picking { border-left-color: var(--color-chrome-active); }
  .endpoint { display: flex; gap: 3px; margin-top: 3px; }
  .picked { min-width: 0; flex: 1; padding: 5px 7px; border: 1px solid var(--color-chrome-border); border-radius: 4px; background: var(--color-surface-3); color: var(--color-text-secondary); overflow-wrap: anywhere; }
  .frame { width: 100%; padding: 5px 7px; border: 1px solid var(--color-chrome-border); border-radius: 4px; background: var(--color-surface-3); color: var(--color-text-primary); font-family: var(--font-mono); outline: none; }
  .frame-warning { color: var(--color-warning); }
  .frame:focus-visible { outline: 1px solid var(--color-chrome-active); }
  .pick-instruction { margin-top: 8px; color: var(--color-chrome-active); }
  .settings { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; margin-top: 10px; }
  .saved-header { display: flex; align-items: center; gap: 6px; border-top: 1px solid var(--color-chrome-border); margin: 14px 0 5px; padding-top: 5px; }
  .help { color: var(--color-text-muted); cursor: help; }
  .help:focus-visible { outline: 1px solid var(--color-primary-accent); }
  .item { display: flex; align-items: center; gap: 6px; padding: 7px 5px; border: 1px solid transparent; border-radius: 4px; }
  .item.unavailable .value { color: var(--color-warning); }
  .colors { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .preset, .swatch { height: 24px; flex-shrink: 0; border: 1px solid var(--color-chrome-border); border-radius: 4px; cursor: pointer; }
  .preset { width: 24px; padding: 0; }
  .swatch { width: 36px; }
  .preset.chosen, .swatch.chosen { outline: 2px solid var(--color-chrome-active); outline-offset: 2px; }
  .preset:focus-visible, .swatch:focus-visible { outline: 2px solid var(--color-chrome-active); outline-offset: 2px; box-shadow: 0 0 0 1px var(--color-text-primary); }
  .swatch { padding: 0; background: transparent; }
  .swatch::-webkit-color-swatch-wrapper { padding: 0; }
  .swatch::-webkit-color-swatch { border: 0; border-radius: 2px; }
  .swatch::-moz-color-swatch { border: 0; border-radius: 2px; }
  .custom-color { display: flex; align-items: center; gap: 5px; cursor: pointer; }
  .list-swatch { width: 3px; height: 24px; border-radius: 2px; flex-shrink: 0; }
  .readout { cursor: pointer; border-radius: 3px; }
  .readout:focus-visible { outline: 1px solid var(--color-chrome-active); outline-offset: 2px; }
  .value { display: block; }
  .value { font-family: var(--font-mono); font-size: var(--text-metadata); color: var(--color-text-secondary); overflow-wrap: anywhere; }
</style>
