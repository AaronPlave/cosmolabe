<script lang="ts">
  /**
   * Renders the open `panel` surfaces for one dock, in the order they were
   * opened rather than in source order.
   *
   * That distinction is the whole point of the open stack: the panel you just
   * opened lands at the bottom of the dock and is the one Escape closes, no
   * matter where its component happens to sit in this file.
   */
  import { shell, openToolsWith, closeTool, toolDef } from '../../lib/shell.svelte';
  import EventFinder from '../EventFinder.svelte';
  import MeasureTool from '../MeasureTool.svelte';
  import DebugPanel from '../DebugPanel.svelte';

  interface Props {
    /** `all` is the compact case, where the shell picks one sheet instead. */
    dock: 'left' | 'right' | 'all';
  }

  let { dock }: Props = $props();

  const panels = $derived.by(() => {
    // Compact shows exactly the active sheet. Every other open tool stays open
    // with its state intact and is one rail press away — the alternative, which
    // this replaced, scrolled all of them into one tall sheet and left the
    // scene a strip at the top.
    if (shell.layout === 'compact') {
      const active = shell.activeSheet;
      if (active == null || active === 'info' || active === 'pick') return [];
      const def = toolDef(active);
      return def.presentation === 'panel' && shell.openTools.includes(active) ? [def] : [];
    }
    return openToolsWith('panel', dock === 'all' ? undefined : dock);
  });
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
