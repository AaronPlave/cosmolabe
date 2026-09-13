<script lang="ts">
  /**
   * The timeline — a first-class instrument docked along the bottom, not a
   * toolbar that happens to contain a slider.
   *
   * Lifted out of `BottomBar.svelte`, which fused three unrelated things: the
   * transport, the time axis, and the tool buttons that are now the rail's.
   * What is left here is everything that shares the time axis.
   *
   * `shell.timelineDepth` is the progressive-depth control #71 asks for: a
   * minimal transport strip by default, and an expanded region below the axis
   * that event lanes (#67) and continuous geometry profiles (#65) will draw
   * into. Those issues add lanes; this establishes that they share one axis and
   * one playhead rather than each bringing a timeline of its own.
   */
  import {
    vs, togglePlay, reverse, faster, slower,
    stepForward, stepBackward, scrubTo, setTime,
    zoomScrubber, resetScrubberZoom, setZoomDuration, etToShortDate,
  } from '../../lib/viewer-state.svelte';
  import { shell, setTimelineDepth } from '../../lib/shell.svelte';
  import { formatDuration } from '../../lib/scrubber-math';
  import { getSpice } from '../../lib/loader';
  import { ef } from '../../lib/event-finder.svelte';
  import { eventFraction } from '../../lib/event-query';
  import { CameraModeName } from '@cosmolabe/three';
  import {
    ChevronsLeft, ChevronLeft, Rewind, Play, Pause,
    ChevronRight, ChevronsRight, ChevronUp, ChevronDown,
  } from 'lucide-svelte';
  import TimeScrubber from '../TimeScrubber.svelte';
  import * as Popover from '$lib/components/ui/popover';
  import Input from '$lib/components/ui/input/input.svelte';
  import Button from '$lib/components/ui/button/button.svelte';

  interface Props {
    /** Render bare, for a parent that supplies the surrounding chrome. */
    inline?: boolean;
  }

  let { inline = false }: Props = $props();

  let height = $state(0);
  $effect(() => {
    // Only the outermost bottom surface reports: when compact folds this into
    // the shared dock, that dock measures itself and this would report the
    // inner row's height instead.
    if (!inline) shell.chromeBottom = height;
  });

  let gotoTimeOpen = $state(false);
  let gotoTimeValue = $state('');
  let gotoTimeError = $state(false);

  const compact = $derived(shell.layout === 'compact');
  const expanded = $derived(shell.timelineDepth === 'expanded');
  /**
   * The rate and step controls are secondary: on a phone they are what pushes
   * the transport onto extra rows. Expanding the timeline brings them back,
   * which is the same progressive-depth control the lane region uses.
   */
  const secondaryHidden = $derived(compact && !expanded);

  // ── Scrubber state ──

  let currentFraction = $derived(
    vs.scrubMax > vs.scrubMin
      ? Math.max(0, Math.min(1, (vs.et - vs.scrubMin) / (vs.scrubMax - vs.scrubMin)))
      : 0.5
  );

  let baseRange = $derived(vs.scrubBaseMax - vs.scrubBaseMin);
  let currentRange = $derived(vs.scrubMax - vs.scrubMin);
  let isZoomed = $derived(baseRange > 0 && currentRange < baseRange * 0.99);

  let viewportStart = $derived(baseRange > 0 ? (vs.scrubMin - vs.scrubBaseMin) / baseRange : 0);
  let viewportEnd = $derived(baseRange > 0 ? (vs.scrubMax - vs.scrubBaseMin) / baseRange : 1);
  let globalPlayhead = $derived(baseRange > 0 ? (vs.et - vs.scrubBaseMin) / baseRange : 0.5);

  // Event finder results as scrubber ticks, on the zoomed range the track
  // actually draws. Events outside it are dropped rather than clamped to an
  // edge, where they would read as happening at a time they do not.
  let eventMarkers = $derived(
    ef.events
      .map((event) => ({
        fraction: eventFraction(event, { start: vs.scrubMin, end: vs.scrubMax }),
        selected: ef.selectedId === event.id,
        title: event.label,
      }))
      .filter((m): m is { fraction: number; selected: boolean; title: string } => m.fraction != null),
  );

  let rangeLabel = $derived(isZoomed ? formatDuration(currentRange) : '');
  // The bounds are dropped at a phone width, where they left the track about
  // forty pixels to draw a two-year mission in. The clock and the zoom readout
  // still say where in time the playhead is; a squeezed axis says nothing.
  let startLabel = $derived(compact ? '' : isZoomed ? etToShortDate(vs.scrubMin) : etToShortDate(vs.scrubBaseMin));
  let endLabel = $derived(compact ? '' : isZoomed ? etToShortDate(vs.scrubMax) : etToShortDate(vs.scrubBaseMax));

  // ── Go to time ──

  function onGotoOpen(open: boolean) {
    gotoTimeOpen = open;
    if (open) {
      gotoTimeValue = vs.timeText.replace(' UTC', '');
      gotoTimeError = false;
    }
  }

  function goToTime() {
    const spice = getSpice();
    if (!spice) return;
    try {
      setTime(spice.str2et(gotoTimeValue.trim()));
      gotoTimeOpen = false;
    } catch {
      gotoTimeError = true;
      setTimeout(() => gotoTimeError = false, 1500);
    }
  }

  function onGotoKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') goToTime();
  }
</script>

<!-- Desktop: its own dock along the bottom, offset past the rail. Compact:
     rendered bare inside the shared bottom dock, so the phone gets one bar of
     chrome rather than two stacked boxes. -->
