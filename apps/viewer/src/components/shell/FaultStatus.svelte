<script lang="ts">
  import { AlertTriangle, List, Trash2, X } from 'lucide-svelte';
  import { clearViewerLog, dismissViewerFault, viewerLog } from '../../lib/viewer-log.svelte';

  const activeFault = $derived(viewerLog.entries.find(entry => entry.id === viewerLog.activeFaultId) ?? null);
</script>

<div data-scene-occluder class="fault-anchor fixed left-[calc(var(--size-rail)+0.75rem)] top-14 z-40 flex max-w-[min(34rem,calc(100vw-1.5rem))] flex-col gap-2">
  {#if activeFault}
    <div class="flex min-w-0 items-start gap-2 rounded-md border border-error/50 bg-panel/95 px-2.5 py-2 text-error shadow-lg backdrop-blur-md" role="alert" aria-live="assertive">
      <AlertTriangle size={15} class="mt-0.5 shrink-0" />
      <div class="min-w-0 flex-1">
        <div class="text-metadata font-semibold uppercase">{activeFault.source}</div>
        <p class="m-0 break-words text-xs leading-snug text-text-primary">{activeFault.message}</p>
      </div>
      <button class="fault-action" aria-label="Open fault log" title="Open fault log" onclick={() => viewerLog.open = true}><List size={15} /></button>
      <button class="fault-action" aria-label="Dismiss fault status" title="Dismiss fault status" onclick={dismissViewerFault}><X size={15} /></button>
    </div>
  {:else}
    <button class="log-trigger" aria-label={`Open log, ${viewerLog.entries.length} entries`} title="Open log" onclick={() => viewerLog.open = !viewerLog.open}>
      <List size={15} />
      {#if viewerLog.entries.length}<span>{viewerLog.entries.length}</span>{/if}
    </button>
  {/if}

  {#if viewerLog.open}
    <section class="log-drawer flex max-h-[min(32rem,65vh)] w-[min(30rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-md border border-border bg-panel/95 shadow-xl backdrop-blur-md" aria-label="Viewer log">
      <header class="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-2">
        <List size={15} class="text-text-muted" />
        <h2 class="m-0 flex-1 text-sm font-semibold">Viewer log</h2>
        <span class="text-metadata text-text-faint">{viewerLog.entries.length}</span>
        <button class="fault-action" aria-label="Clear log" title="Clear log" onclick={clearViewerLog}><Trash2 size={14} /></button>
        <button class="fault-action" aria-label="Close viewer log" title="Close viewer log" onclick={() => viewerLog.open = false}><X size={15} /></button>
      </header>
      <ol class="m-0 flex flex-col gap-2 overflow-y-auto p-3">
        {#if !viewerLog.entries.length}
          <li class="list-none text-xs text-text-muted">No recorded faults or runtime errors.</li>
        {:else}
          {#each viewerLog.entries as entry (entry.id)}
            <li class="list-none border-b border-border-subtle pb-2 last:border-0">
              <div class="mb-0.5 flex items-baseline gap-2">
                <time class="font-mono text-metadata text-text-faint">{new Date(entry.timestamp).toLocaleTimeString()}</time>
                <span class="text-metadata font-semibold uppercase" class:text-error={entry.level === 'error'} class:text-warning={entry.level === 'warning'} class:text-text-muted={entry.level === 'info'}>{entry.level}</span>
                <span class="truncate text-xs text-text-secondary">{entry.source}</span>
              </div>
              <p class="m-0 break-words text-xs leading-snug text-text-primary">{entry.message}</p>
            </li>
          {/each}
        {/if}
      </ol>
    </section>
  {/if}
</div>

<style>
  .fault-action,
  .log-trigger {
    display: grid;
    width: 28px;
    height: 28px;
    flex: none;
    place-items: center;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--color-text-muted);
    cursor: pointer;
  }

  .fault-action:hover,
  .log-trigger:hover { background: var(--color-control-hover); color: var(--color-text-primary); }
  .fault-action:focus-visible,
  .log-trigger:focus-visible { outline: 1px solid var(--color-border-strong); outline-offset: 1px; }
  .log-trigger { display: flex; gap: 6px; border: 1px solid var(--color-border-default); background: color-mix(in srgb, var(--color-panel) 92%, transparent); box-shadow: 0 4px 18px rgba(0, 0, 0, 0.2); backdrop-filter: blur(8px); }
  .log-trigger span { font-size: var(--text-metadata); font-variant-numeric: tabular-nums; }

  @media (max-width: 719px) {
    .fault-anchor { left: 8px; top: 88px; }
  }
</style>