<script lang="ts">
  /**
   * Feature labels for layers whose style turns them on (#199). Placement is
   * recomputed a few times a second, not every frame: candidates are projected
   * at their anchors, those past the horizon, off screen or beyond the layer's
   * range are dropped, and overlapping labels are removed greedily. Labels
   * already on screen are placed first, so a resting or slowly moving view does
   * not reshuffle them. Accepted labels then follow the scene every frame.
   *
   * Bounded: at most `maxLabels` per layer are shown, and at most
   * MAX_CANDIDATES features per layer are considered on each pass.
   */
  import { geographicFeatureAnchor, geographicFeatureName, type GeographicLayer, type GeographicFeature, type BodyFixedPosition } from '@cosmolabe/core';
  import { vs, getRenderer } from '../lib/viewer-state.svelte';
  import { geographicLoads, layerVisible } from '../lib/geographic-layers.svelte';
  import { geoStyles } from '../lib/geographic-styles.svelte';

  const MAX_CANDIDATES = 2000;
  const LAYOUT_MS = 200;

  interface Placed { key: string; layer: GeographicLayer; anchor: BodyFixedPosition; text: string; sizePx: number; halo: boolean; x: number; y: number }

  let placed = $state<Placed[]>([]);
  /** The same list, read without subscribing: the effect below both reads and replaces it. */
  let current: Placed[] = [];
  const show = (next: Placed[]) => { current = next; placed = next; };
  let lastLayout = 0;
  let lastView = '';

  function labelText(feature: GeographicFeature, field: string | null): string | null {
    if (!field) return geographicFeatureName(feature);
    const value = feature.properties?.[field];
    if (value === undefined || value === null || typeof value === 'object') return null;
    const text = String(value).trim();
    return text ? text.slice(0, 60) : null;
  }

  function layout(): Placed[] {
    const r = getRenderer();
    if (!r) return [];
    const canvas = r.renderer.domElement;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    const previous = new Set(current.map((p) => p.key));
    const accepted: Placed[] = [];
    const boxes: [number, number, number, number][] = [];
    for (const load of geographicLoads()) {
      const layer = load.layer;
      const labels = layer ? geoStyles.byLayer[layer.id]?.labels : null;
      if (!layer || !labels || !layerVisible(layer.id)) continue;
      const bm = r.getBodyMesh(layer.body);
      if (!bm?.visible) continue;
      if (labels.maxRangeKm !== undefined) {
        const rangeKm = bm.position.distanceTo(r.camera.position) / r.scaleFactor - bm.displayRadius;
        if (rangeKm > labels.maxRangeKm) continue;
      }
      const filter = r.geographicVectors.featureFilter(layer.id);
      const candidates = layer.features.filter((f) => !filter || filter.has(f.id)).slice(0, MAX_CANDIDATES);
      const anchors = candidates.map(geographicFeatureAnchor);
      const projected = r.projectGeographicPositions(layer.body, anchors, layer.datum) ?? [];
      const sizePx = labels.sizePx ?? 11;
      // Labels on screen last pass go first, then source order: stable, not distance-sorted.
      const order = candidates.map((_, i) => i).sort((a, b) =>
        Number(previous.has(`${layer.id}/${candidates[b].id}`)) - Number(previous.has(`${layer.id}/${candidates[a].id}`)) || a - b);
      let shown = 0;
      for (const i of order) {
        if (shown >= (labels.maxLabels ?? 40)) break;
        const p = projected[i];
        if (!p?.facing || !p.inFront || p.x < 0 || p.y < 0 || p.x > width || p.y > height) continue;
        const text = labelText(candidates[i], labels.field);
        if (!text) continue;
        const w = text.length * sizePx * 0.58 + 8, h = sizePx + 6;
        const box: [number, number, number, number] = [p.x - w / 2, p.y - h - 6, p.x + w / 2, p.y - 6];
        if (boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
        boxes.push(box);
        accepted.push({ key: `${layer.id}/${candidates[i].id}`, layer, anchor: anchors[i], text, sizePx, halo: labels.halo ?? true, x: p.x, y: p.y });
        shown++;
      }
    }
    return accepted;
  }

  // Lay out when the view or styles change, at most every LAYOUT_MS; otherwise
  // move the accepted labels with the scene.
  $effect(() => {
    void vs.frameTick;
    void geoStyles.byLayer;
    const r = getRenderer();
    if (!r) { if (current.length) show([]); return; }
    const any = Object.values(geoStyles.byLayer).some((s) => s.labels);
    if (!any) { if (current.length) show([]); return; }
    const now = performance.now();
    const view = r.camera.matrixWorld.elements.join(',');
    if (now - lastLayout >= LAYOUT_MS && (view !== lastView || now - lastLayout > 1000)) {
      lastLayout = now; lastView = view;
      show(layout());
      return;
    }
    if (!current.length) return;
    // Follow the scene between layouts without re-deciding which labels show.
    const next = current.map((p) => {
      const q = r.projectGeographicPositions(p.layer.body, [p.anchor], p.layer.datum)?.[0];
      return q && q.facing && q.inFront ? { ...p, x: q.x, y: q.y } : null;
    }).filter((p): p is Placed => p !== null);
    show(next);
  });
</script>

{#each placed as label (label.key)}
  <div class="geo-label" class:halo={label.halo} style:transform="translate({Math.round(label.x)}px, {Math.round(label.y)}px)" style:font-size="{label.sizePx}px" aria-hidden="true">
    {label.text}
  </div>
{/each}

<style>
  .geo-label {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 4;
    margin-top: -6px;
    translate: -50% -100%;
    padding: 0 3px;
    color: #e8eef3;
    font-family: var(--font-sans, sans-serif);
    line-height: 1.3;
    white-space: nowrap;
    pointer-events: none;
  }
  .geo-label.halo {
    text-shadow: 0 0 2px #05080c, 0 0 3px #05080c, 0 0 4px #05080c;
  }
</style>
