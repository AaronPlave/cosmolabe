<script lang="ts">
  import { DEFAULT_SURFACE_APPEARANCE, ELEVATION_PALETTES, type SurfaceAppearanceSettings, type SurfaceBaseColor, type ElevationPalette } from '@cosmolabe/three';
  import { onDestroy } from 'svelte';
  import { appearancePick, startAppearancePick, cancelAppearancePick, validAppearanceBound } from '../lib/surface-appearance-pick.svelte';
  import { getRenderer, vs } from '../lib/viewer-state.svelte';

  let { bodyName }: { bodyName: string } = $props();
  let bodyMesh = $derived.by(() => {
    void vs.frameTick;
    return getRenderer()?.getBodyMesh(bodyName);
  });
  let datum = $derived.by(() => {
    // Cube capability arrives asynchronously with product metadata.
    void vs.frameTick;
    return bodyMesh?.surfaceAppearanceDatum;
  });
  let capability = $derived.by(() => { void vs.frameTick; return bodyMesh?.surfaceAppearanceStatus; });
  // Keyed by body in BodyInfoPanel; edits remain on the renderer when closed.
  let settings = $derived.by((): SurfaceAppearanceSettings => {
    void appearancePick.revision;
    return bodyMesh?.surfaceAppearance ?? { ...DEFAULT_SURFACE_APPEARANCE };
  });
  onDestroy(() => { if (appearancePick.bodyName === bodyName) cancelAppearancePick(); });
  let gradient = $derived(`linear-gradient(to right, ${ELEVATION_PALETTES[settings.palette].join(', ')})`);
  let contourInterval = $derived.by(() => { void vs.frameTick; return bodyMesh?.surfaceContourIntervalKm; });

  function update(patch: Partial<SurfaceAppearanceSettings>) {
    bodyMesh?.setSurfaceAppearance({ ...settings, ...patch });
    settings = bodyMesh?.surfaceAppearance ?? settings;
  }
  function enterBound(input: HTMLInputElement, bound: 'minKm' | 'maxKm') {
    const value = input.valueAsNumber;
    const valid = validAppearanceBound(settings, bound, value);
    input.setCustomValidity(valid ? '' : `Enter a ${bound === 'minKm' ? 'minimum below the maximum' : 'maximum above the minimum'} between -1000 and 1000 km, at least 0.001 km apart.`);
    if (!valid) { input.reportValidity(); return; }
    update({ [bound]: value });
  }
  function pick(bound: 'minKm' | 'maxKm') {
    startAppearancePick(bodyName, bound);
  }
</script>

