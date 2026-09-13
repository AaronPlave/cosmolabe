<script lang="ts">
  import { onMount } from 'svelte';
  import WelcomeScreen from './components/WelcomeScreen.svelte';
  import BodyDrawer from './components/BodyDrawer.svelte';
  import ViewportHud from './components/ViewportHud.svelte';
  import DisplaySettings from './components/DisplaySettings.svelte';
  import CommandPalette from './components/CommandPalette.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import BodyInfoPanel from './components/BodyInfoPanel.svelte';
  import ToolRail from './components/shell/ToolRail.svelte';
  import PanelDock from './components/shell/PanelDock.svelte';
  import ToolPanels from './components/shell/ToolPanels.svelte';
  import TimelineDock from './components/shell/TimelineDock.svelte';
  import InstrumentPanel from './components/shell/InstrumentPanel.svelte';
  import { vs, getRenderer, setDisplayOption, cycleCamera, flyToTracked, resetCamera, togglePlay, reverse, faster, slower, stepForward, stepBackward, selectBody } from './lib/viewer-state.svelte';
  import { shell, TOOLS, isToolOpen, toggleTool, closeTool, closeTopTool, watchLayout } from './lib/shell.svelte';
  import { loadDemo, handleDrop, handleFileList, resize, getCurrentRenderer } from './lib/loader';

  let canvas: HTMLCanvasElement;
  let commandPaletteOpen = $state(false);
  let pickModeActive = $state(false);
  let pickResult = $state<{ bodyName: string; latDeg: number; lonDeg: number; altKm: number; cameraDistanceKm: number } | null>(null);
  let uiHidden = $state(false);
  let contextMenu = $state<{ x: number; y: number; bodyName: string | null } | null>(null);

  const compact = $derived(shell.layout === 'compact');

  /**
   * The shell's own measurements, published to the panels and docks that offset
   * against them. The timeline is the only one that changes: it grows when it
   * expands, and everything docked above it has to move with it rather than
   * each surface guessing a fixed 4rem the way they used to.
   */
  const shellVars = $derived.by(() => {
    // Distance from the bottom of the viewport to the top of each docked
    // surface, from what those surfaces actually measure rather than from a
    // constant that has to be kept in step with their contents.
    const gap = 12; // the docks' own `bottom-3`
    const timeline = shell.timelineHeight + gap;
    // Compact puts the rail between the timeline and everything above it.
    const dockBase = compact ? timeline + shell.railHeight + 8 : timeline;
    // The rail has no width to offset against once it is horizontal, so
    // collapsing the variable is what spares every left-docked surface a
    // compact branch of its own.
    const rail = compact ? '0rem' : '2.75rem';
    return `--size-rail: ${rail}; --size-timeline: ${timeline}px; --size-dock-base: ${dockBase}px`;
  });

  /**
   * One condition for the whole load, so there is one loading screen rather than
   * a welcome screen that comes and goes between phases. `showLoading` covers a
   * load in flight — including loading a *second* catalog over a scene that is
   * already up, which otherwise ran its kernel download behind a hidden bar —
   * and `assetsReady` covers the stretch after the scene graph exists but its
   * models, textures and trajectories have not landed yet.
   */
  const loading = $derived(vs.showLoading || !vs.assetsReady);

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
          // Most-recently-opened first. The chain this replaced went in source
          // order, so Escape closed whichever panel happened to be listed
          // first rather than the one the user had just opened.
          if (shell.shortcutsOpen) shell.shortcutsOpen = false;
          else if (closeTopTool()) return;
          else if (pickModeActive) closePickResult();
          else if (vs.selectedBodyName) selectBody(null);
          else resetCamera();
          return;
        case '\\': e.preventDefault(); uiHidden = !uiHidden; return;
      }

      // Tool shortcuts come from the shell's own table, so adding a tool does
      // not mean remembering to add a case above as well.
      const tool = TOOLS.find((t) => t.shortcut === e.key);
      if (tool) toggleTool(tool.id);
    }
  }

  function fmtCoord(n: number, dec: number) { return n.toFixed(dec); }

  onMount(() => {
    onResize();
    // Visual-regression / deep-link entry: `?catalog=<name>` auto-loads a demo
    // (combine with `?test=1` for deterministic offscreen capture — see
    // scripts/visual-regression.mjs).
    const catalogParam = new URLSearchParams(location.search).get('catalog');
    if (catalogParam) loadDemo(canvas, catalogParam);
    window.addEventListener('resize', onResize);
    const stopLayoutWatch = watchLayout();
    // Capture phase so we see right-clicks before CameraController stops propagation
    window.addEventListener('mousedown', onWindowMouseDown, true);
    window.addEventListener('pointerup', onWindowPointerUp);
    return () => {
      stopLayoutWatch();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('mousedown', onWindowMouseDown, true);
      window.removeEventListener('pointerup', onWindowPointerUp);
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />
<svelte:document ondragover={onDocDragOver} ondrop={onDocDrop} />

<div class="relative w-full h-full overflow-hidden" class:cursor-crosshair={pickModeActive} style={shellVars}>
  <canvas bind:this={canvas} class="absolute inset-0 w-full h-full block" onclick={onCanvasClick} oncontextmenu={onCanvasContextMenu}></canvas>

  <!-- Gated on `loading`, not `sceneLoaded`: the scene graph exists well before
       its models and textures do, and handing over a sky of placeholder spheres
       reads as a broken scene rather than a loading one. -->
  {#if loading}
    <WelcomeScreen
      onLoadDemo={(name) => loadDemo(canvas, name)}
      onDrop={(dt) => handleDrop(canvas, dt)}
      onFiles={(files) => handleFileList(canvas, files)}
    />
  {/if}

  {#if !loading && !uiHidden}
    <ViewportHud />

    <!-- Instruments overlay the scene; none of them positions itself. On a
         phone both docks feed one bottom-sheet stack, which is why the compact
         branch is a different composition of the same pieces rather than a
         second set of components. -->
    {#if compact}
      <PanelDock side="sheet">
        <BodyInfoPanel />
        <ToolPanels dock="all" />
        {#if pickResult}
          <InstrumentPanel title="Surface pick" onClose={closePickResult}>
            <div class="font-semibold text-text-primary mb-1.5">{pickResult.bodyName}</div>
            {@render pickRows(pickResult)}
          </InstrumentPanel>
        {/if}
      </PanelDock>
    {:else}
      <PanelDock side="left">
        <ToolPanels dock="left" />
      </PanelDock>
      <PanelDock side="right">
        <BodyInfoPanel />
        <ToolPanels dock="right" />
        {#if pickResult}
          <InstrumentPanel title="Surface pick" width={224} onClose={closePickResult}>
            <div class="font-semibold text-text-primary mb-1.5">{pickResult.bodyName}</div>
            {@render pickRows(pickResult)}
          </InstrumentPanel>
        {/if}
      </PanelDock>
    {/if}

    <BodyDrawer open={isToolOpen('catalog')} onClose={() => closeTool('catalog')} />

    {#if isToolOpen('display')}
      <DisplaySettings
        onClose={() => closeTool('display')}
        debugActive={isToolOpen('debug')}
        onToggleDebug={() => toggleTool('debug')}
      />
    {/if}

    <ToolRail {pickModeActive} onTogglePick={togglePickMode} />
    <TimelineDock />

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

{#snippet pickRows(pick: { latDeg: number; lonDeg: number; altKm: number; cameraDistanceKm: number })}
  <div class="flex justify-between gap-4 leading-relaxed"><span class="text-text-secondary">Lat</span><span class="font-mono text-text-primary">{fmtCoord(Math.abs(pick.latDeg), 5)}&deg; {pick.latDeg >= 0 ? 'N' : 'S'}</span></div>
  <div class="flex justify-between gap-4 leading-relaxed"><span class="text-text-secondary">Lon</span><span class="font-mono text-text-primary">{fmtCoord(Math.abs(pick.lonDeg), 5)}&deg; {pick.lonDeg >= 0 ? 'E' : 'W'}</span></div>
  <div class="flex justify-between gap-4 leading-relaxed"><span class="text-text-secondary">Alt</span><span class="font-mono text-text-primary">{pick.altKm >= 0 ? '+' : ''}{fmtCoord(pick.altKm * 1000, 1)} m</span></div>
  <div class="flex justify-between gap-4 leading-relaxed"><span class="text-text-secondary">Dist</span><span class="font-mono text-text-primary">{pick.cameraDistanceKm < 1 ? `${fmtCoord(pick.cameraDistanceKm * 1000, 1)} m` : `${fmtCoord(pick.cameraDistanceKm, 3)} km`}</span></div>
{/snippet}
