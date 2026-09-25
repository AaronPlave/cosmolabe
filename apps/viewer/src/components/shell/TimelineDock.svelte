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
    timeline, timelineSurface, ghostEt, timelineFraction, clockLines,
    eventKey, eventHoverTargets, type ProfileEventTick, type TimelineGestureOptions,
  } from '../../lib/timeline.svelte';
  import { eventEnd, eventStart } from '@cosmolabe/core';
  import { untrack } from 'svelte';
  import ProfileLanes from './ProfileLanes.svelte';
  import EventLane from './EventLane.svelte';
  import AddProfile from './AddProfile.svelte';
  import SelectedEventInspector from './SelectedEventInspector.svelte';
  import RangeControl from '../RangeControl.svelte';
  import { shell, setTimelineDepth, isToolOpen } from '../../lib/shell.svelte';
  import { formatDuration, inWindow } from '../../lib/scrubber-math';
  import { getSpice } from '../../lib/loader';
  import {
    ef, previewEvent, selectEvent, syncOccultationGeometryAtTime, configuredEventQueries, isSelectedEvent, selectedEventOf,
  } from '../../lib/event-finder.svelte';
  import { visibleTimelineEvents } from '../../lib/analysis.svelte';
  import {
    activeEventsAtTime, eventCalloutLines, eventContainsTime, eventTimelineFractions,
  } from '../../lib/event-query';
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
   * readout rail — and the transport takes two rows of it: controls, track
   * and clock; then "+ Profile", the axis caption, nothing. So the track is
   * the axis column every row below draws on, and the controls and clock
   * centre on the track rather than on the track and its caption together.
   * Collapsed keeps the one-row transport strip.
   */
  const gridded = $derived(expanded && !compact);
  /**
   * A phone, expanded: a header line — controls, clock, actions — over a
   * full-width track, the same width as the stacked rows' plots below it.
   */
  const phoneStacked = $derived(expanded && compact);

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
      selected: isSelectedEvent(event),
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
      // A phone's rows are full width, as is its expanded track.
      // A phone's rows stack a header over each plot; each plot draws its
      // own lines (`PlotCursor`) so none crosses a label or a button.
      if (compact) {
        axis = { left: 0, width: region.clientWidth, railEnd: 0 };
        lines = null;
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
  // Rendered in a page-level layer (`portal`) at viewport coordinates, so no
  // clipping ancestor — the phone's rounded dock — can cut it, and it rises
  // over the scene and the dock's own chrome alike.
  //
  // Sized to its content and measured: it is clamped to the viewport by its
  // real width, and drops below the pointed-at row when there is no room
  // above. The key facts — name, metric, time — each get a line and wrap
  // rather than ellipsize. Brief on purpose: the selected-event inspector is
  // where the full detail lives.
  let calloutSize = $state({ w: 0, h: 0 });
  const callout = $derived.by(() => {
    if (!hoveredEvent || !timeline.anchor) return null;
    const [title, ...rest] = eventCalloutLines(hoveredEvent, { utc: etToUtcString, selected: true });
    const lines = rest.flatMap((line) => line.split(' · '));
    const half = (calloutSize.w || 200) / 2;
    const x = Math.max(half + 8, Math.min(window.innerWidth - half - 8, timeline.anchor.x));
    const below = timeline.anchor.y - (calloutSize.h || 60) - 8 < 8;
    return { title, lines, x, y: below ? timeline.anchor.y + 24 : timeline.anchor.y, below, kind: hoveredEvent.kind, state: hoveredEvent.state };
  });

  /** Moves an element to the end of the page, out of every clipping ancestor. */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

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
  const selectedEvent = $derived(selectedEventOf(visibleTimelineEvents()));

  // ── Selected-event inspector ──
  //
  // Over the selected event's place on the track (pinned to the track's end
  // when it is out of the window). Not shown while the Event Finder is open
  // on that event's own search, whose selected row already shows it.
  let trackBox = $state({ left: 0, width: 0 });
  $effect(() => {
    const track = trackEl;
    if (!track) return;
    const measure = () => {
      const r = track.getBoundingClientRect();
      trackBox = { left: r.left, width: r.width };
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(track);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  });
  const inspector = $derived.by(() => {
    const event = selectedEvent;
    if (!event) return null;
    if (isToolOpen('events') && ef.configuredId === event.queryId) return null;
    const span = eventTimelineFractions(event, { start: vs.scrubMin, end: vs.scrubMax });
    const f = span ? (span.start + span.end) / 2 : timelineFraction(eventStart(event)) < 0 ? 0 : 1;
    // Desktop: above the dock and its edge handle. A phone: above the
    // floating dock (inset 8 px from the bottom).
    const bottom = shell.chromeBottom + (compact ? 16 : 20);
    return { event, x: trackBox.left + f * trackBox.width, bottom };
  });

  // ── Active events, collapsed ──
  //
  // Collapsed, the lanes that show activity are gone; a small count says
  // something is active and opens them. Never a card per active event.
  const activeCount = $derived(expanded ? 0 : activeEventsAtTime(visibleTimelineEvents(), vs.et).length);
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

  // ── Current time ──
  //
  // A desktop has room for the whole timestamp. A phone measures what the
  // transport leaves the clock and steps down a ladder that keeps the date
  // to the end (`clockLines`).
  let transportWidth = $state(0);
  let controlsWidth = $state(0);
  const TOUCH_BTN = 34;
  const clockRoom = $derived.by(() => {
    if (!compact) return Infinity;
    // Collapsed, the track keeps a usable width beside the clock; expanded,
    // the track has a line of its own and the clock shares with the actions.
    const beside = phoneStacked ? TOUCH_BTN + 84 : TOUCH_BTN + 110;
    return transportWidth - controlsWidth - beside - 12;
  });
  const clock = $derived(clockLines(vs.timeText, clockRoom));
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
      data-tl-no-axis
      class="resize-handle"
      class:manual={timeline.laneHeight != null || timeline.laneFit}
      title="Drag to resize the analysis area · double-click to fit it to its rows"
      onpointerdown={onResizeStart}
      ondblclick={() => writeLaneHeight('fit')}
    ></div>
  {/if}
  {#if !compact}
    <!-- Collapse / expand belongs to the timeline's edge, not the clock: a
         tab centred on the top edge. The rest of the edge is the resize
         grip. -->
    <button
      class="edge-tab"
      aria-pressed={expanded}
      aria-label={expanded ? 'Collapse timeline' : 'Expand timeline'}
      title={expanded ? 'Collapse timeline' : 'Expand timeline'}
      onclick={toggleDepth}
    >
      {#if expanded}<ChevronDown size={14} />{:else}<ChevronUp size={14} />{/if}
    </button>
  {/if}
  {#if callout}
    <div
      use:portal
      class="event-callout"
      class:below={callout.below}
      style="left: {callout.x}px; top: {callout.y}px"
      role="tooltip"
      bind:clientWidth={calloutSize.w}
      bind:clientHeight={calloutSize.h}
    >
      <div class="callout-title">
        <span class="callout-glyph" data-ev-kind={callout.kind} data-ev-state={callout.state}></span>
        {callout.title}
      </div>
      {#each callout.lines as line}
        <div class="callout-line">{line}</div>
      {/each}
    </div>
  {/if}
  {#if inspector}
    <SelectedEventInspector event={inspector.event} x={inspector.x} bottom={inspector.bottom} />
  {/if}
  {#if shell.shortcutsOpen}
    <div class="py-0.5 text-center text-[12px] text-text-muted">
      Space: play &middot; &larr;/&rarr;: step &middot; &uarr;/&darr;: speed &middot; R: reverse &middot; F: fly to &middot; B: bodies &middot; E: events &middot; P: pick &middot; M: camera &middot; Cmd+K: search &middot; \: zen
    </div>
  {/if}

  <!-- The transport. Collapsed, one row: play, axis, clock — the wrapped
       three-row transport it replaced cost the scene a third of a phone
       screen before a sheet was even open. Expanded on a desktop, two rows
       of the dock's grid (see `gridded`); expanded on a phone, a header line
       over a full-width track (see `phoneStacked`). -->
  <div
    class="transport"
    class:gridded
    class:phone-stacked={phoneStacked}
    bind:clientWidth={transportWidth}
  >
    <div class="transport-controls flex shrink-0 items-center gap-1.5" bind:clientWidth={controlsWidth}>
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

    <!-- The track handles its own presses (it scrubs): not the surface's. -->
    <div bind:this={transportCellEl} class="transport-axis flex min-w-24 flex-1 items-center self-stretch" data-tl-row="transport" data-tl-no-axis>
      <TimeScrubber
        fraction={currentFraction}
        onScrub={scrubTo}
        {hoverFraction}
        {hoverLabel}
        ghostLine={!gridded}
        layout={expanded ? 'stacked' : 'inline'}
        bind:trackEl
        onResetZoom={resetScrubberZoom}
        onSetZoom={setZoomDuration}
        {onViewportPan}
        {onViewportCenter}
        startLabel=""
        endLabel=""
        {isZoomed}
        {viewportStart}
        {viewportEnd}
        {globalPlayhead}
        {rangeLabel}
        trackHeight={20}
        {fitOptions}
        markers={eventMarkers}
        bands={familyCount <= MAX_BANDS ? Math.max(1, familyCount) : 1}
        dense={familyCount > MAX_BANDS}
      />
    </div>

    <div bind:this={clockEl} class="transport-rail flex shrink-0 items-center gap-0.5">
      {#if activeCount > 0 && !compact}
        <button class="active-chip" onclick={toggleDepth} title="Events active at the playhead — expand the timeline to see them">
          {activeCount} active
        </button>
      {/if}
      <Popover.Root bind:open={gotoTimeOpen} onOpenChange={onGotoOpen}>
        <Popover.Trigger
          class="current-time shrink-0 whitespace-nowrap rounded px-2 py-0.5 font-mono text-text-primary transition-colors hover:bg-surface-3 cursor-pointer {compact ? 'compact-current' : ''} {clock.length > 1 ? 'two-line' : ''}"
          aria-label="Current time {vs.timeText} — go to time"
        >
          {#each clock as line}<span class="clock-line">{line}</span>{/each}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content side="top" sideOffset={8} class="w-80 max-w-[calc(100vw-16px)] p-3">
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
        {#if expanded}<AddProfile compact />{/if}
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

    {#if gridded}
      <!-- Row two: the header's action over the label gutter, and the axis
           caption — the window's bounds and span — under the track. -->
      <div class="transport-add"><AddProfile /></div>
      <div class="axis-caption">
        <span class="date-label">{startLabel}</span>
        <RangeControl
          label={rangeLabel}
          context={rangeContext}
          variant="caption"
          {fitOptions}
          onSetZoom={setZoomDuration}
          onResetZoom={resetScrubberZoom}
        />
        <span class="date-label">{endLabel}</span>
      </div>
    {/if}
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
      <ProfileLanes axisWidth={axis.width} wide={wideLanes} ticks={profileTicks} afterLanes={eventLanes.length > 0} />
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
    z-index: var(--tl-z-chrome);
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
     border, over the resize grip. Quiet, but visible against the scene. */
  .edge-tab {
    position: absolute;
    top: -13px;
    left: 50%;
    z-index: var(--tl-z-chrome);
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 13px;
    padding: 0;
    border: 1px solid rgba(220, 224, 232, 0.12);
    border-bottom: none;
    border-radius: 5px 5px 0 0;
    background: var(--color-panel);
    color: var(--color-text-muted);
    cursor: pointer;
    transform: translateX(-50%);
    transition: color var(--duration-chrome) var(--ease-chrome), background var(--duration-chrome) var(--ease-chrome);
  }
  .edge-tab:hover {
    border-color: rgba(220, 224, 232, 0.32);
    color: var(--color-text-primary);
    background: var(--color-control-hover);
  }
  /* Collapsed, events active at the playhead: a count, not a card. */
  .active-chip {
    flex-shrink: 0;
    margin-right: 2px;
    padding: 1px 6px;
    border: 1px solid color-mix(in srgb, var(--color-event-accent) 40%, transparent);
    border-radius: 9px;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-metadata);
    white-space: nowrap;
    cursor: pointer;
  }
  .active-chip:hover {
    color: var(--color-text-primary);
    border-color: var(--color-event-accent);
  }
  /* A dragged height shows its grip faintly, as the sign it is not automatic. */
  .resize-handle.manual::after {
    opacity: 0.12;
  }

  /* Hover callout: what a previewed event is, anchored above the row it was
     pointed at. Same copy as the scene's callouts. Portalled to the page and
     fixed at viewport coordinates, above all timeline chrome. */
  .event-callout {
    position: fixed;
    z-index: var(--tl-z-callout);
    font-family: var(--font-sans);
    width: max-content;
    max-width: min(420px, calc(100vw - 16px));
    padding: 5px 8px;
    border: 1px solid var(--color-chrome-border);
    border-radius: 4px;
    background: var(--color-panel);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
    transform: translate(-50%, calc(-100% - 6px));
    pointer-events: none;
    overflow-wrap: anywhere;
  }
  .event-callout.below {
    transform: translate(-50%, 0);
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

  /* Collapsed: one row. */
  .transport {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
  }
  /* Desktop, expanded: two rows on the dock's grid. The gutter is the label
     column below; the rail sizes to the clock. Each row centres on its own
     content, so the controls and clock line up with the track itself. */
  .transport.gridded {
    display: grid;
    grid-template-columns: clamp(260px, 22vw, 320px) minmax(0, 1fr) auto;
    grid-template-areas:
      'controls track clock'
      'add caption .';
    row-gap: 1px;
    column-gap: 0;
  }
  .transport.gridded .transport-controls {
    grid-area: controls;
    min-width: 0;
    overflow: hidden;
  }
  .transport.gridded .transport-axis {
    grid-area: track;
  }
  .transport.gridded .transport-rail {
    grid-area: clock;
    padding-left: 10px;
  }
  .transport-add {
    grid-area: add;
    display: flex;
    align-items: center;
    padding-left: calc(var(--tl-label-inset) - 4px);
  }
  .axis-caption {
    grid-area: caption;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 16px;
  }
  .date-label {
    flex-shrink: 0;
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-metadata);
    white-space: nowrap;
  }
  /* A phone, expanded: a header line over a full-width track. */
  .transport.phone-stacked {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    grid-template-areas:
      'controls clock'
      'track track';
    row-gap: 2px;
    column-gap: 4px;
  }
  .transport.phone-stacked .transport-controls {
    grid-area: controls;
  }
  .transport.phone-stacked .transport-rail {
    grid-area: clock;
    justify-self: end;
  }
  .transport.phone-stacked .transport-axis {
    grid-area: track;
    padding-top: 12px; /* room for the ghost's timestamp above the track */
  }
  /* The ghost and the playhead, once, through every row. Weight and opacity
     tell them apart, not colour. */
  .axis-line {
    position: absolute;
    z-index: var(--tl-z-cursor);
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
    /* Vertical swipes scroll; horizontal ones are the surface's, gaps between
       rows included. */
    touch-action: pan-y;
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
    font-size: 12px;
  }
  :global(.current-time) {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
  }
  :global(.current-time.two-line) {
    line-height: 13px;
  }
  :global(.current-time.two-line .clock-line + .clock-line) {
    color: var(--color-text-secondary);
  }
  @media (max-width: 719px) {
    .compact-hide {
      display: none;
    }
    .transport {
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
