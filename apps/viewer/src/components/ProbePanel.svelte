<script lang="ts">
  /**
   * The pinned Point Probe point (#127). The scene callout carries the
   * essentials; this is the reusable record: coordinates to copy, and what the
   * numbers are measured from.
   */
  import {
    describeDatum, describeSource, formatHeight, formatLatitude, formatLongitude, surfacePointToText,
  } from '@cosmolabe/three';
  import { Copy, Check } from 'lucide-svelte';
  import { vs, getRenderer, clearProbePin } from '../lib/viewer-state.svelte';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';

  interface Props {
    width?: number;
  }
  let { width }: Props = $props();

  const point = $derived(vs.probePin);
  let copied = $state(false);
  let copiedTimer = 0;

  /** Camera-to-point slant range, live: it changes as the camera moves, the point does not. */
  const slantRangeKm = $derived.by(() => {
    void vs.et;
    void vs.frameTick;
    const r = getRenderer();
    if (!r || !point) return null;
    const world = r.surfacePointScenePosition(point);
    return world ? world.distanceTo(r.camera.position) / r.scaleFactor : null;
  });

  const datumShape = $derived.by(() => {
    if (!point) return '';
    const shape = point.altitude.datum.referenceShape;
    return shape.kind === 'sphere'
      ? `sphere ${shape.radiusKm.toFixed(3)} km`
      : `ellipsoid ${shape.radiiKm.map((r) => r.toFixed(3)).join(' × ')} km`;
  });

  async function copyCoordinates() {
    if (!point) return;
    try {
      await navigator.clipboard.writeText(surfacePointToText(point));
      copied = true;
      clearTimeout(copiedTimer);
      copiedTimer = window.setTimeout(() => (copied = false), 1500);
    } catch (err) {
      console.warn('[Cosmolabe] Copy failed:', err);
    }
  }

  function fmtRange(km: number) {
    return km < 1 ? `${(km * 1000).toFixed(1)} m` : `${km.toFixed(3)} km`;
  }
</script>

{#if point}
  <InstrumentPanel key="probe" title="Point probe" {width} onClose={clearProbePin}>
    {#snippet actions()}
      <button
        class="flex h-7 w-7 items-center justify-center rounded text-text-muted transition-colors hover:text-text-primary"
        onclick={copyCoordinates}
        title="Copy coordinates"
        aria-label="Copy coordinates"
      >
        {#if copied}<Check size={13} />{:else}<Copy size={13} />{/if}
      </button>
    {/snippet}

    <div class="font-semibold text-text-primary mb-1.5">{point.bodyName}</div>
    <div class="row"><span class="k">Lat</span><span class="v">{formatLatitude(point.latDeg, 5)}</span></div>
    <div class="row"><span class="k">Lon</span><span class="v">{formatLongitude(point.lonDeg, 5)}</span></div>
    <div class="row">
      <span class="k" title={point.altitude.from === 'terrain-sample' ? 'Sampled from the terrain product that was hit' : 'Height of the surface that was hit'}>
        {point.altitude.from === 'terrain-sample' ? 'Elevation' : 'Height'}
      </span>
      <span class="v">{formatHeight(point.altitude.km)}</span>
    </div>
    <div class="row"><span class="k">Datum</span><span class="v">{describeDatum(point.altitude.datum)}</span></div>

    <details class="mt-1.5">
      <summary class="cursor-pointer select-none text-text-muted hover:text-text-secondary">Details</summary>
      <div class="mt-1">
        <div class="row"><span class="k">Surface</span><span class="v">{describeSource(point.source)}</span></div>
        <div class="row"><span class="k">Latitude</span><span class="v">{point.latitudeKind}</span></div>
        <div class="row"><span class="k">Height from</span><span class="v">{point.altitude.from === 'terrain-sample' ? 'terrain sample' : 'rendered hit'}</span></div>
        <div class="row"><span class="k">Hit height</span><span class="v">{formatHeight(point.hit.heightKm)}</span></div>
        <div class="row"><span class="k">Reference</span><span class="v">{datumShape}</span></div>
        {#if point.terrainSample}
          <!-- A sample of a different surface at the same place (an overlay
               over the global terrain) is shown as such, never as this point's
               elevation. -->
          <div class="row">
            <span class="k" title={point.terrainSample.describesHit ? 'The terrain product that was hit' : 'Global terrain product under the surface that was hit — a different surface'}>
              {point.terrainSample.describesHit ? 'Terrain' : 'Terrain below'}
            </span>
            <span class="v">{formatHeight(point.terrainSample.elevationKm)} · {describeDatum(point.terrainSample.datum)}</span>
          </div>
          <div class="row"><span class="k">Terrain source</span><span class="v truncate" title={point.terrainSample.tileId ?? point.terrainSample.sourceId}>{point.terrainSample.sourceId}</span></div>
        {/if}
        {#each ['X', 'Y', 'Z'] as axis, i (axis)}
          <div class="row"><span class="k">{axis} body-fixed</span><span class="v">{point.bodyFixedPositionKm[i].toFixed(4)} km</span></div>
        {/each}
        {#if slantRangeKm != null}
          <div class="row"><span class="k">Camera range</span><span class="v">{fmtRange(slantRangeKm)}</span></div>
        {/if}
      </div>
    </details>
  </InstrumentPanel>
{/if}

<style>
  .row {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    line-height: 1.625;
  }
  .k {
    color: var(--color-text-secondary);
    white-space: nowrap;
  }
  .v {
    font-family: var(--font-mono, ui-monospace, monospace);
    color: var(--color-text-primary);
    min-width: 0;
    text-align: right;
  }
</style>
