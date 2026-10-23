<script lang="ts" module>
  import type { CoordinateOrder, LatitudeConvention, LongitudeDirection } from '@cosmolabe/core';

  /**
   * The form, kept for the session rather than per mount: closing the panel
   * and opening it again starts from the last place, convention and view.
   */
  const form = $state({
    bodyName: '',
    /** One field for the pair, so a pasted "18.4447, 77.4508" goes in whole. */
    pairText: '',
    order: 'lat-lon' as CoordinateOrder,
    latitude: 'planetocentric' as LatitudeConvention,
    direction: 'east' as LongitudeDirection,
  });
</script>

<script lang="ts">
  /**
   * Navigate (#190): name a place on a body by latitude and longitude and fly
   * or jump to a view of it. A tool panel rather than a dialog, so it stays
   * open beside the scene while the person tries the next place, another
   * view or eye height; like any panel it docks, floats, minimizes and
   * closes. The coordinates are the target on the body, not the camera's
   * position; the conventions they are read in are always stated beside the
   * field, and nothing moves until they resolve.
   */
  import { onMount, untrack } from 'svelte';
  import { Info } from 'lucide-svelte';
  import * as Popover from '$lib/components/ui/popover';
  import SegmentedControl from '$lib/components/ui/segmented-control.svelte';
  import { parseCoordinatePair, describeNavigationTarget } from '@cosmolabe/core';
  import { vs, coordinateBodies, resolveCoordinateTarget, goToCoordinates } from '../lib/viewer-state.svelte';
  import { shell, toolDef, minimizePanel } from '../lib/shell.svelte';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';
  import PlacesPanel from './PlacesPanel.svelte';
  import NavigationView from './NavigationView.svelte';
  import NavigationActions from './NavigationActions.svelte';
  import { navigationView, navigationRange } from '../lib/navigation-view.svelte';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  let failure = $state<string | null>(null);

  // The scene's bodies with a geographic reference, again when the scene changes.
  const bodies = $derived.by(() => {
    void vs.catalogName;
    void vs.assetsReady;
    return coordinateBodies();
  });
  // Opened, the panel starts on the tracked body when it has a reference.
  onMount(() => {
    const tracked = untrack(() => vs.trackedBodyName);
    if (tracked && untrack(() => bodies).includes(tracked)) form.bodyName = tracked;
  });
  // Else the last body chosen, else the first, again if the scene drops it.
  $effect(() => {
    if (bodies.includes(form.bodyName)) return;
    const tracked = vs.trackedBodyName;
    form.bodyName = tracked && bodies.includes(tracked) ? tracked : bodies[0] ?? '';
  });

  const pair = $derived(form.pairText.trim() ? parseCoordinatePair(form.pairText, { order: form.order, direction: form.direction }) : null);
  const range = $derived(navigationRange());

  const input = $derived(pair?.ok && form.bodyName
    ? { bodyName: form.bodyName, latDeg: pair.latDeg, lonDeg: pair.lonDeg, latitude: form.latitude, longitudeDirection: form.direction }
    : null);
  // Re-resolved when the body's terrain arrives, so the status says what it lands on.
  const resolved = $derived.by(() => {
    void vs.frameTick;
    return input ? resolveCoordinateTarget(input) : null;
  });

  const error = $derived(
    failure
    ?? (pair && !pair.ok ? pair.error : null)
    ?? (!range.ok ? range.error : null)
    ?? (resolved && !resolved.ok ? resolved.error : null),
  );
  const canGo = $derived(!!resolved?.ok && range.ok);

  /** The conventions the field is read in, tersely, beside it. */
  const conventions = $derived(`${form.order === 'lat-lon' ? 'Lat, lon' : 'Lon, lat'} · ${form.latitude} · ${form.direction}-positive`);

  /**
   * Said only when the reading is not what the field shows at a glance:
   * letters that overrode the order, or a west-positive longitude, which the
   * target states east-positive.
   */
  const reading = $derived.by(() => {
    if (!pair?.ok || !resolved?.ok) return null;
    const parts: string[] = [];
    if (pair.byLetters) parts.push('read by its N/S/E/W letters');
    if (form.direction === 'west' && !pair.byLetters) parts.push(`${Math.abs(pair.lonDeg)}° west-positive`);
    return parts.length ? parts.join('; ') : null;
  });

  /**
   * One short line on what the target stands on, when that is settled; its
   * source and datum are behind the info button. A target still waiting for
   * terrain says so in its notes, shown as a warning instead.
   */
  const ground = $derived.by(() => {
    if (!resolved?.ok || resolved.target.awaitingTerrain) return null;
    const t = resolved.target;
    const shape = t.datum?.referenceShape.kind === 'sphere' ? 'sphere' : 'ellipsoid';
    if (t.height.from === 'terrain-sample') {
      const km = t.height.km ?? 0;
      const elevation = Math.abs(km) < 10 ? `${km < 0 ? '−' : '+'}${Math.abs(km * 1000).toFixed(0)} m` : `${km < 0 ? '−' : '+'}${Math.abs(km).toFixed(2)} km`;
      return {
        text: `Terrain loaded · elevation ${elevation}`,
        help: [`Source: ${t.height.sourceId ?? 'terrain'}${t.height.tileId ? ` (tile ${t.height.tileId})` : ''}`,
          `Elevation is from the terrain's datum, the reference ${shape} of ${t.bodyName}. It updates as finer terrain loads.`],
      };
    }
    return {
      text: `No terrain · on the reference ${shape}`,
      help: [`${t.bodyName} streams no terrain here, so the target is on its declared reference ${shape}, from the catalog radii.`],
    };
  });


  function go(animate: boolean) {
    if (!input || !range.ok) return;
    const result = goToCoordinates(input, { preset: navigationView.preset, animate, rangeKm: range.km });
    if (!result.ok) { failure = result.error; return; }
    // The panel stays for the next place. A phone's sheet would hide what the
    // camera is doing, so it gets out of the way, values kept.
    if (shell.layout === 'compact') minimizePanel('navigate');
  }

  function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (canGo) go(true);
  }

  /** Focus the coordinates as the panel opens, without stealing it later. */
  function focusOnMount(el: HTMLInputElement) {
    if (shell.layout !== 'compact') el.focus({ preventScroll: true });
  }

  const fieldClass = 'ui-control min-w-0 w-full bg-surface-3 text-text-primary border border-border rounded px-2 py-1 outline-none font-mono';
