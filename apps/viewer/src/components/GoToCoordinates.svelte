<script lang="ts">
  /**
   * "Go to coordinates…" (#190): name a place on a body by latitude and
   * longitude and fly or jump to a view of it. The coordinates are the target
   * on the body, not the camera's position; the conventions they are read in
   * are always on screen, and nothing is navigated until they resolve.
   */
  import { untrack } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import SegmentedControl from '$lib/components/ui/segmented-control.svelte';
  import { Navigation, MapPin } from 'lucide-svelte';
  import {
    parseCoordinatePair, describeNavigationTarget, defaultSurfaceRangeKm,
    type CoordinateOrder, type LatitudeConvention, type LongitudeDirection, type SurfaceViewPreset,
  } from '@cosmolabe/core';
  import { vs, coordinateBodies, resolveCoordinateTarget, goToCoordinates } from '../lib/viewer-state.svelte';

  interface Props {
    open: boolean;
    onClose: () => void;
  }
  let { open = $bindable(), onClose }: Props = $props();

  // Kept between openings, so a second visit starts from the last place.
  let bodyName = $state('');
  /** One field for the pair, so a pasted "18.4447, 77.4508" goes in whole. */
  let pairText = $state('');
  let order = $state<CoordinateOrder>('lat-lon');
  let latitude = $state<LatitudeConvention>('planetocentric');
  let direction = $state<LongitudeDirection>('east');
  let preset = $state<SurfaceViewPreset>('overhead');
  let rangeText = $state('');
  let failure = $state<string | null>(null);

  let bodies = $state<string[]>([]);

  function onOpenChange(isOpen: boolean) {
    if (!isOpen) { onClose(); return; }
    bodies = coordinateBodies();
    // The tracked body by default, when it has a geographic reference.
    const tracked = vs.trackedBodyName;
    if (tracked && bodies.includes(tracked)) bodyName = tracked;
    else if (!bodies.includes(bodyName)) bodyName = bodies[0] ?? '';
    failure = null;
  }
  $effect(() => {
    if (open) untrack(() => onOpenChange(true));
  });

  const pair = $derived(pairText.trim() ? parseCoordinatePair(pairText, { order, direction }) : null);
  // A surface eye height is metres; altitudes and ranges are km.
  const rangeUnit = $derived(preset === 'surface' ? 'm' : 'km');
  const range = $derived.by(() => {
    const t = rangeText.trim();
    if (!t) return { ok: true as const, km: undefined };
    const v = Number(t);
    return Number.isFinite(v) && v > 0
      ? { ok: true as const, km: rangeUnit === 'm' ? v / 1000 : v }
      : { ok: false as const, error: `Range must be a positive number of ${rangeUnit === 'm' ? 'metres' : 'km'}` };
  });

  const input = $derived(pair?.ok && bodyName
    ? { bodyName, latDeg: pair.latDeg, lonDeg: pair.lonDeg, latitude, longitudeDirection: direction }
    : null);
  /** The pair as read, before anything moves: which number became which. */
  const parsedText = $derived.by(() => {
    if (!pair?.ok) return '';
    const lat = `${Math.abs(pair.latDeg)}° ${pair.latDeg >= 0 ? 'N' : 'S'}`;
    const lon = `${pair.lonDeg}° ${direction}-positive`;
    return `Latitude ${lat} (${latitude}) · longitude ${lon}${pair.byLetters ? ', from the N/S/E/W letters' : ''}`;
  });
  // Re-resolved when the body's terrain arrives, so the readout says what it lands on.
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

  const rangeLabel = $derived(preset === 'overhead' ? 'Altitude' : preset === 'oblique' ? 'Slant range' : 'Eye height');
  const rangePlaceholder = $derived.by(() => {
    if (!resolved?.ok) return 'auto';
    const km = defaultSurfaceRangeKm(preset, resolved.target.scaleKm);
    return `${Number((rangeUnit === 'm' ? km * 1000 : km).toPrecision(3))} ${rangeUnit} (auto)`;
  });

  function go(animate: boolean) {
    if (!input || !range.ok) return;
    const result = goToCoordinates(input, { preset, animate, rangeKm: range.km });
    if (!result.ok) { failure = result.error; return; }
    open = false;
    onClose();
  }

  function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (canGo) go(true);
  }

  const fieldClass = 'ui-control min-w-0 w-full bg-surface-3 text-text-primary border border-border rounded px-2 py-1 outline-none font-mono';
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Content class="sm:max-w-sm">
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-1.5"><MapPin size={14} /> Go to coordinates</Dialog.Title>
      <Dialog.Description class="text-[11px] text-text-muted">
        A place on a body, by latitude and longitude. The camera looks at it from the chosen view; time and selection stay as they are.
      </Dialog.Description>
    </Dialog.Header>

    {#if bodies.length === 0}
      <p class="text-[12px] text-text-secondary">No body in this scene has a declared shape and rotation to place coordinates on.</p>
    {:else}
      <form class="grid gap-2.5 text-[12px]" onsubmit={onSubmit} oninput={() => (failure = null)}>
        <label class="grid gap-1">
          <span class="text-text-secondary">Body</span>
          <select class={fieldClass} bind:value={bodyName}>
            {#each bodies as name (name)}
              <option value={name}>{name}{name === vs.trackedBodyName ? ' (tracked)' : ''}</option>
            {/each}
          </select>
        </label>

        <label class="grid gap-1">
          <span class="text-text-secondary">Coordinates ({order === 'lat-lon' ? 'latitude, longitude' : 'longitude, latitude'})</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input class={fieldClass} bind:value={pairText} placeholder={order === 'lat-lon' ? '18.4447, 77.4508' : '77.4508, 18.4447'} autocomplete="off" spellcheck="false" autofocus />
        </label>
        <div class="grid gap-1">
          <span class="text-text-secondary">Order of unlabelled numbers</span>
          <!-- Maps and papers write latitude first; GeoJSON and GIS tools
               longitude first. Chosen, never guessed from the values. -->
          <SegmentedControl label="Coordinate order" value={order === 'lat-lon' ? 'lat, lon' : 'lon, lat'} options={['lat, lon', 'lon, lat']} onValueChange={(v) => (order = v === 'lat, lon' ? 'lat-lon' : 'lon-lat')} />
        </div>

        <div class="grid gap-1">
          <span class="text-text-secondary">Latitude convention</span>
          <SegmentedControl label="Latitude convention" value={latitude} options={['planetocentric', 'planetographic']} onValueChange={(v) => (latitude = v as LatitudeConvention)} />
        </div>
        <div class="grid gap-1">
          <span class="text-text-secondary">Longitude positive</span>
          <SegmentedControl label="Longitude direction" value={direction} options={['east', 'west']} onValueChange={(v) => (direction = v as LongitudeDirection)} />
          <span class="text-[11px] text-text-muted">
            Decimal degrees, {direction}-positive; −180…180 or 0…360. N/S and E/W letters mark each number and are absolute directions, in either order.
          </span>
        </div>

        <div class="grid gap-1">
          <span class="text-text-secondary">View</span>
          <SegmentedControl label="View" value={preset} options={['overhead', 'oblique', 'surface']} onValueChange={(v) => { preset = v as SurfaceViewPreset; rangeText = ''; }} />
        </div>

        <details>
          <summary class="cursor-pointer select-none text-text-muted hover:text-text-secondary">Advanced</summary>
          <label class="grid gap-1 mt-1.5">
            <span class="text-text-secondary">{rangeLabel} ({rangeUnit})</span>
            <input class={fieldClass} bind:value={rangeText} placeholder={rangePlaceholder} inputmode="decimal" autocomplete="off" />
          </label>
        </details>

        <!-- What the coordinates resolve to: the target, never the camera. -->
        <div class="min-h-[2.5rem] rounded border border-border bg-surface-1 px-2 py-1.5 text-[11px]" aria-live="polite">
          {#if error}
            <span class="text-[var(--color-danger,#f87171)]">{error}</span>
          {:else if resolved?.ok}
            <div class="text-text-secondary">{parsedText}</div>
            <div class="text-text-primary">Target: {resolved.target.bodyName} {describeNavigationTarget(resolved.target, 4)}</div>
            <div class="text-text-muted">
              {resolved.target.height.from === 'terrain-sample'
                ? `On terrain (${resolved.target.height.sourceId}), ${(resolved.target.height.km ?? 0).toFixed(3)} km from the datum`
                : `On the ${resolved.target.datum?.origin === 'terrain' ? 'terrain datum' : 'reference shape'}`}
            </div>
            {#each resolved.target.notes as note (note)}
              <div class="text-text-muted">{note}</div>
            {/each}
          {:else}
            <span class="text-text-muted">Paste or type a latitude and longitude, e.g. 18.4447° N, 77.4508° E.</span>
          {/if}
        </div>

        <div class="flex gap-2 justify-end">
          <Button type="button" variant="secondary" size="sm" disabled={!canGo} onclick={() => go(false)} title="Cut straight to the view">
            Jump to
          </Button>
          <Button type="submit" size="sm" disabled={!canGo} title="Fly there (Enter)">
            <Navigation size={13} /> Fly to
          </Button>
        </div>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
