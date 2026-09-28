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
   */
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
  class:dragging
  role="region"
  aria-label="Cosmolabe home"
  ondragover={handleDragOver}
  ondragleave={() => (dragging = false)}
  ondrop={handleDropEvent}
>
  <!-- Orbital drafting, kept to the right of the copy. One body with a faint
       halo; an inner circular orbit with a planet and reference ticks; an
       eccentric orbit with the body at its focus, its apsis line and a
       periapsis tick; an inclined orbit whose far half runs behind the body
       (dashed, fainter) and near half in front; part of an outer trajectory
       with a spacecraft and its heading; and a sparse scatter of stars. Line
       weight and opacity step down with distance from the body. Decoration
       only — hidden from assistive tech, never takes a pointer. Narrow
       screens move it below the copy and drop the outer arc rather than let
       it run through the text. -->
  <svg class="orbits" viewBox="0 0 1000 1000" aria-hidden="true">
    <g class="stars" fill="currentColor">
      <circle cx="820" cy="140" r="1.1" opacity="0.2" />
      <circle cx="905" cy="300" r="0.8" opacity="0.13" />
      <circle cx="960" cy="760" r="1.1" opacity="0.16" />
      <circle cx="700" cy="905" r="0.9" opacity="0.11" />
      <circle cx="610" cy="118" r="0.8" opacity="0.12" />
      <circle cx="380" cy="205" r="0.7" opacity="0.09" />
      <circle cx="330" cy="760" r="0.9" opacity="0.1" />
      <circle cx="870" cy="880" r="0.7" opacity="0.13" />
      <circle cx="982" cy="470" r="0.8" opacity="0.1" />
      <circle cx="560" cy="712" r="0.6" opacity="0.08" />
      <circle cx="760" cy="612" r="0.7" opacity="0.1" />
      <circle cx="430" cy="905" r="0.8" opacity="0.08" />
    </g>
    <g fill="none" stroke="currentColor" vector-effect="non-scaling-stroke">
      <circle class="halo" cx="500" cy="500" r="12" />
      <!-- Inclined orbit: far half dashed behind the body, near half solid. -->
      <g transform="rotate(16 500 500)">
        <path class="inclined-far" d="M 240 500 A 260 58 0 0 1 760 500" />
        <path class="inclined-near" d="M 760 500 A 260 58 0 0 1 240 500" />
      </g>
      <circle class="inner" cx="500" cy="500" r="108" />
      <path class="ticks" d="M 500 386 V 396 M 614 500 H 604 M 500 614 V 604 M 386 500 H 396" />
      <!-- a = 236, e = 0.35: centre offset c = 83 along the major axis, so the
           body sits at the near focus and periapsis is the left end. -->
      <g transform="rotate(-22 500 500)">
        <ellipse class="eccentric" cx="583" cy="500" rx="236" ry="221" />
        <line class="apsis" x1="264" y1="500" x2="836" y2="500" />
        <line class="ticks" x1="347" y1="491" x2="347" y2="509" />
      </g>
      <path class="outer" d="M 700 154 A 400 400 0 0 1 331 863" />
      <!-- Spacecraft heading along the outer arc. -->
      <line class="outer heading" x1="876" y1="637" x2="870" y2="654" />
      <!-- A ring around the inner planet. -->
      <circle class="marker-ring" cx="424" cy="424" r="5" />
    </g>
    <g fill="currentColor">
      <circle class="body" cx="500" cy="500" r="3.5" />
      <circle class="marker" cx="424" cy="424" r="1.8" />
      <circle class="marker faint" cx="691" cy="269" r="1.6" />
      <g transform="rotate(16 500 500)"><circle class="marker faint" cx="630" cy="550" r="1.4" /></g>
      <circle class="outer marker" cx="876" cy="637" r="1.8" />
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
        <button
          class="action primary"
          aria-haspopup="dialog"
          aria-expanded={shell.catalogBrowserOpen}
          onclick={() => (shell.catalogBrowserOpen = true)}
        >
          {browse}
        </button>
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
  /* Opacity steps down from the body outwards; line weights stay hairline,
     with the inner orbit a touch heavier. */
  .orbits .inner {
    stroke-width: 1.15;
    opacity: 0.17;
  }
  .orbits .eccentric {
    stroke-width: 1;
    opacity: 0.13;
  }
  .orbits .inclined-near {
    stroke-width: 0.8;
    opacity: 0.08;
  }
  .orbits .inclined-far {
    stroke-width: 0.75;
    stroke-dasharray: 2 4;
    opacity: 0.045;
  }
  .orbits .apsis {
    stroke-width: 0.8;
    stroke-dasharray: 3 5;
    opacity: 0.08;
  }
  .orbits .ticks {
    stroke-width: 1;
    opacity: 0.14;
  }
  .orbits .halo {
    stroke-width: 0.8;
    opacity: 0.08;
  }
  .orbits .marker-ring {
    stroke-width: 0.8;
    opacity: 0.14;
  }
  .orbits .outer {
    stroke-width: 1;
    stroke-dasharray: 4 5;
    opacity: 0.09;
  }
  .orbits .heading {
    stroke-dasharray: none;
    opacity: 0.16;
  }
  .orbits .body {
    opacity: 0.38;
  }
  .orbits .marker {
    opacity: 0.24;
  }
  .orbits .marker.faint {
    opacity: 0.16;
  }
  .orbits circle.outer.marker {
    stroke-dasharray: none;
    opacity: 0.2;
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
    .orbits .apsis,
    .orbits .inclined-far,
    .orbits .inclined-near,
    .orbits .stars {
      display: none;
    }
  }

  .home-body {
    position: relative;
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

  .title {
    font-size: 34px;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.1;
  }
  .lede {
    margin-top: 0.75rem;
    font-size: 14.5px;
    line-height: 1.55;
    color: color-mix(in srgb, var(--color-text-secondary) 68%, var(--color-text-primary));
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 1.5rem;
  }
  .action {
    height: 32px;
    padding: 0 0.75rem;
    border: 1px solid var(--color-border-default);
    border-radius: var(--radius-control);
    background: transparent;
    color: color-mix(in srgb, var(--color-text-secondary) 80%, var(--color-text-primary));
    font-size: 12.5px;
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
    font-size: 10.5px;
    font-weight: 600;
    color: color-mix(in srgb, var(--color-text-muted) 75%, var(--color-text-secondary));
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
    font-size: 14px;
    color: var(--color-text-primary);
  }
  .start-desc {
    min-width: 0;
    font-size: 12.5px;
    color: color-mix(in srgb, var(--color-text-muted) 50%, var(--color-text-secondary));
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
    font-size: 11.5px;
    color: color-mix(in srgb, var(--color-text-muted) 65%, var(--color-text-secondary));
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
