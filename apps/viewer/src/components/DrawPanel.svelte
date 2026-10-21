<script lang="ts">
  /**
   * Draw (#200): choose or create an editable layer, pick a tool, click the
   * surface. Paths and polygons finish with Enter or a double-click; Backspace
   * drops the last vertex; Escape cancels, then leaves the tool. While a tool is
   * on it owns scene clicks; camera drags still navigate.
   *
   * A new layer states its body, reference shape and coordinate convention up
   * front, so nothing is ever read as Earth WGS84. Lengths and areas shown are
   * on the reference shape along the drawn edges; terrain relief is not
   * included, and the dashed preview on the terrain is not a measurement.
   */
  import { Circle, Hexagon, MapPin, Spline, Undo2, Redo2, Download, Upload, Trash2, Check, X, Delete, Ellipsis } from 'lucide-svelte';
  import {
    geographicPathLengthKm, geographicPolygonAreaKm2, normalizeGeographicPosition, geographicDatum, describeGeographicCoordinates,
    GEOGRAPHIC_EXPORT_NOTE, type GeographicCoordinates, type GeoPosition,
  } from '@cosmolabe/core';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';
  import { Button } from '$lib/components/ui/button';
  import SegmentedControl from '$lib/components/ui/segmented-control.svelte';
  import * as Select from '$lib/components/ui/select';
  import { vs, getRenderer } from '../lib/viewer-state.svelte';
  import { getUniverse } from '../lib/loader';
  import {
    edits, editLayers, editLayer, setDrawTool, finishDraft, removeLastVertex, cancelDrawing, undo, redo, canUndo, canRedo,
    createLayer, deleteLayer, renameLayer, exportLayer, exportCompanionCatalog, importLayerText, bodyReferenceShape,
    draftShape, stopEditingFeature, deleteSelectedVertex, type DrawTool,
  } from '../lib/geographic-editing.svelte';

  interface Props { onClose: () => void }
  let { onClose }: Props = $props();

  let target = $derived(editLayer(edits.target));
  let inScene = $derived(editLayers().filter((l) => vs.bodies.some((b) => b.name === l.body)));
  let elsewhere = $derived(editLayers().length - inScene.length);

  // ── New layer ──
  let creating = $state(false);
  let newBody = $state('');
  let newName = $state('');
  let latitude = $state<GeographicCoordinates['latitude']>('planetocentric');
  let domain = $state<GeographicCoordinates['longitudeDomain']>('-180..180');
  let direction = $state<GeographicCoordinates['longitudeDirection']>('east');
  let drawable = $derived(vs.bodies.map((b) => b.name).filter((name) =>
    getRenderer()?.getBodyMesh(name)?.body.geometryType === 'Globe' && bodyReferenceShape(name)));
  let newShape = $derived(newBody ? bodyReferenceShape(newBody) : null);

  function startCreate() {
    creating = true;
    newBody = drawable.includes(vs.selectedBodyName ?? '') ? vs.selectedBodyName! : vs.trackedBodyName && drawable.includes(vs.trackedBodyName) ? vs.trackedBodyName : drawable[0] ?? '';
    newName = '';
    // Match a layer already on that body, so new and existing data agree.
    const existing = getUniverse()?.geographicLayers.layers.find((l) => l.body === newBody);
    if (existing) { latitude = existing.coordinates.latitude; domain = existing.coordinates.longitudeDomain; direction = existing.coordinates.longitudeDirection; }
  }
  function create() {
    if (!newShape) return;
    const id = createLayer({ body: newBody, name: newName || `${newBody} notes`, coordinates: { latitude, longitudeDirection: direction, longitudeDomain: domain, referenceShape: newShape } });
    if (id) creating = false;
  }

  // ── Tools ──
  const tools: { id: DrawTool; label: string; icon: typeof MapPin; hint: string }[] = [
    { id: 'point', label: 'Point', icon: MapPin, hint: 'Click to place a point.' },
    { id: 'line', label: 'Path', icon: Spline, hint: 'Click each vertex; Enter or double-click finishes.' },
    { id: 'polygon', label: 'Polygon', icon: Hexagon, hint: 'Click each corner; Enter or double-click closes it.' },
    { id: 'circle', label: 'Circle', icon: Circle, hint: 'Click the centre, then a point on the edge.' },
    { id: 'ellipse', label: 'Ellipse', icon: Ellipsis, hint: 'Click the centre, the end of the long axis, then the short axis.' },
  ];
  let hint = $derived(tools.find((t) => t.id === edits.tool)?.hint ?? '');

  /** Length, area or radius of the draft so far, on the reference shape. */
  let readout = $derived.by(() => {
    const l = target, d = edits.draft;
    if (!l || !d) return '';
    const datum = geographicDatum(l.coordinates);
    const run: GeoPosition[] = d.hover ? [...d.vertices, d.hover] : d.vertices;
    const geo = (p: GeoPosition) => normalizeGeographicPosition([p[0], p[1]], l.coordinates);
    const km = (v: number) => v < 1 ? `${(v * 1000).toFixed(0)} m` : `${v.toFixed(v < 100 ? 2 : 0)} km`;
    if (d.tool === 'line' && run.length >= 2) return `Length ${km(geographicPathLengthKm(run.map(geo), datum))}`;
    if (d.tool === 'polygon' && run.length >= 3) {
      const ring = [...run, run[0]].map(geo);
      return `Perimeter ${km(geographicPathLengthKm(ring, datum))} · area ${geographicPolygonAreaKm2([ring], datum).toPrecision(4)} km²`;
    }
    if (d.tool === 'circle' || d.tool === 'ellipse') {
      const s = draftShape(l, d);
      if (!s) return '';
      return s.kind === 'circle' ? `Radius ${km(s.semiMajorKm)}` : `Semi-axes ${km(s.semiMajorKm)} × ${km(s.semiMinorKm)} · bearing ${s.bearingDeg.toFixed(1)}°`;
    }
    return '';
  });

  // ── Layer actions ──
  let confirmDelete = $state(false);
  let renaming = $state(false);
  let renameValue = $state('');
  let fileInput = $state<HTMLInputElement | null>(null);

  async function importFile(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    (e.currentTarget as HTMLInputElement).value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { edits.message = 'GeoJSON over 2 MiB cannot be imported for editing.'; return; }
    importLayerText(await file.text());
  }

  function close() {
    setDrawTool(null);
    stopEditingFeature();
    onClose();
  }
