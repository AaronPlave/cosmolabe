<script lang="ts">
  import { CameraModeName } from '@cosmolabe/three';
  import type { PluginOverlay } from '@cosmolabe/three';
  import { vs, clearLookAt, getRenderer } from '../lib/viewer-state.svelte';
  import { ArrowRight, X } from 'lucide-svelte';

  const frameLabel = $derived.by(() => {
    if (vs.cameraMode === CameraModeName.FREE_ORBIT) return 'Free orbit';
    const mode = vs.cameraMode.replaceAll('-', ' ');
    return vs.trackedBodyName ? `${vs.trackedBodyName} ${mode}` : mode;
  });

  /** Collect plugin overlays grouped by corner position */
  function getPluginOverlays(): Record<string, PluginOverlay[]> {
    const r = getRenderer();
    if (!r) return {};
    const groups: Record<string, PluginOverlay[]> = {};
    for (const plugin of r.getPlugins()) {
      if (!plugin.ui?.overlays) continue;
      for (const overlay of plugin.ui.overlays) {
        if (!groups[overlay.position]) groups[overlay.position] = [];
        groups[overlay.position].push(overlay);
      }
    }
    // Sort by order within each group
    for (const pos in groups) {
      groups[pos].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
    return groups;
  }

  function renderOverlay(overlay: PluginOverlay): string | null {
    const r = getRenderer();
    if (!r) return null;
    const result = overlay.render(vs.et, r.getContext());
    if (result == null) return null;
    if (typeof result === 'string') return result;
    // HTMLElement — return its outerHTML
    return result.outerHTML;
  }
</script>

<!-- View context belongs to the viewport rather than either panel dock. Keeping
     it top-centred gives tracking, look-at and reference frame one stable home
     without competing with the rail or timeline. -->
{#if vs.trackedBodyName || vs.lookAtBodyName || vs.cameraMode !== CameraModeName.FREE_ORBIT}
  <div data-scene-occluder class="view-context pointer-events-auto absolute left-1/2 top-3 z-10 flex max-w-[calc(100%-7rem)] -translate-x-1/2 items-center">
    {#if vs.trackedBodyName || vs.lookAtBodyName}
      <span class="context-label">Tracking</span>
      <span class="context-value truncate">{vs.trackedBodyName ?? 'Free camera'}</span>
      {#if vs.lookAtBodyName}
        <ArrowRight class="context-arrow" size={13} aria-hidden="true" />
        <span class="context-value truncate">{vs.lookAtBodyName}</span>
        <button class="clear-look-at" aria-label="Clear look-at target" title="Clear look-at target" onclick={clearLookAt}>
          <X size={12} />
        </button>
      {/if}
      <span class="context-divider" aria-hidden="true"></span>
    {/if}
    <span class="context-label">Frame</span>
    <span class="frame-value truncate">{frameLabel}</span>
  </div>
{/if}


<!-- Script caption (`displayNote`).
     `{#if}`-guarded, never mounted-and-hidden: an always-rendered box with a
     backdrop-blur would bleed into every visual-regression golden.
     Plain interpolation, never {@html} — unlike the plugin overlay below, this
     text comes from a script or an embed host. -->
{#if vs.note}
  <div
    class="absolute left-1/2 -translate-x-1/2 z-10 max-w-[70%] pointer-events-none"
    style="bottom: calc(var(--size-dock-base) + 3rem)"
  >
    <p class="m-0 px-3 py-1.5 rounded-md bg-black/70 backdrop-blur-sm border border-border text-center text-[13px] leading-snug text-text-primary whitespace-pre-wrap">
      {vs.note}
    </p>
  </div>
{/if}


<!-- Plugin overlays (rendered per corner) -->
{#each Object.entries(getPluginOverlays()) as [position, overlays]}
  <!-- Plugin corners clear the rail and the timeline the same way. -->
  {@const posStyle = {
    'top-left': 'top: 2.5rem; left: calc(var(--size-rail) + 1rem)',
    'top-right': 'top: 0.625rem; right: 0.75rem',
    'bottom-left': 'left: calc(var(--size-rail) + 1rem); bottom: calc(var(--size-dock-base) + 0.5rem)',
    'bottom-right': 'right: 0.75rem; bottom: calc(var(--size-dock-base) + 0.5rem)',
  }[position] ?? 'top: 0.625rem; left: calc(var(--size-rail) + 1rem)'}
  <div class="absolute z-10 flex flex-col gap-1 pointer-events-none" style={posStyle}>
    {#each overlays as overlay (overlay.id)}
      {@const html = renderOverlay(overlay)}
      {#if html}
        <div class="text-[11px] text-text-secondary font-mono pointer-events-auto">
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- plugin HTML is a documented escape hatch (PluginUI.ts), and plugins already run with full page access -->
          {@html html}
        </div>
      {/if}
    {/each}
  </div>
{/each}

<style>
  .view-context {
    min-height: 34px;
    padding: 0 10px;
    gap: 8px;
    border: 1px solid var(--color-border-default);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--color-panel) 92%, transparent);
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.24);
    backdrop-filter: blur(8px);
    color: var(--color-text-secondary);
  }

  .context-label {
    flex: none;
    font-family: var(--font-sans);
    font-size: var(--text-metadata);
    font-weight: 600;
    line-height: 1;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-text-faint);
  }

  .context-value {
    min-width: 0;
    max-width: 180px;
    font-family: var(--font-sans);
    font-size: var(--text-label);
    font-weight: 600;
    line-height: 1;
    color: var(--color-text-primary);
  }

  :global(.context-arrow) {
    flex: none;
    color: var(--color-text-muted);
    stroke-width: 1.75;
  }

  .context-divider {
    align-self: stretch;
    width: 1px;
    margin: 7px 2px;
    background: var(--color-border-subtle);
  }

  .frame-value {
    min-width: 0;
    max-width: 200px;
    font-family: var(--font-mono);
    font-size: var(--text-label);
    font-variant-numeric: tabular-nums;
    line-height: 1;
    color: var(--color-text-secondary);
  }

  .clear-look-at {
    display: grid;
    width: 20px;
    height: 20px;
    flex: none;
    place-items: center;
    margin-left: -4px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--color-text-faint);
    cursor: pointer;
  }

  .clear-look-at:hover {
    background: var(--color-control-hover);
    color: var(--color-text-primary);
  }

  .clear-look-at:focus-visible {
    outline: 1px solid var(--color-border-strong);
    outline-offset: 1px;
  }

  @media (max-width: 719px) {
    .view-context {
      left: 8px;
      right: 8px;
      top: 8px;
      max-width: none;
      transform: none;
    }

    .context-value,
    .frame-value {
      max-width: none;
    }
  }
</style>
