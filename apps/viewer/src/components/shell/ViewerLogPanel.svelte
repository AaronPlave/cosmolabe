<script lang="ts">
  /**
   * The viewer's fault log, a section of Diagnostics: a one-line status, with the
   * bounded log a click away. Current fault stays apart from history.
   */
  import { AlertTriangle, Trash2, X } from 'lucide-svelte';
  import { clearViewerLog, dismissViewerFault, viewerLog } from '../../lib/viewer-log.svelte';

  let showLog = $state(false);
  const current = $derived(viewerLog.entries.find(entry => entry.id === viewerLog.activeFaultId) ?? null);
  const history = $derived(viewerLog.entries.filter(entry => entry.id !== viewerLog.activeFaultId));
</script>

<div class="flex flex-col gap-1.5 text-xs" aria-label="Viewer faults">
  <div class="flex items-center gap-2">
    {#if current}
      <AlertTriangle size={14} class="shrink-0 text-error" />
      <span class="min-w-0 flex-1 truncate text-text-primary">1 active fault · {current.source}</span>
    {:else}
      <span class="min-w-0 flex-1 text-text-muted">No active faults</span>
    {/if}
    {#if current}<button class="icon" aria-label="Dismiss current fault" title="Dismiss (stays in log)" onclick={dismissViewerFault}><X size={14} /></button>{/if}
    <button class="link" aria-expanded={showLog} disabled={!viewerLog.entries.length} onclick={() => (showLog = !showLog)}>{showLog ? 'Hide log' : 'View log'}</button>
  </div>
  {#if current}
    <p class="m-0 break-words rounded border border-error/50 px-2 py-1 leading-snug text-text-primary" role="alert">{current.message}</p>
  {/if}

  {#if showLog && viewerLog.entries.length}
    <section aria-label="Log" class="rounded border border-border-subtle">
      <header class="flex items-center gap-2 border-b border-border-subtle px-2 py-0.5">
        <div class="ui-section-label flex-1">Log · {history.length} earlier</div>
        <button class="icon" aria-label="Clear log" title="Clear history" onclick={() => { clearViewerLog(); showLog = false; }}><Trash2 size={14} /></button>
      </header>
      <ol class="m-0 flex max-h-56 flex-col gap-2 overflow-y-auto p-2">
        {#each history as entry (entry.id)}
          <li class="list-none border-b border-border-subtle pb-2 last:border-0 last:pb-0">
            <div class="mb-0.5 flex items-baseline gap-2">
              <time class="font-mono text-metadata text-text-faint">{new Date(entry.timestamp).toLocaleTimeString()}</time>
              <span class="text-metadata font-semibold uppercase" class:text-error={entry.level === 'error'} class:text-warning={entry.level === 'warning'} class:text-success={entry.level === 'info' && entry.message === 'Recovered.'} class:text-text-muted={entry.level === 'info' && entry.message !== 'Recovered.'}>{entry.level === 'info' && entry.message === 'Recovered.' ? 'recovered' : entry.level}</span>
              <span class="truncate text-text-secondary">{entry.source}</span>
            </div>
            {#if entry.message !== 'Recovered.'}<p class="m-0 break-words leading-snug text-text-primary">{entry.message}</p>{/if}
          </li>
        {:else}
          <li class="list-none text-text-muted">Nothing earlier.</li>
        {/each}
      </ol>
    </section>
  {/if}
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
  .link { border: 0; background: transparent; color: var(--color-text-secondary); cursor: pointer; padding: 2px 4px; text-decoration: underline; }
  .link:hover:not(:disabled) { color: var(--color-text-primary); }
  .link:disabled { opacity: 0.4; cursor: default; text-decoration: none; }
  .icon:disabled { opacity: 0.4; cursor: default; }
  .icon:focus-visible { outline: 1px solid var(--color-border-strong); outline-offset: 1px; }
</style>
