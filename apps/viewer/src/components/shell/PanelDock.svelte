<script lang="ts">
  /**
   * Where docked panels sit.
   *
   * Desktop: a column down one side, offset past the rail, stacked in the order
   * they were opened. Each panel owns its scrolling; the dock never scrolls as
   * a group, which keeps every visible panel header anchored and reachable. The
   * scene stays continuous behind it — the dock floats over the canvas rather
   * than claiming a column of the layout, which is the distinction #59 draws
   * between a workspace and a dashboard. A panel dragged out of here goes
   * `position: fixed` and leaves the flow; the dock neither knows nor cares.
   *
   * Compact: one sheet, the panel the shell has made active. Not a stack —
   * a phone has room for one instrument and the scene, and the shell's job is
   * to keep the scene primary.
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
        ? 'left: calc(var(--size-rail) + 0.75rem); bottom: calc(var(--size-dock-base) + 0.75rem)'
        : 'right: 0.75rem; bottom: calc(var(--size-dock-base) + 0.75rem)',
  );
</script>

<!-- `pointer-events-none` on the dock, `auto` on each panel (InstrumentPanel):
     the gaps between panels are still scene, and must stay draggable. -->
{#if side === 'sheet'}
  <!-- Even with an instrument open, more of a phone remains scene than sheet.
       Long instruments scroll inside the shared panel body. -->
  <div class="pointer-events-none absolute z-15 flex max-h-[42%] flex-col gap-2 overflow-hidden" {style}>
    {@render children()}
  </div>
{:else}
  <div
    class="pointer-events-none absolute top-3 z-15 flex flex-col gap-2 overflow-hidden"
    class:items-start={side === 'left'}
    class:items-end={side === 'right'}
    {style}
  >
    {@render children()}
  </div>
{/if}
