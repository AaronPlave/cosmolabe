/**
 * Shell state — which contextual tool surfaces are open, where they are, and
 * how much of themselves they are currently showing.
 *
 * This is the state half of Cosmolabe's 3D-first workspace (#59): the scene is
 * the continuous base layer, and everything here describes instruments that
 * overlay it. It deliberately holds no scene state — time, selection, display
 * options and the rest stay in `viewer-state.svelte.ts`, and the shell reads
 * them like any other consumer.
 *
 * Two ideas carry most of the weight:
 *
 * - **A panel's place is not fixed.** Panels open into a dock, and the dock is
 *   a default rather than an address: drag one by its header and it floats,
 *   where it can be moved and resized. This is not a window manager — there is
 *   no z-order to manage, no tiling, no persistence — it is a rectangle and two
 *   constraints (`panel-geometry.ts`).
 * - **Minimized is not closed.** An instrument you want out of the way keeps
 *   its search, its selection and its form; only its body is hidden. Closing is
 *   the separate, destructive act.
 * - **The user's attention has an order.** `panelOrder` records which panel was
 *   touched most recently. It answers two questions with one list: which
 *   floating panel draws on top, and which surface Escape dismisses.
 */
import { Globe, Radar, Ruler, Settings, Bug } from 'lucide-svelte';
import { clampFloat, type FloatRect, type Viewport } from './panel-geometry';

/**
 * What a rail icon is. Taken from a concrete icon rather than written as
 * `Component`, because lucide-svelte still ships legacy class components and
 * the two signatures are not assignable.
 */
export type IconComponent = typeof Globe;

/** The contextual tool surfaces the rail can open. */
export const TOOL_IDS = ['catalog', 'events', 'measure', 'display', 'debug'] as const;

export type ToolId = (typeof TOOL_IDS)[number];

export function isToolId(value: string): value is ToolId {
  return (TOOL_IDS as readonly string[]).includes(value);
}

/**
 * Everything that can be a panel, which is not the same as everything the rail
 * opens: the body info panel follows the selection and the surface-pick readout
 * follows a click, so neither is a tool, but both are instruments the user
 * should be able to move and minimize like any other.
 */
export const PANEL_KEYS = [...TOOL_IDS, 'info', 'pick'] as const;

export type PanelKey = (typeof PANEL_KEYS)[number];

/**
 * How a surface presents itself.
 *
 * `panel` is the default and the one #59 asks new analysis features to use. The
 * other two exist because the catalog and the display menu already had
 * presentations that earn their shape — a full-height browsing drawer and a
 * small anchored menu — and #59's point is that the catalog is a *separate
 * contextual instrument*, not a panel in a stack. Only `panel` surfaces are laid
 * out by `PanelDock`, and only they float and minimize.
 */
export type ToolPresentation = 'panel' | 'drawer' | 'menu';

export interface ToolDef {
  id: ToolId;
  label: string;
  icon: IconComponent;
  presentation: ToolPresentation;
  /** Which dock a `panel` surface opens into, before the user moves it. */
  dock: 'left' | 'right';
  /** Panel width in px at the desktop layout; ignored when compact. */
  width: number;
  /** Single-key shortcut, where one already existed. */
  shortcut?: string;
}

/**
 * The tool table — the single source of truth for the rail, the keyboard map
 * and the command palette, which previously kept three partial copies of this
 * list between `App.svelte` and `BottomBar.svelte`.
 */
export const TOOLS: readonly ToolDef[] = [
  { id: 'catalog', label: 'Catalog',  icon: Globe,    presentation: 'drawer', dock: 'left',  width: 300, shortcut: 'b' },
  { id: 'events',  label: 'Events',   icon: Radar,    presentation: 'panel',  dock: 'left',  width: 384, shortcut: 'e' },
  { id: 'measure', label: 'Measure',  icon: Ruler,    presentation: 'panel',  dock: 'left',  width: 400 },
  { id: 'display', label: 'Display',  icon: Settings, presentation: 'menu',   dock: 'right', width: 240 },
  { id: 'debug',   label: 'Diagnostics', icon: Bug,   presentation: 'panel',  dock: 'right', width: 260 },
];

