<script lang="ts">
  /**
   * The viewer's fault log, a section of Diagnostics: what is failing now,
   * kept apart from what has happened, with recovery logged where it is seen.
   */
  import { AlertTriangle, Trash2, X } from 'lucide-svelte';
  import { clearViewerLog, dismissViewerFault, viewerLog } from '../../lib/viewer-log.svelte';

  const current = $derived(viewerLog.entries.find(entry => entry.id === viewerLog.activeFaultId) ?? null);
  const history = $derived(viewerLog.entries.filter(entry => entry.id !== viewerLog.activeFaultId));
</script>

<div class="flex flex-col gap-2 text-xs">
  <header class="flex items-center gap-2">
    <div class="ui-section-label flex-1">Faults and log</div>
    <button class="icon" aria-label="Clear log" title="Clear history" disabled={!viewerLog.entries.length} onclick={clearViewerLog}><Trash2 size={14} /></button>
  </header>

  <section aria-label="Current">
    <div class="mb-1 text-metadata uppercase text-text-faint">Now</div>
    {#if current}
      <div class="flex items-start gap-2 rounded border border-error/50 px-2 py-1.5" role="alert">
        <AlertTriangle size={14} class="mt-0.5 shrink-0 text-error" />
        <div class="min-w-0 flex-1">
          <div class="text-metadata font-semibold uppercase text-error">{current.source}</div>
          <p class="m-0 break-words leading-snug text-text-primary">{current.message}</p>
        </div>
        <button class="icon" aria-label="Dismiss current fault" title="Dismiss (stays in history)" onclick={dismissViewerFault}><X size={14} /></button>
      </div>
    {:else}
      <p class="m-0 text-text-muted">No active fault.</p>
    {/if}
  </section>

  <section aria-label="History">
    <div class="mb-1 text-metadata uppercase text-text-faint">History</div>
    {#if !history.length}
      <p class="m-0 text-text-muted">Nothing recorded.</p>
    {:else}
      <ol class="m-0 flex flex-col gap-2 p-0">
        {#each history as entry (entry.id)}
          <li class="list-none border-b border-border-subtle pb-2 last:border-0">
            <div class="mb-0.5 flex items-baseline gap-2">
              <time class="font-mono text-metadata text-text-faint">{new Date(entry.timestamp).toLocaleTimeString()}</time>
              <span class="text-metadata font-semibold uppercase" class:text-error={entry.level === 'error'} class:text-warning={entry.level === 'warning'} class:text-success={entry.level === 'info' && entry.message === 'Recovered.'} class:text-text-muted={entry.level === 'info' && entry.message !== 'Recovered.'}>{entry.level === 'info' && entry.message === 'Recovered.' ? 'recovered' : entry.level}</span>
              <span class="truncate text-text-secondary">{entry.source}</span>
            </div>
            {#if entry.message !== 'Recovered.'}<p class="m-0 break-words leading-snug text-text-primary">{entry.message}</p>{/if}
          </li>
        {/each}
      </ol>
    {/if}
  </section>
</div>

<style>
  .icon {
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
  .icon:hover:not(:disabled) { background: var(--color-control-hover); color: var(--color-text-primary); }
  .icon:disabled { opacity: 0.4; cursor: default; }
  .icon:focus-visible { outline: 1px solid var(--color-border-strong); outline-offset: 1px; }
</style>
