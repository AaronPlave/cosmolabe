<script lang="ts">
  import { trackBody, lookAtBody, flyToTracked, getRenderer } from '../lib/viewer-state.svelte';
  import { Eye, Navigation, Focus, RotateCcw } from 'lucide-svelte';

  interface Props {
    x: number;
    y: number;
    bodyName: string | null;
    onClose: () => void;
  }

  let { x, y, bodyName, onClose }: Props = $props();

  function handleTrack() {
    if (bodyName) trackBody(bodyName);
    onClose();
  }

  function handleLookAt() {
    if (bodyName) lookAtBody(bodyName);
    onClose();
  }

  function handleFlyTo() {
    if (bodyName) {
      trackBody(bodyName);
      flyToTracked();
    }
    onClose();
  }

  function handleResetCamera() {
    const r = getRenderer();
    if (r) r.cameraController.resetToFreeOrbit();
    onClose();
  }

  // Clamp position to viewport
  let menuStyle = $derived(`left: ${Math.min(x, window.innerWidth - 180)}px; top: ${Math.min(y, window.innerHeight - 200)}px;`);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-40" onclick={onClose} oncontextmenu={(e) => { e.preventDefault(); onClose(); }}>
  <div class="absolute bg-black/90 backdrop-blur-xl border border-border rounded-lg py-1 min-w-40 shadow-2xl animate-fade-in" style={menuStyle} onclick={(e) => e.stopPropagation()}>
    {#if bodyName}
      <div class="px-3 py-1 text-[11px] text-text-muted uppercase tracking-wider">{bodyName}</div>
      <button class="ctx-item" onclick={handleTrack}>
        <Focus size={13} /> Track
      </button>
      <button class="ctx-item" onclick={handleLookAt}>
        <Eye size={13} /> Look at
      </button>
      <button class="ctx-item" onclick={handleFlyTo}>
        <Navigation size={13} /> Fly to
      </button>
      <div class="h-px bg-border my-1"></div>
    {/if}
    <button class="ctx-item" onclick={handleResetCamera}>
      <RotateCcw size={13} /> Reset camera
    </button>
  </div>
</div>

<style>
  @keyframes fade-in {
    from { opacity: 0; transform: scale(0.95); }
    to { opacity: 1; transform: scale(1); }
  }
  .animate-fade-in { animation: fade-in 0.1s ease; }

  .ctx-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 12px;
    font-size: 12px;
    color: var(--color-text-primary);
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    transition: background 0.08s;
  }
  .ctx-item:hover {
    background: var(--color-surface-3);
  }
</style>
