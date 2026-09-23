<script lang="ts">
  /**
   * A load in flight (issue #94): which catalog, and how far along.
   *
   * Separate from the home screen so loading a catalog shows that catalog
   * rather than the whole list of them behind a progress bar — and so a switch
   * from inside the viewer, which never visited the home screen, gets the same
   * focused state.
   */
  import { vs } from '../lib/viewer-state.svelte';
</script>

<div class="loading" role="status" aria-live="polite">
  <div class="body">
    <div class="eyebrow">Loading</div>
    <div class="name">{vs.loadingCatalog || 'Catalog'}</div>
    <div
      class="bar"
      role="progressbar"
      aria-label="Loading {vs.loadingCatalog || 'catalog'}"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.min(100, vs.loadingProgress))}
    >
      <div class="fill" style="width: {Math.min(100, vs.loadingProgress)}%"></div>
    </div>
    <div class="label">{vs.loadingLabel}</div>
    {#if vs.loadingDetail}
      <div class="detail">{vs.loadingDetail}</div>
    {/if}
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
    width: 100%;
    max-width: 20rem;
  }
  .eyebrow {
    font-size: 10px;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }
  .name {
    margin-top: 0.25rem;
    font-size: 15px;
    font-weight: 500;
    color: var(--color-text-primary);
    overflow-wrap: anywhere;
  }
  .bar {
    margin-top: 0.875rem;
    height: 1px;
    background: var(--color-surface-3);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--color-text-secondary);
    transition: width 0.2s ease;
  }
  .label {
    margin-top: 0.5rem;
    font-size: 11px;
    color: var(--color-text-muted);
  }
  .detail {
    font-size: 11px;
    color: var(--color-text-muted);
    opacity: 0.6;
    overflow-wrap: anywhere;
  }
</style>