export function toolDef(id: ToolId): ToolDef {
  const def = TOOLS.find((t) => t.id === id);
  // Unreachable through `ToolId`, but `find` is typed as possibly-undefined and
  // a non-null assertion would hide a genuine mistake in a hand-written table.
  if (!def) throw new Error(`unknown tool: ${id}`);
  return def;
}

/** Per-panel placement, independent of whether the panel is currently open. */
export interface PanelRuntime {
  /** Showing its header only. The body's state is untouched. */
  minimized: boolean;
  /** Non-null once the user drags the panel out of its dock. */
  float: FloatRect | null;
}

function seedPanels(): Record<PanelKey, PanelRuntime> {
  return Object.fromEntries(
    PANEL_KEYS.map((key) => [key, { minimized: false, float: null }]),
  ) as Record<PanelKey, PanelRuntime>;
}

/**
 * The shell's own reactive state. Same shape as `vs`: one `$state` object whose
 * properties are mutated, never reassigned.
 */
export const shell = $state({
  /**
   * Open surfaces, least-recently-opened first. The order is load-bearing
   * twice: it is the dock's stacking order, and its end is what Escape closes.
   */
  openTools: [] as ToolId[],

  /**
   * Placement for every panel, seeded up front so a panel never has to create
   * its own entry while rendering.
   */
  panels: seedPanels(),

  /**
   * Focus order, least-recently-touched first.
   *
   * Not the same list as `openTools`: it covers the selection-driven panels too,
   * it survives closing, and it moves when a panel is merely clicked. Opening a
   * panel is one way to reach the top of it; using one is the other.
   */
  panelOrder: [] as PanelKey[],

  /**
   * Which panels are currently rendered. A panel registers itself, so the shell
   * does not have to model why each one is on screen — the info panel follows
   * the selection and the pick readout follows a click, and neither condition
   * belongs here.
   *
   * Mounted is not the same as visible: a minimized panel still renders its
   * header.
   */
  mounted: Object.fromEntries(PANEL_KEYS.map((k) => [k, false])) as Record<PanelKey, boolean>,

  /**
   * `compact` is the phone/narrow presentation. It is a presentation switch over
   * the same state, not a separate feature model — #59's requirement, and what
   * keeps a second mobile-only code path from appearing.
   */
  layout: 'desktop' as 'desktop' | 'compact',

  /**
   * The one panel showing when compact.
   *
   * A phone has room for one instrument and the scene, and not for both plus a
   * stack of others: the first version scrolled every open panel into one tall
   * sheet, which buried the scene the shell exists to keep primary. Other open
   * tools stay open and keep their state; the rail switches between them.
   */
  activeSheet: null as PanelKey | null,

  /**
   * The keyboard-shortcut strip in the timeline dock. Chrome rather than an
   * analysis surface, so it is a flag here rather than a `ToolId` — it docks
   * nowhere and stacks with nothing.
   */
  shortcutsOpen: false,

  /**
   * Progressive analysis depth on the timeline. `transport` is the minimal time
   * strip; `expanded` adds the secondary transport and the region event lanes
   * (#67) and continuous profiles (#65) will draw into.
   */
  timelineDepth: 'transport' as 'transport' | 'expanded',

  /**
   * Measured height of the bottom chrome, in px — the timeline dock on desktop,
   * the combined timeline-and-rail dock when compact.
   *
   * Measured rather than declared because it is not a constant the shell gets to
   * pick: it grows with the expanded lane region, with the shortcut strip, and
   * at a phone width with a transport that wraps. The first version used rem
   * constants, and the wrapped transport promptly grew under the rail and
   * swallowed its clicks.
   */
  chromeBottom: 0,
});

// ── Open / close ──

export function isToolOpen(id: ToolId): boolean {
  return shell.openTools.includes(id);
}

/** Opens `id`, or raises it to the top of the stack if already open. */
export function openTool(id: ToolId) {
  closeToolSilently(id);
  shell.openTools.push(id);
  shell.panels[id].minimized = false;
  raisePanel(id);
  if (shell.layout === 'compact') shell.activeSheet = id;
}

