<script lang="ts">
  /**
   * The deployment's catalogs, as the catalog browser lists them (issue #94):
   * source, then group, then one row per catalog — name and one-line
   * description. Exactly what the deployment configured (#93), so a mission
   * deployment never shows an Examples section it does not have.
   *
   * Groups flow into balanced columns once there is room and are never split
   * across them; a narrow browser is one column. Rows are text, not cards:
   * the list is a way into a scene, not a gallery. The scene that is up is
   * marked quietly, because the browser's header already names it.
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
  // browser's header; with several, each one's catalogs sit under its name.
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
        <div class="groups">
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
                      onclick={() => onSelect(state.source.id, entry)}
                    >
                      <span class="row-name">{entry.name}</span>
                      {#if entry.description}
                        <span class="row-desc">{entry.description}</span>
                      {/if}
                    </button>
                  </li>
                {/each}
              </ul>
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {/each}
</div>

<style>
  .catalog-list {
    container-type: inline-size;
  }

  .source + .source {
    margin-top: 28px;
    padding-top: 22px;
    border-top: 1px solid var(--color-chrome-divider);
  }
  .source-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text-primary);
    margin-bottom: 14px;
  }
  .note {
    font-size: 13px;
    line-height: 1.45;
    color: var(--color-text-muted);
    overflow-wrap: anywhere;
  }
  .note.error {
    color: var(--color-text-secondary);
  }
  .note + .note {
    margin-top: 6px;
  }

  /* Groups flow top to bottom, then into the next column, and stay whole. */
  .groups {
    column-gap: 48px;
  }
  @container (min-width: 640px) {
    .groups {
      column-count: 2;
    }
  }
  .group {
    break-inside: avoid;
    padding-bottom: 30px;
  }

  .group-heading {
    font-size: 12.5px;
    font-weight: 600;
    line-height: 1.3;
    color: var(--color-text-secondary);
    padding: 0 10px 6px;
  }

  .row {
    display: block;
    width: 100%;
    padding: 7px 10px 8px;
    border: none;
    border-radius: 6px;
    background: transparent;
    text-align: left;
    cursor: pointer;
    transition: background var(--duration-chrome) var(--ease-chrome);
  }
  .row:hover {
    background: rgba(220, 224, 232, 0.05);
  }
  .row:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px rgba(220, 224, 232, 0.3);
  }
  .row-name {
    display: block;
    font-size: 14.5px;
    font-weight: 500;
    line-height: 1.3;
    color: color-mix(in srgb, var(--color-text-primary) 88%, var(--color-text-secondary));
  }
  .row-desc {
    display: block;
    margin-top: 2px;
    font-size: 12px;
    font-weight: 400;
    line-height: 1.4;
    color: var(--color-text-muted);
  }
  .row:hover .row-name {
    color: var(--color-text-primary);
  }

  /* The scene that is up: a brighter name on a faint ground. */
  .row[aria-current='true'] {
    background: rgba(220, 224, 232, 0.035);
  }
  .row[aria-current='true'] .row-name {
    color: var(--color-text-primary);
  }
</style>
