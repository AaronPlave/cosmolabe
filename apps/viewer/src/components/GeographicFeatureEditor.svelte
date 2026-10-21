<script lang="ts">
  /**
   * Editing the selected feature (#200), inside its details. An editable
   * feature gets its attributes (name, category, description, notes and any
   * other properties), Edit vertices, Duplicate and Delete (confirmed). A
   * read-only feature offers an editable copy of its layer instead; the
   * original is never changed. Measurements are on the reference shape along
   * the drawn edges, not on terrain.
   */
  import { Copy, PencilLine, Trash2, Plus, X } from 'lucide-svelte';
  import {
    geographicPathLengthKm, geographicPolygonAreaKm2, normalizeGeographicPosition, geographicDatum,
    type GeographicEditFeature, type GeographicEditLayer, type GeoPosition, type JsonValue,
  } from '@cosmolabe/core';
  import { Button } from '$lib/components/ui/button';
  import { geo, findFeature } from '../lib/geographic-layers.svelte';
  import { isToolOpen, openTool } from '../lib/shell.svelte';
  import {
    edits, editLayer, editFeatureOf, isEditable, makeWorkingCopy, setFeatureProperties, startEditingFeature, stopEditingFeature,
    duplicateFeature, deleteFeature,
  } from '../lib/geographic-editing.svelte';

  const STANDARD = ['name', 'category', 'description', 'notes'] as const;

  let found = $derived(findFeature(geo.selected));
  let editable = $derived((void edits.revision, isEditable(geo.selected?.layerId)));
  let layer = $derived(editable ? editLayer(geo.selected!.layerId) : undefined);
  let feature = $derived((void edits.revision, editFeatureOf(geo.selected)));
  let editingThis = $derived(!!feature && edits.editing?.layerId === layer?.id && edits.editing?.featureId === feature.id);

  // Form state, reset whenever another feature (or a new revision of it) is shown.
  let form = $state<Record<string, string>>({});
  let extra = $state<{ key: string; value: string }[]>([]);
  let confirmDelete = $state(false);
  let shownKey = '';
  $effect(() => {
    const key = feature ? `${layer?.id}/${feature.id}/${JSON.stringify(feature.properties)}` : '';
    if (key === shownKey) return;
    shownKey = key;
    confirmDelete = false;
    const props = feature?.properties ?? {};
    form = Object.fromEntries(STANDARD.map((k) => [k, typeof props[k] === 'string' || typeof props[k] === 'number' ? String(props[k]) : '']));
    extra = Object.entries(props).filter(([k]) => !(STANDARD as readonly string[]).includes(k))
      .map(([key, value]) => ({ key, value: typeof value === 'string' ? value : JSON.stringify(value) }));
  });

  /** Back to JSON: an unchanged value keeps its type; numbers typed into a numeric field stay numbers. */
  function properties(): { [key: string]: JsonValue } {
    const before = feature?.properties ?? {};
    const out: { [key: string]: JsonValue } = {};
    const value = (key: string, text: string): JsonValue => {
      const old = before[key];
      if (old !== undefined && (typeof old === 'string' ? old : JSON.stringify(old)) === text) return old;
      if (typeof old === 'number' && text.trim() !== '' && Number.isFinite(Number(text))) return Number(text);
      if (old !== null && typeof old === 'object') { try { return JSON.parse(text) as JsonValue; } catch { return text; } }
      return text;
    };
    // The form is filled by an effect after the first render; until then it is empty.
    for (const k of STANDARD) if ((form[k] ?? '').trim() !== '') out[k] = value(k, form[k]);
    for (const { key, value: text } of extra) if (key.trim()) out[key.trim()] = value(key.trim(), text);
    return out;
  }
  const dirty = $derived(!!feature && JSON.stringify(properties()) !== JSON.stringify(feature.properties));

  function save() {
    if (layer && feature) setFeatureProperties(layer.id, feature.id, properties());
  }

  function measure(l: GeographicEditLayer, f: GeographicEditFeature): string {
    const datum = geographicDatum(l.coordinates);
    const geo = (p: GeoPosition) => normalizeGeographicPosition(p, l.coordinates);
    const km = (v: number) => v < 1 ? `${(v * 1000).toFixed(0)} m` : `${v.toFixed(v < 100 ? 2 : 0)} km`;
    const g = f.geometry;
    if (g.type === 'LineString') return `Length ${km(geographicPathLengthKm(g.coordinates.map(geo), datum))}`;
    if (g.type === 'MultiLineString') return `Length ${km(g.coordinates.reduce((n, line) => n + geographicPathLengthKm(line.map(geo), datum), 0))}`;
    if (g.type === 'Polygon') return `Area ${geographicPolygonAreaKm2(g.coordinates.map((r) => r.map(geo)), datum).toPrecision(4)} km²`;
    if (g.type === 'MultiPolygon') return `Area ${g.coordinates.reduce((n, p) => n + geographicPolygonAreaKm2(p.map((r) => r.map(geo)), datum), 0).toPrecision(4)} km²`;
    return '';
  }

  function editVertices() {
    if (!layer || !feature) return;
    if (editingThis) { stopEditingFeature(); return; }
    startEditingFeature(layer.id, feature.id);
    if (!isToolOpen('draw')) openTool('draw');
  }

  function copyLayer() {
    if (!found) return;
    makeWorkingCopy(found.layer);
    if (!isToolOpen('draw')) openTool('draw');
  }
