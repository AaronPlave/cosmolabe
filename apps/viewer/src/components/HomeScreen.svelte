<script lang="ts">
  /**
   * The start state with no scene up (issue #94).
   *
   * Deliberately sparse: what Cosmolabe is, two ways in, and a short list of
   * catalogs to start with. That list — and whether there is one at all — comes
   * from the deployment's catalog sources (#93); a mission deployment lists its
   * own catalogs, and a bare viewer with no sources is just the local-open
   * action. The full list is one press away, in the same catalog browser the
   * viewer's folder button opens — an overlay above this screen, which itself
   * never grows or rearranges, however much a deployment offers.
   *
   * Loading is not this screen's job any more (LoadingScreen), and neither is
   * browsing the full list of catalogs (CatalogBrowser).
   *
   * Behind it, on the viewer's canvas, the renderer draws a presentation-only
   * scene (lib/hero.ts); this screen is an overlay with a scrim that keeps the
   * copy readable over it, and stays opaque until that scene has drawn.
   */
  import { catalogs, pickLocalFiles } from '../lib/catalogs.svelte';
  import { shell } from '../lib/shell.svelte';
  import { browseLabel, featuredEntries, allEntries } from '../lib/catalog-nav';
  import type { CatalogEntry } from '../lib/catalog-sources';
  import { ChevronRight } from 'lucide-svelte';

  interface Props {
    /** The renderer's backdrop scene is drawn and can show through (lib/hero.ts). */
    backdrop?: boolean;
    onSelect: (sourceId: string, entry: CatalogEntry) => void;
    onDrop: (dt: DataTransfer) => void;
    onFiles: (files: File[]) => void;
  }

  let { backdrop = false, onSelect, onDrop, onFiles }: Props = $props();

  let dragging = $state(false);

  const featured = $derived(featuredEntries(catalogs.sources));
  const total = $derived(allEntries(catalogs.sources).length);
  const browse = $derived(browseLabel(catalogs.sources));
  const pending = $derived(catalogs.sources.some((s) => s.status === 'loading'));
  // Problems are only worth the home screen's space when they leave it with
  // nothing to offer; otherwise the browser, one press away, reports them.
  const problems = $derived([
    ...catalogs.configErrors,
    ...catalogs.sources.flatMap((s) =>
      s.status === 'error' ? [`Couldn't load ${s.source.name} (${s.error}).`] : [],
    ),
  ]);

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragging = true;
  }
  function handleDropEvent(e: DragEvent) {
    e.preventDefault();
    // Handled here rather than by the document listener, so it must not reach it too.
    e.stopPropagation();
    dragging = false;
    if (e.dataTransfer) onDrop(e.dataTransfer);
  }
</script>

<div
  class="home"
  class:backdrop
  class:dragging
  role="region"
  aria-label="Cosmolabe home"
  ondragover={handleDragOver}
  ondragleave={() => (dragging = false)}
  ondrop={handleDropEvent}
