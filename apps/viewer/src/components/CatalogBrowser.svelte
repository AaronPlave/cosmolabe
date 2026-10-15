<script lang="ts">
  /**
   * The catalog browser (issue #94): one large overlay for choosing a catalog,
   * opened the same way from the home screen's Browse and from the viewer's
   * folder button (and `O`, and the command palette).
   *
   * Whatever is up stays up underneath — the home screen, or the scene, which
   * keeps rendering behind the dimmed backdrop — and nothing is unloaded until
   * a catalog is chosen, which goes through the normal loader like any other
   * load. Escape, the close button and a click on the backdrop all dismiss it.
   *
   * Kept apart from the Catalog tool on purpose. That panel browses the
   * *contents* of the loaded catalog — bodies, spacecraft, systems — and this
   * browses the catalogs a deployment offers (#93), so "what is in this scene"
   * and "which scene" stay two questions.
   *
   * Desktop gets a centred, nearly full-screen surface with room for a grouped
   * two-column list; compact gets the same thing as a full-screen sheet.
   */
  import { Dialog as DialogPrimitive } from 'bits-ui';
  import { X } from 'lucide-svelte';
  import CatalogList from './CatalogList.svelte';
  import { catalogs, addCatalogSource, pickLocalFiles } from '../lib/catalogs.svelte';
  import { shell } from '../lib/shell.svelte';
  import { vs } from '../lib/viewer-state.svelte';
  import type { CatalogEntry } from '../lib/catalog-sources';

  interface Props {
    onSelect: (sourceId: string, entry: CatalogEntry) => void;
    onFiles: (files: File[]) => void;
  }

  let { onSelect, onFiles }: Props = $props();

  let contentEl = $state<HTMLElement | null>(null);

  let adding = $state(false);
  let sourceUrl = $state('');
  let addError = $state<string | null>(null);
  let addBusy = $state(false);

  /** A line of context under the title: which source, or how many. */
  const context = $derived.by(() => {
    const sources = catalogs.sources;
    if (sources.length === 0) return 'No catalog sources are configured for this viewer.';
    if (sources.length > 1) return `${sources.length} catalog sources`;
    const only = sources[0];
    const description = only.status === 'ready' ? only.index.description : undefined;
    return description ? `${only.source.name} · ${description}` : only.source.name;
  });

  // The home screen has no scene, whatever the last one was called.
  const currentName = $derived(vs.assetsReady ? vs.catalogName : null);

  function close() {
    shell.catalogBrowserOpen = false;
  }

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

  /** Start on the scene that is up, if it is listed; otherwise on the first catalog. */
  function onOpenAutoFocus(e: Event) {
    const target =
      contentEl?.querySelector<HTMLElement>('.row[aria-current="true"]') ??
      contentEl?.querySelector<HTMLElement>('.row');
    if (!target) return;
    e.preventDefault();
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest' });
  }

  function onOpenChange(open: boolean) {
    if (!open) {
      adding = false;
      addError = null;
    }
  }
</script>

