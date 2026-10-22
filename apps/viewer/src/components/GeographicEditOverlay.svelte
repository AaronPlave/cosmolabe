<script lang="ts">
  /**
   * The drawing preview and the edit handles (#200), as an SVG over the scene.
   *
   * - While drawing: placed vertices, the segment to the pointer and, for a
   *   polygon, the closing edge, all dashed: a preview on the rendered surface,
   *   not a measurement. Circles and ellipses preview their generated ring.
   * - While editing a feature: a handle per vertex (drag to move, tap to select
   *   for Delete), a hollow handle per edge midpoint (drag to insert), a move
   *   handle (drag the whole feature), and for a circle or ellipse its centre
   *   and radius handles. A drag previews the result and shows it red, with the
   *   reason, if core would refuse it; release commits or leaves it unchanged.
   *
   * Handles are DOM, so a drag on one never reaches the camera; anywhere else
   * the scene navigates as usual. Edges are drawn the way the renderer draws
   * them, linear in longitude/latitude, and hidden past the horizon.
   */
  import {
    applyGeographicEdit, geographicFeatureAnchor, geographicEditLayerToLayer, geographicShapeRing, normalizeGeographicPosition,
    geodesicDirect, geographicDatum, geographicPositionInConvention,
    type GeographicEditFeature, type GeographicEditLayer, type GeographicEditOperation, type GeographicGeometry, type GeoPosition,
  } from '@cosmolabe/core';
  import { vs, getRenderer } from '../lib/viewer-state.svelte';
  import { drawnSurface } from '../lib/drawn-surface';
  import { edits, editLayer, applyEdit, draftShape, surfacePosition, editingFeature, selectedVertex } from '../lib/geographic-editing.svelte';

  interface Screen { x: number; y: number; visible: boolean }
  interface Handle { key: string; kind: 'vertex' | 'mid' | 'move' | 'center' | 'radius'; part: number[]; index: number; position: GeoPosition }
  interface Drag { handle: Handle; pointerId: number; current: GeoPosition | null; moved: boolean }

  let drag = $state<Drag | null>(null);
  /** Coarse pointers get larger handles. */
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const R = touch ? 11 : 6;

  let editing = $derived(editingFeature());
  let layer = $derived(editLayer(editing?.layerId ?? edits.target));
  let feature = $derived(editing ? layer?.features.find((f) => f.id === editing!.featureId) ?? null : null);

  /**
   * Heights of the drawn surface at vertices, from the viewer's shared cache:
   * the renderer drapes vectors on its drawn triangles, so marks at these
   * heights sit on the drawn feature. Edge samples between vertices
   * interpolate them.
   */
  function renderedHeights(l: GeographicEditLayer, positions: GeoPosition[]): (number | null)[] {
    const r = getRenderer();
    if (!r) return positions.map(() => null);
    return drawnSurface.heightsOf(r, l.body, positions.map((p) => normalizeGeographicPosition([p[0], p[1]], l.coordinates)), geographicDatum(l.coordinates));
  }

  /** Project declared-convention positions to the canvas at the given heights (else on the drawn surface). */
  function project(l: GeographicEditLayer, positions: GeoPosition[], at?: (number | null)[]): Screen[] {
    const r = getRenderer();
    if (!r || !positions.length) return [];
    const datum = geographicDatum(l.coordinates);
    const h = at ?? renderedHeights(l, positions);
    const projected = r.projectGeographicPositions(l.body, positions.map((p, i) => {
      const g = normalizeGeographicPosition([p[0], p[1]], l.coordinates);
      return h[i] === null ? g : { ...g, heightKm: h[i]! };
    }), datum) ?? [];
    const canvas = r.renderer.domElement;
    return projected.map((p) => ({ x: p.x, y: p.y, visible: p.facing && p.inFront && p.x > -50 && p.y > -50 && p.x < canvas.clientWidth + 50 && p.y < canvas.clientHeight + 50 }));
  }

  /** An edge as the renderer draws it: linear in unwrapped longitude and latitude, heights interpolated. */
  function densify(l: GeographicEditLayer, run: GeoPosition[], steps = 8): { positions: GeoPosition[]; heights: (number | null)[] } {
    const ends = renderedHeights(l, run);
    const positions: GeoPosition[] = [], hs: (number | null)[] = [];
    for (let i = 0; i < run.length; i++) {
      if (i === 0) { positions.push(run[0]); hs.push(ends[0]); continue; }
      const a = run[i - 1], b = run[i];
      let dLon = b[0] - a[0];
      if (dLon > 180) dLon -= 360; else if (dLon < -180) dLon += 360;
      for (let s = 1; s <= steps; s++) {
        let lon = a[0] + dLon * s / steps;
        if (l.coordinates.longitudeDomain === '0..360') lon = ((lon % 360) + 360) % 360;
        else lon = ((lon + 180) % 360 + 360) % 360 - 180;
        positions.push([lon, a[1] + (b[1] - a[1]) * s / steps]);
        const ha = ends[i - 1], hb = ends[i];
        hs.push(ha === null || hb === null ? null : ha + (hb - ha) * s / steps);
      }
    }
    return { positions, heights: hs };
  }

  /** SVG path data, broken wherever the line passes behind the planet. */
  function pathData(l: GeographicEditLayer, run: GeoPosition[]): string {
    const dense = densify(l, run);
    const screen = project(l, dense.positions, dense.heights);
    let d = '', pen = false;
    for (const p of screen) {
      if (!p.visible) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      pen = true;
    }
    return d;
  }

  function runs(g: GeographicGeometry<GeoPosition>): GeoPosition[][] {
    switch (g.type) {
      case 'Point': return [];
      case 'MultiPoint': return [];
      case 'LineString': return [g.coordinates];
      case 'MultiLineString': case 'Polygon': return g.coordinates;
      case 'MultiPolygon': return g.coordinates.flat();
    }
  }
  function points(g: GeographicGeometry<GeoPosition>): GeoPosition[] {
    return g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : [];
  }

  /** Handles for the feature being edited. */
  function handles(l: GeographicEditLayer, f: GeographicEditFeature): Handle[] {
    const list: Handle[] = [];
    const g = f.geometry;
    const move = geographicFeatureAnchor(geographicEditLayerToLayer({ ...l, features: [f] }).features[0]);
    const anchor = geographicPositionInConvention(move, l.coordinates);
    if (f.shape) {
      const s = f.shape;
      const center = normalizeGeographicPosition(s.center, l.coordinates);
      const end = geodesicDirect(center, s.bearingDeg, s.semiMajorKm, geographicDatum(l.coordinates));
      list.push({ key: 'center', kind: 'center', part: [], index: 0, position: s.center });
      list.push({ key: 'radius', kind: 'radius', part: [], index: 0, position: geographicPositionInConvention(end, l.coordinates) });
      return list;
    }
    if (g.type === 'Point') return [{ key: 'v', kind: 'vertex', part: [], index: 0, position: g.coordinates }];
    let lists: { part: number[]; list: GeoPosition[]; ring: boolean }[];
    switch (g.type) {
      case 'MultiPoint': case 'LineString': lists = [{ part: [], list: g.coordinates, ring: false }]; break;
      case 'MultiLineString': lists = g.coordinates.map((list, i) => ({ part: [i], list, ring: false })); break;
      case 'Polygon': lists = g.coordinates.map((list, i) => ({ part: [i], list, ring: true })); break;
      case 'MultiPolygon': lists = g.coordinates.flatMap((poly, p) => poly.map((list, r) => ({ part: [p, r], list, ring: true }))); break;
    }
    for (const { part, list: vertices, ring } of lists) {
      const open = ring ? vertices.slice(0, -1) : vertices;
      open.forEach((position, index) => list.push({ key: `v${part.join('.')}:${index}`, kind: 'vertex', part, index, position }));
      if (g.type === 'MultiPoint') continue;
      const edges = ring ? open.length : open.length - 1;
      for (let i = 0; i < edges; i++) {
        const a = open[i], b = open[(i + 1) % open.length];
        let dLon = b[0] - a[0];
        if (dLon > 180) dLon -= 360; else if (dLon < -180) dLon += 360;
        list.push({ key: `m${part.join('.')}:${i}`, kind: 'mid', part, index: i + 1, position: [a[0] + dLon / 2, (a[1] + b[1]) / 2] });
      }
    }
    list.push({ key: 'move', kind: 'move', part: [], index: 0, position: anchor });
    return list;
  }

  /** The operation a drag stands for. */
  function operation(f: GeographicEditFeature, d: Drag): GeographicEditOperation | null {
    const to = d.current;
    if (!to) return null;
    const h = d.handle;
    switch (h.kind) {
      case 'vertex': return { type: 'move-vertex', featureId: f.id, vertex: { part: h.part, index: h.index }, position: to };
      case 'mid': return { type: 'insert-vertex', featureId: f.id, vertex: { part: h.part, index: h.index }, position: to };
      case 'move': case 'center': return { type: 'translate', featureId: f.id, from: h.position, to };
      case 'radius': {
        if (!f.shape || !layer) return null;
        const shape = draftShape(layer, { tool: f.shape.kind, vertices: [f.shape.center, to], hover: null }, null);
        if (!shape) return null;
        // A circle stays a circle; an ellipse keeps its axis ratio.
        const ratio = f.shape.semiMinorKm / f.shape.semiMajorKm;
        return { type: 'set-shape', featureId: f.id, shape: { ...f.shape, semiMajorKm: shape.semiMajorKm, semiMinorKm: shape.semiMajorKm * ratio, bearingDeg: f.shape.kind === 'ellipse' ? shape.bearingDeg : 0 } };
      }
    }
  }

  // Everything below re-derives each frame: the body turns and the camera moves.
  let view = $derived.by(() => {
    void vs.frameTick; void edits.revision;
    const l = layer;
    if (!l || !getRenderer()) return null;
    const out = { lines: [] as { d: string; closed: boolean }[], dots: [] as Screen[], handles: [] as (Handle & Screen)[], preview: [] as string[], previewDots: [] as Screen[], invalid: false, refusal: '' };
    const draft = edits.draft;
    if (draft && edits.tool) {
      const v = draft.vertices, hover = draft.hover;
      if (draft.tool === 'circle' || draft.tool === 'ellipse') {
        const shape = draftShape(l, draft);
        if (shape) out.preview.push(pathData(l, geographicShapeRing(shape, l.coordinates)));
        out.dots.push(...project(l, v));
      } else {
        const run = hover && draft.tool !== 'point' ? [...v, hover] : v;
        if (draft.tool === 'polygon' && run.length >= 3) out.preview.push(pathData(l, [run.at(-1)!, run[0]]));
        if (run.length >= 2) out.preview.push(pathData(l, run));
        out.dots.push(...project(l, v));
      }
      if (hover) out.previewDots.push(...project(l, [hover]));
    }
    const f = feature;
    if (f) {
      const d = drag;
      let shown = f;
      if (d?.moved) {
        const op = operation(f, d);
        const result = op ? applyGeographicEdit(l, op) : null;
        if (result?.ok) shown = result.layer.features.find((x) => x.id === f.id) ?? f;
        out.invalid = !!result && !result.ok;
        out.refusal = result && !result.ok ? result.diagnostics.map((x) => x.message).join('; ') : '';
        for (const run of runs(shown.geometry)) out.preview.push(pathData(l, run));
        out.previewDots.push(...project(l, points(shown.geometry)));
      }
      const hs = handles(l, d?.moved && !out.invalid ? shown : f);
      const screen = project(l, hs.map((h) => h.position));
      out.handles = hs.map((h, i) => ({ ...h, ...screen[i] })).filter((h) => h.visible);
    }
    return out;
  });

  function canvasPoint(e: PointerEvent): { x: number; y: number } | null {
    const canvas = getRenderer()?.renderer.domElement;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function down(h: Handle, e: PointerEvent) {
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag = { handle: h, pointerId: e.pointerId, current: null, moved: false };
  }
  function move(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId || !layer) return;
    const r = getRenderer(), p = canvasPoint(e);
    if (!r || !p) return;
    const position = surfacePosition(r, layer, p.x, p.y);
    if (position) drag = { ...drag, current: position, moved: true };
  }
  function up(e: PointerEvent) {
    const d = drag;
    if (!d || e.pointerId !== d.pointerId) return;
    drag = null;
    const f = feature, l = layer;
    if (!f || !l) return;
    if (!d.moved) {
      // A tap selects a vertex for Delete; tapping it again deselects.
      if (d.handle.kind === 'vertex') {
        const current = selectedVertex();
        const same = current && current.index === d.handle.index && current.part.join() === d.handle.part.join();
        edits.vertex = same || !editing ? null : { layerId: editing.layerId, featureId: editing.featureId, part: d.handle.part, index: d.handle.index };
      }
      return;
    }
    const op = operation(f, d);
    if (op) applyEdit(l.id, op);
  }
  function cancel(e: PointerEvent) {
    if (drag && e.pointerId === drag.pointerId) drag = null;
  }

  const isSelectedVertex = (h: Handle) => h.kind === 'vertex' && selectedVertex()?.index === h.index && selectedVertex()!.part.join() === h.part.join();
