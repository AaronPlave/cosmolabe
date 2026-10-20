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
    parseLatitudeText, parseLongitudeText, describeNavigationTarget, defaultSurfaceRangeKm,
    type LatitudeConvention, type LongitudeDirection, type SurfaceViewPreset,
  } from '@cosmolabe/core';
  import { vs, coordinateBodies, resolveCoordinateTarget, goToCoordinates } from '../lib/viewer-state.svelte';

  interface Props {
    open: boolean;
    onClose: () => void;
  }
  let { open = $bindable(), onClose }: Props = $props();

  // Kept between openings, so a second visit starts from the last place.
  let bodyName = $state('');
  let latText = $state('');
  let lonText = $state('');
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

  const lat = $derived(latText.trim() ? parseLatitudeText(latText) : null);
  const lon = $derived(lonText.trim() ? parseLongitudeText(lonText, direction) : null);
  const range = $derived.by(() => {
    const t = rangeText.trim();
    if (!t) return { ok: true as const, km: undefined };
    const km = Number(t);
    return Number.isFinite(km) && km > 0 ? { ok: true as const, km } : { ok: false as const, error: 'Range must be a positive number of km' };
  });

  const input = $derived(lat?.ok && lon?.ok && bodyName
    ? { bodyName, latDeg: lat.deg, lonDeg: lon.deg, latitude, longitudeDirection: direction }
    : null);
  // Re-resolved when the body's terrain arrives, so the readout says what it lands on.
  const resolved = $derived.by(() => {
    void vs.frameTick;
    return input ? resolveCoordinateTarget(input) : null;
  });

  const error = $derived(
    failure
    ?? (lat && !lat.ok ? lat.error : null)
    ?? (lon && !lon.ok ? lon.error : null)
    ?? (!range.ok ? range.error : null)
    ?? (resolved && !resolved.ok ? resolved.error : null),
  );
  const canGo = $derived(!!resolved?.ok && range.ok);

  const rangeLabel = $derived(preset === 'overhead' ? 'Altitude' : preset === 'oblique' ? 'Slant range' : 'Eye height');
  const rangePlaceholder = $derived(resolved?.ok ? `${defaultSurfaceRangeKm(preset, resolved.target.scaleKm).toPrecision(3)} km (auto)` : 'auto');

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

        <div class="grid grid-cols-2 gap-2">
          <label class="grid gap-1">
            <span class="text-text-secondary">Latitude</span>
            <!-- svelte-ignore a11y_autofocus -->
            <input class={fieldClass} bind:value={latText} placeholder="18.4447 N" autocomplete="off" spellcheck="false" autofocus />
          </label>
          <label class="grid gap-1">
            <span class="text-text-secondary">Longitude</span>
            <input class={fieldClass} bind:value={lonText} placeholder="77.4508 E" autocomplete="off" spellcheck="false" />
          </label>
        </div>

        <div class="grid gap-1">
          <span class="text-text-secondary">Latitude convention</span>
          <SegmentedControl label="Latitude convention" value={latitude} options={['planetocentric', 'planetographic']} onValueChange={(v) => (latitude = v as LatitudeConvention)} />
        </div>
        <div class="grid gap-1">
          <span class="text-text-secondary">Longitude positive</span>
          <SegmentedControl label="Longitude direction" value={direction} options={['east', 'west']} onValueChange={(v) => (direction = v as LongitudeDirection)} />
          <span class="text-[11px] text-text-muted">
            Degrees, {direction}-positive; −180…180 or 0…360. N/S and E/W letters are read as absolute directions.
          </span>
        </div>

        <div class="grid gap-1">
          <span class="text-text-secondary">View</span>
          <SegmentedControl label="View" value={preset} options={['overhead', 'oblique', 'surface']} onValueChange={(v) => (preset = v as SurfaceViewPreset)} />
        </div>

        <details>
          <summary class="cursor-pointer select-none text-text-muted hover:text-text-secondary">Advanced</summary>
          <label class="grid gap-1 mt-1.5">
            <span class="text-text-secondary">{rangeLabel} (km)</span>
            <input class={fieldClass} bind:value={rangeText} placeholder={rangePlaceholder} inputmode="decimal" autocomplete="off" />
          </label>
        </details>

        <!-- What the coordinates resolve to: the target, never the camera. -->
        <div class="min-h-[2.5rem] rounded border border-border bg-surface-1 px-2 py-1.5 text-[11px]" aria-live="polite">
          {#if error}
            <span class="text-[var(--color-danger,#f87171)]">{error}</span>
          {:else if resolved?.ok}
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
            <span class="text-text-muted">Enter a latitude and longitude.</span>
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
