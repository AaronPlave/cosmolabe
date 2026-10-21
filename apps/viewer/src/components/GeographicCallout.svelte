<script lang="ts">
  /**
   * Names the selected geographic feature in the scene — one callout, never
   * one per feature, so a dense layer does not crowd the view. It sits at the
   * feature's anchor (a point's own position, otherwise its extent's centre) on
   * the drawn surface, follows the body every frame, and
   * hides past the horizon or off screen rather than showing through the planet.
   * Selecting in the scene opens nothing; clicking the callout opens the
   * feature's details in Surface layers.
   */
  import { geographicFeatureAnchor, geographicFeatureName } from '@cosmolabe/core';
  import { vs, getRenderer } from '../lib/viewer-state.svelte';
  import { geo, findFeature, showSelectedDetails } from '../lib/geographic-layers.svelte';

  let found = $derived(findFeature(geo.selected));
  let anchor = $derived(found ? geographicFeatureAnchor(found.feature) : null);

  let position = $derived.by(() => {
    void vs.frameTick;
    const r = getRenderer();
    if (!r || !found || !anchor) return null;
    // On the drawn surface (globe facets or terrain tiles), where the feature itself is drawn.
    const heightKm = r.renderedSurfaceHeightsKm(found.layer.body, [anchor], found.layer.datum)[0];
    const at = heightKm === null ? anchor : { ...anchor, heightKm };
    const p = r.projectGeographicPositions(found.layer.body, [at], found.layer.datum, { sampleTerrain: heightKm === null })?.[0];
    const canvas = r.renderer.domElement;
    if (!p || !p.facing || !p.inFront || p.x < 0 || p.y < 0 || p.x > canvas.clientWidth || p.y > canvas.clientHeight) return null;
    // Whole pixels: sub-pixel motion of a resting view reads as jitter in text.
    return { x: Math.round(p.x), y: Math.round(p.y) };
  });
</script>

{#if found && position}
  <div class="callout" style:transform="translate({position.x}px, {position.y}px)">
    <span class="leader"></span>
    <button class="label" onclick={showSelectedDetails} title="Show details in Surface layers">{geographicFeatureName(found.feature)}</button>
  </div>
{/if}

<style>
  .callout {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 5;
    pointer-events: none;
  }
  .leader {
    position: absolute;
    left: 0;
    bottom: 0;
    width: 1px;
    height: 18px;
    background: #f0c040cc;
  }
  .label {
    position: absolute;
    left: 0;
    bottom: 18px;
    transform: translateX(-50%);
    max-width: 220px;
    overflow: hidden;
    padding: 2px 6px;
    border: none;
    border-radius: 3px;
    pointer-events: auto;
    cursor: pointer;
    background: #111b24d9;
    color: #f5e6b8;
    font: 11px/1.4 var(--font-sans, sans-serif);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