</script>

{#if view}
  <svg class="edit-overlay" aria-hidden={!feature}>
    {#each view.preview as d, i (i)}
      <path {d} class="preview" class:invalid={view.invalid} />
    {/each}
    {#each view.dots as p, i (i)}
      {#if p.visible}<circle cx={p.x} cy={p.y} r="4" class="placed" />{/if}
    {/each}
    {#each view.previewDots as p, i (i)}
      {#if p.visible}<circle cx={p.x} cy={p.y} r="3" class="pointer" class:invalid={view.invalid} />{/if}
    {/each}
    {#each view.handles as h (h.key)}
      <g
        class="handle {h.kind}"
        class:selected={isSelectedVertex(h)}
        transform="translate({h.x} {h.y})"
        role="button"
        tabindex="-1"
        aria-label={h.kind === 'vertex' ? `Vertex ${h.index + 1}` : h.kind === 'mid' ? 'Insert a vertex here' : h.kind === 'radius' ? 'Resize' : 'Move feature'}
        onpointerdown={(e) => down(h, e)}
        onpointermove={move}
        onpointerup={up}
        onpointercancel={cancel}
      >
        <!-- A larger transparent target than the visible mark, for fingers. -->
        <circle r={R + 4} class="hit" />
        {#if h.kind === 'vertex'}<circle r={R / 1.4} class="mark" />
        {:else if h.kind === 'mid'}<circle r={R / 2.2} class="mark hollow" />
        {:else if h.kind === 'radius'}<rect x={-R / 1.6} y={-R / 1.6} width={R * 1.25} height={R * 1.25} class="mark" />
        {:else}<path d="M{-R} 0H{R}M0 {-R}V{R}" class="cross" /><circle r={R / 2.4} class="mark" />{/if}
      </g>
    {/each}
  </svg>
  {#if view.refusal}<div class="refusal" role="status">{view.refusal}</div>{/if}
{/if}

<style>
  .edit-overlay {
    position: absolute;
    inset: 0;
    z-index: 6;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }
  .preview {
    fill: none;
    stroke: #ffffff;
    stroke-width: 1.5;
    stroke-dasharray: 5 4;
    filter: drop-shadow(0 0 1px #000);
  }
  .preview.invalid, .pointer.invalid { stroke: #ff6b6b; fill: #ff6b6b; }
  .placed { fill: #ffffff; stroke: #0b1220; stroke-width: 1.5; }
  .pointer { fill: #ffffff; opacity: 0.8; }
  .handle { pointer-events: all; cursor: grab; touch-action: none; }
  .handle:active { cursor: grabbing; }
  .hit { fill: transparent; }
  .mark { fill: #ffffff; stroke: #0b1220; stroke-width: 1.5; }
  .mark.hollow { fill: #0b1220aa; stroke: #ffffff; }
  .handle.selected .mark { fill: #f0c040; }
  .handle:hover .mark { stroke: #f0c040; }
  .cross { stroke: #ffffff; stroke-width: 2; filter: drop-shadow(0 0 1px #000); }
  .refusal {
    position: absolute;
    left: 50%;
    bottom: 96px;
    z-index: 7;
    max-width: min(28rem, calc(100% - 32px));
    transform: translateX(-50%);
    padding: 4px 10px;
    border-radius: 4px;
    background: #2a0f12e6;
    color: #ffb4b4;
    font: 12px/1.4 var(--font-sans, sans-serif);
    pointer-events: none;
  }
</style>
