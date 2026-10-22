<script lang="ts">
  /**
   * Drawing and shape editing as a small tool state over the scene (#200;
   * docs/design/surface-layers-ux.md), not a window. While a draw tool is on,
   * the bar shows where shapes go, the tools, a measurement of the draft and
   * Finish / Undo last point / Cancel. While an editable feature is selected,
   * its handles show on the scene and the bar offers Delete point, Undo, Redo
   * and Done. Otherwise the bar is not shown at all.
   */
  import { Check, Circle, CornerUpLeft, Hexagon, MapPin, Redo2, Spline, Trash2, Undo2, X } from 'lucide-svelte';
  import {
    geodesicDistanceKm, geographicDatum, geographicPathLengthKm, geographicPolygonAreaKm2, normalizeGeographicPosition, type GeoPosition,
  } from '@cosmolabe/core';
  import * as Select from '$lib/components/ui/select';
  import { clearGeographicSelection } from '../lib/geographic-layers.svelte';
  import {
    edits, editLayer, editLayers, setDrawTool, finishDraft, removeLastVertex, cancelDrawing, draftShape, editingFeature, selectedVertex,
    deleteSelectedVertex, undo, redo, canUndo, canRedo, type DrawTool,
  } from '../lib/geographic-editing.svelte';

  const tools: { id: DrawTool; label: string; icon: typeof MapPin; hint: string }[] = [
    { id: 'point', label: 'Point', icon: MapPin, hint: 'Click to place a point.' },
    { id: 'line', label: 'Path', icon: Spline, hint: 'Click each point; Enter or double-click finishes.' },
    { id: 'polygon', label: 'Polygon', icon: Hexagon, hint: 'Click each corner; Enter or double-click closes it.' },
    { id: 'circle', label: 'Circle', icon: Circle, hint: 'Click the centre, then the edge.' },
    { id: 'ellipse', label: 'Ellipse', icon: Circle, hint: 'Click the centre, the end of the long axis, then the short axis.' },
  ];

  let target = $derived(edits.tool ? editLayer(edits.target) : undefined);
  let editing = $derived(editingFeature());
  let editingLayer = $derived(editing ? editLayer(editing.layerId) : undefined);
  let vertex = $derived(selectedVertex());
  let hint = $derived(tools.find((t) => t.id === edits.tool)?.hint ?? '');
  /** Editable layers on the body being drawn on, to switch where shapes go. */
  let choices = $derived(target ? editLayers().filter((l) => l.body === target!.body) : []);

  const km = (v: number) => v < 1 ? `${(v * 1000).toFixed(0)} m` : `${v.toFixed(v < 100 ? 2 : 0)} km`;
  /** Length, area or radius of the draft so far, on the reference shape. */
  let readout = $derived.by(() => {
    const l = target, d = edits.draft;
    if (!l || !d) return '';
    const datum = geographicDatum(l.coordinates);
    const run: GeoPosition[] = d.hover ? [...d.vertices, d.hover] : d.vertices;
    const geo = (p: GeoPosition) => normalizeGeographicPosition([p[0], p[1]], l.coordinates);
    if (d.tool === 'line' && run.length >= 2) return km(geographicPathLengthKm(run.map(geo), datum));
    if (d.tool === 'polygon' && run.length >= 3) {
      const ring = [...run, run[0]].map(geo);
      return `${geographicPolygonAreaKm2([ring], datum).toPrecision(3)} km²`;
    }
    if (d.tool === 'circle' || d.tool === 'ellipse') {
      const s = draftShape(l, d);
      if (!s) return '';
      return s.kind === 'circle' ? `radius ${km(s.semiMajorKm)}` : `${km(s.semiMajorKm)} × ${km(s.semiMinorKm)}`;
    }
    if (d.tool === 'line' && run.length === 1 && d.hover) return km(geodesicDistanceKm(geo(run[0]), geo(d.hover), datum));
    return '';
  });
  let canFinish = $derived((edits.draft?.vertices.length ?? 0) >= (edits.tool === 'line' ? 2 : 3));
</script>

