<script lang="ts">
  /**
   * One plugin timeline track (`ui.timelineTracks`) as a lane: the track's
   * intervals as bars on the shared axis. Same row grammar as `EventLane` —
   * label gutter, plot, readout rail — so a mission plugin's spans read like
   * any other lane. Clicking a bar seeks to its start; hover, ghost and
   * playhead belong to the dock's one interaction surface.
   */
  import type { ResolvedTrack } from '../../lib/plugin-tracks';
  import { intervalsAt } from '../../lib/plugin-tracks';
  import { vs, setTime } from '../../lib/viewer-state.svelte';
  import { timeline, ghostEt, TL_HEAD_PX } from '../../lib/timeline.svelte';
  import PlotCursor from './PlotCursor.svelte';

  interface Props {
    resolved: ResolvedTrack;
    wide: boolean;
  }

  let { resolved, wide }: Props = $props();

  const H = $derived(wide ? 20 : TL_HEAD_PX + 22);
  const rowId = $derived(`plugin:${resolved.track.id}`);

  const bars = $derived.by(() => {
    const span = vs.scrubMax - vs.scrubMin;
    if (!(span > 0)) return [];
    return resolved.intervals.flatMap((iv, i) => {
      if (iv.endEt < vs.scrubMin || iv.startEt > vs.scrubMax) return [];
      const start = (Math.max(iv.startEt, vs.scrubMin) - vs.scrubMin) / span;
      const end = (Math.min(iv.endEt, vs.scrubMax) - vs.scrubMin) / span;
      return [{ key: `${i}:${iv.startEt}`, iv, start, end }];
    });
  });

  const inspected = $derived(ghostEt());
  const readout = $derived.by(() => {
    const here = intervalsAt(resolved.intervals, inspected ?? vs.et);
    if (here.length === 1) return { text: here[0]!.label ?? 'Active', value: true };
    if (here.length > 1) return { text: `${here.length} active`, value: true };
    const n = resolved.intervals.length;
    return { text: `${n} ${n === 1 ? 'interval' : 'intervals'}`, value: false };
  });
</script>

<div
  class="tl-row plugin-lane"
  class:stacked={!wide}
  class:inspected={timeline.hoverRow === rowId}
  data-tl-row={rowId}
  data-tl-no-axis={!wide || undefined}
  style="height: {H}px"
>
  <div data-tl-no-axis class="tl-label">
    <span class="tl-label-main" title={resolved.track.label}>
      <span class="tl-primary">{resolved.track.label}</span>
    </span>
  </div>

  <div class="tl-plot lane-plot" data-tl-plot role="group" aria-label="{resolved.track.label} intervals">
    {#each bars as bar (bar.key)}
      <button
        type="button"
        class="lane-bar"
        class:active={vs.et >= bar.iv.startEt && vs.et <= bar.iv.endEt}
        style="left: {bar.start * 100}%; width: {Math.max(0, bar.end - bar.start) * 100}%; --bar: {bar.iv.color ?? resolved.track.color}"
        title={bar.iv.label ?? resolved.track.label}
        aria-label={bar.iv.label ?? resolved.track.label}
        data-tl-event-mark
        onclick={() => setTime(bar.iv.startEt)}
      ></button>
    {/each}
    {#if !wide}<PlotCursor />{/if}
  </div>

  <div data-tl-no-axis class="tl-readout">
    {#if readout.value}
      <span class="tl-num" class:preview={inspected != null}>{readout.text}</span>
    {:else}
      <span class="tl-secondary">{readout.text}</span>
    {/if}
  </div>
</div>

<style>
  .lane-plot {
    margin-block: 3px;
    border-radius: 2px;
  }
  .lane-bar {
    position: absolute;
    top: 0;
    bottom: 0;
    min-width: 2px;
    padding: 0;
    border: 0;
    border-radius: 1px;
    background: var(--bar);
    opacity: 0.6;
    cursor: pointer;
  }
  .lane-bar.active {
    opacity: 0.95;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.45);
  }
  .lane-bar:hover {
    z-index: 1;
    opacity: 1;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.55);
  }
  .tl-label-main {
    min-width: 0;
  }
</style>
