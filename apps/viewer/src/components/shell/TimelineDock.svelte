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
    resetScrubberZoom, setZoomDuration, etToShortDate, etToUtcString,
    setScrubberWindow, panScrubberBy,
  } from '../../lib/viewer-state.svelte';
  import {
    timeline, timelineSurface, ghostEt, timelineFraction,
    eventKey, eventHoverTargets, type ProfileEventTick, type TimelineGestureOptions,
  } from '../../lib/timeline.svelte';
  import { eventEnd, eventStart } from '@cosmolabe/core';
  import { untrack } from 'svelte';
  import ProfileLanes from './ProfileLanes.svelte';
  import EventLane from './EventLane.svelte';
  import { shell, setTimelineDepth } from '../../lib/shell.svelte';
  import { formatDuration, inWindow } from '../../lib/scrubber-math';
  import { getSpice } from '../../lib/loader';
  import {
    ef, previewEvent, selectEvent, syncOccultationGeometryAtTime, configuredEventQueries,
  } from '../../lib/event-finder.svelte';
  import { visibleTimelineEvents } from '../../lib/analysis.svelte';
  import { eventCalloutLines, eventContainsTime, eventTimelineFractions } from '../../lib/event-query';
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
  /**
   * Desktop, expanded: the dock is one grid — label gutter, time axis,
   * readout rail — and the transport lays itself out on it, so the track is
   * the axis column every row below draws on. Collapsed keeps the compact
   * transport strip; a phone overlays labels instead of a gutter.
   */
  const gridded = $derived(expanded && !compact);

  // ── Scrubber state ──

  // Unclamped: a playhead outside the zoomed window is out of view — on the
  // track, on the lanes, everywhere — rather than pinned to an edge where it
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

  // One lane per participating query. Hidden ones stay listed (dimmed, with
  // their eye toggle) so they can be shown again from here; disabled ones are
  // out of the analysis entirely and have nothing to draw.
  let eventLanes = $derived(configuredEventQueries().filter((item) => item.enabled));

  // ── Transport overview ──
  //
  // The track is an overview, not a lossless stack: each event family (query)
  // gets a sub-band a few px tall, so overlapping results from different
  // queries do not share pixels; within a family, overlaps merge visually.
  // Exact distinctions are the lanes'. Past three families, bands get too
  // thin to read and the overview becomes a density instead.
  const MAX_BANDS = 3;
  let eventMarkers = $derived.by(() => {
    const range = { start: vs.scrubMin, end: vs.scrubMax };
    const drawn = visibleTimelineEvents().flatMap((event) => {
      // Events outside the window are dropped rather than clamped to an edge,
      // where they would read as happening at a time they do not.
      const span = eventTimelineFractions(event, range);
      return span ? [{ event, span }] : [];
    });
    const families = eventLanes.map((q) => q.id).filter((id) => drawn.some((d) => d.event.queryId === id));
    return drawn.map(({ event, span }) => ({
      id: eventKey(event),
      queryId: event.queryId,
      fraction: span.start,
      endFraction: span.end,
      selected: ef.selectedId === event.id && ef.configuredId === event.queryId,
      preview: ef.previewId === event.id && ef.previewQueryId === event.queryId,
      active: eventContainsTime(event, vs.et),
      title: event.label,
      kind: event.kind,
      state: event.state,
      participants: event.bodies,
      previewed: timeline.previewEventId === eventKey(event),
      band: families.length <= MAX_BANDS ? families.indexOf(event.queryId) : undefined,
      bands: families.length,
      onSelect: () => selectEvent(event),
      // Keyboard focus previews; pointer hover is the surface's.
      onPreview: () => previewEvent(event),
      onPreviewEnd: () => previewEvent(null),
    }));
  });
  const familyCount = $derived(eventMarkers[0]?.bands ?? 0);

  // The same results, as the profile rows draw them: with their kind and
  // state, so the spans behind a trace speak the lanes' vocabulary.
  let profileTicks = $derived(
    eventMarkers.map((m): ProfileEventTick => ({
      id: m.id,
      fraction: m.fraction,
      endFraction: m.endFraction,
      selected: m.selected,
      previewed: m.previewed || m.preview,
      active: m.active,
      kind: m.kind,
      state: m.state,
      participants: m.participants,
    })),
  );

  // What a hover snaps to and previews, by row: a lane its own results,
  // anything else — the track, a profile — every visible result.
  const allTargets = $derived(eventHoverTargets(eventMarkers));
  const laneTargets = $derived.by(() => {
    const byQuery = new Map<string, typeof eventMarkers>();
    for (const m of eventMarkers) byQuery.set(m.queryId, [...(byQuery.get(m.queryId) ?? []), m]);
    return new Map([...byQuery].map(([id, ms]) => [id, eventHoverTargets(ms)]));
  });
  const NO_TARGETS: TimelineGestureOptions = { snapTargets: [] };
  function targetsFor(row: string | null): TimelineGestureOptions {
    if (row?.startsWith('lane:')) return laneTargets.get(row.slice(5)) ?? NO_TARGETS;
    return allTargets;
  }

  // ── Shared axis ──
  //
  // Every row aligns to the transport track, measured rather than assumed:
  // its extent moves with the layout. The lane region exposes it to its rows
  // as grid columns (`--tl-gutter`, `--tl-axis`, `--tl-rail-end`); the dock
  // uses it for the lines drawn through every row and for the interaction
  // surface's bounds.
  let rootEl: HTMLDivElement | undefined = $state();
  let trackEl: HTMLDivElement | undefined = $state();
  let transportCellEl: HTMLDivElement | undefined = $state();
  let regionEl: HTMLDivElement | undefined = $state();
  let clockEl: HTMLDivElement | undefined = $state();
  let axis = $state({ left: 0, width: 0, railEnd: 0 });
  /** Geometry of the through-lines, relative to the dock. */
  let lines = $state<{ left: number; width: number; top: number; lanesTop: number; bottom: number } | null>(null);

  $effect(() => {
    const root = rootEl;
    const track = trackEl;
    const region = regionEl;
    if (!root || !track || !region) {
      lines = null;
      return;
    }
    const measure = () => {
      const o = root.getBoundingClientRect();
      const r = region.getBoundingClientRect();
      const t = track.getBoundingClientRect();
      const cell = transportCellEl?.getBoundingClientRect() ?? t;
      // A phone leaves the track a sliver once the secondary transport is
      // back; there the rows draw the same window across the dock's full
      // width instead, with their labels overlaid.
      if (compact) {
        axis = { left: 0, width: region.clientWidth, railEnd: 0 };
        lines = { left: r.left - o.left, width: region.clientWidth, top: r.top - o.top, lanesTop: r.top - o.top, bottom: r.bottom - o.top };
        return;
      }
      // The rail's values right-align under the clock.
      // (The clock button's text ends 8 px inside its padding.)
      const clockRight = clockEl ? clockEl.getBoundingClientRect().right - 8 : r.right;
      axis = { left: t.left - r.left, width: t.width, railEnd: Math.max(0, r.left + region.clientWidth - clockRight) };
      lines = { left: t.left - o.left, width: t.width, top: cell.top - o.top, lanesTop: r.top - o.top, bottom: r.bottom - o.top };
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    ro.observe(track);
    ro.observe(region);
    return () => ro.disconnect();
  });

  const wideLanes = $derived(gridded);

  /**
   * Where the surface's shared axis is live for a pointer. Desktop: one axis,
   * the track's extent, from the transport down through the lanes. A phone's
   * lanes span the full width while its track does not, so there the axis is
   * whichever of the two the pointer is over.
   */
  function surfaceBounds(e: { clientY: number }) {
    if (!trackEl) return null;
    const t = trackEl.getBoundingClientRect();
    const cell = transportCellEl?.getBoundingClientRect() ?? t;
    const r = expanded ? regionEl?.getBoundingClientRect() : undefined;
    if (compact && r && regionEl && e.clientY >= r.top) {
      return { left: r.left, width: regionEl.clientWidth, top: r.top, bottom: r.bottom };
    }
    return { left: t.left, width: t.width, top: cell.top, bottom: compact || !r ? cell.bottom : r.bottom };
  }

  // ── Hover callout ──
  //
  // What a previewed event *is*, anchored where it was pointed at. The copy
  // is the scene callouts' (`eventCalloutLines`), so the timeline and the 3D
  // view name events in one language.
  const hoveredEvent = $derived(
    timeline.previewEventId == null
      ? undefined
      : visibleTimelineEvents().find((event) => eventKey(event) === timeline.previewEventId),
  );
  const callout = $derived.by(() => {
    if (!hoveredEvent || !timeline.anchor || !rootEl) return null;
    const root = rootEl.getBoundingClientRect();
    const lines = eventCalloutLines(hoveredEvent, { utc: etToUtcString, selected: true });
    // Kept inside the dock horizontally; it may rise above it into the scene.
    const half = 110;
    const x = Math.max(half, Math.min(root.width - half, timeline.anchor.x - root.left));
    return { lines, x, y: timeline.anchor.y - root.top, kind: hoveredEvent.kind, state: hoveredEvent.state };
  });

  // Hover = preview across linked surfaces: an event hovered on any timeline
  // row is previewed in the scene through the Event Finder's own
  // `previewEvent`. Only changes are pushed, and leaving clears only the
  // preview this set, so a preview from the Event Finder's list is not
  // cleared by an unrelated timeline hover.
  let drivenPreview: string | null = null;
  $effect(() => {
    const event = hoveredEvent;
    const key = event ? eventKey(event) : null;
    untrack(() => {
      if (key === drivenPreview) return;
      if (event) {
        previewEvent(event);
      } else if (
        drivenPreview != null && ef.previewId != null
        && eventKey({ id: ef.previewId, queryId: ef.previewQueryId ?? '' }) === drivenPreview
      ) {
        previewEvent(null);
      }
      drivenPreview = key;
    });
  });

  // And the other way: an event previewed elsewhere — the Event Finder's
  // list, the scene — puts the ghost on it, so every profile reads out at
  // that event while it is previewed.
  $effect(() => {
    const id = ef.previewId;
    const queryId = ef.previewQueryId;
    const fromTimeline = timeline.previewEventId;
    let linked: number | null = null;
    if (id != null && (fromTimeline == null || fromTimeline !== eventKey({ id, queryId: queryId ?? '' }))) {
      const event = visibleTimelineEvents().find((e) => e.id === id && e.queryId === queryId);
      if (event) linked = eventStart(event);
    }
    if (timeline.linkedEt !== linked) timeline.linkedEt = linked;
  });

  const ghost = $derived(ghostEt());
  const hoverFraction = $derived(ghost == null || !(currentRange > 0) ? null : timelineFraction(ghost));
  // The callout carries the time when an event is previewed; the bare
  // timestamp would only collide with it.
  const hoverLabel = $derived(
    ghost == null || callout ? '' : etToUtcString(ghost).replace(' UTC', ''),
  );

  // ── Framing presets ──
  //
  // Behind the range control rather than as a row of buttons. "Fit mission"
  // is the existing reset to the full range.
  function fitSpan(start: number, end: number) {
    const span = end - start;
    const pad = span > 0 ? span * 0.08 : Math.min(currentRange, 6 * 3600) / 2;
    setScrubberWindow(start - pad, end + pad);
  }
  const selectedEvent = $derived(
    ef.selectedId == null
      ? undefined
      : visibleTimelineEvents().find((event) => event.id === ef.selectedId && event.queryId === ef.configuredId),
  );
  const fitOptions = $derived.by(() => {
    const events = visibleTimelineEvents();
    const options: { label: string; onSelect: () => void }[] = [];
    const selected = selectedEvent;
    if (selected) {
      options.push({ label: 'Fit selected', onSelect: () => fitSpan(eventStart(selected), eventEnd(selected)) });
    }
    if (events.length > 0) {
      options.push({
        label: 'Fit results',
        onSelect: () => fitSpan(Math.min(...events.map(eventStart)), Math.max(...events.map(eventEnd))),
      });
    }
    return options;
  });

  // Minimap navigation: drag the viewport to pan, press elsewhere to go there.
  function onViewportPan(deltaFraction: number) {
    panScrubberBy(deltaFraction * baseRange);
  }
  function onViewportCenter(fraction: number) {
    const center = vs.scrubBaseMin + fraction * baseRange;
    setScrubberWindow(center - currentRange / 2, center + currentRange / 2);
  }

  // ── Analysis region height ──
  //
  // Three states, remembered for the session per layout:
  // - automatic (default): the region fits its rows and stops growing at
  //   about a third of the viewport (`.lane-region`'s max-height), then
  //   scrolls;
  // - fit (double-click the top edge): sized to its content, clamped only by
  //   the hard scene-preserving cap, so it scrolls only if the rows genuinely
  //   exceed that — and it keeps fitting as rows come and go, since the
  //   region is content-sized rather than given a measured height;
  // - manual: dragged to a height.
  const MIN_LANE_HEIGHT = 44;
  const heightKey = () => `cosmolabe.timeline.laneHeight.${shell.layout}`;
  function readLaneHeight(): { height: number | null; fit: boolean } {
    try {
      const raw = sessionStorage.getItem(heightKey());
      if (raw === 'fit') return { height: null, fit: true };
      const v = Number(raw);
      return { height: v > 0 ? v : null, fit: false };
    } catch {
      return { height: null, fit: false };
    }
  }
  function writeLaneHeight(v: number | 'fit' | null) {
    timeline.laneHeight = typeof v === 'number' ? v : null;
    timeline.laneFit = v === 'fit';
    try {
      if (v == null) sessionStorage.removeItem(heightKey());
      else sessionStorage.setItem(heightKey(), String(v));
    } catch {
      // Storage unavailable: the height still holds for this page.
    }
  }
  $effect(() => {
    void shell.layout;
    untrack(() => {
      const stored = readLaneHeight();
      timeline.laneHeight = stored.height;
      timeline.laneFit = stored.fit;
    });
  });
  const regionSize = $derived(
    timeline.laneHeight != null
      ? ` height: ${timeline.laneHeight}px; max-height: none;`
      : timeline.laneFit ? ' max-height: 58vh;' : '',
  );
  function maxLaneHeight() {
    return Math.round(window.innerHeight * 0.58);
  }
  function onResizeStart(e: PointerEvent) {
    if (e.button !== 0 || !regionEl) return;
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startHeight = regionEl.clientHeight;
    const move = (ev: PointerEvent) => {
      const h = startHeight + (startY - ev.clientY);
      timeline.laneHeight = Math.round(Math.max(MIN_LANE_HEIGHT, Math.min(maxLaneHeight(), h)));
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      writeLaneHeight(timeline.laneHeight);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // The range control names what it is framing: the full mission and its
  // span, or the zoomed span. Never a bare icon.
  const spanText = (seconds: number) => formatDuration(seconds).replace('~', '').replace(/([\d.])([a-z])/, '$1 $2');
  let rangeLabel = $derived(isZoomed ? spanText(currentRange) : spanText(baseRange));
  let rangeContext = $derived(isZoomed ? '' : 'Full mission');
  // The bounds are dropped at a phone width, where they left the track about
  // forty pixels to draw a two-year mission in. The clock and the zoom readout
  // still say where in time the playhead is; a squeezed axis says nothing.
  // Collapsed, the strip is a dense overview and the axis takes the width:
  // the bounds live in the expanded axis caption instead.
  let startLabel = $derived(!gridded ? '' : isZoomed ? etToShortDate(vs.scrubMin) : etToShortDate(vs.scrubBaseMin));
  let endLabel = $derived(!gridded ? '' : isZoomed ? etToShortDate(vs.scrubMax) : etToShortDate(vs.scrubBaseMax));

  function toggleDepth() {
    setTimelineDepth(expanded ? 'transport' : 'expanded');
  }

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
  bind:this={rootEl}
  data-scene-occluder
  bind:clientHeight={height}
  use:timelineSurface={{ bounds: surfaceBounds, targets: targetsFor }}
  class="timeline flex flex-col gap-0.5"
  class:pointer-events-auto={!inline}
  class:absolute={!inline}
  class:z-20={!inline}
  class:desktop-timeline={!inline}
  class:relative={inline}
  class:px-3={expanded}
  class:py-1.5={expanded}
  class:px-2={!expanded}
  class:py-1={!expanded}
>
  {#if expanded}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="resize-handle"
      class:manual={timeline.laneHeight != null || timeline.laneFit}
      title="Drag to resize the analysis area · double-click to fit it to its rows"
      onpointerdown={onResizeStart}
      ondblclick={() => writeLaneHeight('fit')}
    ></div>
  {/if}
  {#if !compact}
    <!-- Collapse / expand belongs to the timeline's edge, not the clock: a
         small tab centred on the top edge. The rest of the edge is the
         resize grip. -->
    <button
      class="edge-tab"
      aria-pressed={expanded}
      aria-label={expanded ? 'Collapse timeline' : 'Expand timeline'}
      title={expanded ? 'Collapse timeline' : 'Expand timeline'}
      onclick={toggleDepth}
    >
      {#if expanded}<ChevronDown size={12} />{:else}<ChevronUp size={12} />{/if}
    </button>
  {/if}
  {#if callout}
    <div class="event-callout" style="left: {callout.x}px; top: {callout.y}px" role="tooltip">
      <div class="callout-title">
        <span class="callout-glyph" data-ev-kind={callout.kind} data-ev-state={callout.state}></span>
        {callout.lines[0]}
      </div>
      {#each callout.lines.slice(1) as line}
        <div class="callout-line">{line}</div>
      {/each}
    </div>
  {/if}
  {#if shell.shortcutsOpen}
    <div class="py-0.5 text-center text-[12px] text-text-muted">
      Space: play &middot; &larr;/&rarr;: step &middot; &uarr;/&darr;: speed &middot; R: reverse &middot; F: fly to &middot; B: bodies &middot; E: events &middot; P: pick &middot; M: camera &middot; Cmd+K: search &middot; \: zen
    </div>
  {/if}

  <!-- Compact keeps this to one row — play, axis, clock — and puts the rest
       behind the expand toggle. The wrapped three-row transport it replaced
       cost the scene a third of a phone screen before a sheet was even open,
       which is backwards for a shell whose premise is scene-first.
       Expanded on a desktop, the same three parts take the grid's three
       columns: controls over the label gutter, the track as the axis column,
       the clock heading the readout rail. -->
  <div class="transport-row flex w-full items-center gap-1.5" class:gridded>
    <div class="transport-controls flex shrink-0 items-center gap-1.5">
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
    </div>

    <div bind:this={transportCellEl} class="transport-axis flex min-w-24 flex-1 items-center self-stretch" data-tl-row="transport">
      <TimeScrubber
        fraction={currentFraction}
        onScrub={scrubTo}
        {hoverFraction}
        {hoverLabel}
        ghostLine={!gridded}
        layout={gridded ? 'stacked' : 'inline'}
        bind:trackEl
        onResetZoom={resetScrubberZoom}
        onSetZoom={setZoomDuration}
        {onViewportPan}
        {onViewportCenter}
        {startLabel}
        {endLabel}
        {isZoomed}
        {viewportStart}
        {viewportEnd}
        {globalPlayhead}
        {rangeLabel}
        {rangeContext}
        trackHeight={gridded ? 12 : 15}
        {fitOptions}
        markers={eventMarkers}
        bands={familyCount <= MAX_BANDS ? Math.max(1, familyCount) : 1}
        dense={familyCount > MAX_BANDS}
      />
    </div>

    <div bind:this={clockEl} class="transport-rail flex shrink-0 items-center gap-0.5">
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

      {#if compact}
        <!-- A phone keeps a full-size button: the edge tab is too small a
             touch target, and the shared dock owns the edge above it. -->
        <button
          class="tl-btn"
          aria-pressed={expanded}
          aria-label={expanded ? 'Collapse timeline' : 'Expand timeline'}
          title={expanded ? 'Collapse timeline' : 'Expand timeline'}
          onclick={toggleDepth}
        >
          {#if expanded}<ChevronDown size={14} />{:else}<ChevronUp size={14} />{/if}
        </button>
      {/if}
    </div>
  </div>

  {#if expanded}
    <!-- The shared-axis region: event lanes, then continuous profiles, all
         drawn on the track's extent and window. Fits its rows, up to a third
         or so of the viewport, then scrolls. -->
    <div
      bind:this={regionEl}
      class="lane-region"
      style="--tl-gutter: {axis.left}px; --tl-axis: {axis.width}px; --tl-rail-end: {axis.railEnd}px;{regionSize}"
    >
      {#each eventLanes as item (item.id)}
        <EventLane {item} wide={wideLanes} />
      {/each}
      <ProfileLanes axisWidth={axis.width} wide={wideLanes} ticks={profileTicks} />
    </div>

    <!-- One ghost line and one playhead through every row, so they cannot
         drift or blink between rows. Out of the window, they are not drawn. -->
    {#if lines}
      {#if hoverFraction != null && inWindow(hoverFraction)}
        <div
          class="axis-line ghost"
          style="left: {lines.left + hoverFraction * lines.width}px; top: {lines.top}px; height: {lines.bottom - lines.top}px"
        ></div>
      {/if}
      {#if inWindow(currentFraction)}
        <div
          class="axis-line playhead"
          style="left: {lines.left + currentFraction * lines.width}px; top: {lines.lanesTop}px; height: {lines.bottom - lines.lanesTop}px"
        ></div>
      {/if}
    {/if}
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
  /* The top edge, while the analysis region is open. A few px of grab target
     over the dock's border, visible only as a faint bar on hover. */
  .resize-handle {
    position: absolute;
    top: -4px;
    right: 0;
    left: 0;
    height: 8px;
    cursor: ns-resize;
    touch-action: none;
    z-index: 2;
  }
  .resize-handle::after {
    content: '';
    position: absolute;
    top: 3px;
    right: 0;
    left: 0;
    height: 2px;
    border-radius: 1px;
    background: var(--color-text-muted);
    opacity: 0;
    transition: opacity var(--duration-chrome) var(--ease-chrome);
  }
  .resize-handle:hover::after {
    opacity: 0.35;
  }
  /* The collapse tab: a notch on the dock's top edge, panel-coloured with a
     faint border, over the resize grip. */
  .edge-tab {
    position: absolute;
    top: -11px;
    left: 50%;
    z-index: 3;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 12px;
    padding: 0;
    border: 1px solid var(--color-chrome-border);
    border-bottom: none;
    border-radius: 5px 5px 0 0;
    background: var(--color-panel);
    color: var(--color-text-muted);
    cursor: pointer;
    transform: translateX(-50%);
    transition: color var(--duration-chrome) var(--ease-chrome), background var(--duration-chrome) var(--ease-chrome);
  }
  .edge-tab:hover {
    color: var(--color-text-primary);
    background: var(--color-control-hover);
  }
  /* A dragged height shows its grip faintly, as the sign it is not automatic. */
  .resize-handle.manual::after {
    opacity: 0.12;
  }

  /* Hover callout: what a previewed event is, anchored above the row it was
     pointed at. Same copy as the scene's callouts. */
  .event-callout {
    position: absolute;
    z-index: 3;
    max-width: 240px;
    padding: 5px 8px;
    border: 1px solid var(--color-chrome-border);
    border-radius: 4px;
    background: var(--color-panel);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
    transform: translate(-50%, calc(-100% - 6px));
    pointer-events: none;
    white-space: nowrap;
  }
  .callout-title {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--color-text-primary);
    font-size: var(--text-section);
    font-weight: 560;
  }
  .callout-line {
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--color-text-secondary);
    font-family: var(--font-mono);
    font-size: var(--text-metadata);
    font-variant-numeric: tabular-nums;
  }
  .callout-glyph {
    flex-shrink: 0;
    width: 7px;
    height: 7px;
    border-radius: 1px;
    background: var(--ev);
  }

  /* Desktop, expanded: the transport on the grid. The gutter is the label
     column below it; the rail sizes to the clock. */
  .transport-row.gridded {
    display: grid;
    grid-template-columns: clamp(260px, 22vw, 320px) minmax(0, 1fr) auto;
    gap: 0;
  }
  .transport-row.gridded .transport-controls {
    min-width: 0;
    overflow: hidden;
  }
  .transport-row.gridded .transport-rail {
    padding-left: 10px;
  }
  /* The ghost and the playhead, once, through every row. Weight and opacity
     tell them apart, not colour. */
  .axis-line {
    position: absolute;
    z-index: 2;
    transform: translateX(-50%);
    pointer-events: none;
  }
  .axis-line.ghost {
    width: 1px;
    background: var(--color-text-secondary);
    opacity: 0.6;
  }
  .axis-line.playhead {
    width: 2px;
    background: var(--color-text-primary);
    opacity: 0.85;
  }

  .lane-region {
    position: relative;
    max-height: 38vh;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  :global(.current-time) {
    font-size: var(--text-readout-strong);
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
