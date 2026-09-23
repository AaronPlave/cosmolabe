<script lang="ts">
  /**
   * The in-viewer catalog switcher (issue #94): a small text popover off the
   * rail, not a modal and not a header.
   *
   * Kept apart from the Catalog tool on purpose. That panel browses the
   * *contents* of the loaded catalog — bodies, spacecraft, systems — and
   * turning it into a way to replace the scene would mix "what is in this
   * scene" with "which scene". This one only lists catalogs to open.
   *
   * Opening it touches nothing: the scene stays up until a replacement is
   * chosen, and choosing one goes through the normal loader like any other
   * load.
   *
   * Rendered inside the rail's `Popover.Root`, so the rail owns the trigger
   * (and its styling) and this owns what the popover shows. Compact anchors it
   * to the whole bottom dock rather than the button, so it rises above the
   * dock as a full-width sheet instead of covering the transport.
   */
  import * as Popover from '$lib/components/ui/popover';
  import CatalogList from '../CatalogList.svelte';
  import { catalogs, addCatalogSource, pickLocalFiles } from '../../lib/catalogs.svelte';
  import { shell } from '../../lib/shell.svelte';
  import { vs } from '../../lib/viewer-state.svelte';
  import type { CatalogEntry } from '../../lib/catalog-sources';

  interface Props {
    onSelect: (sourceId: string, entry: CatalogEntry) => void;
    onFiles: (files: File[]) => void;
    close: () => void;
  }

  let { onSelect, onFiles, close }: Props = $props();

  const compact = $derived(shell.layout === 'compact');

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

<Popover.Content
  side={compact ? 'top' : 'right'}
  align={compact ? 'center' : 'start'}
  sideOffset={8}
  collisionPadding={8}
  customAnchor={compact ? '.compact-dock' : null}
  class="catalog-menu gap-0 p-0 bg-panel text-text-primary {compact ? 'w-[calc(100vw-1rem)]' : 'w-80'}"
  onEscapeKeydown={(e) => {
    // Handled: tell the viewer's own Escape handling not to also dismiss a
    // panel behind the popover.
    e.preventDefault();
    close();
  }}
>
  <div class="head">
    <div class="title">Open catalog</div>
    {#if vs.catalogName}
      <div class="current" title="Current catalog">{vs.catalogName}</div>
    {/if}
  </div>

  {#if catalogs.sources.length > 0 || catalogs.configErrors.length > 0}
    <div class="list">
      <CatalogList
        dense
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
</Popover.Content>

<style>
  .head {
    padding: 0.625rem 0.75rem 0.5rem;
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

  .list {
    max-height: min(26rem, calc(100vh - 12rem));
    overflow-y: auto;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--color-chrome-divider);
  }

  .foot {
    padding: 0.25rem;
  }
  .item {
    display: block;
    width: 100%;
    padding: 0.375rem 0.5rem;
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
