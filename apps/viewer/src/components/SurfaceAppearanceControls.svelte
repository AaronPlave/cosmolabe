<script lang="ts">
  import { DEFAULT_SURFACE_APPEARANCE, ELEVATION_PALETTES, type SurfaceAppearanceSettings, type ElevationPalette } from '@cosmolabe/three';
  import { getRenderer, vs } from '../lib/viewer-state.svelte';

  let { bodyName }: { bodyName: string } = $props();
  let bodyMesh = $derived.by(() => {
    void vs.frameTick;
    return getRenderer()?.getBodyMesh(bodyName);
  });
  let datum = $derived(bodyMesh?.surfaceAppearanceDatum);
  // Keyed by body in BodyInfoPanel; edits remain on the renderer when closed.
  let settings = $derived<SurfaceAppearanceSettings>(bodyMesh?.surfaceAppearance ?? { ...DEFAULT_SURFACE_APPEARANCE });
  let preset = $derived(settings.elevationTint ? 'elevation' : settings.hillshade ? 'hillshade' : 'natural');
  let gradient = $derived(`linear-gradient(to right, ${ELEVATION_PALETTES[settings.palette].join(', ')})`);

  function update(patch: Partial<SurfaceAppearanceSettings>) {
    bodyMesh?.setSurfaceAppearance({ ...settings, ...patch });
    settings = bodyMesh?.surfaceAppearance ?? settings;
  }
  function choosePreset(value: string) {
    update({ hillshade: value === 'hillshade', elevationTint: value === 'elevation' });
  }
</script>

{#if bodyMesh?.hasTerrain}
  <section class="mt-2 pt-2 border-t border-border" aria-label="Surface appearance">
    <div class="ui-section-label mb-1">Surface appearance</div>
    {#if datum}
      <label class="control-row">
        <span>Style</span>
        <select aria-label="Surface style" value={preset} onchange={e => choosePreset(e.currentTarget.value)}>
          <option value="natural">Normal imagery</option>
          <option value="hillshade">Hillshade</option>
          <option value="elevation">Elevation tint</option>
        </select>
      </label>
      {#if preset !== 'natural'}
        <label class="control-row">
          <span>Hillshade</span>
          <input type="checkbox" aria-label="Combine hillshade" checked={settings.hillshade} onchange={e => update({ hillshade: e.currentTarget.checked })} />
        </label>
        {#if settings.hillshade}
          <label class="control-row"><span>Azimuth <span class="ui-readout">{settings.azimuthDeg}°</span></span>
            <input aria-label="Light azimuth" type="range" min="0" max="360" step="5" value={settings.azimuthDeg} oninput={e => update({ azimuthDeg: +e.currentTarget.value })} />
          </label>
          <label class="control-row"><span>Elevation <span class="ui-readout">{settings.elevationDeg}°</span></span>
            <input aria-label="Light elevation" type="range" min="5" max="90" step="5" value={settings.elevationDeg} oninput={e => update({ elevationDeg: +e.currentTarget.value })} />
          </label>
          <label class="control-row"><span>Contrast</span>
            <input aria-label="Hillshade contrast" type="range" min="0.25" max="3" step="0.05" value={settings.contrast} oninput={e => update({ contrast: +e.currentTarget.value })} />
          </label>
          <label class="control-row"><span>Imagery blend</span>
            <input aria-label="Hillshade imagery blend" type="range" min="0" max="1" step="0.05" value={settings.imageryMix} oninput={e => update({ imageryMix: +e.currentTarget.value })} />
          </label>
          <p class="ui-meta text-text-muted my-1">Artificial light, clockwise from north. Sun and physical terrain are unchanged.</p>
        {/if}
        {#if settings.elevationTint}
          <label class="control-row"><span>Palette</span>
            <select aria-label="Elevation palette" value={settings.palette} onchange={e => update({ palette: e.currentTarget.value as ElevationPalette })}>
              <option value="terrain">Terrain</option><option value="blue-gold">Blue / gold</option><option value="grayscale">Grayscale</option>
            </select>
          </label>
          <label class="control-row"><span>Tint opacity</span>
            <input aria-label="Elevation tint opacity" type="range" min="0" max="1" step="0.05" value={settings.tintOpacity} oninput={e => update({ tintOpacity: +e.currentTarget.value })} />
          </label>
          <details class="my-1">
            <summary class="ui-label cursor-pointer">Fixed elevation range</summary>
            <label class="control-row"><span>Minimum (km)</span><input aria-label="Minimum elevation km" type="number" step="0.1" value={settings.minKm} onchange={e => update({ minKm: +e.currentTarget.value })} /></label>
            <label class="control-row"><span>Maximum (km)</span><input aria-label="Maximum elevation km" type="number" step="0.1" value={settings.maxKm} onchange={e => update({ maxKm: +e.currentTarget.value })} /></label>
          </details>
          <div class="mt-2" aria-label="Elevation legend">
            <div class="h-2 rounded-sm" style:background={gradient}></div>
            <div class="flex justify-between ui-readout mt-1"><span>≤ {settings.minKm} km</span><span>≥ {settings.maxKm} km</span></div>
            <p class="ui-meta text-text-muted mt-1">{datum.heightConvention === 'radial' ? 'Radial height' : 'Normal height'} above body reference {datum.referenceShape.kind}. Colors clip at range limits.</p>
          </div>
        {/if}
        <p class="ui-meta text-text-muted mt-2">Loaded terrain mesh only; coarse tiles give coarse relief. Tile debug colors take precedence.</p>
      {/if}
    {:else}
      <p class="ui-meta text-text-muted">Relief styles unavailable: this surface has no supported physical elevation reference.</p>
    {/if}
  </section>
{/if}

<style>
  .control-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 6px 0; font-size: var(--text-label); color: var(--color-text-secondary); }
  select, input[type='number'] { background: var(--color-control); color: var(--color-text-primary); border: 1px solid var(--color-border); border-radius: 3px; padding: 3px; min-width: 0; max-width: 150px; }
  input[type='range'] { width: 112px; min-width: 0; accent-color: var(--color-accent); }
  input[type='number'] { width: 85px; }
  input[type='checkbox'] { accent-color: var(--color-accent); }
</style>