{#if (edits.tool && target) || (editing && editingLayer)}
  <div class="draw-bar" role="toolbar" aria-label={edits.tool ? 'Drawing' : 'Editing shape'}>
    {#if edits.tool && target}
      <div class="row">
        {#if choices.length > 1}
          <Select.Root type="single" value={target.id} onValueChange={(v) => { if (v) { edits.target = v; setDrawTool(edits.tool, target!.body); } }}>
            <Select.Trigger size="sm" class="ui-control h-7 max-w-40 rounded border-border bg-surface-3 px-2 text-text-primary" aria-label="Draw into">
              <Select.Value>{target.name}</Select.Value>
            </Select.Trigger>
            <Select.Content align="start" class="max-h-64 rounded border border-border-strong bg-surface-2 p-1">
              {#each choices as l (l.id)}<Select.Item value={l.id} label={l.name} />{/each}
            </Select.Content>
          </Select.Root>
        {:else}
          <span class="into ui-meta" title="New shapes go into this layer">{target.name}</span>
        {/if}
        <span class="sep"></span>
        <div class="tools" role="group" aria-label="Drawing tools">
          {#each tools as t (t.id)}
            {@const Icon = t.icon}
            <button class="tool" class:on={edits.tool === t.id} aria-pressed={edits.tool === t.id} aria-label={t.label} title={t.label}
              onclick={() => setDrawTool(t.id, target!.body)}><span class:squash={t.id === 'ellipse'}><Icon size={15} /></span></button>
          {/each}
        </div>
        <span class="sep"></span>
        {#if edits.tool === 'line' || edits.tool === 'polygon'}
          <button class="action primary" disabled={!canFinish} onclick={finishDraft} title="Finish (Enter)"><Check size={14} /> Finish</button>
        {/if}
        <button class="action" disabled={!edits.draft?.vertices.length} onclick={removeLastVertex} aria-label="Undo last point" title="Undo last point (Backspace)"><CornerUpLeft size={14} /></button>
        <button class="action" onclick={() => setDrawTool(null)} aria-label="Stop drawing" title="Stop drawing (Esc)"><X size={14} /></button>
      </div>
      <p class="hint ui-meta" class:warn={!!edits.message} role="status">{edits.message || hint}{#if readout && !edits.message}&nbsp;·&nbsp;<span class="readout">{readout}</span>{/if}</p>
    {:else if editing && editingLayer}
      <div class="row">
        <span class="into ui-meta" title="Drag a point to move it, a hollow midpoint to add one, or the cross to move the whole shape. Click a point, then Delete, to remove it.">Drag points; hollow ones add a point</span>
        <span class="sep"></span>
        <button class="action" disabled={!vertex} onclick={deleteSelectedVertex} aria-label="Delete point" title="Delete the chosen point (Delete)"><Trash2 size={14} /></button>
        <button class="action" disabled={!canUndo(editing.layerId)} onclick={() => undo(editing!.layerId)} aria-label="Undo" title="Undo (Ctrl/⌘ Z)"><Undo2 size={14} /></button>
        <button class="action" disabled={!canRedo(editing.layerId)} onclick={() => redo(editing!.layerId)} aria-label="Redo" title="Redo (Ctrl/⌘ Shift Z)"><Redo2 size={14} /></button>
        <button class="action primary" onclick={() => { cancelDrawing(); clearGeographicSelection(); }} title="Done (Esc)"><Check size={14} /> Done</button>
      </div>
      {#if edits.message}<p class="hint ui-meta warn" role="status">{edits.message}</p>{/if}
    {/if}
  </div>
{/if}

<style>
  .draw-bar {
    position: absolute;
    left: 50%;
    bottom: 72px;
    z-index: 20;
    display: flex;
    max-width: calc(100% - 32px);
    flex-direction: column;
    gap: 4px;
    transform: translateX(-50%);
    padding: 6px 8px;
    border: 1px solid var(--color-border-strong);
    border-radius: 8px;
    background: color-mix(in srgb, var(--color-surface-1, #0d1117) 94%, transparent);
    box-shadow: 0 6px 24px #0008;
  }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
  .into { max-width: 220px; overflow: hidden; color: var(--color-text-secondary); text-overflow: ellipsis; white-space: nowrap; }
  .sep { width: 1px; height: 20px; margin: 0 2px; background: var(--color-border); }
  .tools { display: flex; gap: 2px; }
  .squash { display: inline-flex; transform: scaleY(0.62); }
  .tool, .action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-width: 30px;
    height: 30px;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-metadata);
    cursor: pointer;
  }
  .tool:hover, .action:hover:not(:disabled) { background: var(--color-surface-3); color: var(--color-text-primary); }
  .tool.on { border-color: var(--color-border-strong); background: var(--color-control); color: var(--color-text-primary); }
  .action:disabled { opacity: 0.35; cursor: default; }
  .action.primary { background: var(--color-text-primary); color: var(--color-surface-1, #0d1117); }
  .action.primary:hover:not(:disabled) { background: var(--color-text-primary); color: var(--color-surface-1, #0d1117); opacity: 0.9; }
  .hint { margin: 0; padding: 0 2px; color: var(--color-text-secondary); }
  .readout { color: var(--color-text-primary); font-variant-numeric: tabular-nums; }
  .warn { color: var(--color-warning); }
  @media (max-width: 640px) {
    .draw-bar { bottom: 132px; }
    .into { max-width: 120px; }
  }
</style>
