<script lang="ts">
  /**
   * An editable feature's properties (#200), in its Feature view. Each
   * property keeps its JSON type (text, number, yes/no, empty or JSON) while
   * its value is edited, and a new one takes the type chosen for it
   * (geographic-attributes.ts). The name is edited in the view's title, not
   * here. Broken numbers or JSON hold Save back, with the reason.
   */
  import { Plus, X } from 'lucide-svelte';
  import type { GeographicEditFeature, JsonValue } from '@cosmolabe/core';
  import { Button } from '$lib/components/ui/button';
  import { ATTRIBUTE_TYPES, attributeRow, attributesToProperties, retypeAttribute, type AttributeRow } from '../lib/geographic-attributes';
  import { setFeatureProperties } from '../lib/geographic-editing.svelte';

  interface Props { layerId: string; feature: GeographicEditFeature }
  let { layerId, feature }: Props = $props();

  const TYPE_LABELS: Record<AttributeRow['type'], string> = { text: 'Text', number: 'Number', boolean: 'Yes/no', null: 'Empty', json: 'JSON' };

  let rows = $state<AttributeRow[]>([]);
  let shownKey = '';
  // Reset whenever another feature, or a new revision of it, is shown.
  $effect(() => {
    const key = `${layerId}/${feature.id}/${JSON.stringify(feature.properties)}`;
    if (key === shownKey) return;
    shownKey = key;
    rows = Object.entries(feature.properties ?? {}).filter(([k]) => k !== 'name').map(([k, v]) => attributeRow(k, v));
  });

  let converted = $derived(attributesToProperties(rows));
  /** The properties to save: the rows, with the name kept as it is. */
  let next = $derived.by((): { [key: string]: JsonValue } => {
    const name = feature.properties?.name;
    return name === undefined ? converted.properties : { name, ...converted.properties };
  });
  let dirty = $derived(converted.errors.size === 0 && JSON.stringify(next) !== JSON.stringify(feature.properties ?? {}));
</script>

<div class="props-editor" role="group" aria-label="Edit feature">
  {#each rows as row, i (i)}
    <div class="pair">
      <input bind:value={row.key} aria-label="Property name" placeholder="property" />
      <select value={row.type} aria-label="Type of {row.key || 'new property'}" onchange={(e) => (rows[i] = retypeAttribute(row, e.currentTarget.value as AttributeRow['type']))}>
        {#each ATTRIBUTE_TYPES as t (t)}<option value={t}>{TYPE_LABELS[t]}</option>{/each}
      </select>
      {#if row.type === 'boolean'}
        <label class="check"><input type="checkbox" checked={row.text === 'true'} onchange={(e) => (row.text = e.currentTarget.checked ? 'true' : 'false')} aria-label="Value of {row.key}" /> {row.text === 'true' ? 'Yes' : 'No'}</label>
      {:else if row.type === 'null'}
        <span class="ui-meta muted">empty</span>
      {:else}
        <input bind:value={row.text} aria-label="Value of {row.key}" placeholder={row.type === 'json' ? '{ } or [ ]' : 'value'} class:invalid={converted.errors.has(i)} title={converted.errors.get(i) ?? ''} />
      {/if}
      <button class="icon" onclick={() => (rows = rows.filter((_, j) => j !== i))} aria-label="Remove property {row.key}" title="Remove"><X size={12} /></button>
    </div>
    {#if converted.errors.has(i)}<p class="ui-helper error">{row.key || 'New property'}: {converted.errors.get(i)}. Fix it to save.</p>{/if}
  {/each}
  <div class="row">
    <button class="link" onclick={() => (rows = [...rows, { key: '', type: 'text', text: '' }])}><Plus size={11} /> Property</button>
    <span class="grow"></span>
    {#if dirty}<Button size="sm" class="ui-control" onclick={() => setFeatureProperties(layerId, feature.id, next)}>Save</Button>{/if}
  </div>
</div>

<style>
  .props-editor { display: flex; flex-direction: column; gap: 4px; }
  .pair { display: grid; grid-template-columns: 1fr 70px 1.2fr 22px; gap: 4px; align-items: center; }
  input:not([type='checkbox']), select {
    min-width: 0;
    padding: 2px 6px;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    background: var(--color-surface-3);
    color: var(--color-text-primary);
    font: inherit;
    font-size: var(--text-metadata);
  }
  .check { display: inline-flex; align-items: center; gap: 4px; font-size: var(--text-metadata); }
  .invalid { border-color: var(--color-error); }
  .error { color: var(--color-error); }
  .muted { color: var(--color-text-muted); }
  .row { display: flex; align-items: center; gap: 4px; }
  .grow { flex: 1; }
  .link, .icon {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    border: none;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
  }
  .link:hover, .icon:hover { color: var(--color-text-primary); }
</style>