<div
  bind:clientHeight={height}
  class="flex flex-col gap-0.5"
  class:pointer-events-auto={!inline}
  class:absolute={!inline}
  class:bottom-3={!inline}
  class:right-3={!inline}
  class:z-20={!inline}
  class:rounded-lg={!inline}
  class:border={!inline}
  class:border-border={!inline}
  class:bg-panel={!inline}
  class:backdrop-blur-md={!inline}
  class:px-3={true}
  class:py-1.5={true}
  style:left={inline ? undefined : 'calc(var(--size-rail) + 1rem)'}
>
  {#if shell.shortcutsOpen}
    <div class="py-0.5 text-center text-[12px] text-text-muted">
      Space: play &middot; &larr;/&rarr;: step &middot; &uarr;/&darr;: speed &middot; R: reverse &middot; F: fly to &middot; B: bodies &middot; E: events &middot; P: pick &middot; M: camera &middot; Cmd+K: search &middot; \: zen
    </div>
  {/if}

  <!-- Compact keeps this to one row — play, axis, clock — and puts the rest
       behind the expand toggle. The wrapped three-row transport it replaced
       cost the scene a third of a phone screen before a sheet was even open,
       which is backwards for a shell whose premise is scene-first. -->
  <div class="flex w-full items-center gap-1.5">
    <div class="flex shrink-0 gap-px">
      {#if !secondaryHidden}
        <button class="tl-btn" onclick={slower} title="Slower (Down)" aria-label="Slower"><ChevronsLeft size={14} /></button>
        <button class="tl-btn" onclick={stepBackward} title="Step back (Left)" aria-label="Step back"><ChevronLeft size={14} /></button>
        <button class="tl-btn" onclick={reverse} title="Reverse (R)" aria-label="Reverse"><Rewind fill="currentColor" size={13} /></button>
      {/if}
      <button class="tl-btn mx-0.5 border border-border bg-surface-3 px-2" onclick={togglePlay} title="Play/Pause (Space)" aria-label={vs.playing ? 'Pause' : 'Play'}>
        {#if vs.playing}<Pause fill="currentColor" size={14} />{:else}<Play fill="currentColor" size={14} />{/if}
      </button>
      {#if !secondaryHidden}
        <button class="tl-btn" onclick={stepForward} title="Step forward (Right)" aria-label="Step forward"><ChevronRight size={14} /></button>
        <button class="tl-btn" onclick={faster} title="Faster (Up)" aria-label="Faster"><ChevronsRight size={14} /></button>
      {/if}
    </div>

    {#if !secondaryHidden}
      <span class="min-w-16 shrink-0 text-center font-mono text-[11px] text-text-secondary">{vs.rateText}</span>
    {/if}

    <div class="flex min-w-24 flex-1 items-center">
      <TimeScrubber
        fraction={currentFraction}
        onScrub={scrubTo}
        onZoom={zoomScrubber}
        onResetZoom={resetScrubberZoom}
        onSetZoom={setZoomDuration}
        {startLabel}
        {endLabel}
        {isZoomed}
        {viewportStart}
        {viewportEnd}
        {globalPlayhead}
        {rangeLabel}
        markers={eventMarkers}
      />
    </div>

    <Popover.Root bind:open={gotoTimeOpen} onOpenChange={onGotoOpen}>
      <Popover.Trigger class="shrink-0 whitespace-nowrap rounded px-2 py-0.5 font-mono text-text-primary transition-colors hover:bg-surface-3 cursor-pointer {compact ? 'text-[10px]' : 'text-[12px]'}">
        {compact ? vs.timeText.replace(' UTC', '') : vs.timeText}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" sideOffset={8} class="w-80 p-3">
          <div class="flex flex-col gap-2">
            <span class="text-[11px] text-muted-foreground">Go to time</span>
            <div class="flex gap-1.5">
              <Input
                bind:value={gotoTimeValue}
                class="font-mono text-[12px] h-8 {gotoTimeError ? 'border-error' : ''}"
                placeholder="e.g. 2004-06-30T12:00:00"
                onkeydown={onGotoKeydown}
                autofocus
              />
              <Button size="sm" onclick={goToTime}>Go</Button>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>

    {#if vs.cameraMode !== CameraModeName.FREE_ORBIT && !compact}
      <span class="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-text-secondary">{vs.cameraMode}</span>
    {/if}

    <button
      class="tl-btn"
      aria-pressed={expanded}
      aria-label={expanded ? 'Collapse timeline' : 'Expand timeline'}
      title={expanded ? 'Collapse timeline' : 'Expand timeline'}
      onclick={() => setTimelineDepth(expanded ? 'transport' : 'expanded')}
    >
      {#if expanded}<ChevronDown size={14} />{:else}<ChevronUp size={14} />{/if}
    </button>
  </div>

  {#if expanded}
    <!-- The shared-axis region. Event lanes (#67) and continuous geometry
         profiles (#65) land here, against this playhead — the placeholder is
         what keeps them from each arriving with a timeline of their own. -->
    <div class="flex h-16 items-center justify-center rounded border border-dashed border-border/60 text-[11px] text-text-muted">
      Event lanes and geometry profiles share this axis
    </div>
  {/if}
</div>

<style>
  .tl-btn {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    padding: 6px;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: color 0.1s, background 0.1s;
  }
  .tl-btn:hover {
    color: var(--color-text-primary);
    background: var(--color-surface-3);
  }
  .tl-btn[aria-pressed='true'] {
    color: var(--color-accent);
  }
</style>
