<script lang="ts">
  // Every action here is one of the shared navigation verbs (docs/navigation.md):
  // the menu chooses which, and does not re-derive what any of them means.
  import { selectBody, trackBody, frameBody, flyToBody, lookAtBody, resetCamera, navigateToSurfacePoint } from '../lib/viewer-state.svelte';
  import { surfaceNavigable, type SurfacePoint } from '@cosmolabe/three';
  import { Eye, Navigation, Focus, Maximize, MousePointerClick, RotateCcw, Route, ZoomIn, Copy } from 'lucide-svelte';
  import { copySurfacePointCoordinates } from '../lib/surface-coordinates';
  import { workspaceSize } from '../lib/workspace.svelte';

  interface Props {
    x: number;
    y: number;
    bodyName: string | null;
    /** The surface point under the click, when the scene hit found one. */
    surfacePoint?: SurfacePoint | null;
    onClose: () => void;
  }

  let { x, y, bodyName, surfacePoint = null, onClose }: Props = $props();

  /**
   * Navigate to the clicked point: camera only — no selection, time or mode
   * change. Zoom comes a step closer each time; Fly to here lands at the same
   * framing however often it is used.
   */
  function toPoint(verb: 'zoom' | 'frame', animate: boolean) {
    return () => {
      if (surfacePoint) navigateToSurfacePoint(surfacePoint, { animate, from: 'click', verb });
      onClose();
    };
  }

  function copyPoint() {
    if (surfacePoint) void copySurfacePointCoordinates(surfacePoint);
    onClose();
  }

  /** Run `action` on the menu's body, then close. */
  function act(action: (name: string) => unknown) {
    return () => {
      if (bodyName) action(bodyName);
      onClose();
    };
  }

  function handleResetCamera() {
    resetCamera();
    onClose();
  }

  // Clamp position to viewport
  let menuStyle = $derived(`left: ${Math.min(x, workspaceSize().width - 200)}px; top: ${Math.min(y, workspaceSize().height - (surfacePoint && surfaceNavigable(surfacePoint) ? 360 : 290))}px;`);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-40" onclick={onClose} oncontextmenu={(e) => { e.preventDefault(); onClose(); }}>
  <div class="absolute bg-black/90 backdrop-blur-xl border border-border rounded-lg py-1 min-w-40 shadow-2xl animate-fade-in" style={menuStyle} onclick={(e) => e.stopPropagation()}>
    {#if bodyName}
      <div class="px-3 py-1 text-[11px] text-text-muted uppercase tracking-wider">{bodyName}</div>
      <button class="ctx-item" onclick={act(selectBody)} title="Show its details; the camera stays put">
        <MousePointerClick size={13} /> Select
      </button>
      <button class="ctx-item" onclick={act(trackBody)} title="Orbit and follow it without moving the camera">
        <Focus size={13} /> Track
      </button>
      <button class="ctx-item" onclick={act(frameBody)} title="Cut to a view that fits it">
        <Maximize size={13} /> Frame
      </button>
      <button class="ctx-item" onclick={act((name) => flyToBody(name))} title="Fly straight there">
        <Navigation size={13} /> Fly to
      </button>
      <button class="ctx-item" onclick={act((name) => flyToBody(name, { path: 'overview' }))} title="Pull back to show where it is from here, then fly there">
        <Route size={13} /> Fly via overview
      </button>
      <button class="ctx-item" onclick={act(lookAtBody)} title="Aim at it while orbiting what is tracked">
        <Eye size={13} /> Look at
      </button>
      <div class="h-px bg-border my-1"></div>
    {/if}
    {#if surfacePoint && surfaceNavigable(surfacePoint)}
      <!-- Actions on the point clicked; its full readout is the Point Probe's. -->
      <button class="ctx-item" onclick={toPoint('zoom', false)} title="Move a step closer along this line of sight and orbit about this point">
        <ZoomIn size={13} /> Zoom to here
      </button>
      <button class="ctx-item" onclick={toPoint('frame', true)} title="Fly to a local view of this point and orbit about it">
        <Navigation size={13} /> Fly to here
      </button>
      <button class="ctx-item" onclick={copyPoint} title="Copy latitude, longitude (planetocentric, east-positive) — pastes into Navigate">
        <Copy size={13} /> Copy coordinates
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
