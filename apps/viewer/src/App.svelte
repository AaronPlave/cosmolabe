<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import HomeScreen from './components/HomeScreen.svelte';
  import LoadingScreen from './components/LoadingScreen.svelte';
  import CatalogBrowser from './components/CatalogBrowser.svelte';
  import ViewportHud from './components/ViewportHud.svelte';
  import GeographicCallout from './components/GeographicCallout.svelte';
  import GeographicLabels from './components/GeographicLabels.svelte';
  import GeographicEditOverlay from './components/GeographicEditOverlay.svelte';
  import DrawToolbar from './components/DrawToolbar.svelte';
  import {
    edits, finishDraft, removeLastVertex, cancelDrawing, deleteSelectedVertex, undo, redo, editingFeature, undoDelete,
  } from './lib/geographic-editing.svelte';
  import './lib/geographic-styles.svelte';
  import { geo, clearGeographicSelection } from './lib/geographic-layers.svelte';
  import CommandPalette from './components/CommandPalette.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import BodyInfoPanel from './components/BodyInfoPanel.svelte';
  import ToolRail from './components/shell/ToolRail.svelte';
  import PanelDock from './components/shell/PanelDock.svelte';
  import ToolPanels from './components/shell/ToolPanels.svelte';
  import TimelineDock from './components/shell/TimelineDock.svelte';
  import ProbePanel from './components/ProbePanel.svelte';
  import { vs, getRenderer, setDisplayOption, cycleCamera, flyToTracked, resetCamera, stopFlight, dismissGeographicContext, togglePlay, reverse, faster, slower, stepForward, stepBackward, selectBody, toggleProbe, setProbeActive, clearProbePin } from './lib/viewer-state.svelte';
  import {
    shell, TOOLS, toggleTool, closeTool, watchLayout, isMinimized,
    reclampFloats, topVisiblePanel, minimizePanel, isToolId, toggleExpanded, expandedPanel,
    isToolOpen, openTool, setLayout, COMPACT_MAX_WIDTH,
  } from './lib/shell.svelte';
  import { ef, clearSelection } from './lib/event-finder.svelte';
  import { loadDemo, demoCatalogUrl, loadCatalogUrl, handleDrop, handleFileList, resize, getCurrentRenderer } from './lib/loader';
  import { startHero, stopHero } from './lib/hero';
  import { queueScript, fetchScript } from './lib/script-demo.svelte';
  import { restoreView } from './lib/view-link';
  import { requestedView } from './lib/view-state-url';
  import type { CatalogEntry } from './lib/catalog-sources';
  import type { SurfacePoint } from '@cosmolabe/three';
  import { catalogs, initCatalogSources, sourceSettled, syncSourceParams } from './lib/catalogs.svelte';
  import {
    catalogLocation, findEntry, isCurrentEntry, requestedCatalog, withCatalogLocation, allEntries,
    type CatalogLocation, type SourcedEntry,
  } from './lib/catalog-nav';
  import { cancelMeasurementPick, measurements, selectMeasurement } from './lib/spatial-measurements.svelte';
  import { cancelAppearancePick } from './lib/surface-appearance-pick.svelte';
  import { workspace, setWorkspaceRoot, toWorkspace, workspaceNode } from './lib/workspace.svelte';
  import { BitsConfig } from 'bits-ui';
  import type { CatalogFetcher } from '@cosmolabe/core';

  let canvas: HTMLCanvasElement;
  let rootEl = $state<HTMLDivElement>() as HTMLDivElement;
  const embedded = workspace.embedded;
  const ui = workspace.ui;
  let commandPaletteOpen = $state(false);
  let uiHidden = $state(false);
  let contextMenu = $state<{ x: number; y: number; bodyName: string | null; surfacePoint: SurfacePoint | null } | null>(null);

  const compact = $derived(shell.layout === 'compact');

  // The window title carries the current catalog, so the identity costs the
  // scene nothing (#94: no persistent header).
  // The page is the host's when embedded: its title is not ours to set.
  $effect(() => {
    if (!embedded) document.title = vs.catalogName ? `${vs.catalogName} — Cosmolabe` : 'Cosmolabe';
  });

  // Closing the Instrument view window — X, Escape, the rail, Display's Off —
  // ends the feed. Here rather than in the panel, which also unmounts for a
  // layout switch or a scene load that must not end it.
  $effect(() => {
    if (!isToolOpen('instrument')) untrack(() => getRenderer()?.setInstrumentView(null));
  });

  // A scene deep-linked by path is named by that path until a source lists it
  // — at startup, or when a source is added later — and then by its entry.
  $effect(() => {
    const url = catalogs.currentUrl;
    const script = catalogs.currentScriptUrl;
    if (!url || !vs.catalogName) return;
    const listed = allEntries(catalogs.sources).find((e) => isCurrentEntry(e.entry, url, script));
    if (listed && listed.entry.name !== vs.catalogName) vs.catalogName = listed.entry.name;
  });

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
   * opened a tool, probed a point, selected a body — is what is on screen.
   */
  const fallbackSheet = $derived.by(() => {
    if (shell.activeSheet != null) return null;
    if (vs.probePin && !isMinimized('probe')) return 'probe';
    if (vs.selectedBodyName && !isMinimized('info')) return 'info';
    return null;
  });

  /**
   * One condition for the whole load, so there is one loading screen rather than
   * one that comes and goes between phases. `showLoading` covers a load in
   * flight — including loading a *second* catalog over a scene that is already
   * up, which otherwise ran its kernel download behind a hidden bar — and
   * `assetsReady` covers the stretch after the scene graph exists but its
   * models, textures and trajectories have not landed yet.
   *
   * Which screen stands in for the scene meanwhile is split (#94): a load in
   * flight gets the loading screen, naming the catalog; no scene and no load
   * is the home screen.
   */
  const loading = $derived(vs.showLoading || !vs.assetsReady);

  // Closing/minimizing retains unfinished work and clears temporary picking feedback.
  $effect(() => {
    const open = shell.openTools.includes('measure');
    const hidden = shell.panels.measure.minimized || (shell.layout === 'compact' && shell.activeSheet !== 'measure');
    untrack(() => {
      if (!open || hidden) cancelMeasurementPick();
    });
  });

  /**
   * The home screen's backdrop: a presentation-only scene on the same canvas
   * (lib/hero.ts), up exactly while the home screen is and no scene holds the
   * canvas. A load stops it the moment it begins, so it never competes with
   * one for the GPU. Skipped in test mode, whose captures are of catalogs.
   */
  const TEST_MODE = !embedded && new URLSearchParams(location.search).has('test');
  let heroReady = $state(false);
  $effect(() => {
    const home = !vs.showLoading && !vs.assetsReady;
    if (home && !TEST_MODE && !embedded && !getCurrentRenderer()) {
      startHero(canvas, () => (heroReady = true));
    } else {
      stopHero();
      heroReady = false;
    }
  });

  // Right-click: track pointerdown + pointerup for drag detection.
  // macOS fires contextmenu synchronously with the button press, so we can't use
  // it for drag detection. Instead: suppress native contextmenu, detect on pointerup.
  let rightClickStart = { x: 0, y: 0 };

  /** Size everything to the workspace root — the window standalone, the host element embedded. */
  function onResize() {
    if (!canvas || !rootEl) return;
    const width = rootEl.clientWidth;
    const height = rootEl.clientHeight;
    // A hidden host element measures 0×0; keep the last real size until it shows.
    if (width === 0 || height === 0) return;
    workspace.width = width;
    workspace.height = height;
    canvas.width = width;
    canvas.height = height;
    resize(width, height);
    // A floating panel must not be stranded off-screen by a workspace that
    // shrank under it — there would be no header left to drag it back by.
    reclampFloats({ width, height });
    // Embedded, the host element's width decides the layout, not the window's.
    if (embedded) setLayout(width <= COMPACT_MAX_WIDTH ? 'compact' : 'desktop');
  }

  function onDocDragOver(e: DragEvent) { e.preventDefault(); }
  function onDocDrop(e: DragEvent) {
    e.preventDefault();
    const dt = e.dataTransfer;
    if (!dt) return;
    shell.catalogBrowserOpen = false;
    loadFiles(() => handleDrop(canvas, dt));
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
    // The surface under the click, through the same scene hit as the probe
    // (#127): only a genuine hit offers surface navigation, never a lat/lon
    // made up from the body's centre.
    const hit = renderer.pickScene(screenX, screenY, 'probe');
    const surfacePoint = hit?.kind === 'surface' ? hit.point : null;

    const at = toWorkspace(e.clientX, e.clientY);
    contextMenu = { x: at.x, y: at.y, bodyName, surfacePoint };
  }

  /** Suppress native context menu on the canvas */
  function onCanvasContextMenu(e: MouseEvent) {
    e.preventDefault();
  }

  function onKeydown(e: KeyboardEvent) {
    if (!ui.shortcuts) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      commandPaletteOpen = !commandPaletteOpen;
      return;
    }

    // Let command palette handle all keys when open (arrow nav, typing, etc.)
    if (commandPaletteOpen) return;
    // Likewise the catalog browser, which also handles its own Escape and
    // marks it handled, so the Escape does not go on to dismiss a panel too.
    if ((ui.catalogBrowser && shell.catalogBrowserOpen) || e.defaultPrevented) return;

    // Transient controls own Escape before focus or scene dismissal.
    if (e.key === 'Escape' && workspaceNode().querySelector('[data-popover-content], [data-dropdown-menu-content], [data-select-content], [popover]:popover-open')) return;
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      (e.target instanceof HTMLElement && e.target.isContentEditable)
    ) {
      // First leave text entry; subsequent Escape presses follow the normal
      // flight / inspector / geographic-target dismissal ladder.
      if (e.key === 'Escape') { e.preventDefault(); (e.target as HTMLElement).blur(); }
      return;
    }

    const renderer = getRenderer();
    if (!renderer) return;

    // Undo a delete, which ended the selection and with it the editing keys.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && edits.deleted && !edits.tool && !editingFeature()) {
      e.preventDefault(); undoDelete(); return;
    }
    // Drawing and editing keys (#200), while a draw tool or vertex editing is on.
    if (edits.tool || editingFeature()) {
      const mod = e.ctrlKey || e.metaKey;
      // Undo and redo apply to the layer being drawn into or edited.
      const layerId = editingFeature()?.layerId ?? edits.target;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(layerId); else undo(layerId); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(layerId); return; }
      if (!mod && e.key === 'Enter' && edits.tool) { e.preventDefault(); finishDraft(); return; }
      if (!mod && e.key === 'Backspace' && removeLastVertex()) { e.preventDefault(); return; }
      if (!mod && e.key === 'Delete' && deleteSelectedVertex()) { e.preventDefault(); return; }
      if (e.key === 'Escape' && cancelDrawing()) return;
    }

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
        case 'p': toggleProbe(); return;
        case 'o': if (ui.catalogBrowser) shell.catalogBrowserOpen = true; return;
        case 'Escape':
          if (cancelAppearancePick()) return;
          if (cancelMeasurementPick()) return;
          if (shell.shortcutsOpen) shell.shortcutsOpen = false;
          // A flight is the most transient thing on screen: Escape stops it
          // where it is before it dismisses anything.
          else if (vs.flight) stopFlight();
          // An active mode is what Escape is for: the probe goes before any
          // selection. The pinned point stays until a second Escape (or its
          // panel's close) clears it.
          else if (vs.probeActive) setProbeActive(false);
          else if (measurements.selectedId) selectMeasurement(null);
          // A selected surface feature is as small as an event selection.
          else if (geo.selected) clearGeographicSelection();
          // An event selection is the smallest thing on screen to dismiss:
          // it goes before any panel does.
          else if (ef.selectedId) clearSelection();
          else if (dismissTopSurface()) return;
          else if (dismissGeographicContext()) return;
          else if (vs.selectedBodyName) selectBody(null);
          else resetCamera();
          return;
        case '\\': e.preventDefault(); uiHidden = !uiHidden; return;
      }

      // Tool shortcuts come from the shell's own table, so adding a tool does
      // not mean remembering to add a case above as well.
      const tool = TOOLS.find((t) => t.shortcut === e.key);
      // `I` opens, restores or raises the Instrument view without changing its
      // sensor (#192). Closing stays with the rail, Escape and X.
      if (tool && !e.repeat) {
        if (tool.id === 'instrument') openTool('instrument');
        else toggleTool(tool.id);
      }
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
    // An expanded panel covers the workspace, whatever was touched since: it
    // steps back to its window before anything behind it is dismissed.
    const expanded = expandedPanel();
    if (expanded) {
      toggleExpanded(expanded);
      return true;
    }
    const top = topVisiblePanel();
    if (top == null) return false;
    if (compact) {
      minimizePanel(top);
      return true;
    }
    // The selection-driven panels have no open flag to clear: closing them is
    // undoing what put them there.
    if (isToolId(top)) closeTool(top);
    else if (top === 'probe') clearProbePin();
    else if (top === 'info') selectBody(null);
    return true;
  }

  // ── Catalog navigation (#94) ──
  //
  // Every way into a scene — the home screen, the catalog browser, a deep link, the
  // browser's back button, dropped files — ends in the same loader call; this
  // is only the bookkeeping around it: what is current, what the URL says, and
  // what to tell the user when a load fails.

  /** Record the scene in the URL, as a new history entry, unless it already says so. */
  function pushLocation(loc: CatalogLocation | null) {
    const now = requestedCatalog(location.search);
    if (JSON.stringify(now) === JSON.stringify(loc) && !new URLSearchParams(location.search).has('view')) return;
    const search = new URLSearchParams(withCatalogLocation(location.search, loc));
    search.delete('view');
    history.pushState(null, '', `${location.pathname}${search.size ? `?${search}` : ''}${location.hash}`);
  }

  /**
   * Browser navigation, counted. Every Back/Forward bumps it, and a load
   * started before the latest one finishes without touching history: pushing
   * its own location then would stack an entry on top of where the user just
   * went, and drop the forward entry they came from.
   */
  let navGeneration = 0;
  let loadGeneration = 0;
  let viewRestore: AbortController | null = null;
  /** A load is in flight; set and cleared by `runLoad`. */
  let loadInFlight = $state(false);
  /** Back/Forward arrived during a load and is still owed a reconcile. */
  let navPending = $state(false);

  // The owed reconcile runs once the scene has settled — the loader call and
  // the asset phase after it — rather than being dropped: the URL has already
  // changed, and the scene has to follow it.
  $effect(() => {
    if (navPending && !loadInFlight && !vs.showLoading) {
      navPending = false;
      reconcileWithUrl();
    }
  });

  /**
   * Run one load. The scene that is up stays up until the loader has what it
   * needs for the next one (#70), so a load that fails early leaves it on
   * screen; either way the failure is reported, not just logged. `after` is
   * told whether the user navigated during the load, so it can leave history
   * alone.
   */
  async function runLoad(load: () => Promise<void>, after: (navigatedAway: boolean) => void) {
    const loadToken = ++loadGeneration;
    viewRestore?.abort();
    const generation = navGeneration;
    const preservedEt = getCurrentRenderer()?.timeController.et;
    catalogs.loadError = null;
    loadInFlight = true;
    try {
      await load();
      if (loadToken !== loadGeneration) return;
      after(generation !== navGeneration);
      if (generation === navGeneration) await restoreFromUrl(generation, preservedEt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (generation !== navGeneration || loadToken !== loadGeneration) return;
      catalogs.loadError = `Couldn't load ${vs.loadingCatalog || 'the catalog'}: ${message}`;
      console.error('[Cosmolabe] Catalog load failed:', err);
    } finally {
      if (loadToken === loadGeneration) loadInFlight = false;
    }
  }

  function loadEntry(item: SourcedEntry, push = true) {
    const { scriptUrl } = item.entry;
    // A scripted entry's script is fetched first — it is a few kilobytes — so
    // one that cannot be had fails the load before the scene is touched, and
    // is queued only once the scene it drives is up, never for whatever loads
    // next. The console picks it up when it mounts over the new scene.
    let script: string | null = null;
    void runLoad(
      async () => {
        if (scriptUrl) script = await fetchScript(scriptUrl);
        await loadCatalogUrl(canvas, item.entry.catalogUrl, item.entry.name);
      },
      (navigatedAway) => {
        catalogs.currentUrl = item.entry.catalogUrl;
        catalogs.currentScriptUrl = scriptUrl ?? null;
        if (push && !navigatedAway) pushLocation(catalogLocation(item, location.href));
        if (script != null && !navigatedAway) queueScript(script);
      },
    );
  }

  function selectCatalog(sourceId: string, entry: CatalogEntry) {
    loadEntry({ sourceId, entry });
  }

  /**
   * `?catalog=<name>`. Named by its entry where a source lists it, and by the
   * path until then — a deep link does not wait on the sources, and the name
   * is corrected once they arrive (onMount).
   */
  function loadNamed(name: string) {
    const url = demoCatalogUrl(name);
    const listed = allEntries(catalogs.sources).find((e) => isCurrentEntry(e.entry, url, null));
    void runLoad(() => loadDemo(canvas, name, listed?.entry.name ?? name), () => {
      catalogs.currentUrl = url;
      catalogs.currentScriptUrl = null;
    });
  }

  /**
   * Dropped or picked files. Only a drop that brought a catalog replaced the
   * scene — kernels alone are added to the one that is up — and a scene from
   * local files has no URL, so the catalog parameter is dropped rather than
   * left naming a scene that is no longer on screen.
   */
  function loadFiles(load: () => Promise<void>) {
    const before = getCurrentRenderer();
    void runLoad(load, (navigatedAway) => {
      if (getCurrentRenderer() === before) return;
      catalogs.currentUrl = null;
      catalogs.currentScriptUrl = null;
      if (!navigatedAway) pushLocation(null);
    });
  }

  /**
   * Back and forward. Never ignored: during a load the navigation is owed
   * and reconciled once the load settles (the effect above).
   */
  function onPopState() {
    // An entry from before a source was added lacks its `?source=`.
    syncSourceParams();
    navGeneration++;
    viewRestore?.abort();
    if (loadInFlight || vs.showLoading) navPending = true;
    else reconcileWithUrl();
  }

  /**
   * Bring the scene in line with the URL. One that names a catalog loads it
   * (unless it is already up); one that names none leaves the scene alone,
   * since there is no scene it could mean — the one before might have come
   * from dropped files.
   */
  function reconcileWithUrl() {
    catalogs.loadError = null;
    try {
      const state = requestedView(location.search);
      const req = state?.catalog ?? requestedCatalog(location.search);
      if (!req) return;
      if ('catalog' in req) {
        // A state-less history entry means that catalog's default view. Reload
        // it on Back rather than retaining the later checkpoint's camera/time.
        if (!isCurrentEntry({ catalogUrl: demoCatalogUrl(req.catalog) }, catalogs.currentUrl, catalogs.currentScriptUrl) || !state) loadNamed(req.catalog);
        else void restoreFromUrl(navGeneration);
      } else {
        openEntryParam(req.entry);
      }
    } catch (err) {
      catalogs.loadError = `Couldn't restore view: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * `?entry=<source>/<entry>`: waits for that source only, then loads the
   * entry — unless the user has navigated again meanwhile, in which case the
   * newer navigation's own reconcile owns the scene.
   */
  function openEntryParam(param: string) {
    const generation = navGeneration;
    const sourceId = param.slice(0, Math.max(0, param.indexOf('/')));
    void sourceSettled(sourceId).then((state) => {
      if (generation !== navGeneration) return;
      const item = state ? findEntry([state], param) : null;
      if (!item) {
        catalogs.loadError = `No catalog "${param}" in this viewer's catalog sources.`;
        return;
      }
      if (loadInFlight || vs.showLoading) { navPending = true; return; }
      if (isCurrentEntry(item.entry, catalogs.currentUrl, catalogs.currentScriptUrl) && new URLSearchParams(location.search).has('view')) {
        void restoreFromUrl(generation);
        return;
      }
      loadEntry(item, false);
    });
  }

  async function restoreFromUrl(generation: number, preservedEt?: number) {
    try {
      const state = requestedView(location.search);
      if (!state) return;
      const renderer = getCurrentRenderer();
      if (!renderer) throw new Error('The requested catalog has no scene.');
      await renderer.waitForInitialAssets();
      if (generation !== navGeneration || renderer !== getCurrentRenderer()) return;
      viewRestore?.abort();
      const controller = new AbortController();
      viewRestore = controller;
      await restoreView(state.time.kind === 'preserve' && preservedEt !== undefined
        ? { ...state, time: { kind: 'fixed', source: 'ET', et: preservedEt } } : state, controller.signal);
    } catch (err) {
      if (generation === navGeneration) {
        catalogs.loadError = `Couldn't restore view: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  /**
   * A load an embedding host asked for (`embed.ts`). No URL, history or
   * catalog sources: the host decides what is on screen. Resolves once the
   * scene's initial models, textures and trails settle; rejects when the load
   * fails, leaving up the scene that was there.
   */
  export async function loadForHost(entryUrl: string, name: string, fetcher?: CatalogFetcher): Promise<void> {
    const loadToken = ++loadGeneration;
    catalogs.loadError = null;
    loadInFlight = true;
    try {
      await loadCatalogUrl(canvas, entryUrl, name, fetcher);
      await getCurrentRenderer()?.waitForInitialAssets();
    } catch (err) {
      if (loadToken === loadGeneration) catalogs.loadError = `Couldn't load ${name}: ${err instanceof Error ? err.message : String(err)}`;
      throw err;
    } finally {
      if (loadToken === loadGeneration) loadInFlight = false;
    }
  }

  onMount(() => {
    setWorkspaceRoot(rootEl);
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(rootEl);
    onResize();
    // Embedded, input is the workspace's only while it has focus or the
    // pointer: the host page keeps its keys, and its right-clicks.
    // (Typed as an element: the window takes the same listeners.)
    const input = (embedded ? rootEl : window) as HTMLElement;
    input.addEventListener('keydown', onKeydown);
    // Capture phase so we see right-clicks before CameraController stops propagation
    input.addEventListener('pointerdown', onWindowPointerDown, true);
    input.addEventListener('pointerup', onWindowPointerUp);
    const stopInput = () => {
      resizeObserver.disconnect();
      input.removeEventListener('keydown', onKeydown);
      input.removeEventListener('pointerdown', onWindowPointerDown, true);
      input.removeEventListener('pointerup', onWindowPointerUp);
    };
    if (embedded) {
      return () => {
        loadGeneration++;
        stopInput();
        setWorkspaceRoot(null);
      };
    }
    // Visual-regression / deep-link entry: `?catalog=<name>` auto-loads a demo
    // (combine with `?test=1` for deterministic offscreen capture — see
    // scripts/visual-regression.mjs).
    // `?entry=<source>/<entry>` names a catalog in a configured source, so it
    // waits for that source — and only that one; `?catalog=` needs none.
    const sourcesDone = initCatalogSources();
    reconcileWithUrl();
    const requested = requestedCatalog(location.search);
    void sourcesDone.then((states) => {
      if (requested && 'catalog' in requested) {
        const url = demoCatalogUrl(requested.catalog);
        const listed = allEntries(states).find((e) => e.entry.catalogUrl === url);
        if (listed && vs.loadingCatalog === requested.catalog) vs.loadingCatalog = listed.entry.name;
      }
    });
    window.addEventListener('popstate', onPopState);
    // The standalone viewer owns the page, drops included.
    document.addEventListener('dragover', onDocDragOver);
    document.addEventListener('drop', onDocDrop);
    const stopLayoutWatch = watchLayout();
    return () => {
      viewRestore?.abort();
      stopHero();
      stopLayoutWatch();
      stopInput();
      window.removeEventListener('popstate', onPopState);
      document.removeEventListener('dragover', onDocDragOver);
      document.removeEventListener('drop', onDocDrop);
      setWorkspaceRoot(null);
    };
  });
</script>

<!-- Embedded, the root is the containing block for every page-level layer
     (floating panels, callouts, portalled popovers), so they stay inside the
     workspace and move with the host page; it takes focus so its shortcuts
     apply only while it is in use. `container-type` makes cq units the
     workspace's, which the standalone page's root equals the viewport for. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  bind:this={rootEl}
  class="cosmolabe-root relative w-full h-full overflow-hidden"
  class:cosmolabe-embedded={embedded}
  class:cursor-crosshair={!!measurements.pendingPickSlot}
  style={shellVars}
  tabindex={embedded ? -1 : undefined}
  role={embedded ? 'application' : undefined}
  aria-label={embedded ? 'Cosmolabe mission visualization' : undefined}
>
<BitsConfig defaultPortalTo={embedded ? rootEl : undefined}>
  <!-- `touch-none`: the browser must not claim a drag as a scroll or a pinch as
       a page zoom before the camera controls see the gesture. -->
  <canvas bind:this={canvas} class="absolute inset-0 w-full h-full block touch-none" oncontextmenu={onCanvasContextMenu}></canvas>

  <!-- Gated on `loading`, not `sceneLoaded`: the scene graph exists well before
       its models and textures do, and handing over a sky of placeholder spheres
       reads as a broken scene rather than a loading one. -->
  {#if vs.showLoading}
    <LoadingScreen />
  {:else if !vs.assetsReady && ui.homeScreen}
    <HomeScreen
      backdrop={heroReady}
      onSelect={selectCatalog}
      onDrop={(dt) => loadFiles(() => handleDrop(canvas, dt))}
      onFiles={(files) => loadFiles(() => handleFileList(canvas, files))}
    />
  {/if}

  <!-- One catalog browser for both entry points: the home screen's Browse and
       the rail's folder button. It sits over whichever is up, and a load
       covers it with the loading screen only once a catalog is chosen. -->
  {#if !vs.showLoading && ui.catalogBrowser}
    <CatalogBrowser
      onSelect={selectCatalog}
      onFiles={(files) => loadFiles(() => handleFileList(canvas, files))}
    />
  {/if}

  {#if !loading && catalogs.loadError}
    <!-- A switch that failed before touching the scene leaves it up; say so
         over it, briefly and out of the way, rather than only in the console. -->
    <div class="load-notice shell-surface pointer-events-auto absolute left-1/2 top-3 z-30 flex max-w-[min(32rem,calc(100cqw-2rem))] -translate-x-1/2 items-start gap-3 rounded-md border px-3 py-2 text-[12px] text-text-secondary backdrop-blur-md" role="alert">
      <span class="min-w-0 break-words">{catalogs.loadError}</span>
      <button class="shrink-0 text-text-muted hover:text-text-primary" aria-label="Dismiss" onclick={() => (catalogs.loadError = null)}>&times;</button>
    </div>
  {/if}

  {#if !loading && !uiHidden}
    <ViewportHud />
    <GeographicLabels />
    <GeographicCallout />
    <GeographicEditOverlay />
    <DrawToolbar />

    <!-- Instruments overlay the scene; none of them places itself, and any of
         them can be dragged out of its dock. Compact shows one sheet at a time
         — the scene is the point, and a phone has room for it and one
         instrument. -->
    {#if ui.analysisPanels}
      {#if compact}
        <PanelDock side="sheet">
          <ToolPanels dock="all" />
          {#if shell.activeSheet === 'info' || fallbackSheet === 'info'}
            <BodyInfoPanel />
          {/if}
          {#if shell.activeSheet === 'probe' || fallbackSheet === 'probe'}
            <ProbePanel />
          {/if}
        </PanelDock>
      {:else}
        <PanelDock side="left">
          <ToolPanels dock="left" />
        </PanelDock>
        <PanelDock side="right">
          <BodyInfoPanel />
          <ToolPanels dock="right" />
          <ProbePanel width={240} />
        </PanelDock>
      {/if}
    {/if}

    {#if compact && (ui.timeline || ui.toolRail)}
      <!-- One bar, not two: the rail and the transport share a box so the
           chrome costs the scene one strip instead of a third of the screen. -->
      <div
        bind:clientHeight={shell.chromeBottom}
        class="compact-dock shell-surface pointer-events-auto absolute inset-x-2 bottom-2 z-20 overflow-hidden rounded-md border backdrop-blur-md"
      >
        {#if ui.timeline}<TimelineDock inline />{/if}
        {#if ui.timeline && ui.toolRail}<div class="shell-divider mx-2 border-t"></div>{/if}
        {#if ui.toolRail}
          <ToolRail
            inline
            probeActive={vs.probeActive}
            onToggleProbe={toggleProbe}
            onOpenSearch={() => commandPaletteOpen = true}
          />
        {/if}
      </div>
    {:else if !compact}
      {#if ui.toolRail}
        <ToolRail
          probeActive={vs.probeActive}
          onToggleProbe={toggleProbe}
          onOpenSearch={() => commandPaletteOpen = true}
        />
      {/if}
      {#if ui.timeline}<TimelineDock />{/if}
    {/if}

    <CommandPalette open={commandPaletteOpen} onClose={() => commandPaletteOpen = false} />

    {#if contextMenu}
      <ContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        bodyName={contextMenu.bodyName}
        surfacePoint={contextMenu.surfacePoint}
        onClose={() => contextMenu = null}
      />
    {/if}
  {/if}
</BitsConfig>
</div>

<style>
  .compact-dock {
    box-shadow: 0 -8px 28px rgba(0, 0, 0, 0.24);
  }
  .cosmolabe-root {
    container-type: size;
  }
  .cosmolabe-embedded {
    contain: layout paint;
    outline: none;
  }
</style>