function closeToolSilently(id: ToolId) {
  const i = shell.openTools.indexOf(id);
  if (i >= 0) shell.openTools.splice(i, 1);
}

export function closeTool(id: ToolId) {
  closeToolSilently(id);
  // Minimizing is a view state and closing resets it, so reopening a panel does
  // not hand it back collapsed. Its float rect survives: where the user put an
  // instrument is a preference, not a transient.
  shell.panels[id].minimized = false;
  if (shell.activeSheet === id) shell.activeSheet = lastOpenPanel();
}

function lastOpenPanel(): ToolId | null {
  for (let i = shell.openTools.length - 1; i >= 0; i--) {
    const id = shell.openTools[i];
    if (toolDef(id).presentation === 'panel' && !shell.panels[id].minimized) return id;
  }
  return null;
}

/**
 * What the rail's button does, which differs by layout because the layouts
 * answer different questions.
 *
 * Desktop asks "is this instrument on my workspace?" — so a second press closes
 * it, and a press on a minimized one brings it back rather than closing
 * something the user cannot currently see.
 *
 * Compact asks "which instrument am I looking at?" — so a press on the visible
 * one puts it away without losing it, and a press on any other switches to it.
 */
export function toggleTool(id: ToolId) {
  const runtime = shell.panels[id];
  if (!isToolOpen(id)) {
    openTool(id);
    return;
  }
  if (shell.layout === 'compact') {
    if (shell.activeSheet === id) minimizePanel(id);
    else activateSheet(id);
    return;
  }
  if (runtime.minimized) {
    runtime.minimized = false;
    openTool(id); // raise
    return;
  }
  closeTool(id);
}

export function closeAllTools() {
  for (const id of [...shell.openTools]) closeTool(id);
  shell.openTools.length = 0;
  shell.activeSheet = null;
}

/** Open surfaces of one presentation, in the order they should be laid out. */
export function openToolsWith(presentation: ToolPresentation, dock?: 'left' | 'right'): ToolDef[] {
  return shell.openTools
    .map(toolDef)
    .filter((t) => t.presentation === presentation && (dock === undefined || t.dock === dock));
}

// ── Focus order ──

/**
 * Brings a panel to the front of the focus order. Called when a panel is
 * clicked or dragged, and when one is opened.
 */
export function raisePanel(key: PanelKey) {
  const i = shell.panelOrder.indexOf(key);
  // `i >= 0` guards the empty list, where `indexOf` and `length - 1` are both
  // -1 and the "already on top" test would swallow the first raise.
  if (i >= 0 && i === shell.panelOrder.length - 1) return; // on top; don't churn
  if (i >= 0) shell.panelOrder.splice(i, 1);
  shell.panelOrder.push(key);
}

/** Where a floating panel sits in the stack. */
export const FLOAT_Z_BASE = 16;

/**
 * A floating panel's `z-index`, from its place in the focus order.
 *
 * Bounded by the number of panels, and deliberately kept under the drawer and
 * menu layers (25+): a floating instrument is part of the workspace, not
 * something that should cover the catalog.
 */
export function panelZIndex(key: PanelKey): number {
  const i = shell.panelOrder.indexOf(key);
  return FLOAT_Z_BASE + (i < 0 ? 0 : Math.min(i, PANEL_KEYS.length - 1));
}

/** A panel reports whether it is on screen at all. */
export function setPanelMounted(key: PanelKey, value: boolean) {
  shell.mounted[key] = value;
}

/** Rendered and showing its body — what a user would point at and call open. */
export function isPanelVisible(key: PanelKey): boolean {
  return shell.mounted[key] && !shell.panels[key].minimized;
}

/**
 * The surface Escape should dismiss: the most recently touched panel that is
 * actually on screen.
 *
 * Escape used to take the end of `openTools`, which is neither — it ignored the
 * selection-driven panels entirely, and on a phone it could close a tool the
 * user could not see while the sheet in front of them stayed put.
 */
