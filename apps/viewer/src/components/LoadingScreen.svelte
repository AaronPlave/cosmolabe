<script lang="ts">
  /**
   * A load in flight (issue #94): which catalog, and how far along.
   *
   * Separate from the home screen so loading a catalog shows that catalog
   * rather than the whole list of them behind a progress bar — and so a switch
   * from inside the viewer, which never visited the home screen, gets the same
   * focused state.
   *
   * Layout is fixed (#346): every row has a reserved height, so the bar never
   * moves whatever the name, stage or detail says. Only the stage label is a
   * live region; per-file / per-byte detail is not announced.
   */
  import { vs } from '../lib/viewer-state.svelte';

  const name = $derived(vs.loadingCatalog || 'Catalog');
  const pct = $derived(Math.round(Math.min(100, vs.loadingProgress)));
</script>

<div class="loading">
  <div class="body">
    <div class="name" title={name}>{name}</div>
    <div
      class="bar"
      role="progressbar"
      aria-label="Loading {name}"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext="{pct}%{vs.loadingLabel ? `, ${vs.loadingLabel}` : ''}"
    >
      <div class="fill" style="width: {Math.min(100, vs.loadingProgress)}%"></div>
    </div>
    <div class="row">
      <span class="label" role="status" aria-live="polite">{vs.loadingLabel}</span>
      <span class="figures">{vs.loadingCount}</span>
    </div>
    <div class="row detail">
      <span class="file" title={vs.loadingDetail}>{vs.loadingDetail}</span>
      <span class="figures">{vs.loadingFigures}</span>
    </div>
  </div>
</div>

<style>
  .loading {
    position: absolute;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: var(--color-canvas);
  }
  .body {
    width: min(384px, 100%);
  }
  /* Fixed heights and margins on every row: nothing the text says can move the
     bar. Rhythm is title / bar / (status + detail as a tight pair). */
  .name,
  .label,
  .file {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name {
    font-size: 16px;
    font-weight: 500;
    line-height: 24px;
    height: 24px;
    color: var(--color-text-primary);
  }
  .bar {
    height: 3px;
    margin-top: 8px;
    border-radius: 999px;
    background: var(--color-surface-3);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    border-radius: inherit;
    background: var(--color-text-column);
    transition: width 0.2s ease;
  }
  .row {
    display: flex;
    gap: 12px;
    font-size: 13px;
    line-height: 18px;
    height: 18px;
    margin-top: 14px;
    color: color-mix(in srgb, var(--color-text-primary) 55%, var(--color-text-column));
  }
  .detail {
    font-size: 12px;
    line-height: 16px;
    height: 16px;
    margin-top: 2px;
    color: color-mix(in srgb, var(--color-text-secondary) 70%, var(--color-text-muted));
  }
  .label,
  .file {
    flex: 1 1 0;
    min-width: 0;
  }
  .figures {
    flex: none;
    margin-left: auto;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
</style>
