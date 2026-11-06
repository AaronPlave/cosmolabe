<script lang="ts">
  /**
   * A genuine, newly raised fault surfaces once as a transient message — the
   * same pattern as the view-link notice — and then lives in Diagnostics, whose
   * rail button turns red while it is active. No permanent chrome.
   */
  import { untrack } from 'svelte';
  import { viewerLog } from '../../lib/viewer-log.svelte';
  import { openTool, isToolOpen } from '../../lib/shell.svelte';

  let shownId = $state<number | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const entry = $derived(shownId === null ? null : viewerLog.entries.find(e => e.id === shownId) ?? null);

  $effect(() => {
    const id = viewerLog.activeFaultId === viewerLog.acknowledgedId ? null : viewerLog.activeFaultId;
    untrack(() => {
      clearTimeout(timer);
      shownId = id;
      if (id !== null) timer = setTimeout(() => { shownId = null; }, 10_000);
    });
    return () => clearTimeout(timer);
  });
</script>

{#if entry && !isToolOpen('debug')}
  <div data-scene-occluder class="shell-surface fixed left-1/2 top-3 z-40 flex max-w-[calc(100cqw-2rem)] -translate-x-1/2 items-start gap-3 rounded-md border border-error/50 px-3 py-2 text-[12px] text-text-secondary backdrop-blur-md" role="alert">
    <span class="min-w-0 break-words"><b class="text-error">{entry.source}:</b> {entry.message}</span>
    <button class="shrink-0 text-text-muted underline hover:text-text-primary" onclick={() => openTool('debug')}>Details</button>
    <button aria-label="Dismiss message" class="shrink-0 text-text-muted hover:text-text-primary" onclick={() => { shownId = null; }}>&times;</button>
  </div>
{/if}
