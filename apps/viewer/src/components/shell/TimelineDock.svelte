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
   * minimal transport strip by default — which already carries the configured
   * event results as marks on the track — and an expanded region below the
   * axis: one lane per configured event query, then the continuous geometry
   * profiles (#65). Every row is laid over
   * the track's own horizontal extent and reads the same window, playhead and
   * ghost playhead, so the whole dock is one instrument rather than a
   * transport with charts attached. Collapsing returns the region's height to
   * the scene; the profiles stay configured.
   */
  import {
    vs, togglePlay, reverse, faster, slower,
    stepForward, stepBackward, scrubTo, setTime,
    zoomScrubber, resetScrubberZoom, setZoomDuration, etToShortDate, etToUtcString,
  } from '../../lib/viewer-state.svelte';
  import { timeline, setTimelineHover, timelineEt, timelineFraction, type ProfileEventTick } from '../../lib/timeline.svelte';
  import ProfileLanes from './ProfileLanes.svelte';
  import EventLane from './EventLane.svelte';
  import { shell, setTimelineDepth } from '../../lib/shell.svelte';
  import { formatDuration, snapFraction } from '../../lib/scrubber-math';
  import { getSpice } from '../../lib/loader';
  import { ef, selectEvent, syncOccultationGeometryAtTime, configuredEventQueries } from '../../lib/event-finder.svelte';
  import { visibleTimelineEvents } from '../../lib/analysis.svelte';
  import { eventContainsTime, eventTimelineFractions } from '../../lib/event-query';
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

  // Unclamped: a playhead outside the zoomed window is out of view, on the
  // track exactly as on the lanes, rather than pinned to an edge where it
  // would name a time it is not at.
  let currentFraction = $derived(timelineFraction(vs.et));

  let baseRange = $derived(vs.scrubBaseMax - vs.scrubBaseMin);
  let currentRange = $derived(vs.scrubMax - vs.scrubMin);
  let isZoomed = $derived(baseRange > 0 && currentRange < baseRange * 0.99);

  let viewportStart = $derived(baseRange > 0 ? (vs.scrubMin - vs.scrubBaseMin) / baseRange : 0);
  let viewportEnd = $derived(baseRange > 0 ? (vs.scrubMax - vs.scrubBaseMin) / baseRange : 1);
  let globalPlayhead = $derived(baseRange > 0 ? (vs.et - vs.scrubBaseMin) / baseRange : 0.5);

  // A clicked result is navigation/detail state. The 3D explanatory overlay
  // follows whichever enabled occultation the shared playhead is actually in,
  // so scrubbing and playback reveal cached events without extra clicks.
  $effect(() => {
    syncOccultationGeometryAtTime();
  });

  // Event finder results as scrubber ticks, on the zoomed range the track
  // actually draws. Events outside it are dropped rather than clamped to an
  // edge, where they would read as happening at a time they do not.
  let eventMarkers = $derived(
    visibleTimelineEvents()
      .map((event) => {
        const span = eventTimelineFractions(event, { start: vs.scrubMin, end: vs.scrubMax });
        if (!span) return null;
        return {
          id: event.id,
          fraction: span.start,
          endFraction: span.end,
          selected: ef.selectedId === event.id,
          active: eventContainsTime(event, vs.et),
          title: event.label,
          kind: event.kind,
          state: event.state,
          previewed: timeline.previewEventId === event.id,
          onSelect: () => selectEvent(event),
        };
      })
      .filter((marker) => marker != null),
  );

  // One lane per participating query. Hidden ones stay listed (dimmed, with
  // their eye toggle) so they can be shown again from here; disabled ones are
  // out of the analysis entirely and have nothing to draw.
  let eventLanes = $derived(configuredEventQueries().filter((item) => item.enabled));

  // The same results, as the profile rows draw them.
  let profileTicks = $derived(
    eventMarkers.map((m): ProfileEventTick => ({
      id: m.id, fraction: m.fraction, endFraction: m.endFraction, selected: m.selected, active: m.active,
    })),
  );

  // ── Shared axis ──
  //
  // Profile rows align to the transport track, wherever the transport's
  // buttons and clock leave it. Measured, not assumed: the track's extent
  // moves with the layout, the rate readout and the compact toggle.
  let trackEl: HTMLDivElement | undefined = $state();
  let regionEl: HTMLDivElement | undefined = $state();
  let axis = $state({ left: 0, width: 0 });

  $effect(() => {
    const track = trackEl;
    const region = regionEl;
    if (!track || !region) return;
    const measure = () => {
      const r = region.getBoundingClientRect();
      // A phone leaves the track a sliver once the secondary transport is
      // back; there the rows draw the same window across the dock's full
      // width instead, with their labels overlaid.
      if (compact) {
        axis = { left: 0, width: region.clientWidth };
        return;
      }
      const t = track.getBoundingClientRect();
      axis = { left: t.left - r.left, width: t.width };
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(track);
    ro.observe(region);
    return () => ro.disconnect();
  });

  // Labels in a gutter left of the axis need room; a phone overlays them.
  const wideLanes = $derived(!compact && axis.left >= 120);

  // A hover on the track snaps to its marks like one on a lane, so pointing at
  // an event on the collapsed strip cross-highlights it too.
  function onTrackHover(fraction: number | null) {
    if (fraction == null) {
      setTimelineHover(null);
      return;
    }
    const targets = eventMarkers.flatMap((m) => m.endFraction > m.fraction
      ? [{ fraction: m.fraction, id: m.id }, { fraction: m.endFraction, id: m.id }]
      : [{ fraction: m.fraction, id: m.id }]);
    const snap = snapFraction(fraction, targets, trackEl?.clientWidth ?? 0);
    setTimelineHover(timelineEt(snap?.fraction ?? fraction), snap?.id ?? null);
  }

  const hoverFraction = $derived(
    timeline.hoverEt == null || !(currentRange > 0) ? null : (timeline.hoverEt - vs.scrubMin) / currentRange,
  );
  const hoverLabel = $derived(
    timeline.hoverEt == null ? '' : etToUtcString(timeline.hoverEt).replace(' UTC', ''),
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

<!-- Desktop: its own dock along the full bottom edge. Compact:
     rendered bare inside the shared bottom dock, so the phone gets one bar of
     chrome rather than two stacked boxes. -->
<div
  bind:clientHeight={height}
  class="timeline flex flex-col gap-0.5"
  class:pointer-events-auto={!inline}
  class:absolute={!inline}
  class:z-20={!inline}
  class:desktop-timeline={!inline}
  class:px-3={true}
  class:py-1.5={true}
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
  <div class="transport-row flex w-full items-center gap-1.5">
    <div class="flex shrink-0 gap-px">
      {#if !secondaryHidden}
        <button class="tl-btn compact-hide" onclick={slower} title="Slower (Down)" aria-label="Slower"><ChevronsLeft size={14} /></button>
        <button class="tl-btn" onclick={stepBackward} title="Step back (Left)" aria-label="Step back"><ChevronLeft size={14} /></button>
        <button class="tl-btn" onclick={reverse} title="Reverse (R)" aria-label="Reverse"><Rewind fill="currentColor" size={13} /></button>
      {/if}
      <button class="tl-btn play-btn mx-0.5 border px-2" onclick={togglePlay} title="Play/Pause (Space)" aria-label={vs.playing ? 'Pause' : 'Play'} aria-pressed={vs.playing}>
        {#if vs.playing}<Pause fill="currentColor" size={14} />{:else}<Play fill="currentColor" size={14} />{/if}
      </button>
      {#if !secondaryHidden}
        <button class="tl-btn" onclick={stepForward} title="Step forward (Right)" aria-label="Step forward"><ChevronRight size={14} /></button>
        <button class="tl-btn compact-hide" onclick={faster} title="Faster (Up)" aria-label="Faster"><ChevronsRight size={14} /></button>
      {/if}
    </div>

    {#if !secondaryHidden}
      <span class="ui-readout compact-hide min-w-16 shrink-0 text-center text-text-secondary">{vs.rateText}</span>
    {/if}

    <div class="flex min-w-24 flex-1 items-center">
      <TimeScrubber
        fraction={currentFraction}
        onScrub={scrubTo}
        onZoom={(zoomIn, anchor) => zoomScrubber(zoomIn, timelineEt(anchor))}
        onHover={onTrackHover}
        {hoverFraction}
        {hoverLabel}
        bind:trackEl
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
      <Popover.Trigger class="current-time shrink-0 whitespace-nowrap rounded px-2 py-0.5 font-mono text-text-primary transition-colors hover:bg-surface-3 cursor-pointer {compact ? 'compact-current' : ''}">
        {compact ? vs.timeText.replace(' UTC', '').slice(11) : vs.timeText}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" sideOffset={8} class="w-80 p-3">
          <div class="flex flex-col gap-2">
            <span class="ui-label">Go to time</span>
            <div class="flex gap-1.5">
              <Input
                bind:value={gotoTimeValue}
                class="font-mono text-[13px] h-8 {gotoTimeError ? 'border-error' : ''}"
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
    <!-- The shared-axis region: event lanes, then continuous profiles, all
         drawn against the track's extent, window and playhead. Scrolls past a
         few rows so a long list cannot take the scene's height. -->
    <div bind:this={regionEl} class="lane-region">
      {#each eventLanes as item (item.id)}
        <EventLane {item} axisLeft={axis.left} axisWidth={axis.width} wide={wideLanes} />
      {/each}
      <ProfileLanes axisLeft={axis.left} axisWidth={axis.width} wide={wideLanes} ticks={profileTicks} />
    </div>
  {/if}
</div>

<style>
  .timeline {
    font-family: var(--font-sans);
  }
  .desktop-timeline {
    right: 0;
    bottom: 0;
    left: 0;
    border-top: 1px solid var(--color-chrome-border);
    background: var(--color-panel);
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.015);
    backdrop-filter: blur(8px);
  }
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
    transition:
      color var(--duration-chrome) var(--ease-chrome),
      background var(--duration-chrome) var(--ease-chrome),
      transform var(--duration-chrome) var(--ease-chrome);
  }
  .tl-btn:hover {
    color: var(--color-text-primary);
    background: var(--color-control-hover);
  }
  .tl-btn:active {
    transform: translateY(1px);
  }
  .tl-btn[aria-pressed='true'] {
    color: var(--color-chrome-active);
    background: var(--color-chrome-active-bg);
  }
  .play-btn {
    border-color: var(--color-chrome-border);
    background: rgba(255, 255, 255, 0.055);
    color: var(--color-text-primary);
  }
  .play-btn[aria-pressed='true'] {
    border-color: rgba(220, 224, 232, 0.2);
    background: var(--color-chrome-active-bg);
    color: var(--color-chrome-active);
  }
  .lane-region {
    position: relative;
    max-height: min(36vh, 260px);
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  :global(.current-time) {
    font-size: var(--text-readout-strong);
    font-weight: 560;
    font-variant-numeric: tabular-nums slashed-zero;
  }
  :global(.current-time.compact-current) {
    font-size: var(--text-metadata);
  }
  @media (max-width: 719px) {
    .compact-hide {
      display: none;
    }
    .transport-row {
      min-height: 38px;
    }
    .tl-btn {
      min-width: 34px;
      min-height: 34px;
      justify-content: center;
    }
    .lane-region {
      max-height: 30vh;
    }
  }
</style>
