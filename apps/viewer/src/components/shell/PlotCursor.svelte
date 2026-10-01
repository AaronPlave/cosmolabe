<script lang="ts">
  /**
   * The ghost and playhead lines inside one plot. On a phone the rows stack
   * a header line over each plot, so a line drawn through the whole region
   * would cross labels and buttons; there each plot draws its own, on the
   * same shared times. (A desktop draws one line through every row: its
   * labels sit in a gutter beside the axis, not across it.)
   */
  import { vs } from '../../lib/viewer-state.svelte';
  import { ghostEt, timelineFraction } from '../../lib/timeline.svelte';
  import { inWindow } from '../../lib/scrubber-math';

  const ghost = $derived(ghostEt());
  const ghostFraction = $derived(ghost == null ? null : timelineFraction(ghost));
  const playFraction = $derived(timelineFraction(vs.et));
</script>

{#if ghostFraction != null && inWindow(ghostFraction)}
  <div class="plot-line ghost" style="left: {ghostFraction * 100}%"></div>
{/if}
{#if inWindow(playFraction)}
  <div class="plot-line playhead" style="left: {playFraction * 100}%"></div>
{/if}

<style>
  .plot-line {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: var(--tl-z-cursor, 3);
    transform: translateX(-50%);
    pointer-events: none;
  }
  .ghost {
    width: 1px;
    background: var(--color-text-secondary);
    opacity: 0.6;
  }
  .playhead {
    width: 2px;
    background: var(--color-text-primary);
    opacity: 0.85;
  }
</style>
