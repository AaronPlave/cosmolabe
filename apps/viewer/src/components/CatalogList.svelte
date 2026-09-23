<script lang="ts">
  /**
   * The deployment's catalogs as a plain text list (issue #94): source, then
   * group, then one row per catalog. Shared by the home screen and the
   * in-viewer switcher, so both list exactly what the deployment configured
   * (#93) — a mission deployment never shows an Examples section it does not
   * have.
   *
   * Text rather than cards on purpose. The list is a way into a scene, not a
   * gallery; a thumbnail per row would cost more than the scene it previews.
   */
  import { groupEntries, type CatalogEntry, type CatalogSourceState } from '../lib/catalog-sources';

  interface Props {
    sources: CatalogSourceState[];
    configErrors?: string[];
    onSelect: (sourceId: string, entry: CatalogEntry) => void;
    /** Catalog URL of the scene that is up, marked rather than hidden. */
    currentUrl?: string | null;
    /** Tighter rows and no descriptions, for the switcher popover. */
    dense?: boolean;
  }

  let { sources, configErrors = [], onSelect, currentUrl = null, dense = false }: Props = $props();

  // A single source is the whole list, so its name would only restate the
  // surface around it; with several, each one's catalogs sit under its name.
  const showSourceNames = $derived(sources.length > 1);
</script>

<div class="catalog-list" class:dense>
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
                {@const current = entry.catalogUrl === currentUrl}
                <li>
                  <button
                    class="row"
                    aria-current={current ? 'true' : undefined}
                    title={dense ? entry.description : undefined}
                    onclick={() => onSelect(state.source.id, entry)}
                  >
                    <span class="row-name">{entry.name}</span>
                    {#if !dense && entry.description}
                      <span class="row-desc">{entry.description}</span>
                    {/if}
                    {#if current}<span class="row-current">current</span>{/if}
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
    margin-top: 1.25rem;
  }
  .dense .source + .source {
    margin-top: 0.75rem;
  }
  .source-name {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-primary);
    margin-bottom: 0.5rem;
  }
  .note {
    font-size: 12px;
    color: var(--color-text-muted);
    overflow-wrap: anywhere;
  }
  .note.error {
    color: var(--color-text-secondary);
  }
  .note + .note,
  .note + .source {
    margin-top: 0.5rem;
  }

  .group + .group {
    margin-top: 1rem;
  }
  .dense .group + .group {
    margin-top: 0.625rem;
  }
  .group-heading {
    font-size: 10px;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    margin-bottom: 0.25rem;
  }

  .row {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 4px;
    padding: 0.3rem 0.5rem;
    margin: 0 -0.5rem;
    width: calc(100% + 1rem);
    cursor: pointer;
    transition: background var(--duration-chrome) var(--ease-chrome);
  }
  .dense .row {
    padding: 0.25rem 0.5rem;
  }
  .row:hover {
    background: var(--color-control-hover);
  }
  .row:focus-visible {
    outline: none;
    box-shadow: var(--focus-chrome);
  }
  .row-name {
    flex-shrink: 0;
    font-size: 13px;
    color: var(--color-text-primary);
    line-height: 1.35;
  }
  .row-desc {
    min-width: 0;
    font-size: 12px;
    color: var(--color-text-muted);
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-current {
    margin-left: auto;
    flex-shrink: 0;
    font-size: 10px;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .row[aria-current='true'] .row-name {
    color: var(--color-chrome-active);
  }

  @media (max-width: 639px) {
    /* A phone has no room for name and description side by side. */
    .row {
      flex-direction: column;
      gap: 0;
    }
    .row-desc {
      white-space: normal;
    }
    .row-current {
      margin-left: 0;
    }
  }
</style>
