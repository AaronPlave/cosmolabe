<script lang="ts">
  import { adjacentActivity, activityWindow, type MissionActivity } from '@cosmolabe/core';
  import { activityEvent, activityLayout, visibleActivityMarks } from '../../lib/mission-activities';
  import { selectActivity, seekActivity } from '../../lib/activity-control';
  import { previewEvent, isSelectedEvent } from '../../lib/event-finder.svelte';
  import { timeline, eventKey, setTimelineHover } from '../../lib/timeline.svelte';
  import { vs, setPlaying, setScrubberWindow, etToUtcString } from '../../lib/viewer-state.svelte';
  import { ChevronDown, ChevronLeft, ChevronRight, Maximize2 } from 'lucide-svelte';
  import { tick } from 'svelte';

  let { items, label, expanded, wide, axis }: {
    items: MissionActivity[]; label: string; expanded: boolean; wide: boolean;
    axis: { left: number; width: number; railEnd: number };
  } = $props();
  const pickerId = $props.id();
  let picker = $state<HTMLDivElement>(undefined!);
  let trigger = $state<HTMLButtonElement>(undefined!);
  let searchInput = $state<HTMLInputElement>(undefined!);
  let pickerOpen = $state(false);
  let pickerLeft = $state(0);
  let pickerBottom = $state(0);
  const kinds: Record<string, string> = {flight:'Flights', drive:'Drives', hop:'Hops', descent:'Descents', landing:'Landings', phase:'Phases', other:'Activities'};
  const heading = $derived(kinds[label] ?? 'Activities');
  const vehicleLabel = $derived(label === 'activity' ? 'Activities' : items[0]?.vehicle);
  let search = $state('');
  let groupIds = $state<Set<string> | null>(null);
  const selected = $derived(items.find(a => isSelectedEvent(activityEvent(a))));
  const navigable = $derived(items.filter(a => a.enabled !== false));
  const selectedIndex = $derived(selected ? navigable.indexOf(selected) : -1);
  const previous = $derived(selectedIndex >= 0 ? navigable[selectedIndex - 1] : adjacentActivity(navigable, vs.et, -1));
  const next = $derived(selectedIndex >= 0 ? navigable[selectedIndex + 1] : adjacentActivity(navigable, vs.et, 1));
  const matches = $derived(items.filter(a => (!groupIds || groupIds.has(a.id)) && `${a.vehicle} ${a.name}`.toLowerCase().includes(search.toLowerCase())));
  const choices = $derived(matches.slice(0, 200));
  async function togglePicker(event: Event) {
    pickerOpen = (event as ToggleEvent).newState === 'open';
    if (pickerOpen) {
      await tick(); searchInput.focus();
      picker.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({block:'nearest'});
    }
  }
  function openPicker(members?: MissionActivity[]) {
    clearPreview();
    groupIds = members ? new Set(members.map(a => a.id)) : null;
    const rect = trigger.getBoundingClientRect();
    pickerLeft = Math.max(8, Math.min(rect.left, innerWidth - Math.min(320, innerWidth - 16) - 8));
    pickerBottom = innerHeight - rect.top + 6;
    search = '';
    picker.togglePopover();
  }
  function choose(item: MissionActivity) {
    seek(item); picker.hidePopover(); trigger.focus();
  }
  function pickerKey(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const buttons = [...picker.querySelectorAll<HTMLButtonElement>('.picker-result:not(:disabled)')];
      const index = buttons.indexOf((picker.getRootNode() as Document | ShadowRoot).activeElement as HTMLButtonElement);
      const target = index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[target]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      picker.hidePopover(); trigger.focus();
    } else if (event.key === 'Enter' && event.target === searchInput) {
      const first = choices.find(a => a.enabled !== false);
      if (first) { event.preventDefault(); choose(first); }
    }
  }
  const layout = $derived(activityLayout(items));
  const marks = $derived(visibleActivityMarks(layout, vs.scrubMin, vs.scrubMax));
  const rows = $derived(Math.max(1, ...marks.map(m => m.row + 1)));
  function clearPreview() { setTimelineHover(null); previewEvent(null); }
  function seek(item: MissionActivity | undefined, window = true) {
    if (!item) return;
    clearPreview();
    setPlaying(false);
    selectActivity(item.id);
    seekActivity(item.id);
    if (window) setScrubberWindow(...activityWindow(item));
  }
  const fraction = (et: number) => (et - vs.scrubMin) / (vs.scrubMax - vs.scrubMin) * 100;
  function description(a: MissionActivity) {
    const date = etToUtcString(a.start).replace(/\s.*$/, '');
    return `${label === 'activity' ? `${a.vehicle} · ` : ''}${a.name} · ${date}`;
  }