</script>

{#if found && editable && layer && feature}
  <div class="editor" role="group" aria-label="Edit feature">
    <div class="ui-section-label">Attributes</div>
    {#each STANDARD as key (key)}
      <label class="field">
        <span class="ui-meta">{key[0].toUpperCase() + key.slice(1)}</span>
        {#if key === 'description' || key === 'notes'}
          <textarea rows="2" bind:value={form[key]} aria-label={key}></textarea>
        {:else}
          <input bind:value={form[key]} aria-label={key} />
        {/if}
      </label>
    {/each}
    {#each extra as row, i (i)}
      <div class="pair">
        <input bind:value={row.key} aria-label="Property name" placeholder="property" />
        <input bind:value={row.value} aria-label="Property value" placeholder="value" />
        <button class="icon" onclick={() => (extra = extra.filter((_, j) => j !== i))} aria-label="Remove property {row.key}"><X size={12} /></button>
      </div>
    {/each}
    <div class="row">
      <button class="link" onclick={() => (extra = [...extra, { key: '', value: '' }])}><Plus size={11} /> Property</button>
      <span class="grow"></span>
      <Button size="sm" class="ui-control" disabled={!dirty} onclick={save}>Save attributes</Button>
    </div>
    {#if measure(layer, feature)}
      <p class="ui-meta" title="Along the drawn edges on the reference shape; terrain relief is not included">{measure(layer, feature)} <span class="muted">· reference shape</span></p>
    {/if}
    {#if feature.shape}
      <p class="ui-meta muted">{feature.shape.kind === 'circle' ? `Circle, radius ${feature.shape.semiMajorKm.toFixed(3)} km` : `Ellipse ${feature.shape.semiMajorKm.toFixed(3)} × ${feature.shape.semiMinorKm.toFixed(3)} km, bearing ${feature.shape.bearingDeg.toFixed(1)}°`}. Editing its vertices makes it an ordinary polygon.</p>
    {/if}
    <div class="row">
      <Button variant="secondary" size="sm" class="ui-control flex-1" onclick={editVertices} aria-pressed={editingThis}><PencilLine size={13} /> {editingThis ? 'Done editing' : 'Edit shape'}</Button>
      <Button variant="secondary" size="sm" class="ui-control flex-1" onclick={() => duplicateFeature(layer!.id, feature!.id)}><Copy size={13} /> Duplicate</Button>
      {#if !confirmDelete}
        <Button variant="secondary" size="sm" class="ui-control flex-1" onclick={() => (confirmDelete = true)}><Trash2 size={13} /> Delete</Button>
      {:else}
        <Button variant="destructive" size="sm" class="ui-control flex-1" onclick={() => deleteFeature(layer!.id, feature!.id)}>Confirm</Button>
      {/if}
    </div>
    {#if confirmDelete}<p class="ui-helper muted">Delete this feature? Undo in Draw brings it back.</p>{/if}
  </div>
{:else if found && found.layer.ownership !== 'user'}
  <div class="row readonly">
    <span class="ui-meta muted">Read-only {found.layer.ownership === 'catalog' ? 'catalog' : 'imported'} data.</span>
    <Button variant="secondary" size="sm" class="ui-control" onclick={copyLayer} title="Copy this layer into an editable layer; the original stays unchanged">Make editable copy</Button>
  </div>
{/if}

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding-top: 6px;
    border-top: 1px solid var(--color-border);
  }
  .field { display: grid; grid-template-columns: 76px 1fr; gap: 6px; align-items: start; }
  .pair { display: grid; grid-template-columns: 1fr 1.4fr 24px; gap: 4px; }
  input, textarea {
    min-width: 0;
    padding: 2px 6px;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    background: var(--color-surface-3);
    color: var(--color-text-primary);
    font: inherit;
    font-size: var(--text-metadata);
  }
  textarea { resize: vertical; }
  .row { display: flex; gap: 4px; align-items: center; }
  .readonly { justify-content: space-between; flex-wrap: wrap; }
  .grow { flex: 1; }
  .muted { color: var(--color-text-muted); }
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
