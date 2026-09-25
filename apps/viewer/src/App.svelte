<script lang="ts">
  import { onMount } from 'svelte';
  import WelcomeScreen from './components/WelcomeScreen.svelte';
  import ViewportHud from './components/ViewportHud.svelte';
  import CommandPalette from './components/CommandPalette.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import BodyInfoPanel from './components/BodyInfoPanel.svelte';
  import ToolRail from './components/shell/ToolRail.svelte';
  import PanelDock from './components/shell/PanelDock.svelte';
  import ToolPanels from './components/shell/ToolPanels.svelte';
  import TimelineDock from './components/shell/TimelineDock.svelte';
  import InstrumentPanel from './components/shell/InstrumentPanel.svelte';
  import { vs, getRenderer, setDisplayOption, cycleCamera, flyToTracked, resetCamera, togglePlay, reverse, faster, slower, stepForward, stepBackward, selectBody } from './lib/viewer-state.svelte';
  import {
    shell, TOOLS, toggleTool, closeTool, watchLayout, isMinimized,
    reclampFloats, topVisiblePanel, minimizePanel, isToolId,
  } from './lib/shell.svelte';
  import { ef, clearSelection } from './lib/event-finder.svelte';
  import { loadDemo, loadCatalogUrl, handleDrop, handleFileList, resize, getCurrentRenderer } from './lib/loader';
  import { loadCatalogSources, type CatalogSourceState } from './lib/catalog-sources';
  import { catalogSourceDeployment } from './lib/deployment';

  let canvas: HTMLCanvasElement;
  let commandPaletteOpen = $state(false);
  let pickModeActive = $state(false);
  let pickResult = $state<{ bodyName: string; latDeg: number; lonDeg: number; altKm: number; cameraDistanceKm: number; bodyFixedHitKm: readonly [number, number, number] } | null>(null);
  let uiHidden = $state(false);
  let contextMenu = $state<{ x: number; y: number; bodyName: string | null } | null>(null);

  const compact = $derived(shell.layout === 'compact');

  // The deployment's catalog sources (issue #93) — zero or more, each fetched
  // on its own so one that fails reports its error without holding back the
  // rest, or dropped files and `?catalog=`.
  const sourceDeployment = catalogSourceDeployment();
  let catalogSources = $state<CatalogSourceState[]>([]);

  /**
   * The shell's own measurements, published to the panels and docks that offset
   * against them. The timeline is the only one that changes: it grows when it
   * expands, and everything docked above it has to move with it rather than
   * each surface guessing a fixed 4rem the way they used to.
   */
  const shellVars = $derived.by(() => {
    // Distance from the bottom of the viewport to the top of whatever docks
    // above the bottom chrome, from what that chrome actually measures rather
    // than from a constant that has to be kept in step with its contents.
    const dockBase = shell.chromeBottom + 12; // the dock's own `bottom-3`
    // The rail has no width to offset against once it is horizontal, so
    // collapsing the variable is what spares every left-docked surface a
    // compact branch of its own.
    // Only override the token in compact mode. Re-declaring a desktop width
    // here let this stale value drift from the rail primitive, so the button
    // could become wider than its shrink-wrapped rail.
    const railOverride = compact ? '--size-rail: 0rem;' : '';
    return `${railOverride} --size-bottom-chrome: ${shell.chromeBottom}px; --size-dock-base: ${dockBase}px`;
  });

  /**
   * Which panel the compact layout shows, when no tool has claimed the sheet.
   *
   * The selection-driven panels do not open through the rail, so they fall back
   * into the sheet rather than competing for it: whatever the user last did —
   * opened a tool, picked a surface, selected a body — is what is on screen.
   */
  const fallbackSheet = $derived.by(() => {
    if (shell.activeSheet != null) return null;
    if (pickResult && !isMinimized('pick')) return 'pick';
    if (vs.selectedBodyName && !isMinimized('info')) return 'info';
    return null;
  });;

  /**
   * One condition for the whole load, so there is one loading screen rather than
   * a welcome screen that comes and goes between phases. `showLoading` covers a
   * load in flight — including loading a *second* catalog over a scene that is
   * already up, which otherwise ran its kernel download behind a hidden bar —
   * and `assetsReady` covers the stretch after the scene graph exists but its
   * models, textures and trajectories have not landed yet.
   */
  const loading = $derived(vs.showLoading || !vs.assetsReady);

  // Right-click: track pointerdown + pointerup for drag detection.
  // macOS fires contextmenu synchronously with the button press, so we can't use
  // it for drag detection. Instead: suppress native contextmenu, detect on pointerup.
  let rightClickStart = { x: 0, y: 0 };

  function onResize() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    resize(window.innerWidth, window.innerHeight);
    // A floating panel must not be stranded off-screen by a window that shrank
    // under it — there would be no header left to drag it back by.
    reclampFloats({ width: window.innerWidth, height: window.innerHeight });
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

  /** Capture-phase pointerdown on window — records right-click start before CameraController blocks it */
  function onWindowPointerDown(e: PointerEvent) {
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

    // An open popover or menu handles its own Escape (it closes); that same
    // press must not also clear a selection or dismiss a panel behind it.
    if (e.key === 'Escape' && document.querySelector('[data-popover-content], [data-dropdown-menu-content], [data-select-content]')) return;

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
          if (shell.shortcutsOpen) shell.shortcutsOpen = false;
          // An event selection is the smallest thing on screen to dismiss:
          // it goes before any panel does.
          else if (ef.selectedId) clearSelection();
          else if (dismissTopSurface()) return;
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

  /**
   * Escape dismisses whatever the user is actually looking at: the most
   * recently touched panel that is on screen.
   *
   * Two earlier versions got this wrong in the same way — they went by list
   * order rather than by what was visible. The first walked an if/else chain in
   * source order; the second took the end of `openTools`, which ignores the
   * selection-driven panels entirely and, on a phone, could close a tool behind
   * the sheet the user was reading.
   *
   * Compact minimizes instead of closing. There is one sheet on screen, getting
   * it out of the way is the whole request, and destroying a search to do it
   * would be a poor trade.
   */
  function dismissTopSurface(): boolean {
    const top = topVisiblePanel();
    if (top == null) return false;
    if (compact) {
      minimizePanel(top);
      return true;
    }
    // The selection-driven panels have no open flag to clear: closing them is
    // undoing what put them there.
    if (isToolId(top)) closeTool(top);
    else if (top === 'pick') closePickResult();
    else if (top === 'info') selectBody(null);
    return true;
  }

  function fmtCoord(n: number, dec: number) { return n.toFixed(dec); }

  onMount(() => {
    onResize();
    // Visual-regression / deep-link entry: `?catalog=<name>` auto-loads a demo
    // (combine with `?test=1` for deterministic offscreen capture — see
    // scripts/visual-regression.mjs).
    const catalogParam = new URLSearchParams(location.search).get('catalog');
    if (catalogParam) loadDemo(canvas, catalogParam);
    void loadCatalogSources(sourceDeployment.sources, sourceDeployment.baseUrl, (states) => {
      catalogSources = states;
    }).then((states) => {
      for (const s of states) {
        if (s.status === 'error') console.warn(`[Cosmolabe] Catalog source "${s.source.id}" unavailable: ${s.error}`);
        else if (s.status === 'ready') for (const w of s.warnings) console.warn(`[Cosmolabe] Catalog source "${s.source.id}": ${w}`);
      }
    });
    window.addEventListener('resize', onResize);
    const stopLayoutWatch = watchLayout();
    // Capture phase so we see right-clicks before CameraController stops propagation
    window.addEventListener('pointerdown', onWindowPointerDown, true);
    window.addEventListener('pointerup', onWindowPointerUp);
    return () => {
      stopLayoutWatch();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointerdown', onWindowPointerDown, true);
      window.removeEventListener('pointerup', onWindowPointerUp);
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />
<svelte:document ondragover={onDocDragOver} ondrop={onDocDrop} />

<div class="relative w-full h-full overflow-hidden" class:cursor-crosshair={pickModeActive} style={shellVars}>
  <!-- `touch-none`: the browser must not claim a drag as a scroll or a pinch as
       a page zoom before the camera controls see the gesture. -->
  <canvas bind:this={canvas} class="absolute inset-0 w-full h-full block touch-none" onclick={onCanvasClick} oncontextmenu={onCanvasContextMenu}></canvas>

  <!-- Gated on `loading`, not `sceneLoaded`: the scene graph exists well before
       its models and textures do, and handing over a sky of placeholder spheres
       reads as a broken scene rather than a loading one. -->
  {#if loading}
    <WelcomeScreen
      sources={catalogSources}
      configErrors={sourceDeployment.errors}
      onLoadCatalog={(entry) => loadCatalogUrl(canvas, entry.catalogUrl, entry.name)}
      onDrop={(dt) => handleDrop(canvas, dt)}
      onFiles={(files) => handleFileList(canvas, files)}
    />
  {/if}

  {#if !loading && !uiHidden}
    <ViewportHud />

    <!-- Instruments overlay the scene; none of them places itself, and any of
         them can be dragged out of its dock. Compact shows one sheet at a time
         — the scene is the point, and a phone has room for it and one
         instrument. -->
    {#if compact}
      <PanelDock side="sheet">
        <ToolPanels dock="all" />
        {#if shell.activeSheet === 'info' || fallbackSheet === 'info'}
          <BodyInfoPanel />
        {/if}
        {#if pickResult && (shell.activeSheet === 'pick' || fallbackSheet === 'pick')}
          <InstrumentPanel key="pick" title="Surface pick" onClose={closePickResult}>
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
          <InstrumentPanel key="pick" title="Surface pick" width={224} onClose={closePickResult}>
            <div class="font-semibold text-text-primary mb-1.5">{pickResult.bodyName}</div>
            {@render pickRows(pickResult)}
          </InstrumentPanel>
        {/if}
      </PanelDock>
    {/if}

    {#if compact}
      <!-- One bar, not two: the rail and the transport share a box so the
           chrome costs the scene one strip instead of a third of the screen. -->
      <div
        bind:clientHeight={shell.chromeBottom}
        class="compact-dock shell-surface pointer-events-auto absolute inset-x-2 bottom-2 z-20 overflow-hidden rounded-md border backdrop-blur-md"
      >
        <TimelineDock inline />
        <div class="shell-divider mx-2 border-t"></div>
        <ToolRail
          inline
          {pickModeActive}
          onTogglePick={togglePickMode}
          onOpenSearch={() => commandPaletteOpen = true}
        />
      </div>
    {:else}
      <ToolRail
        {pickModeActive}
        onTogglePick={togglePickMode}
        onOpenSearch={() => commandPaletteOpen = true}
      />
      <TimelineDock />
    {/if}

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

<style>
  .compact-dock {
    box-shadow: 0 -8px 28px rgba(0, 0, 0, 0.24);
  }
</style>

{#snippet pickRows(pick: { latDeg: number; lonDeg: number; altKm: number; cameraDistanceKm: number })}
  <div class="flex justify-between gap-4 leading-relaxed"><span class="text-text-secondary">Lat</span><span class="font-mono text-text-primary">{fmtCoord(Math.abs(pick.latDeg), 5)}&deg; {pick.latDeg >= 0 ? 'N' : 'S'}</span></div>
  <div class="flex justify-between gap-4 leading-relaxed"><span class="text-text-secondary">Lon</span><span class="font-mono text-text-primary">{fmtCoord(Math.abs(pick.lonDeg), 5)}&deg; {pick.lonDeg >= 0 ? 'E' : 'W'}</span></div>
  <div class="flex justify-between gap-4 leading-relaxed"><span class="text-text-secondary">Sampled alt</span><span class="font-mono text-text-primary">{pick.altKm >= 0 ? '+' : ''}{fmtCoord(pick.altKm * 1000, 1)} m</span></div>
  <div class="flex justify-between gap-4 leading-relaxed"><span class="text-text-secondary">Dist</span><span class="font-mono text-text-primary">{pick.cameraDistanceKm < 1 ? `${fmtCoord(pick.cameraDistanceKm * 1000, 1)} m` : `${fmtCoord(pick.cameraDistanceKm, 3)} km`}</span></div>
{/snippet}
