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
  <!-- One large dark body off the right edge, lit from behind and to the
       left so only a soft crescent of rim light shows; a small companion on
       one faint orbit, whose far side passes behind the body and near side in
       front of it; and a few faint stars. Decoration only — hidden from
       assistive tech, never takes a pointer — and the quietest thing on the
       page. Narrower screens crop the body further into the corner and drop
       the companion rather than let anything sit behind the text. -->
  <svg class="backdrop" viewBox="0 0 1000 1000" aria-hidden="true">
    <defs>
      <!-- Bounding-box units, so both bodies share the lighting. -->
      <radialGradient id="home-sphere" cx="0.36" cy="0.32" r="0.78">
        <stop offset="0" stop-color="#101216" />
        <stop offset="0.6" stop-color="#060709" />
        <stop offset="1" stop-color="#020203" />
      </radialGradient>
      <linearGradient id="home-rim" x1="0.1" y1="0.05" x2="0.62" y2="0.7">
        <stop offset="0" stop-color="#dfe4ee" stop-opacity="0.34" />
        <stop offset="0.45" stop-color="#dfe4ee" stop-opacity="0.08" />
        <stop offset="1" stop-color="#dfe4ee" stop-opacity="0" />
      </linearGradient>
      <!-- The disc minus a slightly larger one offset away from the light. -->
      <mask id="home-crescent" maskContentUnits="objectBoundingBox">
        <circle cx="0.5" cy="0.5" r="0.5" fill="#fff" />
        <circle cx="0.52" cy="0.525" r="0.502" fill="#000" />
      </mask>
      <!-- A small body needs a proportionally wider crescent to read at all. -->
      <mask id="home-crescent-small" maskContentUnits="objectBoundingBox">
        <circle cx="0.5" cy="0.5" r="0.5" fill="#fff" />
        <circle cx="0.58" cy="0.6" r="0.52" fill="#000" />
      </mask>
      <filter id="home-soft" x="-10%" y="-10%" width="120%" height="120%">
        <feGaussianBlur stdDeviation="2.4" />
      </filter>
      <filter id="home-glow" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="14" />
      </filter>
    </defs>

    <g class="stars" fill="currentColor">
      <circle cx="120" cy="90" r="1.1" opacity="0.22" />
      <circle cx="310" cy="40" r="0.8" opacity="0.14" />
      <circle cx="40" cy="560" r="0.9" opacity="0.14" />
      <circle cx="210" cy="820" r="1" opacity="0.16" />
      <circle cx="420" cy="960" r="0.8" opacity="0.1" />
      <circle cx="610" cy="30" r="0.7" opacity="0.12" />
      <circle cx="930" cy="60" r="0.9" opacity="0.12" />
    </g>

    <!-- Orbit plane tilted 18°; a = 470, b = 120, around the body. -->
    <g class="orbit" fill="none" stroke="currentColor" vector-effect="non-scaling-stroke"
       transform="rotate(18 500 500)">
      <path class="orbit-far" d="M 30 500 A 470 120 0 0 1 970 500" />
    </g>

    <!-- The body: a dark disc, a faint wide glow along the lit limb, and the
         crescent itself. -->
    <circle class="limb-glow" cx="500" cy="500" r="400" fill="none" stroke="url(#home-rim)"
            stroke-width="10" filter="url(#home-glow)" />
    <circle cx="500" cy="500" r="400" fill="url(#home-sphere)" />
    <!-- Blurred after masking, so the crescent's outer edge softens too. -->
    <g filter="url(#home-soft)">
      <circle cx="500" cy="500" r="400" fill="url(#home-rim)" mask="url(#home-crescent)" />
    </g>

    <g class="orbit" fill="none" stroke="currentColor" vector-effect="non-scaling-stroke"
       transform="rotate(18 500 500)">
      <path class="orbit-near" d="M 970 500 A 470 120 0 0 1 30 500" />
    </g>

    <!-- The companion, on the orbit's far side, lit the same way. -->
    <g class="companion">
      <circle cx="66" cy="337" r="24" fill="url(#home-sphere)" />
      <circle cx="66" cy="337" r="24" fill="url(#home-rim)" mask="url(#home-crescent-small)" />
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

  /* Sized to the viewport's height and pushed mostly off the right edge, so
     the body is a cropped horizon well clear of the copy. Fixed boxes add no
     scroll overflow, so the crop costs nothing. */
  .backdrop {
    position: fixed;
    top: 50%;
    right: 0;
    width: min(112vh, 100vw);
    height: auto;
    aspect-ratio: 1;
    transform: translate(42%, -50%);
    color: var(--color-text-primary);
    pointer-events: none;
    overflow: visible;
  }
  .backdrop .orbit {
    stroke-width: 0.9;
  }
  .backdrop .orbit-far {
    opacity: 0.1;
  }
  .backdrop .orbit-near {
    opacity: 0.07;
  }
  .backdrop .limb-glow {
    opacity: 0.22;
  }
  @media (max-width: 1279px) {
    /* The copy spans most of the width: centre the body on the right edge
       and drop the companion, which would sit behind the text. */
    .backdrop {
      width: min(92vh, 72vw);
      transform: translate(50%, -50%);
    }
    .backdrop .companion {
      display: none;
    }
  }
  @media (max-width: 719px) {
    /* A phone keeps a corner of the body above the title, and nothing else. */
    .backdrop {
      top: 0;
      width: 20rem;
      transform: translate(40%, -40%);
    }
    .backdrop .stars,
    .backdrop .orbit {
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
    font-size: 14.5px;
    line-height: 1.55;
    color: color-mix(in srgb, var(--color-text-secondary) 82%, var(--color-text-primary));
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
    padding: 0 16px;
    border-color: rgba(184, 197, 220, 0.2);
    background: #1a1c21;
    color: #f2f3f5;
    font-weight: 500;
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.04);
  }
  .action.primary:hover {
    border-color: rgba(184, 197, 220, 0.28);
    background: #22252b;
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
    font-size: 14px;
    font-weight: 500;
    color: var(--color-text-primary);
  }
  .start-desc {
    min-width: 0;
    font-size: 12.5px;
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
