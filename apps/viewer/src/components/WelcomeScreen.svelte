<script lang="ts">
  import { vs } from "../lib/viewer-state.svelte";
  import {
    groupEntries,
    type CatalogEntry,
    type CatalogSourceState,
  } from "../lib/catalog-sources";

  interface Props {
    /** The deployment's catalog sources — possibly none. */
    sources: CatalogSourceState[];
    /** Problems with the deployment's source configuration itself. */
    configErrors?: string[];
    onLoadCatalog: (entry: CatalogEntry) => void;
    onDrop: (dt: DataTransfer) => void;
    onFiles: (files: File[]) => void;
  }

  let { sources, configErrors = [], onLoadCatalog, onDrop, onFiles }: Props = $props();

  let fileInput: HTMLInputElement;
  let dragging = $state(false);

  // A single source is the whole list, so its name would only restate the
  // page; with several, each one's catalogs sit under its name.
  const showSourceNames = $derived(sources.length > 1);

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragging = true;
  }
  function handleDragLeave() {
    dragging = false;
  }
  function handleDropEvent(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    if (e.dataTransfer) onDrop(e.dataTransfer);
  }
  function handleFileInput() {
    if (fileInput.files) onFiles(Array.from(fileInput.files));
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="welcome-bg"
  class:dragging
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDropEvent}
  onclick={() => fileInput?.click()}
>
  <div class="welcome-card" onclick={(e) => e.stopPropagation()}>
    <!-- Title block -->
    <div class="mb-8">
      <h1
        class="text-6xl font-bold tracking-tight text-text-primary leading-none"
      >
        Cosmolabe
      </h1>
      <p class="text-text-secondary mt-3 text-[14px] leading-relaxed max-w-prose">
        3D space mission visualization in the browser. Render trajectories, planetary systems, sensor frustums, and mission events from SPICE kernels, TLE data, or Cosmographia catalogs.
      </p>
    </div>

    <input
      bind:this={fileInput}
      type="file"
      multiple
      accept=".json,.bsp,.tls,.tpc,.xyzv,.tf,.tsc,.ti,.ck,.bc,.bpc,.spk,.pck,.fk"
      class="hidden"
      onchange={handleFileInput}
    />

    {#if vs.showLoading}
      <div class="w-full max-w-80">
        <div class="w-full h-px bg-surface-3 rounded overflow-hidden">
          <div
            class="h-full bg-text-secondary rounded transition-[width] duration-200"
            style="width: {Math.min(100, vs.loadingProgress)}%"
          ></div>
        </div>
        <div class="text-text-muted text-[11px] mt-2">{vs.loadingLabel}</div>
        {#if vs.loadingDetail}
          <div class="text-text-muted text-[11px] opacity-50">
            {vs.loadingDetail}
          </div>
        {/if}
      </div>
    {:else}
      {#each configErrors as message}
        <p class="source-error mb-4">{message}</p>
      {/each}

      {#each sources as state (state.source.id)}
        <div class="source">
          {#if showSourceNames || state.status === "error"}
            <h2 class="source-name">{state.source.name}</h2>
          {/if}
          {#if state.status === "loading"}
            <p class="text-text-muted text-[12px]">Loading catalogs…</p>
          {:else if state.status === "error"}
            <p class="source-error">
              Couldn't load this catalog source ({state.error}).
              <span class="opacity-60">{state.indexUrl}</span>
            </p>
          {:else if state.index.catalogs.length === 0}
            <p class="text-text-muted text-[12px]">No catalogs in this source.</p>
          {:else}
            <!-- CSS columns flow groups evenly into 1/2 columns -->
            <div class="demo-columns">
              {#each groupEntries(state.index.catalogs) as group}
                <div class="demo-section">
                  {#if group.heading}
                    <h3 class="demo-heading">{group.heading}</h3>
                  {/if}
                  <div class="flex flex-col gap-0.5">
                    {#each group.entries as entry (entry.id)}
                      <button
                        class="demo-item"
                        onclick={(e: MouseEvent) => {
                          e.stopPropagation();
                          onLoadCatalog(entry);
                        }}
                      >
                        <div class="demo-item-label">{entry.name}</div>
                        {#if entry.description}
                          <div class="demo-item-desc">{entry.description}</div>
                        {/if}
                      </button>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}

      <!-- Drop hint -->
      <div class="w-full" class:drop-hint-separated={sources.length > 0 || configErrors.length > 0}>
        <p class="text-text-muted text-[12px]">
          Drop a catalog folder here, or click to browse files
        </p>
        <p class="text-text-muted text-[11px] mt-1 opacity-40">
          .json &middot; .bsp &middot; .tls &middot; .tpc &middot; .tf &middot;
          .ck
        </p>
      </div>
    {/if}
  </div>
</div>

<style>
  .welcome-bg {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    overflow-y: auto;
    z-index: 100;
    cursor: pointer;
    /* Subtle radial gradient — dark center fading to slightly lighter edge, gives depth */
    background: radial-gradient(
      ellipse 80% 60% at 50% 45%,
      rgba(18, 18, 24, 0.97) 0%,
      rgba(0, 0, 0, 0.99) 100%
    );
    transition: background 0.2s ease;
  }
  .welcome-bg.dragging {
    background: radial-gradient(
      ellipse 80% 60% at 50% 45%,
      rgba(25, 25, 35, 0.98) 0%,
      rgba(0, 0, 0, 1) 100%
    );
  }

  .welcome-card {
    cursor: default;
    max-width: 760px;
    width: 100%;
    padding: 2rem;
    margin: auto;
  }

  .source + .source {
    margin-top: 2rem;
  }
  .source-name {
    font-size: 16px;
    font-weight: 600;
    color: var(--color-text-primary);
    margin-bottom: 1rem;
  }
  .source-error {
    font-size: 12px;
    color: var(--color-text-secondary);
    overflow-wrap: anywhere;
  }
  .drop-hint-separated {
    margin-top: 2rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--color-border);
  }

  /* CSS multi-column flows sections evenly without row alignment */
  .demo-columns {
    column-count: 1;
    column-gap: 2.5rem;
  }
  @media (min-width: 640px) {
    .demo-columns {
      column-count: 2;
    }
  }
  .demo-section {
    break-inside: avoid;
    margin-bottom: 1.75rem;
  }
  .demo-section:last-child {
    margin-bottom: 0;
  }

  .demo-heading {
    /* display: inline-flex; */
    font-size: 11px;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    margin-bottom: 0.5rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid color-mix(in srgb, var(--color-text-muted) 35%, transparent);
  }

  .demo-item {
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    margin-left: -0.75rem;
    margin-right: -0.75rem;
    cursor: pointer;
    transition: background 0.12s ease;
  }
  .demo-item:hover {
    background: var(--color-surface-2);
  }
  .demo-item-label {
    font-size: 14px;
    font-weight: 500;
    color: var(--color-text-primary);
    line-height: 1.3;
  }
  .demo-item-desc {
    font-size: 12px;
    color: var(--color-text-secondary);
    line-height: 1.35;
    margin-top: 2px;
  }
</style>
