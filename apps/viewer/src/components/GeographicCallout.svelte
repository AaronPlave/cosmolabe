<script lang="ts">
  /**
   * Names the selected geographic feature in the scene — one callout, never
   * one per feature, so a dense layer does not crowd the view. It sits at the
   * feature's anchor (a point's own position, otherwise its extent's centre) on
   * resident terrain where there is some, follows the body every frame, and
   * hides past the horizon or off screen rather than showing through the planet.
   * Selecting in the scene opens nothing; the callout's name opens the
   * feature in Surface layers, and its ✈ flies there.
   */
  import { geographicFeatureAnchor, geographicFeatureName } from '@cosmolabe/core';
  import { vs, getRenderer } from '../lib/viewer-state.svelte';
  import { Plane } from 'lucide-svelte';
  import { drawnSurface } from '../lib/drawn-surface';
  import { geo, findFeature, goToFeature, navigationUnavailable, showSelectedDetails } from '../lib/geographic-layers.svelte';

  let found = $derived(findFeature(geo.selected));
  let anchor = $derived(found ? geographicFeatureAnchor(found.feature) : null);

  let position = $derived.by(() => {
    void vs.frameTick;
    const r = getRenderer();
    if (!r || !found || !anchor) return null;
    // On the drawn surface, so the leader touches the feature as drawn even on a coarse globe.
    const p = drawnSurface.project(r, found.layer.body, [anchor], found.layer.datum)?.[0];
    const canvas = r.renderer.domElement;
    if (!p || !p.facing || !p.inFront || p.x < 0 || p.y < 0 || p.x > canvas.clientWidth || p.y > canvas.clientHeight) return null;
    // Whole pixels: sub-pixel motion of a resting view reads as jitter in text.
    return { x: Math.round(p.x), y: Math.round(p.y) };
  });
</script>

{#if found && position}
  <div class="callout" style:transform="translate({position.x}px, {position.y}px)">
    <span class="leader"></span>
    <span class="card">
      <button class="label" onclick={showSelectedDetails} title="Show details in Surface layers">{geographicFeatureName(found.feature)}</button>
      {#if !navigationUnavailable(found.layer)}
        <button class="fly" onclick={() => geo.selected && goToFeature(geo.selected)} aria-label="Fly to {geographicFeatureName(found.feature)}" title="Fly to"><Plane size={11} /></button>
      {/if}
    </span>
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
  .card {
    position: absolute;
    left: 0;
    bottom: 18px;
    display: flex;
    transform: translateX(-50%);
    border-radius: 3px;
    background: #111b24d9;
    pointer-events: auto;
  }
  .label, .fly {
    border: none;
    background: none;
    color: #f5e6b8;
    font: 11px/1.4 var(--font-sans, sans-serif);
    cursor: pointer;
  }
  .label {
    max-width: 220px;
    overflow: hidden;
    padding: 2px 6px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fly {
    display: inline-flex;
    align-items: center;
    padding: 0 6px;
    border-left: 1px solid #f5e6b833;
  }
  .label:hover, .fly:hover { color: #fff; }
</style>
