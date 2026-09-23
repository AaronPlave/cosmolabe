<script lang="ts">
  /**
   * The start state with no scene up (issue #94).
   *
   * Deliberately sparse: what Cosmolabe is, two ways in, and a short list of
   * catalogs to start with. That list — and whether there is one at all — comes
   * from the deployment's catalog sources (#93); a mission deployment lists its
   * own catalogs, and a bare viewer with no sources is just the local-open
   * action. The full list is one press away, in the same catalog chooser the
   * viewer's rail opens — a popover over this screen, so the screen itself
   * stays this sparse however much a deployment offers.
   *
   * Loading is not this screen's job any more (LoadingScreen), and neither is
   * switching catalogs once a scene is up (CatalogMenu).
   */
  import * as Popover from '$lib/components/ui/popover';
  import CatalogChooser, { CHOOSER_SURFACE, CHOOSER_OVER_PAGE } from './CatalogChooser.svelte';
  import { catalogs, pickLocalFiles } from '../lib/catalogs.svelte';
  import { shell } from '../lib/shell.svelte';
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
  const compact = $derived(shell.layout === 'compact');

  const featured = $derived(featuredEntries(catalogs.sources));
  const total = $derived(allEntries(catalogs.sources).length);
  const browse = $derived(browseLabel(catalogs.sources));
  const pending = $derived(catalogs.sources.some((s) => s.status === 'loading'));
  // Problems are only worth the home screen's space when they leave it with
  // nothing to offer; otherwise the chooser, one press away, reports them.
  const problems = $derived([
    ...catalogs.configErrors,
    ...catalogs.sources.flatMap((s) =>
      s.status === 'error' ? [`Couldn't load ${s.source.name} (${s.error}).`] : [],
    ),
  ]);
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
  <!-- Orbital drafting, kept to the right of the copy: one body, an inner
       circular orbit, an eccentric one with the body at its focus (apsis
       line drawn across it), and part of an outer trajectory. Very low
       contrast, decoration only — hidden from assistive tech, never takes a
       pointer. Narrow screens move it below the copy and drop the outer arc
       rather than let it run through the text. -->
  <svg class="orbits" viewBox="0 0 1000 1000" aria-hidden="true">
    <g fill="none" stroke="currentColor" vector-effect="non-scaling-stroke">
      <g class="ring">
        <circle cx="500" cy="500" r="108" />
        <!-- a = 236, e = 0.35: centre offset c = 83 along the major axis,
             so the body sits at the focus. -->
        <g transform="rotate(-22 500 500)">
          <ellipse cx="583" cy="500" rx="236" ry="221" />
          <line x1="264" y1="500" x2="836" y2="500" class="apsis" />
        </g>
        <!-- Ticks on the inner orbit, like a drafted reference circle. -->
        <path d="M 500 386 V 396 M 614 500 H 604 M 500 614 V 604 M 386 500 H 396" />
      </g>
      <path class="outer" d="M 700 154 A 400 400 0 0 1 331 863" />
    </g>
    <g fill="currentColor">
      <circle cx="500" cy="500" r="3.5" class="body" />
      <circle cx="424" cy="424" r="2" />
      <circle cx="691" cy="269" r="1.8" />
      <circle class="outer" cx="892" cy="583" r="1.8" />
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
        <Popover.Root bind:open={browsing}>
          <Popover.Trigger>
            {#snippet child({ props })}
              <button {...props} class="action primary">{browse}</button>
            {/snippet}
          </Popover.Trigger>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={8}
            collisionPadding={8}
            class="{CHOOSER_SURFACE} {CHOOSER_OVER_PAGE} z-[110] {compact ? 'compact w-[calc(100vw-1rem)]' : 'w-[320px]'}"
          >
            <CatalogChooser {onSelect} {onFiles} close={() => (browsing = false)} />
          </Popover.Content>
        </Popover.Root>
      {/if}
      <button class="action" class:primary={!browse} onclick={() => pickLocalFiles(onFiles)}>
        Open local catalog…
      </button>
    </div>

    {#if catalogs.loadError}
      <p class="load-error" role="alert">{catalogs.loadError}</p>
    {/if}

    {#if featured.length > 0}
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

  /* Centred at ~72% across and sized to the viewport's shorter side, so the
     orbits stay clear of the copy on the left at any desktop aspect. */
  .orbits {
    position: fixed;
    top: 50%;
    left: 72%;
    width: min(52vw, 100vh);
    height: auto;
    aspect-ratio: 1;
    transform: translate(-50%, -50%);
    color: var(--color-text-primary);
    pointer-events: none;
  }
  .orbits .ring {
    stroke-width: 1;
    opacity: 0.13;
  }
  .orbits .apsis {
    stroke-dasharray: 3 5;
    opacity: 0.7;
  }
  .orbits .outer {
    stroke-width: 1;
    stroke-dasharray: 4 5;
    opacity: 0.09;
  }
  .orbits g[fill] > circle {
    opacity: 0.16;
  }
  .orbits g[fill] > .body {
    opacity: 0.3;
  }
  .orbits g[fill] > circle.outer {
    opacity: 0.12;
  }
  @media (max-width: 1279px) {
    /* The copy spans most of the width: sit the drawing low and to the
       right, behind nothing, and without the outer trajectory. */
    .orbits {
      top: auto;
      bottom: 0;
      left: auto;
      right: 0;
      width: min(34rem, 80vw);
      transform: translate(28%, 26%);
    }
    .orbits .outer {
      display: none;
    }
  }
  @media (max-width: 719px) {
    /* A phone's copy fills the width and the footer fills the bottom, so
       just the inner orbits show, as a corner fragment above the title. */
    .orbits {
      top: 0;
      bottom: auto;
      width: 15rem;
      transform: translate(32%, -32%);
    }
    .orbits .apsis {
      display: none;
    }
  }

  .home-body {
    position: relative;
    width: 100%;
    max-width: 576px;
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
    font-size: 31px;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.1;
  }
  .lede {
    margin-top: 0.75rem;
    font-size: 13.75px;
    line-height: 1.55;
    color: color-mix(in srgb, var(--color-text-secondary) 82%, var(--color-text-primary));
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
    color: color-mix(in srgb, var(--color-text-muted) 72%, var(--color-text-secondary));
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