</script>

<InstrumentPanel key="draw" title="Draw" width={320} onClose={close}>
  <div class="section">
    <span class="ui-label">Layer</span>
    {#if inScene.length}
      <Select.Root type="single" value={edits.target ?? ''} onValueChange={(v) => { setDrawTool(null); edits.target = v || null; confirmDelete = false; renaming = false; }}>
        <Select.Trigger size="sm" class="ui-control h-7 w-full rounded border-border bg-surface-3 px-2 text-text-primary" aria-label="Layer to draw into">
          <Select.Value>{target ? `${target.name} · ${target.body}` : 'Choose a layer…'}</Select.Value>
        </Select.Trigger>
        <Select.Content align="start" class="max-h-64 rounded border border-border-strong bg-surface-2 p-1">
          {#each inScene as l (l.id)}<Select.Item value={l.id} label={`${l.name} · ${l.body}`} />{/each}
        </Select.Content>
      </Select.Root>
    {:else}
      <p class="ui-helper muted">No editable layers in this scene yet.</p>
    {/if}
    {#if elsewhere}<p class="ui-helper muted">{elsewhere} more on bodies not in this scene.</p>{/if}
    {#if !creating}
      <div class="row">
        <Button variant="secondary" size="sm" class="ui-control flex-1" onclick={startCreate} disabled={!drawable.length}
          title={drawable.length ? 'A new layer on a body in this scene' : 'No body here has a sphere or oblate reference shape to draw on'}>New layer</Button>
        <Button variant="secondary" size="sm" class="ui-control flex-1" onclick={() => fileInput?.click()} title="Import planetary GeoJSON exported from Cosmolabe">
          <Upload size={13} /> Import
        </Button>
        <input bind:this={fileInput} type="file" accept=".geojson,.json,application/geo+json,application/json" class="hidden" onchange={importFile} />
      </div>
      <p class="ui-helper muted">To edit a catalog or imported layer, select one of its features and choose <em>Make editable copy</em>.</p>
    {/if}
  </div>

  {#if creating}
    <div class="section form" role="group" aria-label="New layer">
      <label class="field"><span class="ui-label">Name</span><input class="text" bind:value={newName} placeholder="{newBody} notes" /></label>
      <span class="ui-label">Body</span>
      <Select.Root type="single" value={newBody} onValueChange={(v) => (newBody = v)}>
        <Select.Trigger size="sm" class="ui-control h-7 w-full rounded border-border bg-surface-3 px-2 text-text-primary" aria-label="Body">
          <Select.Value>{newBody || 'Body…'}</Select.Value>
        </Select.Trigger>
        <Select.Content align="start" class="max-h-64 rounded border border-border-strong bg-surface-2 p-1">
          {#each drawable as b (b)}<Select.Item value={b} label={b} />{/each}
        </Select.Content>
      </Select.Root>
      <span class="ui-label">Latitude</span>
      <SegmentedControl value={latitude} options={['planetocentric', 'planetographic']} label="Latitude convention" onValueChange={(v) => (latitude = v as typeof latitude)} />
      <span class="ui-label">Longitude</span>
      <div class="row">
        <SegmentedControl value={direction} options={['east', 'west']} label="Positive longitude direction" onValueChange={(v) => (direction = v as typeof direction)} />
        <SegmentedControl value={domain} options={['-180..180', '0..360']} label="Longitude range" onValueChange={(v) => (domain = v as typeof domain)} />
      </div>
      {#if newShape}
        <p class="ui-helper muted">{describeGeographicCoordinates({ latitude, longitudeDirection: direction, longitudeDomain: domain, referenceShape: newShape })}. Coordinates are stored and exported in this convention.</p>
      {/if}
      <div class="row">
        <Button size="sm" class="ui-control flex-1" onclick={create} disabled={!newShape}>Create</Button>
        <Button variant="secondary" size="sm" class="ui-control flex-1" onclick={() => (creating = false)}>Cancel</Button>
      </div>
    </div>
  {/if}

  {#if target}
    <div class="section">
      <div class="tools" role="toolbar" aria-label="Drawing tools">
        {#each tools as t (t.id)}
          {@const Icon = t.icon}
          <button class="tool" class:on={edits.tool === t.id} aria-pressed={edits.tool === t.id} title={t.hint}
            onclick={() => setDrawTool(edits.tool === t.id ? null : t.id)}>
            <Icon size={15} /><span>{t.label}</span>
          </button>
        {/each}
      </div>
      {#if edits.tool}
        <p class="ui-helper">{hint} Esc cancels.</p>
        <div class="row">
          {#if edits.tool === 'line' || edits.tool === 'polygon'}
            <Button size="sm" class="ui-control flex-1" onclick={finishDraft} disabled={(edits.draft?.vertices.length ?? 0) < (edits.tool === 'line' ? 2 : 3)}><Check size={13} /> Finish</Button>
          {/if}
          <Button variant="secondary" size="sm" class="ui-control flex-1" onclick={removeLastVertex} disabled={!edits.draft?.vertices.length} title="Remove the last vertex (Backspace)"><Delete size={13} /> Last</Button>
          <Button variant="secondary" size="sm" class="ui-control flex-1" onclick={cancelDrawing} title="Cancel (Esc)"><X size={13} /> Cancel</Button>
        </div>
        {#if readout}<p class="ui-readout readout" title="Along the drawn edges on {target.body}’s reference shape; terrain relief is not included">{readout} <span class="muted">· reference shape, not terrain</span></p>{/if}
      {/if}
      {#if edits.editing}
        <p class="ui-helper">Drag a vertex to move it, a hollow midpoint to add one, the cross to move the whole feature. Tap a vertex, then Delete, to remove it.</p>
        <div class="row">
          <Button variant="secondary" size="sm" class="ui-control flex-1" onclick={deleteSelectedVertex} disabled={!edits.vertex}><Trash2 size={13} /> Delete vertex</Button>
          <Button size="sm" class="ui-control flex-1" onclick={stopEditingFeature}><Check size={13} /> Done</Button>
        </div>
      {/if}
      <div class="row">
        <Button variant="secondary" size="sm" class="ui-control flex-1" onclick={() => undo()} disabled={!canUndo()} title="Undo (Ctrl/⌘ Z)"><Undo2 size={13} /> Undo</Button>
        <Button variant="secondary" size="sm" class="ui-control flex-1" onclick={() => redo()} disabled={!canRedo()} title="Redo (Ctrl/⌘ Shift Z)"><Redo2 size={13} /> Redo</Button>
      </div>
    </div>

    <div class="section">
      <div class="ui-section-label">{target.name}</div>
      <p class="ui-meta">{target.features.length} features · {target.body} · {target.basedOn ? `copy of ${target.basedOn.layerId}` : 'authored here'}</p>
      <p class="ui-meta muted">{describeGeographicCoordinates(target.coordinates)}</p>
      {#if renaming}
        <div class="row">
          <input class="text flex-1" bind:value={renameValue} aria-label="Layer name" onkeydown={(e) => { if (e.key === 'Enter') { renameLayer(target!.id, renameValue); renaming = false; } }} />
          <Button size="sm" class="ui-control" onclick={() => { renameLayer(target!.id, renameValue); renaming = false; }}>Save</Button>
        </div>
      {/if}
      <div class="row wrap">
        <Button variant="secondary" size="sm" class="ui-control" onclick={() => exportLayer(target!.id)}><Download size={13} /> GeoJSON</Button>
        <Button variant="secondary" size="sm" class="ui-control" onclick={() => exportCompanionCatalog(target!.id)}><Download size={13} /> Catalog</Button>
        <Button variant="secondary" size="sm" class="ui-control" onclick={() => { renaming = !renaming; renameValue = target!.name; }}>Rename</Button>
        {#if !confirmDelete}
          <Button variant="secondary" size="sm" class="ui-control" onclick={() => (confirmDelete = true)}><Trash2 size={13} /> Delete</Button>
        {:else}
          <Button variant="destructive" size="sm" class="ui-control" onclick={() => { deleteLayer(target!.id); confirmDelete = false; }}>Delete {target.features.length} features</Button>
          <Button variant="secondary" size="sm" class="ui-control" onclick={() => (confirmDelete = false)}>Keep</Button>
        {/if}
      </div>
      <p class="ui-helper muted">{GEOGRAPHIC_EXPORT_NOTE}</p>
    </div>
  {/if}

  {#if edits.message}<p class="ui-helper message" role="status">{edits.message}</p>{/if}
  {#if !edits.persistent}<p class="ui-helper message">Edits are not being saved in this browser.</p>{/if}
  {#each edits.problems as problem (problem)}<p class="ui-helper message">{problem}</p>{/each}
</InstrumentPanel>

<style>
  .section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .section + .section {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid var(--color-border);
  }
  .row { display: flex; gap: 4px; align-items: center; }
  .row.wrap { flex-wrap: wrap; }
  .muted { color: var(--color-text-muted); }
  .message { margin-top: 8px; color: var(--color-warning); }
  .readout { color: var(--color-text-primary); }
  .field { display: flex; flex-direction: column; gap: 2px; }
  .text {
    height: 26px;
    padding: 0 6px;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    background: var(--color-surface-3);
    color: var(--color-text-primary);
  }
  .tools { display: grid; grid-template-columns: repeat(5, 1fr); gap: 3px; }
  .tool {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 6px 2px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-metadata);
    cursor: pointer;
  }
  .tool:hover { background: var(--color-surface-3); color: var(--color-text-primary); }
  .tool.on { border-color: var(--color-border-strong); background: var(--color-control); color: var(--color-text-primary); }
  .hidden { display: none; }
</style>