</script>

{#if items.length}
  <div class="activity-lane" class:wide={expanded && wide}
    style={expanded && wide ? `grid-template-columns: ${axis.left}px ${axis.width}px minmax(0, 1fr)` : ''}
    onpointerdowncapture={event => { if (event.pointerType === 'touch') clearPreview(); }}
    data-tl-row={expanded ? `lane:activity:${items[0].vehicle}:${label}` : undefined}>
  <div class="activity-navigation" class:narrow={expanded && wide && axis.left < 300} role="group" aria-label={`${items[0].vehicle} ${label} navigation`} data-tl-no-axis>
    <span class="vehicle" title={label === 'activity' ? 'Activities' : `${vehicleLabel} · ${heading}`}>{vehicleLabel}{label === 'activity' ? '' : ` · ${heading}`}</span>
    <button class="tl-icon-btn" aria-label={`Previous ${label}`} disabled={!previous} onclick={() => seek(previous)}><ChevronLeft size={14} /></button>
    <button bind:this={trigger} class="picker-trigger" aria-label={`Choose ${label}`} aria-haspopup="dialog" aria-expanded={pickerOpen} aria-controls={pickerId} onclick={() => openPicker()}>
      <span>{selected ? `${label === 'activity' ? `${selected.vehicle} · ` : ''}${selected.name}` : `Choose ${label}`}</span><ChevronDown size={12}/>
    </button>
    <div data-tl-no-axis bind:this={picker} id={pickerId} popover="auto" class="activity-picker" role="dialog" aria-label={`Choose ${label}`} style={`left:${pickerLeft}px; bottom:${pickerBottom}px`} ontoggle={togglePicker} onkeydowncapture={pickerKey} tabindex="-1">
      <input bind:this={searchInput} type="search" aria-label={`Search ${items[0].vehicle} ${label}`} placeholder="Search activities" bind:value={search}/>
      <p class="result-count" role="status">{matches.length === 0 ? 'No activities found' : `${matches.length} ${matches.length === 1 ? 'activity' : 'activities'}${matches.length > 200 ? ' · first 200 shown; refine search' : ''}`}</p>
      <ul>
        {#each choices as item (item.id)}
          <li><button class="picker-result" aria-pressed={item.id === selected?.id} disabled={item.enabled === false} data-activity-id={item.id} onclick={() => choose(item)}><span>{label === 'activity' ? `${item.vehicle} · ` : ''}{item.name}</span><small>{etToUtcString(item.start).split(' ')[0]}</small></button></li>
        {/each}
      </ul>
    </div>
    <button class="tl-icon-btn" aria-label={`Next ${label}`} disabled={!next} onclick={() => seek(next)}><ChevronRight size={14} /></button>
    {#if selected}<button class="tl-icon-btn" onclick={() => setScrubberWindow(...activityWindow(selected!))} aria-label={`Fit activity ${selected.name}`} title="Fit activity"><Maximize2 size={13}/></button>{/if}
  </div>
  {#if expanded}
      <div class="activity-axis" style={`height: ${rows * 21 + 4}px`} data-tl-plot role="group" aria-label={`${items[0].vehicle} ${label} intervals`}>
        {#each marks as { item, row, count, windowStart, windowEnd, members } (item.id)}
          <button class="activity-mark" class:active={vs.et >= (members && count > 1 ? windowStart : item.start) && vs.et <= (members && count > 1 ? windowEnd : item.end)}
            class:selected={members ? members.some(a => a.id === selected?.id) : item.id === selected?.id} class:bounded={item.provenance.timing === 'bounded'}
            class:previewed={timeline.previewEventId === eventKey(activityEvent(item))}
            disabled={count === 1 && item.enabled === false} data-tl-event-mark data-ev-kind="mission-activity"
            style={`top: ${row * 21 + 3}px; left: ${Math.max(0, fraction(count > 1 ? windowStart : item.start))}%; width: max(5px, ${Math.min(100, fraction(count > 1 ? windowEnd : item.end)) - Math.max(0, fraction(count > 1 ? windowStart : item.start))}%)`}
            aria-label={count > 1 ? members ? `Choose among ${count} overlapping activities` : `Zoom into ${count} activities` : `Go to ${item.name}`} title={count > 1 ? members ? `Choose among ${count} overlapping activities` : `Zoom into ${count} activities` : description(item)}
            onclick={() => count > 1 ? (members ? openPicker(members) : setScrubberWindow(windowStart, windowEnd)) : seek(item, false)} onfocus={() => { if (matchMedia('(hover: hover)').matches) previewEvent(count > 1 ? null : activityEvent(item)); }} onblur={() => previewEvent(null)}
          ><span>{count > 1 ? `${count} activities` : item.temporality === 'instant' ? '◆' : item.name}</span></button>
        {/each}
        {#if vs.et >= vs.scrubMin && vs.et <= vs.scrubMax}<span class="activity-playhead" style={`left: ${fraction(vs.et)}%`}></span>{/if}
      </div>
  {/if}
  </div>
{/if}

<style>
  .activity-navigation { display:flex; align-items:center; gap:4px; padding:3px 8px; min-width:0; font-size:11px; }
  .vehicle { max-width:130px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .picker-trigger { width:180px; max-width:42cqw; min-width:0; display:flex; align-items:center; justify-content:space-between; gap:6px; background:var(--color-surface-2, #171b20); border-radius:4px; padding:4px 6px; }
  .picker-trigger span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .activity-picker { position:fixed; top:auto; right:auto; margin:0; width:min(320px, calc(100vw - 16px)); max-height:min(340px, 55vh); overflow:hidden; padding:8px; border:1px solid var(--color-chrome-border); border-radius:6px; background:var(--color-surface-1); color:var(--color-text-primary); box-shadow:0 4px 18px #0008; font-size:12px; }
  .activity-picker input { width:100%; padding:6px; background:var(--color-surface-2, #171b20); color:inherit; border-radius:4px; }
  .result-count { margin:6px 0; color:var(--color-text-secondary); font-size:11px; }
  .activity-picker ul { list-style:none; padding:0; margin:0; max-height:calc(min(340px, 55vh) - 84px); overflow-y:auto; overscroll-behavior:contain; }
  .picker-result { display:flex; justify-content:space-between; gap:12px; width:100%; padding:6px; text-align:left; border-radius:3px; }
  .picker-result small { white-space:nowrap; color:var(--color-text-secondary); }
  .picker-result:hover, .picker-result:focus-visible { background:var(--color-control-hover); }
  .picker-result[aria-pressed="true"] { background:var(--color-control-hover); box-shadow:inset 2px 0 var(--ev); }
  .activity-lane { padding:2px 0; font-size:11px; }
  .activity-lane.wide { display:grid; align-items:center; }
  .wide .activity-navigation { padding:2px 6px; gap:3px; }
  .wide .picker-trigger { flex:1; width:120px; max-width:120px; }
  .wide .activity-navigation :global(.tl-icon-btn) { flex-shrink:0; }
  .activity-navigation.narrow { flex-wrap:wrap; }
  .narrow .vehicle { flex-basis:100%; max-width:none; }
  .narrow .picker-trigger { flex:none; }
  .activity-axis { position:relative; background:rgb(255 255 255 / 3%); overflow:hidden; }
  .activity-mark { position:absolute; height:17px; background:var(--ev); opacity:.72; border-radius:2px; overflow:hidden; font-size:10px; white-space:nowrap; text-align:center; }
  .activity-mark.bounded { background:color-mix(in srgb, var(--ev) 12%, transparent); box-shadow:inset 0 -2px color-mix(in srgb, var(--ev) 55%, transparent); color:var(--color-text-secondary); }
  .activity-mark.active:not(.bounded) { opacity:1; color:#111; }
  .activity-mark.selected, .activity-mark.previewed, .activity-mark:hover { outline:1px solid white; outline-offset:-1px; }
  .activity-mark span { padding:0 4px; }
  .activity-playhead { position:absolute; width:1px; height:100%; background:white; pointer-events:none; }
  @media (max-width:480px) { .vehicle { max-width:125px; } .activity-navigation { padding:3px 4px; } }
</style>
