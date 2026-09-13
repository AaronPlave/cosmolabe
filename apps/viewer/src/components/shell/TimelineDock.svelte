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

  let gotoTimeOpen = $state(false);
  let gotoTimeValue = $state('');
  let gotoTimeError = $state(false);

  const compact = $derived(shell.layout === 'compact');
  const expanded = $derived(shell.timelineDepth === 'expanded');

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
  let startLabel = $derived(isZoomed ? etToShortDate(vs.scrubMin) : etToShortDate(vs.scrubBaseMin));
  let endLabel = $derived(isZoomed ? etToShortDate(vs.scrubMax) : etToShortDate(vs.scrubBaseMax));

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

<!-- Its own height is published back to the shell: the transport wraps at a
     phone width and the lane region grows when expanded, so what docks above
     this has to follow the measurement, not a constant. -->
<div
  bind:clientHeight={shell.timelineHeight}
  class="pointer-events-auto absolute bottom-3 right-3 z-20 flex flex-col gap-0.5 rounded-lg border border-border bg-panel backdrop-blur-md px-3 py-1.5"
  style:left={compact ? '0.5rem' : 'calc(var(--size-rail) + 1rem)'}
>
  {#if shell.shortcutsOpen}
    <div class="py-0.5 text-center text-[12px] text-text-muted">
      Space: play &middot; &larr;/&rarr;: step &middot; &uarr;/&darr;: speed &middot; R: reverse &middot; F: fly to &middot; B: bodies &middot; E: events &middot; P: pick &middot; M: camera &middot; Cmd+K: search &middot; \: zen
    </div>
  {/if}

  <!-- The transport wraps rather than overflowing: at a phone width the time
       readout drops to its own row instead of pushing the axis off-screen. -->
  <div class="flex w-full flex-wrap items-center gap-1.5">
    <div class="flex shrink-0 gap-px">
      <button class="tl-btn" onclick={slower} title="Slower (Down)" aria-label="Slower"><ChevronsLeft size={14} /></button>
      <button class="tl-btn" onclick={stepBackward} title="Step back (Left)" aria-label="Step back"><ChevronLeft size={14} /></button>
      <button class="tl-btn" onclick={reverse} title="Reverse (R)" aria-label="Reverse"><Rewind fill="currentColor" size={13} /></button>
      <button class="tl-btn mx-0.5 border border-border bg-surface-3 px-2" onclick={togglePlay} title="Play/Pause (Space)" aria-label={vs.playing ? 'Pause' : 'Play'}>
        {#if vs.playing}<Pause fill="currentColor" size={14} />{:else}<Play fill="currentColor" size={14} />{/if}
      </button>
      <button class="tl-btn" onclick={stepForward} title="Step forward (Right)" aria-label="Step forward"><ChevronRight size={14} /></button>
      <button class="tl-btn" onclick={faster} title="Faster (Up)" aria-label="Faster"><ChevronsRight size={14} /></button>
    </div>

    <span class="min-w-16 shrink-0 text-center font-mono text-[11px] text-text-secondary">{vs.rateText}</span>

    <!-- `order-last` when compact gives the axis a full row of its own; on
         desktop it keeps its place inline between transport and readout. -->
    <div class="flex min-w-40 flex-1 items-center" class:order-last={compact} class:w-full={compact}>
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
      <Popover.Trigger class="shrink-0 whitespace-nowrap rounded px-2 py-0.5 font-mono text-[12px] text-text-primary transition-colors hover:bg-surface-3 cursor-pointer">
        {vs.timeText}
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

    {#if vs.cameraMode !== CameraModeName.FREE_ORBIT}
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
