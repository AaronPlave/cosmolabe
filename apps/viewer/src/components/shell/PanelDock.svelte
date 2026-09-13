<script lang="ts">
  /**
   * Where open `panel` surfaces live.
   *
   * Desktop: a column down one side, offset past the rail, stacked in the order
   * they were opened and scrolling as a group when there are more than fit. The
   * scene stays continuous behind it — the dock floats over the canvas rather
   * than claiming a column of the layout, which is the distinction #59 draws
   * between a workspace and a dashboard.
   *
   * Compact: one bottom-sheet stack above the timeline, capped so the scene
   * keeps the upper half of the screen. Both sides feed the same stack there,
   * which is why `sheet` is a side of its own rather than a flag.
   */
  import type { Snippet } from 'svelte';

  interface Props {
    side: 'left' | 'right' | 'sheet';
    children: Snippet;
  }

  let { side, children }: Props = $props();

  // One style string rather than `style:` directives beside a `style`
  // attribute, so there is a single place the dock's geometry is decided.
  const style = $derived(
    side === 'sheet'
      ? 'left: 0.5rem; right: 0.5rem; bottom: calc(var(--size-dock-base) + 0.5rem)'
      : side === 'left'
        ? 'left: calc(var(--size-rail) + 1rem); bottom: calc(var(--size-dock-base) + 0.75rem)'
        : 'right: 0.75rem; bottom: calc(var(--size-dock-base) + 0.75rem)',
  );
</script>

<!-- `pointer-events-none` on the dock, `auto` on each panel (InstrumentPanel):
     the gaps between panels are still scene, and must stay draggable. -->
{#if side === 'sheet'}
  <div class="pointer-events-none absolute z-15 flex max-h-[55%] flex-col gap-2 overflow-y-auto" {style}>
    {@render children()}
  </div>
{:else}
  <div
    class="pointer-events-none absolute top-3 z-15 flex flex-col gap-2 overflow-y-auto"
    class:items-start={side === 'left'}
    class:items-end={side === 'right'}
    {style}
  >
    {@render children()}
  </div>
{/if}
