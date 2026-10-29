<script lang="ts">
  import { adjacentActivity, activityWindow, type MissionActivity } from '@cosmolabe/core';
  import { activityEvent, activityLayout, visibleActivityMarks } from '../../lib/mission-activities';
  import { selectActivity, seekActivity } from '../../lib/activity-control';
  import { previewEvent, isSelectedEvent } from '../../lib/event-finder.svelte';
  import { timeline, eventKey } from '../../lib/timeline.svelte';
  import { vs, setPlaying, setScrubberWindow, etToUtcString } from '../../lib/viewer-state.svelte';
  import { ChevronLeft, ChevronRight } from 'lucide-svelte';

  let { items, label, expanded, wide, axis }: {
    items: MissionActivity[]; label: string; expanded: boolean; wide: boolean;
    axis: { left: number; width: number; railEnd: number };
  } = $props();
  const vehicleLabel = $derived(label === 'activity' ? 'Activities' : items[0]?.vehicle);
  let search = $state('');
  const selected = $derived(items.find(a => isSelectedEvent(activityEvent(a))));
  const navigable = $derived(items.filter(a => a.enabled !== false));
  const selectedIndex = $derived(selected ? navigable.indexOf(selected) : -1);
  const previous = $derived(selectedIndex >= 0 ? navigable[selectedIndex - 1] : adjacentActivity(navigable, vs.et, -1));
  const next = $derived(selectedIndex >= 0 ? navigable[selectedIndex + 1] : adjacentActivity(navigable, vs.et, 1));
  // No per-frame list scan: active state is CSS on visible marks and this O(1) selected read.
  const selectedState = $derived(!selected ? 'Choose activity' : vs.et < selected.start ? 'Upcoming' : vs.et > selected.end ? 'Past' : selected.provenance.timing === 'bounded' ? 'Within reported window' : 'Active');
  const matches = $derived(items.filter(a => `${a.vehicle} ${a.name}`.toLowerCase().includes(search.toLowerCase())));
  const choices = $derived(selected && !matches.slice(0, 200).includes(selected) ? [selected, ...matches.slice(0, 200)] : matches.slice(0, 200));
  const layout = $derived(activityLayout(items));
  const marks = $derived(visibleActivityMarks(layout, vs.scrubMin, vs.scrubMax));
  const rows = $derived(Math.max(1, ...marks.map(m => m.row + 1)));
  function seek(item: MissionActivity | undefined, window = false) {
    if (!item) return;
    setPlaying(false);
    selectActivity(item.id);
    seekActivity(item.id);
    if (window) setScrubberWindow(...activityWindow(item));
  }
  const fraction = (et: number) => (et - vs.scrubMin) / (vs.scrubMax - vs.scrubMin) * 100;
  function description(a: MissionActivity) {
    const duration = a.temporality === 'instant' ? 'Milestone' : a.provenance.timing === 'bounded' ? 'Reported date window; duration unknown' : `${(a.end - a.start).toFixed(1)} s`;
    return `${a.vehicle} ${a.name} · ${etToUtcString(a.start)} → ${etToUtcString(a.end)} · ${duration} · ${a.provenance.authority}`;
  }
</script>

