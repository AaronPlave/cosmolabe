<script lang="ts">
  /**
   * The start state with no scene up (issue #94).
   *
   * Deliberately sparse: what Cosmolabe is, two ways in, and a short list of
   * catalogs to start with. That list — and whether there is one at all — comes
   * from the deployment's catalog sources (#93); a mission deployment lists its
   * own catalogs, and a bare viewer with no sources is just the local-open
   * action. The full list is one press away rather than the page itself.
   *
   * Loading is not this screen's job any more (LoadingScreen), and neither is
   * switching catalogs once a scene is up (CatalogMenu).
   */
  import CatalogList from './CatalogList.svelte';
  import { catalogs, pickLocalFiles } from '../lib/catalogs.svelte';
  import { browseLabel, featuredEntries, allEntries } from '../lib/catalog-nav';
  import type { CatalogEntry } from '../lib/catalog-sources';

  interface Props {
    onSelect: (sourceId: string, entry: CatalogEntry) => void;
    onDrop: (dt: DataTransfer) => void;
    onFiles: (files: File[]) => void;
  }

  let { onSelect, onDrop, onFiles }: Props = $props();

  let browsing = $state(false);
  let dragging = $state(false);

  const featured = $derived(featuredEntries(catalogs.sources));
  const total = $derived(allEntries(catalogs.sources).length);
  const browse = $derived(browseLabel(catalogs.sources));
  const pending = $derived(catalogs.sources.some((s) => s.status === 'loading'));
  // Problems are only worth the home screen's space when they leave it with
  // nothing to offer; otherwise the full list, one press away, reports them.
  const problems = $derived(
    catalogs.configErrors.length > 0 || catalogs.sources.some((s) => s.status === 'error'),
  );
  // With one source the short list sits under that source's name; with several
  // it is a cross-section, so it gets a neutral heading.
  const listHeading = $derived(catalogs.sources.length === 1 ? catalogs.sources[0].source.name : 'Start with');

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
  class:dragging
  role="region"
  aria-label="Cosmolabe home"
  ondragover={handleDragOver}
  ondragleave={() => (dragging = false)}
  ondrop={handleDropEvent}
>
  <!-- Restrained orbital geometry: thin rings and a few points, low contrast.
       Decoration only, so it is hidden from assistive tech and never takes a
       pointer. -->
  <svg class="orbits" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <g fill="none" stroke="currentColor" stroke-width="1" vector-effect="non-scaling-stroke">
      <circle cx="760" cy="520" r="120" />
      <ellipse cx="760" cy="520" rx="260" ry="236" />
      <ellipse cx="760" cy="520" rx="430" ry="380" stroke-dasharray="2 6" />
      <path d="M 180 980 A 700 700 0 0 1 980 250" />
    </g>
    <g fill="currentColor">
      <circle cx="760" cy="520" r="3" />
      <circle cx="880" cy="520" r="2" />
      <circle cx="570" cy="360" r="1.6" />
      <circle cx="1010" cy="790" r="1.6" />
    </g>
  </svg>

  <main class="home-body">
    <h1 class="title">Cosmolabe</h1>
    <p class="lede">
      3D space mission visualization in the browser.
      Render trajectories, planetary systems, sensor frustums, and mission events from SPICE kernels, TLE data, or Cosmographia catalogs.
    </p>

    <div class="actions">
      {#if browse && total > featured.length}
        <button class="action primary" aria-expanded={browsing} onclick={() => (browsing = !browsing)}>
          {browsing ? 'Show fewer' : browse}
        </button>
      {/if}
      <button class="action" class:primary={!browse} onclick={() => pickLocalFiles(onFiles)}>
        Open local catalog…
      </button>
    </div>

    {#if catalogs.loadError}
      <p class="load-error" role="alert">{catalogs.loadError}</p>
    {/if}

    {#if browsing || (problems && featured.length === 0)}
      <div class="list full">
        <CatalogList sources={catalogs.sources} configErrors={catalogs.configErrors} {onSelect} />
      </div>
    {:else if featured.length > 0}
      <div class="list">
        <h2 class="list-heading">{listHeading}</h2>
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
  .home {
    position: absolute;
    inset: 0;
    z-index: 100;
    display: flex;
    overflow-y: auto;
    background: var(--color-canvas);
    color: var(--color-text-primary);
    transition: background var(--duration-chrome) var(--ease-chrome);
  }
  .home.dragging {
    background: var(--color-surface-0);
  }

  .orbits {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    color: var(--color-text-primary);
    opacity: 0.07;
    pointer-events: none;
  }

  .home-body {
    position: relative;
    width: 100%;
    max-width: 34rem;
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

  .title {
    font-size: 28px;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.1;
  }
  .lede {
    margin-top: 0.75rem;
    font-size: 13px;
    line-height: 1.55;
    color: var(--color-text-secondary);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 1.5rem;
  }
  .action {
    height: 30px;
    padding: 0 0.75rem;
    border: 1px solid var(--color-border-default);
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--color-text-secondary);
    font-size: 12px;
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
    color: var(--color-text-primary);
    border-color: var(--color-border-strong);
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
    margin-top: 2rem;
  }
  .list-heading {
    font-size: 10px;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    margin-bottom: 0.375rem;
  }
  .start-row {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    width: calc(100% + 1rem);
    margin: 0 -0.5rem;
    padding: 0.3rem 0.5rem;
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
    font-size: 13px;
    color: var(--color-text-primary);
  }
  .start-desc {
    min-width: 0;
    font-size: 12px;
    color: var(--color-text-muted);
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
    margin-top: 2.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--color-border-subtle);
    font-size: 11px;
    color: var(--color-text-muted);
  }
  .links {
    display: flex;
    gap: 0.875rem;
  }
  .links a {
    color: var(--color-text-muted);
    text-decoration: none;
    border-radius: 2px;
  }
  .links a:hover {
    color: var(--color-text-secondary);
  }
</style>