export function topVisiblePanel(): PanelKey | null {
  for (let i = shell.panelOrder.length - 1; i >= 0; i--) {
    const key = shell.panelOrder[i];
    if (isPanelVisible(key)) return key;
  }
  // Nothing has been touched yet but something may still be on screen — a panel
  // opened by a keyboard shortcut and never clicked, for instance.
  return PANEL_KEYS.find(isPanelVisible) ?? null;
}

// ── Minimize ──

export function isMinimized(key: PanelKey): boolean {
  return shell.panels[key].minimized;
}

export function minimizePanel(key: PanelKey) {
  shell.panels[key].minimized = true;
  // Compact shows one sheet, so minimizing the visible one gives the scene the
  // whole screen rather than promoting the next panel into its place.
  if (shell.activeSheet === key) shell.activeSheet = null;
}

export function restorePanel(key: PanelKey) {
  shell.panels[key].minimized = false;
  raisePanel(key);
  if (shell.layout === 'compact') shell.activeSheet = key;
}

export function toggleMinimized(key: PanelKey) {
  if (shell.panels[key].minimized) restorePanel(key);
  else minimizePanel(key);
}

// ── Compact sheets ──

export function activateSheet(key: PanelKey | null) {
  shell.activeSheet = key;
  if (key) {
    shell.panels[key].minimized = false;
    raisePanel(key);
  }
}

// ── Floating ──

export function isFloating(key: PanelKey): boolean {
  return shell.panels[key].float !== null;
}

export function floatOf(key: PanelKey): FloatRect | null {
  return shell.panels[key].float;
}

export function setFloat(key: PanelKey, rect: FloatRect, viewport: Viewport) {
  shell.panels[key].float = clampFloat(rect, viewport);
}

/** Sends a floating panel back to its dock, discarding the rect. */
export function dockPanel(key: PanelKey) {
  shell.panels[key].float = null;
}

/**
 * Re-clamps every floating panel, for when the viewport changes under them —
 * a resized window or a rotated phone must not strand a panel off-screen.
 */
export function reclampFloats(viewport: Viewport) {
  // Judged from the viewport passed in, not from `shell.layout`: `resize` and
  // the `matchMedia` listener fire in no guaranteed order, so on the way down
  // to a phone width this ran once while the layout still said `desktop` and
  // flattened every stored rect against a 390px viewport before compact was
  // even entered. The argument is the only thing here that is certainly current.
  //
  // At these widths the rects are a stored desktop arrangement rather than
  // anything on screen (see `setLayout`), and clamping them would destroy it.
  if (viewport.width <= COMPACT_MAX_WIDTH) return;
  for (const key of PANEL_KEYS) {
    const rect = shell.panels[key].float;
    if (rect) shell.panels[key].float = clampFloat(rect, viewport);
  }
}

// ── Layout ──

export function setLayout(layout: 'desktop' | 'compact') {
  if (shell.layout === layout) return;
  shell.layout = layout;
  // Float rects are kept, not cleared. Compact ignores them — a phone-width
  // screen has nowhere to float anything — but narrowing a window and widening
  // it again should hand back the workspace the user arranged, not a pile of
  // panels back in their docks. `reclampFloats` leaves them alone while compact
  // for the same reason: clamping a desktop rect to a phone viewport would
  // destroy it on the way through.
  if (layout === 'compact') shell.activeSheet = lastOpenPanel();
}

export function setTimelineDepth(depth: 'transport' | 'expanded') {
  shell.timelineDepth = depth;
}

/** The width below which the shell uses its compact presentation. */
export const COMPACT_MAX_WIDTH = 767;

/**
 * Binds `shell.layout` to the viewport width. Returns a teardown, and is a
 * no-op where `matchMedia` is absent (tests, non-DOM hosts) so importing this
 * module never requires a browser.
 */
export function watchLayout(): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia(`(max-width: ${COMPACT_MAX_WIDTH}px)`);
  const apply = () => setLayout(mq.matches ? 'compact' : 'desktop');
  apply();
  mq.addEventListener('change', apply);
  return () => mq.removeEventListener('change', apply);
}
