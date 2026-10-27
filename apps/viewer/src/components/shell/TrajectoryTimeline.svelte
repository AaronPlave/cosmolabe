<script lang="ts">
  import type { TrajectoryInterval } from '../../lib/trajectory-timeline';
  import { adjacentTrajectoryInterval, trajectoryIntervalWindow } from '../../lib/trajectory-timeline';
  import { vs, setTime, setPlaying, setScrubberWindow, etToShortDate } from '../../lib/viewer-state.svelte';
  import { ChevronLeft, ChevronRight } from 'lucide-svelte';

  let { items, expanded, wide, axis }: {
    items: TrajectoryInterval[];
    expanded: boolean;
    wide: boolean;
    axis: { left: number; width: number; railEnd: number };
  } = $props();
  const active = $derived(items.find(item => vs.et >= item.start && vs.et <= item.end));
  const previous = $derived(adjacentTrajectoryInterval(items, vs.et, -1));
  const next = $derived(adjacentTrajectoryInterval(items, vs.et, 1));
  const marks = $derived(items.filter(item => item.end >= vs.scrubMin && item.start <= vs.scrubMax));
  function seek(item: TrajectoryInterval | undefined) {
    if (!item) return;
    setPlaying(false);
    setTime(item.start);
    setScrubberWindow(...trajectoryIntervalWindow(item));
  }
  const fraction = (et: number) => (et - vs.scrubMin) / (vs.scrubMax - vs.scrubMin) * 100;
</script>

{#if items.length}
  <div class="trajectory-navigation" data-tl-no-axis>
    <span class="text-text-secondary">{items[0].body}</span>
    <button class="tl-icon-btn" aria-label="Previous flight" disabled={!previous} onclick={() => seek(previous)}><ChevronLeft size={14} /></button>
    <select aria-label="Choose flight" value={active?.id ?? ''} onchange={event => seek(items.find(item => item.id === event.currentTarget.value))}>
      <option value="" disabled>Choose flight · {items.length}</option>
      {#each items as item (item.id)}
        <option value={item.id}>{item.label} · {etToShortDate(item.start)} · {(item.end - item.start).toFixed(1)} s</option>
      {/each}
    </select>
    <button class="tl-icon-btn" aria-label="Next flight" disabled={!next} onclick={() => seek(next)}><ChevronRight size={14} /></button>
    <span class="text-text-secondary">{active ? `${(active.end - active.start).toFixed(1)} s` : 'Between flights'}</span>
  </div>
  {#if expanded}
    <div class="trajectory-lane" class:wide style={wide ? `grid-template-columns: ${axis.left}px ${axis.width}px minmax(0, 1fr)` : ''} data-tl-no-axis>
      {#if wide}<span class="text-text-secondary">Flights</span>{/if}
      <div class="flight-axis" aria-label="Flight intervals">
        {#each marks as item (item.id)}
          <button
            class="flight-mark"
            class:active={item.id === active?.id}
            style={`left: ${Math.max(0, fraction(item.start))}%; width: max(3px, ${Math.min(100, fraction(item.end)) - Math.max(0, fraction(item.start))}%)`}
            aria-label={`Go to ${item.label}`}
            title={`${item.body} ${item.label} · ${(item.end - item.start).toFixed(1)} s`}
            onclick={() => seek(item)}
          ><span>{item.label}</span></button>
        {/each}
        {#if vs.et >= vs.scrubMin && vs.et <= vs.scrubMax}<span class="flight-playhead" style={`left: ${fraction(vs.et)}%`}></span>{/if}
      </div>
    </div>
  {/if}
{/if}

<style>
  .trajectory-navigation { display: flex; align-items: center; gap: 4px; padding: 2px 8px; min-width: 0; font-size: 11px; }
  select { min-width: 0; max-width: 310px; flex: 1; background: var(--color-surface-2, #171b20); color: inherit; border-radius: 4px; padding: 3px; }
  .trajectory-lane { padding: 2px 8px; font-size: 11px; }
  .trajectory-lane.wide { display: grid; padding: 2px 0; align-items: center; }
  .trajectory-lane.wide > span { padding-left: 8px; }
  .flight-axis { position: relative; height: 22px; background: rgb(255 255 255 / 3%); overflow: hidden; }
  .flight-mark { position: absolute; top: 3px; height: 16px; background: #9380ad; border-radius: 2px; overflow: hidden; font-size: 10px; white-space: nowrap; text-align: center; }
  .flight-mark.active { background: #c5a9e5; color: #111; }
  .flight-mark:hover { outline: 1px solid white; }
  .flight-mark span { padding: 0 4px; }
  .flight-playhead { position: absolute; width: 1px; height: 100%; background: white; pointer-events: none; }
</style>
