<script lang="ts">
  /**
   * The deployment's catalogs as a dense text list (issue #94): source, then
   * group, then one row per catalog. The body of the catalog chooser, so the
   * home screen's Browse and the in-viewer switcher list exactly what the
   * deployment configured (#93) in exactly the same way — a mission
   * deployment never shows an Examples section it does not have.
   *
   * Text rather than cards on purpose. The list is a way into a scene, not a
   * gallery. Names only; a row's description is its tooltip. The scene that
   * is up is marked quietly, because the chooser's header already names it.
   */
  import { groupEntries, type CatalogEntry, type CatalogSourceState } from '../lib/catalog-sources';

  interface Props {
    sources: CatalogSourceState[];
    configErrors?: string[];
    onSelect: (sourceId: string, entry: CatalogEntry) => void;
    /** Catalog URL of the scene that is up, marked rather than hidden. */
    currentUrl?: string | null;
  }

  let { sources, configErrors = [], onSelect, currentUrl = null }: Props = $props();

  // A single source is the whole list, so its name would only restate the
  // surface around it; with several, each one's catalogs sit under its name.
  const showSourceNames = $derived(sources.length > 1);
</script>

<div class="catalog-list">
  {#each configErrors as message}
    <p class="note error">{message}</p>
  {/each}

  {#each sources as state (state.source.id)}
    <section class="source">
      {#if showSourceNames || state.status === 'error'}
        <h2 class="source-name">{state.source.name}</h2>
      {/if}
      {#if state.status === 'loading'}
        <p class="note">Loading catalogs…</p>
      {:else if state.status === 'error'}
        <p class="note error">
          Couldn't load this catalog source ({state.error}).
          <span class="opacity-60">{state.indexUrl}</span>
        </p>
      {:else if state.index.catalogs.length === 0}
        <p class="note">No catalogs in this source.</p>
      {:else}
        {#each groupEntries(state.index.catalogs) as group}
          <div class="group">
            {#if group.heading}
              <h3 class="group-heading">{group.heading}</h3>
            {/if}
            <ul>
              {#each group.entries as entry (entry.id)}
                <li>
                  <button
                    class="row"
                    aria-current={entry.catalogUrl === currentUrl ? 'true' : undefined}
                    title={entry.description}
                    onclick={() => onSelect(state.source.id, entry)}
                  >
                    {entry.name}
                  </button>
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      {/if}
    </section>
  {/each}
</div>

<style>
  .source + .source {
    margin-top: 0.625rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--color-chrome-divider);
  }
  .source-name {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-text-secondary);
    margin-bottom: 0.125rem;
  }
  .note {
    font-size: 11px;
    line-height: 1.4;
    color: var(--color-text-muted);
    overflow-wrap: anywhere;
    padding: 0.125rem 0;
  }
  .note.error {
    color: var(--color-text-secondary);
  }

  /* Group headings stay well below the rows they label: smaller, wider set,
     muted, and close to their rows. */
  .group {
    margin-top: 0.5rem;
  }
  .group:first-of-type {
    margin-top: 0.125rem;
  }
  .group-heading {
    font-size: 9.5px;
    font-weight: 500;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.14em;
    line-height: 1.2;
    padding: 0.25rem 0 0.1875rem;
    opacity: 0.85;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row {
    display: block;
    width: calc(100% + 0.75rem);
    margin: 0 -0.375rem;
    padding: 0.25rem 0.375rem;
    border: none;
    border-radius: 3px;
    background: transparent;
    text-align: left;
    font-size: 12.5px;
    line-height: 1.3;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
    transition:
      color var(--duration-chrome) var(--ease-chrome),
      background var(--duration-chrome) var(--ease-chrome);
  }
  .row:hover {
    color: var(--color-text-primary);
    background: var(--color-control-hover);
  }
  /* Visible but in the shell's own register: popovers put focus on the
     first row when opened from the keyboard, and the full focus ring there
     reads as a selection. */
  .row:focus-visible {
    outline: none;
    color: var(--color-text-primary);
    box-shadow: inset 0 0 0 1px rgba(220, 224, 232, 0.32);
  }
  /* The scene that is up: brighter, on the shell's own quiet active ground. */
  .row[aria-current='true'] {
    color: var(--color-text-primary);
    background: var(--color-chrome-active-bg);
  }

  @media (max-width: 719px) {
    /* Touch targets. */
    .row {
      padding: 0.4375rem 0.375rem;
      font-size: 13px;
    }
  }
</style>