{#if items.length}
  <div class="activity-navigation" role="group" aria-label={`${items[0].vehicle} ${label} navigation`} data-tl-no-axis>
    <span class="vehicle">{vehicleLabel}{label === 'activity' ? '' : ` · ${label}`}</span>
    <button class="tl-icon-btn" aria-label={`Previous ${label}`} disabled={!previous} onclick={() => seek(previous)}><ChevronLeft size={14} /></button>
    <select aria-label={`Choose ${label}`} value={selected?.id ?? ''} onchange={event => seek(items.find(a => a.id === event.currentTarget.value))}>
      <option value="" disabled>Choose {label} · {items.length}</option>
      {#each choices as item (item.id)}<option value={item.id} disabled={item.enabled === false}>{description(item)}</option>{/each}
    </select>
    <button class="tl-icon-btn" aria-label={`Next ${label}`} disabled={!next} onclick={() => seek(next)}><ChevronRight size={14} /></button>
    {#if selected}<button class="window-button" onclick={() => setScrubberWindow(...activityWindow(selected!))} aria-label={`Window ${selected.name}`}>Window</button>{/if}
  </div>
  {#if expanded}
    <div class="activity-tools" data-tl-no-axis>
      {#if matches.length > 200}<span>First 200 of {matches.length}; search to narrow</span>{/if}
      {#if items.length > 20}<input type="search" aria-label={`Search ${items[0].vehicle} ${label}`} placeholder="Search activities" bind:value={search} />{/if}
      <span>{selectedState}</span>
      {#if selected}<span class="activity-facts" title={`${selected.start} → ${selected.end} ET seconds past J2000 · ${selected.provenance.source} (${selected.provenance.version}) · ${selected.provenance.limitations}`}>{description(selected)} · {selected.provenance.limitations}</span>{/if}
    </div>
    <div class="activity-lane" class:wide style={wide ? `grid-template-columns: ${axis.left}px ${axis.width}px minmax(0, 1fr)` : ''} data-tl-row={`lane:activity:${items[0].vehicle}:${label}`}>
      {#if wide}<span class="text-text-secondary" data-tl-no-axis>{label}</span>{/if}
      <div class="activity-axis" style={`height: ${rows * 21 + 4}px`} data-tl-plot role="group" aria-label={`${items[0].vehicle} ${label} intervals`}>
        {#each marks as { item, row, count } (item.id)}
          <button class="activity-mark" class:active={vs.et >= item.start && vs.et <= item.end}
            class:selected={item.id === selected?.id} class:estimated={item.provenance.timing !== 'exact'}
            class:previewed={timeline.previewEventId === eventKey(activityEvent(item))}
            disabled={item.enabled === false} data-tl-event-mark data-ev-kind="mission-activity"
            style={`top: ${row * 21 + 3}px; left: ${Math.max(0, fraction(item.start))}%; width: max(5px, ${Math.min(100, fraction(item.end)) - Math.max(0, fraction(item.start))}%)`}
            aria-label={`Go to ${item.name}`} title={`${count > 1 ? `${count} activities here; choose to inspect. ` : ''}${description(item)} · ${item.provenance.limitations}`}
            onclick={() => seek(item)} onfocus={() => previewEvent(activityEvent(item))} onblur={() => previewEvent(null)}
          ><span>{count > 1 ? `${count} activities` : item.temporality === 'instant' ? '◆' : item.name}</span></button>
        {/each}
        {#if vs.et >= vs.scrubMin && vs.et <= vs.scrubMax}<span class="activity-playhead" style={`left: ${fraction(vs.et)}%`}></span>{/if}
      </div>
    </div>
  {/if}
{/if}

<style>
  .activity-navigation { display:flex; align-items:center; gap:4px; padding:3px 8px; min-width:0; font-size:11px; }
  .vehicle { max-width:130px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  select, input { min-width:0; background:var(--color-surface-2, #171b20); color:inherit; border-radius:4px; padding:4px; }
  select { flex:1; max-width:440px; }
  .window-button { font-size:11px; padding:4px; }
  .activity-tools { display:flex; gap:8px; padding:2px 8px; font-size:11px; align-items:center; }
  .activity-tools input { width:130px; }
  .activity-facts { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .activity-lane { padding:2px 0; font-size:11px; }
  .activity-lane.wide { display:grid; align-items:center; }
  .activity-lane.wide > span { padding-left:8px; }
  .activity-axis { position:relative; background:rgb(255 255 255 / 3%); overflow:hidden; }
  .activity-mark { position:absolute; height:17px; background:var(--ev); opacity:.72; border-radius:2px; overflow:hidden; font-size:10px; white-space:nowrap; text-align:center; }
  .activity-mark.estimated { border:1px dashed currentColor; }
  .activity-mark.active { opacity:1; color:#111; }
  .activity-mark.selected, .activity-mark.previewed, .activity-mark:hover { outline:1px solid white; outline-offset:-1px; }
  .activity-mark span { padding:0 4px; }
  .activity-playhead { position:absolute; width:1px; height:100%; background:white; pointer-events:none; }
  @media (max-width:480px) { .vehicle { max-width:80px; } .activity-navigation { padding:3px 4px; } }
</style>
