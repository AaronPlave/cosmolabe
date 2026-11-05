<script lang="ts">
  /**
   * Feature labels for layers whose style turns them on (#199). Which labels
   * show is decided a few times a second by `layoutGeographicLabels`: chosen
   * by where features are (horizon, then screen), never by source order, and
   * placed on the drawn surface so they sit on their features at close range.
   * Between layouts the accepted labels follow the scene every frame, on the
   * same drawn surface (heights are cached, so this is a projection, not a
   * raycast). At most `maxLabels` per layer show.
   *
   * A label shows only where the drawn surface does not hide it, and, close
   * to a large area, on a part of it in view (see the layout), so it neither
   * floats through a crater rim nor vanishes while its area fills the screen.
   */
  import * as THREE from 'three';
  import { bodyFixedToGeodetic, type BodyFixedPosition, type GeographicLayer } from '@cosmolabe/core';
  import { vs, getRenderer } from '../lib/viewer-state.svelte';
  import { geo, geographicLoads, layerVisible } from '../lib/geographic-layers.svelte';
  import { geoStyles } from '../lib/geographic-styles.svelte';
  import { drawnSurface } from '../lib/drawn-surface';
  import { layoutGeographicLabels, type LabelLayer, type LabelView, type PlacedLabel } from '../lib/geographic-label-layout';

  const LAYOUT_MS = 200;
  /** Where to look for a large area under the view, as fractions of the canvas, centre first. */
  const PROBES: [number, number][] = [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];

  let placed = $state<PlacedLabel[]>([]);
  /** The same list, read without subscribing: the effect below both reads and replaces it. */
  let current: PlacedLabel[] = [];
  const show = (next: PlacedLabel[]) => { current = next; placed = next; };
  let lastLayout = 0;
  let lastView = '';

  function layout(): PlacedLabel[] {
    const r = getRenderer();
    if (!r) return [];
    const canvas = r.renderer.domElement;
    const layers: LabelLayer[] = [];
    for (const load of geographicLoads()) {
      const layer = load.layer;
      const labels = layer ? geoStyles.byLayer[layer.id]?.labels : null;
      if (!layer || !labels || !layerVisible(layer.id)) continue;
      const bm = r.getBodyMesh(layer.body);
      if (!bm?.visible) continue;
      if (labels.maxRangeKm !== undefined && bm.position.distanceTo(r.camera.position) / r.scaleFactor - bm.displayRadius > labels.maxRangeKm) continue;
      // The selected feature is named by its callout instead.
      const skip = geo.selected?.layerId === layer.id ? geo.selected.featureId : null;
      layers.push({ layer, labels, filter: r.geographicVectors.featureFilter(layer.id), skip });
    }
    if (!layers.length) return [];
    // The surface under a few points of the view, nearest the centre first, per body: one raycast each per layout.
    const hits = new Map<string, [number, number, number][]>();
    const probeHits = (body: string) => {
      let found = hits.get(body);
      if (found) return found;
      found = [];
      const w = canvas.clientWidth, h = canvas.clientHeight;
      for (const [fx, fy] of PROBES) {
        const hit = r.pickScene(fx * w, fy * h, 'probe', { renderedOnly: true, bodyMeshes: false });
        if (hit?.kind === 'surface' && hit.point.bodyName === body) found.push([...hit.point.bodyFixedPositionKm] as [number, number, number]);
      }
      hits.set(body, found);
      return found;
    };
    const view: LabelView = {
      width: canvas.clientWidth, height: canvas.clientHeight,
      horizon: (layer: GeographicLayer) => {
        const bm = r.getBodyMesh(layer.body);
        if (!bm) return null;
        const toBody = bm.bodyToWorldQuaternion(new THREE.Quaternion()).invert();
        const camera = r.camera.position.clone().sub(bm.position).divideScalar(r.scaleFactor).applyQuaternion(toBody);
        const shape = layer.datum.referenceShape;
        const radius = shape.kind === 'sphere' ? shape.radiusKm : Math.min(shape.radiiKm[0], shape.radiiKm[2]);
        const d = camera.length();
        if (d <= radius) return null;
        // A little past the datum horizon: relief can lift an anchor into view.
        return { direction: [camera.x / d, camera.y / d, camera.z / d], angle: Math.acos(radius / d) + 2 * Math.PI / 180 };
      },
      // At decoded terrain height where there is one: over a deep floor (Gale, ~4.5 km
      // below the datum) a low camera sees datum points far above where they are drawn.
      project: (layer, positions) => r.projectGeographicPositions(layer.body, positions, layer.datum, { sampleTerrain: true }) ?? [],
      place: (layer, positions) => drawnSurface.project(r, layer.body, positions, layer.datum, { occlusion: true }) ?? [],
      probes: (layer) => probeHits(layer.body).map(([xKm, yKm, zKm]): BodyFixedPosition => {
        const p = bodyFixedToGeodetic({ xKm, yKm, zKm }, layer.datum);
        return { latDeg: p.latDeg, lonDeg: p.lonDeg };
      }),
    };
    return layoutGeographicLabels(layers, view, new Set(current.map((p) => p.key)), new Map(current.map((p) => [p.key, p.anchor])));
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
    const view = r.camera.matrixWorld.elements.join(',') + JSON.stringify(geo.selected);
    if (now - lastLayout >= LAYOUT_MS && (view !== lastView || now - lastLayout > 1000)) {
      lastLayout = now; lastView = view;
      show(layout());
      return;
    }
    if (!current.length) return;
    // Follow the scene between layouts without re-deciding which labels show.
    const next = current.map((p) => {
      const q = drawnSurface.project(r, p.layer.body, [p.anchor], p.layer.datum, { occlusion: true })?.[0];
      return q && q.facing && q.inFront ? { ...p, x: q.x, y: q.y } : null;
    }).filter((p): p is PlacedLabel => p !== null);
    show(next);
  });
</script>

{#each placed as label (label.key)}
  <div class="geo-label" class:halo={label.halo} style:transform="translate({Math.round(label.x)}px, {Math.round(label.y)}px)" style:font-size="{label.sizePx}px" data-key={label.key} data-lat={label.anchor.latDeg} data-lon={label.anchor.lonDeg} aria-hidden="true">
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
