<script lang="ts">
  import { ArrowDownToLine, ArrowUpToLine, ZoomIn, ZoomOut } from 'lucide-svelte';
  import { startHeldCameraMove, stopHeldCameraMove } from '../lib/held-camera-moves';

  function hold(id: string, event: PointerEvent) {
    event.preventDefault();
    (event.currentTarget as HTMLButtonElement).setPointerCapture(event.pointerId);
    startHeldCameraMove(id);
  }
</script>

<div data-scene-occluder class="pointer-events-auto absolute right-3 bottom-[calc(var(--size-dock-base)+0.75rem)] z-10 flex gap-1 rounded-md border border-border bg-panel/90 p-1 shadow-lg backdrop-blur-md" aria-label="Camera movement">
  <button class="move-btn" aria-label="Dolly in" title="Dolly in · hold [" onpointerdown={(e) => hold('cam:dolly-in', e)} onpointerup={() => stopHeldCameraMove('cam:dolly-in')} onpointercancel={() => stopHeldCameraMove('cam:dolly-in')} onlostpointercapture={() => stopHeldCameraMove('cam:dolly-in')}>
    <ZoomIn size={15} />
  </button>
  <button class="move-btn" aria-label="Dolly out" title="Dolly out · hold ]" onpointerdown={(e) => hold('cam:dolly-out', e)} onpointerup={() => stopHeldCameraMove('cam:dolly-out')} onpointercancel={() => stopHeldCameraMove('cam:dolly-out')} onlostpointercapture={() => stopHeldCameraMove('cam:dolly-out')}>
    <ZoomOut size={15} />
  </button>
  <span class="mx-0.5 self-stretch border-l border-border-subtle" aria-hidden="true"></span>
  <button class="move-btn" aria-label="Crane up" title="Crane up · hold Page Up" onpointerdown={(e) => hold('cam:crane-up', e)} onpointerup={() => stopHeldCameraMove('cam:crane-up')} onpointercancel={() => stopHeldCameraMove('cam:crane-up')} onlostpointercapture={() => stopHeldCameraMove('cam:crane-up')}>
    <ArrowUpToLine size={15} />
  </button>
  <button class="move-btn" aria-label="Crane down" title="Crane down · hold Page Down" onpointerdown={(e) => hold('cam:crane-down', e)} onpointerup={() => stopHeldCameraMove('cam:crane-down')} onpointercancel={() => stopHeldCameraMove('cam:crane-down')} onlostpointercapture={() => stopHeldCameraMove('cam:crane-down')}>
    <ArrowDownToLine size={15} />
  </button>
</div>

<style>
  .move-btn {
    display: grid;
    width: 30px;
    height: 30px;
    flex: none;
    place-items: center;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--color-text-secondary);
    touch-action: none;
    cursor: pointer;
  }

  .move-btn:hover { background: var(--color-control-hover); color: var(--color-text-primary); }
  .move-btn:active { background: var(--color-control-active); color: var(--color-text-primary); }
  .move-btn:focus-visible { outline: 1px solid var(--color-border-strong); outline-offset: 1px; }
</style>