<DialogPrimitive.Root bind:open={shell.catalogBrowserOpen} {onOpenChange}>
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay class="browser-backdrop" />
    <DialogPrimitive.Content
      bind:ref={contentEl}
      class="browser"
      {onOpenAutoFocus}
      onEscapeKeydown={(e) => {
        // Handled: the viewer's own Escape handling must not also dismiss a
        // panel behind the browser.
        e.preventDefault();
        close();
      }}
    >
      <header class="head">
        <div class="head-text">
          <DialogPrimitive.Title class="title">Open catalog</DialogPrimitive.Title>
          <DialogPrimitive.Description class="context">{context}</DialogPrimitive.Description>
        </div>
        {#if currentName}
          <div class="current" title="Loaded now">
            <span class="current-label">Current:</span> {currentName}
          </div>
        {/if}
        <DialogPrimitive.Close class="close" aria-label="Close">
          <X size={16} />
        </DialogPrimitive.Close>
      </header>

      <div class="body">
        <CatalogList
          sources={catalogs.sources}
          configErrors={catalogs.configErrors}
          currentUrl={currentName ? catalogs.currentUrl : null}
          currentScriptUrl={catalogs.currentScriptUrl}
          onSelect={select}
        />
      </div>

      <footer class="foot">
        <button class="foot-action" onclick={openLocal}>Open local catalog…</button>
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
                {addBusy ? 'Adding…' : 'Add'}
              </button>
              <button class="foot-action" type="button" onclick={() => { adding = false; addError = null; }}>
                Cancel
              </button>
            </form>
            {#if addError}<p class="add-error">{addError}</p>{/if}
          {:else}
            <button class="foot-action" onclick={() => (adding = true)}>Add catalog source…</button>
          {/if}
        {/if}
        <span class="foot-hint">Or drop a catalog folder anywhere</span>
      </footer>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
</DialogPrimitive.Root>

<style>
  :global(.browser-backdrop) {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: rgba(0, 0, 0, 0.46);
    backdrop-filter: blur(2px);
  }

  :global(.browser) {
    position: fixed;
    z-index: 201;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    width: min(1120px, 88vw);
    max-height: min(820px, 84vh);
    border: 1px solid var(--color-chrome-border);
    border-radius: 10px;
    background:
      linear-gradient(180deg, var(--color-chrome-highlight), transparent 48px),
      rgba(9, 10, 13, 0.92);
    backdrop-filter: blur(14px);
    box-shadow: var(--shadow-float), inset 0 1px rgba(255, 255, 255, 0.025);
    color: var(--color-text-primary);
    outline: none;
    overflow: hidden;
  }
  @media (max-width: 719px) {
    /* A phone gets the whole screen: a sheet, not a box with margins. */
    :global(.browser) {
      inset: 0;
      transform: none;
      width: 100%;
      max-height: none;
      border: none;
      border-radius: 0;
    }
  }

  .head {
    display: flex;
    align-items: flex-start;
    gap: 1.5rem;
    padding: 22px 24px 18px 28px;
    border-bottom: 1px solid var(--color-chrome-divider);
  }
  .head-text {
    flex: 1;
    min-width: 0;
  }
  :global(.browser .title) {
    font-size: 19px;
    font-weight: 600;
    letter-spacing: -0.005em;
    line-height: 1.25;
    color: var(--color-text-primary);
  }
  :global(.browser .context) {
    margin-top: 4px;
    font-size: 12.5px;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .current {
    flex-shrink: 1;
    min-width: 0;
    max-width: 18rem;
    padding-top: 5px;
    font-size: 12.5px;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .current-label {
    color: var(--color-text-muted);
  }
  :global(.browser .close) {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    margin: -2px -4px 0 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      color var(--duration-chrome) var(--ease-chrome),
      background var(--duration-chrome) var(--ease-chrome);
  }
  :global(.browser .close:hover) {
    color: var(--color-text-primary);
    background: var(--color-control-hover);
  }
  :global(.browser .close:focus-visible) {
    outline: none;
    box-shadow: var(--focus-chrome);
  }

  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 20px 28px 24px;
    scrollbar-width: thin;
    scrollbar-color: var(--color-surface-3) transparent;
  }

  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 18px;
    padding: 12px 28px 14px;
    border-top: 1px solid var(--color-chrome-divider);
  }
  .foot-action {
    padding: 4px 0;
    border: none;
    background: transparent;
    font-size: 12.5px;
    color: var(--color-text-secondary);
    cursor: pointer;
    border-radius: 3px;
    transition: color var(--duration-chrome) var(--ease-chrome);
  }
  .foot-action:hover {
    color: var(--color-text-primary);
  }
  .foot-action:focus-visible,
  .add-btn:focus-visible,
  .add-input:focus-visible {
    outline: none;
    box-shadow: var(--focus-chrome);
  }
  .foot-hint {
    margin-left: auto;
    font-size: 11.5px;
    color: var(--color-text-muted);
  }
  @media (max-width: 719px) {
    .head {
      padding: calc(18px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) 14px calc(18px + env(safe-area-inset-left));
    }
    .body {
      padding: 16px 18px 20px;
    }
    .foot {
      padding: 10px 18px calc(12px + env(safe-area-inset-bottom));
    }
    .current,
    .foot-hint {
      display: none;
    }
  }

  .add {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .add-input {
    width: min(22rem, 60vw);
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--color-border-default);
    border-radius: 5px;
    background: var(--color-control);
    color: var(--color-text-primary);
    font-size: 12.5px;
  }
  .add-btn {
    height: 28px;
    padding: 0 12px;
    border: 1px solid var(--color-border-default);
    border-radius: 5px;
    background: transparent;
    color: var(--color-text-secondary);
    font-size: 12.5px;
    cursor: pointer;
  }
  .add-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .add-error {
    flex-basis: 100%;
    font-size: 12px;
    color: var(--color-text-secondary);
    overflow-wrap: anywhere;
  }
</style>