{#if bodyMesh?.hasTerrain}
  <section class="mt-2 pt-2 border-t border-border" aria-label="Surface appearance">
    <div class="ui-section-label mb-1">Surface appearance</div>
    {#if datum}
      <label class="control-row">
        <span>Base color</span>
        <select aria-label="Surface base color" value={settings.baseColor} onchange={e => { cancelAppearancePick(); update({ baseColor: e.currentTarget.value as SurfaceBaseColor }); }}>
          <option value="imagery">Imagery</option>
          <option value="elevation">Elevation colors</option>
          <option value="neutral">Neutral gray</option>
        </select>
      </label>
      <div>
        <label class="control-row">
          <span>Contours</span>
          <input type="checkbox" aria-label="Contours" checked={settings.contours ?? false} onchange={e => update({ contours: e.currentTarget.checked })} />
        </label>
        {#if settings.contours}
          <label class="control-row"><span>Line opacity</span>
            <input aria-label="Contour opacity" type="range" min="0" max="1" step="0.05" value={settings.contourOpacity ?? 0.35} oninput={e => update({ contourOpacity: +e.currentTarget.value })} />
          </label>
          <label class="control-row"><span>Line color</span>
            <input aria-label="Contour color" type="color" value={settings.contourColor ?? '#f2e6c9'} oninput={e => update({ contourColor: e.currentTarget.value })} />
          </label>
          <label class="control-row"><span>Interval</span>
            <select aria-label="Contour interval" value={settings.contourIntervalKm ?? 0} onchange={e => {
              const interval = +e.currentTarget.value;
              update({ contourIntervalKm: interval });
            }}>
              <option value={0}>Automatic</option>
              {#each [0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5] as interval}
                <option value={interval}>{interval * 1000} m</option>
              {/each}
            </select>
          </label>
          <label class="control-row"><span>Elevation labels</span>
            <input aria-label="Contour elevation labels" type="checkbox" checked={settings.contourLabels ?? false} onchange={e => update({
              contourLabels: e.currentTarget.checked,
            })} />
          </label>
          {#if !settings.contourIntervalKm}
          <label class="control-row"><span>Density</span>
            <input aria-label="Contour density" type="range" min="0.25" max="2" step="0.25" value={settings.contourDensity ?? 1} oninput={e => update({ contourDensity: +e.currentTarget.value })} />
          </label>
          {/if}
          {#if contourInterval}
            <p class="ui-readout text-text-muted my-1" aria-label="Resolved contour interval">Minor {Math.round(contourInterval * 1000)} m · index {Math.round(contourInterval * 5000)} m</p>
          {/if}
          <p class="ui-meta text-text-muted my-1">Every fifth line is an index contour. Labels follow index lines and show metres above the body reference {datum.referenceShape.kind}; negative values are below it. Automatic spacing adjusts as you zoom; crowded minor lines give way to coarser contours. Fixed intervals can show no lines where the visible elevations do not cross a contour level; try a smaller interval.</p>
        {/if}
        <label class="control-row">
          <span>Hillshade effect</span>
          <input type="checkbox" aria-label="Hillshade effect" checked={settings.hillshade} onchange={e => update({ hillshade: e.currentTarget.checked })} />
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
          <p class="ui-meta text-text-muted my-1">Artificial light, clockwise from north. Sun and physical terrain are unchanged.</p>
        {/if}
        {#if settings.baseColor !== 'imagery'}
          <label class="control-row"><span>Imagery amount <span class="ui-readout">{Math.round(settings.imageryAmount * 100)}%</span></span>
            <input aria-label="Imagery amount" type="range" min="0" max="1" step="0.05" value={settings.imageryAmount} oninput={e => update({ imageryAmount: +e.currentTarget.value })} />
          </label>
          <p class="ui-meta text-text-muted my-1">0% = {settings.baseColor === 'elevation' ? 'elevation colors' : 'gray'}; 100% = imagery. Hillshade lights this base color.</p>
        {/if}
        {#if settings.baseColor === 'elevation'}
          <label class="control-row"><span>Palette</span>
            <select aria-label="Elevation palette" value={settings.palette} onchange={e => update({ palette: e.currentTarget.value as ElevationPalette })}>
              <option value="terrain">Terrain</option><option value="blue-gold">Blue / gold</option><option value="grayscale">Grayscale</option>
            </select>
          </label>
          <details class="my-1">
            <summary class="ui-label cursor-pointer">Fixed elevation range</summary>
            <label class="control-row"><span>Minimum (km)</span><input aria-label="Minimum elevation km" type="number" step="0.1" value={+settings.minKm.toFixed(3)} oninput={e => e.currentTarget.setCustomValidity('')} onchange={e => enterBound(e.currentTarget, 'minKm')} /></label>
            <button class="pick-button" aria-pressed={appearancePick.bound === 'minKm' && appearancePick.bodyName === bodyName} onclick={() => pick('minKm')}>Pick minimum on surface</button>
            <label class="control-row"><span>Maximum (km)</span><input aria-label="Maximum elevation km" type="number" step="0.1" value={+settings.maxKm.toFixed(3)} oninput={e => e.currentTarget.setCustomValidity('')} onchange={e => enterBound(e.currentTarget, 'maxKm')} /></label>
            <button class="pick-button" aria-pressed={appearancePick.bound === 'maxKm' && appearancePick.bodyName === bodyName} onclick={() => pick('maxKm')}>Pick maximum on surface</button>
          </details>
          {#if appearancePick.feedback && appearancePick.bodyName === bodyName}
            <p role="status" class="ui-meta text-text-muted my-1">{appearancePick.feedback}</p>
            {#if appearancePick.bound}<button class="pick-button" onclick={cancelAppearancePick}>Cancel point pick</button>{/if}
          {/if}
          <div class="mt-2" aria-label="Elevation legend">
            <div class="h-2 rounded-sm" style:background={gradient}></div>
            <div class="flex justify-between ui-readout mt-1"><span>≤ {+settings.minKm.toFixed(3)} km</span><span>≥ {+settings.maxKm.toFixed(3)} km</span></div>
            <p class="ui-meta text-text-muted mt-1">{datum.heightConvention === 'radial' ? 'Radial height' : 'Normal height'} above body reference {datum.referenceShape.kind}. Colors clip at range limits.</p>
          </div>
        {/if}
        <p class="ui-meta text-text-muted mt-2">Loaded terrain mesh only; coarse tiles give coarse relief. Tile debug colors take precedence.</p>
      </div>
    {:else}
      <p class="ui-meta text-text-muted" role="status" data-appearance-state={capability?.state}>{capability?.message ?? 'Terrain appearance is unavailable.'}</p>
    {/if}
  </section>
{/if}

<style>
  .control-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 6px 0; font-size: var(--text-label); color: var(--color-text-secondary); }
  select, input[type='number'] { background: var(--color-control); color: var(--color-text-primary); border: 1px solid var(--color-border); border-radius: 3px; padding: 3px; min-width: 0; max-width: 150px; }
  input[type='range'] { width: 112px; min-width: 0; accent-color: var(--color-accent); }
  input[type='number'] { width: 85px; }
  .pick-button { color: var(--color-text-primary); border: 1px solid var(--color-border); border-radius: 3px; padding: 3px 6px; font-size: var(--text-label); cursor: pointer; }
  .pick-button[aria-pressed='true'] { border-color: var(--color-accent); }
  input[type='checkbox'] { accent-color: var(--color-accent); }
</style>
