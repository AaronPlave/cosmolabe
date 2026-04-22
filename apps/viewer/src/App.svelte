<script lang="ts">
  import { onMount } from 'svelte';
  import WelcomeScreen from './components/WelcomeScreen.svelte';
  import BottomBar from './components/BottomBar.svelte';
  import BodyDrawer from './components/BodyDrawer.svelte';
  import ViewportHud from './components/ViewportHud.svelte';
  import DisplaySettings from './components/DisplaySettings.svelte';
  import CommandPalette from './components/CommandPalette.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import BodyInfoPanel from './components/BodyInfoPanel.svelte';
  import DebugPanel from './components/DebugPanel.svelte';
  import MeasureTool from './components/MeasureTool.svelte';
  import { vs, getRenderer, setDisplayOption, cycleCamera, flyToTracked, resetCamera, togglePlay, reverse, faster, slower, stepForward, stepBackward, selectBody } from './lib/viewer-state.svelte';
  import { loadDemo, handleDrop, handleFileList, resize, getCurrentRenderer } from './lib/loader';
  import { X } from 'lucide-svelte';

  let canvas: HTMLCanvasElement;
  let bodyDrawerOpen = $state(false);
  let displaySettingsOpen = $state(false);
  let commandPaletteOpen = $state(false);
  let pickModeActive = $state(false);
  let pickResult = $state<{ bodyName: string; latDeg: number; lonDeg: number; altKm: number } | null>(null);
  let uiHidden = $state(false);
  let contextMenu = $state<{ x: number; y: number; bodyName: string | null } | null>(null);
  let debugPanelOpen = $state(false);
  let measureToolOpen = $state(false);

  // Right-click: track mousedown + pointerup for drag detection.
  // macOS fires contextmenu synchronously with mousedown, so we can't use it
  // for drag detection. Instead: suppress native contextmenu, detect on pointerup.
  let rightClickStart = { x: 0, y: 0 };

  function onResize() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    resize(window.innerWidth, window.innerHeight);
  }

  function onDocDragOver(e: DragEvent) { e.preventDefault(); }
  function onDocDrop(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) handleDrop(canvas, e.dataTransfer);
  }

  function onCanvasClick(e: MouseEvent) {
    if (!pickModeActive) return;
    const renderer = getCurrentRenderer();
    if (!renderer) return;
    e.stopPropagation();
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    const result = renderer.pickSurface(ndcX, ndcY);
    if (result) {
      pickResult = result;
      renderer.setPickMarker(result);
    }
  }

  /** Capture-phase mousedown on window — records right-click start before CameraController blocks it */
  function onWindowMouseDown(e: MouseEvent) {
    if (e.button === 2) {
      rightClickStart = { x: e.clientX, y: e.clientY };
    }
  }

  /** Pointerup on window — detect right-click (no drag) and show context menu */
  function onWindowPointerUp(e: PointerEvent) {
    if (e.button !== 2) return;
    const dx = e.clientX - rightClickStart.x;
    const dy = e.clientY - rightClickStart.y;
    if (dx * dx + dy * dy > 25) return; // dragged — don't show menu

    const renderer = getCurrentRenderer();
    if (!renderer) return;

    // Use the renderer's pickBody which checks labels (screen-space) then meshes (raycast)
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const bodyName = renderer.pickBody(screenX, screenY);

    contextMenu = { x: e.clientX, y: e.clientY, bodyName };
  }

  function togglePickMode() {
    pickModeActive = !pickModeActive;
    if (!pickModeActive) {
      pickResult = null;
      getCurrentRenderer()?.setPickMarker(null);
    }
  }

  function closePickResult() {
    pickResult = null;
    pickModeActive = false;
    getCurrentRenderer()?.setPickMarker(null);
  }

  /** Suppress native context menu on the canvas */
  function onCanvasContextMenu(e: MouseEvent) {
    e.preventDefault();
  }

  function onKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      commandPaletteOpen = !commandPaletteOpen;
      return;
    }

    // Let command palette handle all keys when open (arrow nav, typing, etc.)
    if (commandPaletteOpen) return;

    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    const renderer = getRenderer();
    if (!renderer) return;

    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      switch (e.key) {
        case ' ': e.preventDefault(); togglePlay(); return;
        case 'ArrowLeft': e.preventDefault(); stepBackward(); return;
        case 'ArrowRight': e.preventDefault(); stepForward(); return;
        case 'ArrowDown': slower(); return;
        case 'ArrowUp': faster(); return;
        case 'r': reverse(); return;
        case 'f': flyToTracked(); return;
        case 't': setDisplayOption('trajectories', !vs.showTrajectories); return;
        case 'l': setDisplayOption('labels', !vs.showLabels); return;
        case 'g': setDisplayOption('grid', !vs.showGrid); return;
        case 'x': setDisplayOption('axes', !vs.showAxes); return;
        case 'm': cycleCamera(); return;
        case 'b': bodyDrawerOpen = !bodyDrawerOpen; return;
        case 'i': {
          const sensors = renderer.getSensorNames();
          if (sensors.length === 0) return;
          const current = renderer.activeInstrumentView;
          const idx = current ? sensors.indexOf(current) : -1;
          const next = idx + 1 < sensors.length ? sensors[idx + 1] : null;
          renderer.setInstrumentView(next, { marginX: 16, marginY: 60 });
          return;
        }
        case 'p': togglePickMode(); return;
        case 'Escape':
          if (displaySettingsOpen) displaySettingsOpen = false;
          else if (bodyDrawerOpen) bodyDrawerOpen = false;
          else if (pickModeActive) closePickResult();
          else if (vs.selectedBodyName) selectBody(null);
          else resetCamera();
          return;
        case '\\': e.preventDefault(); uiHidden = !uiHidden; return;
      }
    }
  }

  function fmtCoord(n: number, dec: number) { return n.toFixed(dec); }

  onMount(() => {
    onResize();
    window.addEventListener('resize', onResize);
    // Capture phase so we see right-clicks before CameraController stops propagation
    window.addEventListener('mousedown', onWindowMouseDown, true);
    window.addEventListener('pointerup', onWindowPointerUp);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('mousedown', onWindowMouseDown, true);
      window.removeEventListener('pointerup', onWindowPointerUp);
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />
<svelte:document ondragover={onDocDragOver} ondrop={onDocDrop} />

<div class="relative w-full h-full overflow-hidden" class:cursor-crosshair={pickModeActive}>
  <canvas bind:this={canvas} class="absolute inset-0 w-full h-full block" onclick={onCanvasClick} oncontextmenu={onCanvasContextMenu}></canvas>

  {#if !vs.sceneLoaded}
    <WelcomeScreen
      onLoadDemo={(name) => loadDemo(canvas, name)}
      onDrop={(dt) => handleDrop(canvas, dt)}
      onFiles={(files) => handleFileList(canvas, files)}
    />
  {/if}

  {#if vs.sceneLoaded && !uiHidden}
    <ViewportHud />
    <BodyInfoPanel />

    {#if debugPanelOpen}
      <DebugPanel onClose={() => debugPanelOpen = false} />
    {/if}

    {#if measureToolOpen}
      <MeasureTool onClose={() => measureToolOpen = false} />
    {/if}

    <BodyDrawer open={bodyDrawerOpen} onClose={() => bodyDrawerOpen = false} />

    {#if displaySettingsOpen}
      <DisplaySettings
        onClose={() => displaySettingsOpen = false}
        debugActive={debugPanelOpen}
        onToggleDebug={() => debugPanelOpen = !debugPanelOpen}
      />
    {/if}

    {#if pickResult}
      <div class="absolute top-3 right-3 z-20 bg-black/90 backdrop-blur-md border border-border rounded-lg p-2.5 min-w-50 text-[12px]">
        <button class="absolute top-1.5 right-2 bg-transparent border-none cursor-pointer text-text-muted hover:text-text-primary" onclick={closePickResult}><X size={13} /></button>
        <div class="text-text-primary font-semibold mb-1.5">{pickResult.bodyName}</div>
        <div class="flex justify-between gap-4 leading-relaxed"><span class="text-text-secondary">Lat</span><span class="font-mono text-text-primary">{fmtCoord(Math.abs(pickResult.latDeg), 5)}&deg; {pickResult.latDeg >= 0 ? 'N' : 'S'}</span></div>
        <div class="flex justify-between gap-4 leading-relaxed"><span class="text-text-secondary">Lon</span><span class="font-mono text-text-primary">{fmtCoord(Math.abs(pickResult.lonDeg), 5)}&deg; {pickResult.lonDeg >= 0 ? 'E' : 'W'}</span></div>
        <div class="flex justify-between gap-4 leading-relaxed"><span class="text-text-secondary">Alt</span><span class="font-mono text-text-primary">{pickResult.altKm >= 0 ? '+' : ''}{fmtCoord(pickResult.altKm * 1000, 1)} m</span></div>
      </div>
    {/if}

    <BottomBar
      onToggleBodyDrawer={() => bodyDrawerOpen = !bodyDrawerOpen}
      onToggleDisplaySettings={() => displaySettingsOpen = !displaySettingsOpen}
      onTogglePick={togglePickMode}
      onToggleInfoPanel={() => {
        if (vs.selectedBodyName) selectBody(null);
        else if (vs.trackedBodyName) selectBody(vs.trackedBodyName);
      }}
      onToggleMeasure={() => measureToolOpen = !measureToolOpen}
      {pickModeActive}
      infoPanelActive={!!vs.selectedBodyName}
      measureActive={measureToolOpen}
    />

    <CommandPalette open={commandPaletteOpen} onClose={() => commandPaletteOpen = false} />

    {#if contextMenu}
      <ContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        bodyName={contextMenu.bodyName}
        onClose={() => contextMenu = null}
      />
    {/if}
  {/if}
</div>
