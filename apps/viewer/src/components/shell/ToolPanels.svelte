<script lang="ts">
  /**
   * Renders the open `panel` surfaces for one dock, in the order they were
   * opened rather than in source order.
   *
   * That distinction is the whole point of the open stack: the panel you just
   * opened lands at the bottom of the dock and is the one Escape closes, no
   * matter where its component happens to sit in this file.
   */
  import { openToolsWith, closeTool } from '../../lib/shell.svelte';
  import EventFinder from '../EventFinder.svelte';
  import MeasureTool from '../MeasureTool.svelte';
  import DebugPanel from '../DebugPanel.svelte';

  interface Props {
    /** `all` feeds the compact bottom-sheet stack, which both docks share. */
    dock: 'left' | 'right' | 'all';
  }

  let { dock }: Props = $props();

  const panels = $derived(openToolsWith('panel', dock === 'all' ? undefined : dock));
</script>

{#each panels as tool (tool.id)}
  {#if tool.id === 'events'}
    <EventFinder onClose={() => closeTool('events')} />
  {:else if tool.id === 'measure'}
    <MeasureTool onClose={() => closeTool('measure')} />
  {:else if tool.id === 'debug'}
    <DebugPanel onClose={() => closeTool('debug')} />
  {/if}
{/each}