>

  <main class="home-body">
    <h1 class="title">Cosmolabe</h1>
    <p class="lede">
      3D space mission visualization in the browser.
      Render trajectories, planetary systems, sensor frustums, and mission events from SPICE kernels, TLE data, or Cosmographia catalogs.
    </p>

    <div class="actions">
      {#if browse && total > featured.length}
        <button
          class="action primary"
          aria-haspopup="dialog"
          aria-expanded={shell.catalogBrowserOpen}
          onclick={() => (shell.catalogBrowserOpen = true)}
        >
          {browse}
          <ChevronRight size={15} strokeWidth={2} aria-hidden="true" />
        </button>
      {/if}
      <button class="action" class:primary={!browse} class:link={!!browse} onclick={() => pickLocalFiles(onFiles)}>
        Open local catalog…
      </button>
    </div>

    {#if catalogs.loadError}
      <p class="load-error" role="alert">{catalogs.loadError}</p>
    {/if}

    {#if featured.length > 0}
      <div class="list">
        <h2 class="list-heading">Start with</h2>
        <ul>
          {#each featured as item (`${item.sourceId}/${item.entry.id}`)}
            <li>
              <button class="start-row" onclick={() => onSelect(item.sourceId, item.entry)}>
                <span class="start-name">{item.entry.name}</span>
                {#if item.entry.description}<span class="start-desc">{item.entry.description}</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {:else if pending}
      <p class="hint">Loading catalogs…</p>
    {:else}
      {#each problems as message}
        <p class="load-error">{message}</p>
      {/each}
    {/if}

    <footer class="foot">
      <span>Or drop a catalog folder or kernel files anywhere.</span>
      <span class="links">
        <a href="https://github.com/AaronPlave/cosmolabe/tree/main/docs" target="_blank" rel="noopener noreferrer">Docs</a>
        <a href="https://github.com/AaronPlave/cosmolabe" target="_blank" rel="noopener noreferrer">GitHub</a>
      </span>
    </footer>
  </main>
</div>

<style>
  /* Opaque until the backdrop scene has drawn, then a scrim over it: dark
     behind the copy, clear over the planet on the right. */
  .home {
    position: absolute;
    inset: 0;
    z-index: 100;
    display: flex;
    overflow-y: auto;
    color: var(--color-text-primary);
  }
  .home::before {
    content: '';
    position: fixed;
    inset: 0;
    background: var(--color-canvas);
    pointer-events: none;
    transition: opacity 1.2s var(--ease-chrome);
  }
  .home::after {
    content: '';
    position: fixed;
    inset: 0;
    background: linear-gradient(
      90deg,
      rgba(0, 0, 0, 0.82) 0%,
      rgba(0, 0, 0, 0.66) 38%,
      rgba(0, 0, 0, 0.2) 58%,
      rgba(0, 0, 0, 0) 72%
    );
    pointer-events: none;
  }
  .home.backdrop::before {
    opacity: 0;
  }
  .home.dragging::before {
    opacity: 0.6;
    background: var(--color-surface-1);
  }
  @media (max-width: 719px) {
    /* A phone's copy spans the width, so the scrim runs top to bottom:
       clear over the planet's corner, dark from the title down. */
    .home::after {
      background: linear-gradient(
        180deg,
        rgba(0, 0, 0, 0.1) 0%,
        rgba(0, 0, 0, 0.72) 30%,
        rgba(0, 0, 0, 0.86) 100%
      );
    }
  }

  .home-body {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 608px;
    margin: auto;
    /* Sits left of centre on a wide screen, like a document; centred text
       would read as a splash page. */
    margin-left: max(1rem, 12vw);
    padding: 3rem 1rem;
  }
  @media (max-width: 639px) {
    .home-body {
      margin-left: auto;
      padding: 2rem 1rem;
    }
  }

  /* Four steps of emphasis: the title and Browse; the lede and catalog
     names; descriptions, the secondary action and the list label; then the
     footer and the drawing. */
  .title {
    font-size: 42px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.05;
    color: #f2f3f5;
  }
  .lede {
    max-width: 34em;
    margin-top: 0.9rem;
    font-size: 15.5px;
    line-height: 1.55;
    color: color-mix(in srgb, var(--color-text-secondary) 55%, var(--color-text-primary));
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin-top: 1.75rem;
  }
  /* Secondary by default: a ghost, dimmer text, no box until hovered. */
  .action {
    height: 34px;
    padding: 0 12px;
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--color-text-secondary);
    font-size: 13px;
    cursor: pointer;
    transition:
      color var(--duration-chrome) var(--ease-chrome),
      background var(--duration-chrome) var(--ease-chrome),
      border-color var(--duration-chrome) var(--ease-chrome);
  }
  .action:hover {
    color: var(--color-text-primary);
    background: var(--color-control-hover);
  }
  .action.primary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 36px;
    padding: 0 12px 0 16px;
    border-color: rgba(200, 210, 230, 0.26);
    background: #2a2e36;
    color: #f5f6f8;
    font-weight: 500;
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.07), 0 1px 2px rgba(0, 0, 0, 0.4);
  }
  .action.primary :global(svg) {
    opacity: 0.7;
    transition: transform var(--duration-chrome) var(--ease-chrome);
  }
  .action.primary:hover {
    border-color: rgba(200, 210, 230, 0.36);
    background: #333842;
  }
  .action.primary:hover :global(svg) {
    transform: translateX(2px);
  }
  /* Beside a primary action, the local open is nearly a link. */
  .action.link {
    padding: 0 8px;
    text-decoration: underline;
    text-decoration-color: transparent;
    text-underline-offset: 3px;
  }
  .action.link:hover {
    background: transparent;
    text-decoration-color: currentColor;
  }
  .action:focus-visible,
  .start-row:focus-visible,
  .links a:focus-visible {
    outline: none;
    box-shadow: var(--focus-chrome);
  }

  .load-error {
    margin-top: 1rem;
    font-size: 12px;
    color: var(--color-text-secondary);
    overflow-wrap: anywhere;
  }

  .list {
    margin-top: 2.5rem;
  }
  .list-heading {
    font-size: 10px;
    font-weight: 500;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.14em;
    margin-bottom: 0.5rem;
  }
  .start-row {
    display: flex;
    align-items: baseline;
    gap: 0.875rem;
    width: calc(100% + 1rem);
    margin: 0 -0.5rem;
    padding: 0.35rem 0.5rem;
    border: none;
    border-radius: 4px;
    background: transparent;
    text-align: left;
    cursor: pointer;
    transition: background var(--duration-chrome) var(--ease-chrome);
  }
  .start-row:hover {
    background: var(--color-control-hover);
  }
  .start-name {
    flex-shrink: 0;
    font-size: 14.5px;
    font-weight: 500;
    color: var(--color-text-primary);
  }
  .start-desc {
    min-width: 0;
    font-size: 13px;
    color: color-mix(in srgb, var(--color-text-secondary) 72%, var(--color-text-muted));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @media (max-width: 639px) {
    .start-row {
      flex-direction: column;
      gap: 0;
    }
    .start-desc {
      white-space: normal;
    }
  }

  .hint {
    margin-top: 2rem;
    font-size: 12px;
    color: var(--color-text-muted);
  }

  .foot {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.5rem 1rem;
    margin-top: 2.75rem;
    padding-top: 1rem;
    border-top: 1px solid var(--color-border-subtle);
    font-size: 11.5px;
    color: color-mix(in srgb, var(--color-text-muted) 72%, var(--color-text-faint));
  }
  .links {
    display: flex;
    gap: 0.875rem;
  }
  .links a {
    color: inherit;
    text-decoration: none;
    border-radius: 2px;
  }
  .links a:hover {
    color: var(--color-text-secondary);
  }
</style>
