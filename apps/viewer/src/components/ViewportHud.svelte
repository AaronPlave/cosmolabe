<script lang="ts">
  import { CameraModeName } from '@cosmolabe/three';
  import type { PluginOverlay } from '@cosmolabe/three';
  import { vs, clearLookAt, getRenderer } from '../lib/viewer-state.svelte';
  import { X } from 'lucide-svelte';

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

<!-- Tracked body / camera mode HUD -->
{#if vs.trackedBodyName || vs.cameraMode !== CameraModeName.FREE_ORBIT}
  <div class="absolute bottom-16 left-3 z-10 flex flex-col gap-0.5 pointer-events-none">
    {#if vs.trackedBodyName}
      <span class="text-[13px] font-medium text-text-primary opacity-80">{vs.trackedBodyName}</span>
    {/if}
    {#if vs.cameraMode !== CameraModeName.FREE_ORBIT}
      <span class="text-[11px] text-text-secondary opacity-70 uppercase tracking-wider">{vs.cameraMode}</span>
    {/if}
    {#if vs.lookAtBodyName}
      <span class="text-[11px] text-text-secondary flex items-center gap-1 pointer-events-auto">
        Look at: {vs.lookAtBodyName}
        <button class="bg-transparent border-none text-text-muted cursor-pointer p-0 leading-none hover:text-text-primary pointer-events-auto" onclick={clearLookAt}><X size={12} /></button>
      </span>
    {/if}
  </div>
{/if}


<!-- Plugin overlays (rendered per corner) -->
{#each Object.entries(getPluginOverlays()) as [position, overlays]}
  {@const posClasses = {
    'top-left': 'top-10 left-3',
    'top-right': 'top-2.5 right-3',
    'bottom-left': 'bottom-16 left-3',
    'bottom-right': 'bottom-16 right-3',
  }[position] ?? 'top-2.5 left-3'}
  <div class="absolute {posClasses} z-10 flex flex-col gap-1 pointer-events-none">
    {#each overlays as overlay (overlay.id)}
      {@const html = renderOverlay(overlay)}
      {#if html}
        <div class="text-[11px] text-text-secondary font-mono pointer-events-auto">
          {@html html}
        </div>
      {/if}
    {/each}
  </div>
{/each}
