<script lang="ts" module>
  /**
   * The floating surface both choosers sit on — the shell's panel material,
   * a little translucent over the scene, so it reads as a temporary
   * instrument rather than the rail growing sideways. Utilities rather than a
   * component class, so they win over the popover primitive's own defaults.
   * Never taller than the room the popover has, so the local-open action at
   * its foot is always on screen; the list is what gives way.
   */
  export const CHOOSER_SURFACE =
    'gap-0 p-0 overflow-hidden rounded-md ring-0 border border-[var(--color-chrome-border)] ' +
    'max-h-[var(--bits-floating-available-height)] backdrop-blur-md shadow-[var(--shadow-float)] text-text-primary';

  /** Over a scene: translucent enough that the scene is still there behind it. */
  export const CHOOSER_OVER_SCENE = 'bg-[rgba(9,10,13,0.84)]';
  /** Over the home screen's copy, which would otherwise read through the list. */
  export const CHOOSER_OVER_PAGE = 'bg-[rgba(9,10,13,0.97)]';
</script>

<script lang="ts">
  /**
   * The one catalog chooser (issue #94): a header, the deployment's catalogs
   * as a dense text list, and the local-open action pinned under it.
   *
   * Two places show it — the rail's switcher over a scene (CatalogMenu), and
   * the home screen's Browse action (HomeScreen) — each in its own popover,
   * so browsing looks the same wherever it starts and the home screen never
   * grows into a catalog page.
   */
  import CatalogList from './CatalogList.svelte';
  import { catalogs, addCatalogSource, pickLocalFiles } from '../lib/catalogs.svelte';
  import type { CatalogEntry } from '../lib/catalog-sources';

  interface Props {
    onSelect: (sourceId: string, entry: CatalogEntry) => void;
    onFiles: (files: File[]) => void;
    close: () => void;
    /** Name of the scene that is up, if any. */
    currentName?: string | null;
  }

  let { onSelect, onFiles, close, currentName = null }: Props = $props();

  let adding = $state(false);
  let sourceUrl = $state('');
  let addError = $state<string | null>(null);
  let addBusy = $state(false);

  function select(sourceId: string, entry: CatalogEntry) {
    close();
    onSelect(sourceId, entry);
  }

  function openLocal() {
    close();
    pickLocalFiles(onFiles);
  }

  async function submitSource(e: SubmitEvent) {
    e.preventDefault();
    if (!sourceUrl.trim() || addBusy) return;
    addBusy = true;
    addError = null;
    const state = await addCatalogSource(sourceUrl);
    addBusy = false;
    if (state.status === 'error') {
      addError = `Couldn't load that source (${state.error}).`;
    } else {
      sourceUrl = '';
      adding = false;
    }
  }
</script>

<div class="head">
  <div class="title">Open catalog</div>
  {#if currentName}
    <div class="current" title="Current catalog">{currentName}</div>
  {/if}
</div>

{#if catalogs.sources.length > 0 || catalogs.configErrors.length > 0}
  <div class="list">
    <CatalogList
      sources={catalogs.sources}
      configErrors={catalogs.configErrors}
      currentUrl={catalogs.currentUrl}
      onSelect={select}
    />
  </div>
{/if}

<div class="foot">
  <button class="item" onclick={openLocal}>Open local catalog…</button>
  {#if catalogs.allowAddSource}
    {#if adding}
      <form class="add" onsubmit={submitSource}>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="add-input"
          type="url"
          placeholder="https://…/index.json"
          aria-label="Catalog source index URL"
          autofocus
          bind:value={sourceUrl}
        />
        <button class="add-btn" type="submit" disabled={addBusy || !sourceUrl.trim()}>
          {addBusy ? '…' : 'Add'}
        </button>
      </form>
      {#if addError}<p class="add-error">{addError}</p>{/if}
    {:else}
      <button class="item" onclick={() => (adding = true)}>Add catalog source…</button>
    {/if}
  {/if}
</div>

<style>
  .head,
  .foot {
    flex-shrink: 0;
  }
  .head {
    padding: 0.5625rem 0.75rem 0.5rem;
    border-bottom: 1px solid var(--color-chrome-divider);
  }
  .title {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-primary);
  }
  .current {
    margin-top: 1px;
    font-size: 11px;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The list scrolls; the header and the local-open action stay put. Capped
     so the chooser stays a small floating instrument rather than a column
     the height of the window. The compact sheet may use more of the screen. */
  .list {
    flex: 0 1 auto;
    min-height: 0;
    max-height: min(380px, calc(100vh - 11rem));
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0.375rem 0.625rem 0.5rem;
    border-bottom: 1px solid var(--color-chrome-divider);
    scrollbar-width: thin;
    scrollbar-color: var(--color-surface-3) transparent;
  }
  :global(.compact) .list {
    max-height: min(60vh, calc(100vh - 14rem));
  }

  .foot {
    padding: 0.25rem;
  }
  .item {
    display: block;
    width: 100%;
    padding: 0.3125rem 0.5rem;
    border: none;
    border-radius: 4px;
    background: transparent;
    text-align: left;
    font-size: 12px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      color var(--duration-chrome) var(--ease-chrome),
      background var(--duration-chrome) var(--ease-chrome);
  }
  .item:hover {
    color: var(--color-text-primary);
    background: var(--color-control-hover);
  }
  .item:focus-visible,
  .add-btn:focus-visible,
  .add-input:focus-visible {
    outline: none;
    box-shadow: var(--focus-chrome);
  }

  .add {
    display: flex;
    gap: 0.25rem;
    padding: 0.25rem;
  }
  .add-input {
    flex: 1;
    min-width: 0;
    height: 26px;
    padding: 0 0.5rem;
    border: 1px solid var(--color-border-default);
    border-radius: 4px;
    background: var(--color-control);
    color: var(--color-text-primary);
    font-size: 12px;
  }
  .add-btn {
    height: 26px;
    padding: 0 0.625rem;
    border: 1px solid var(--color-border-default);
    border-radius: 4px;
    background: transparent;
    color: var(--color-text-secondary);
    font-size: 12px;
    cursor: pointer;
  }
  .add-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .add-error {
    padding: 0 0.5rem 0.25rem;
    font-size: 11px;
    color: var(--color-text-secondary);
    overflow-wrap: anywhere;
  }
</style>