</script>

<InstrumentPanel key="navigate" title="Navigate" initialHeightVh={50} width={toolDef('navigate').width} fill={vs.navigateMode === 'places'} {onClose}>
  <div class:places-layout={vs.navigateMode === 'places'}>
  <div class="mb-3 shrink-0"><SegmentedControl label="Navigate mode" value={vs.navigateMode} options={['places', 'coordinates']} onValueChange={v => vs.navigateMode = v as 'places' | 'coordinates'} /></div>
  {#if vs.navigateMode === 'places'}
    <PlacesPanel />
  {:else if bodies.length === 0}
    <p class="text-text-secondary">No body in this scene has a declared shape and rotation to place coordinates on.</p>
  {:else}
    <form class="grid gap-2.5" onsubmit={onSubmit} oninput={() => (failure = null)}>
      <label class="grid gap-1">
        <span class="text-text-secondary">Body</span>
        <select class={fieldClass} bind:value={form.bodyName}>
          {#each bodies as name (name)}
            <option value={name}>{name}{name === vs.trackedBodyName ? ' (tracked)' : ''}</option>
          {/each}
        </select>
      </label>

      <label class="grid gap-1">
        <span class="text-text-secondary">Coordinates</span>
        <input
          class={fieldClass}
          bind:value={form.pairText}
          placeholder={form.order === 'lat-lon' ? '18.4447, 77.4508' : '77.4508, 18.4447'}
          autocomplete="off"
          spellcheck="false"
          aria-describedby="navigate-conventions navigate-status"
          use:focusOnMount
        />
        <!-- The active conventions, always visible; changed under Advanced. -->
        <span id="navigate-conventions" class="text-[11px] text-text-muted">{conventions}</span>
      </label>

      <NavigationView scaleKm={resolved?.ok ? resolved.target.scaleKm : undefined} />

      <details>
        <summary class="cursor-pointer select-none text-text-muted hover:text-text-secondary">Advanced</summary>
        <div class="mt-1.5 grid gap-2.5">
          <div class="grid gap-1">
            <span class="text-text-secondary">Order of unlabelled numbers</span>
            <!-- Maps and papers write latitude first; GeoJSON and GIS tools
                 longitude first. Chosen, never guessed from the values. -->
            <SegmentedControl label="Coordinate order" value={form.order === 'lat-lon' ? 'lat, lon' : 'lon, lat'} options={['lat, lon', 'lon, lat']} onValueChange={(v) => (form.order = v === 'lat, lon' ? 'lat-lon' : 'lon-lat')} />
          </div>
          <div class="grid gap-1">
            <span class="text-text-secondary">Latitude convention</span>
            <SegmentedControl label="Latitude convention" value={form.latitude} options={['planetocentric', 'planetographic']} onValueChange={(v) => (form.latitude = v as LatitudeConvention)} />
          </div>
          <div class="grid gap-1">
            <span class="text-text-secondary">Longitude positive</span>
            <SegmentedControl label="Longitude direction" value={form.direction} options={['east', 'west']} onValueChange={(v) => (form.direction = v as LongitudeDirection)} />
            <span class="text-[11px] text-text-muted">
              Decimal degrees; −180…180 or 0…360. N/S and E/W letters mark each number and are absolute directions, in either order.
            </span>
          </div>

        </div>
      </details>

      <!-- Quiet when the coordinates simply resolve; errors, warnings (terrain
           not loaded yet, a pole) and a non-obvious reading are what is said. -->
      <div id="navigate-status" class="text-[11px]" aria-live="polite">
        {#if error}
          <span class="text-[var(--color-danger,#f87171)]">{error}</span>
        {:else if resolved?.ok}
          <div class="text-text-secondary">
            {resolved.target.bodyName} {describeNavigationTarget(resolved.target, 4)}{reading ? ` — ${reading}` : ''}
          </div>
          {#each resolved.target.notes as note (note)}
            <div class="text-[var(--color-warning,#fbbf24)]">{note}</div>
          {/each}
          {#if ground}
            <div class="flex items-center gap-1 text-text-muted">
              <span>{ground.text}</span>
              <Popover.Root>
                <Popover.Trigger class="text-text-muted hover:text-text-primary cursor-pointer" aria-label="Terrain source and datum">
                  <Info size={11} />
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content side="bottom" align="start" sideOffset={6} class="w-64 max-w-[calc(100vw-24px)] p-3 ui-helper">
                    {#each ground.help as line, i (i)}
                      <p class={i > 0 ? 'mt-2' : ''}>{line}</p>
                    {/each}
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            </div>
          {/if}
        {/if}
      </div>

      <NavigationActions disabled={!canGo} onJump={() => go(false)} />
    </form>
  {/if}
  </div>
</InstrumentPanel>

<style>
  .places-layout {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    padding: var(--space-ui-3) var(--space-ui-4);
    overflow: hidden;
  }
</style>
