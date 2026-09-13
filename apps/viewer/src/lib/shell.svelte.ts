/**
 * Shell state — which contextual tool surfaces are open, and how the shell is
 * laid out.
 *
 * This is the state half of Cosmolabe's 3D-first workspace (#59): the scene is
 * the continuous base layer, and everything here describes instruments that
 * overlay it. It deliberately holds no scene state — time, selection, display
 * options and the rest stay in `viewer-state.svelte.ts`, and the shell reads
 * them like any other consumer.
 *
 * It replaces the six independent `$state` booleans `App.svelte` used to keep,
 * which had two problems beyond the bookkeeping: three panels hardcoded the
 * same `top-3 left-3` slot and overlapped when opened together, and "what does
 * Escape close?" was an if/else chain in source order rather than a property of
 * what the user actually opened last.
 */
import { Globe, Radar, Ruler, Settings, Bug } from 'lucide-svelte';

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
 * How a surface presents itself.
 *
 * `panel` is the default and the one #59 asks new analysis features to use: a
 * compact instrument stacked in a side dock. The other two exist because the
 * catalog and the display menu already had presentations that earn their shape
 * — a full-height browsing drawer and a small anchored menu — and #59's point
 * is that the catalog is a *separate contextual instrument*, not a panel in a
 * stack. Only `panel` surfaces are laid out by `PanelDock`.
 */
export type ToolPresentation = 'panel' | 'drawer' | 'menu';

export interface ToolDef {
  id: ToolId;
  label: string;
  icon: IconComponent;
  presentation: ToolPresentation;
  /** Which dock a `panel` surface stacks in. */
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
   * `compact` is the phone/narrow presentation: the rail becomes a horizontal
   * strip and panels become bottom sheets. It is a presentation switch over the
   * same state, not a separate feature model — #59's requirement, and what
   * keeps a second mobile-only code path from appearing.
   */
  layout: 'desktop' as 'desktop' | 'compact',

  /**
   * Progressive analysis depth on the timeline. `transport` is the minimal time
   * strip; `expanded` adds the region event lanes (#67) and continuous profiles
   * (#65) will draw into. Further levels belong to those issues, not here.
   */
  timelineDepth: 'transport' as 'transport' | 'expanded',

  /**
   * The keyboard-shortcut strip in the timeline dock. Chrome rather than an
   * analysis surface, so it is a flag here rather than a `ToolId` — it docks
   * nowhere and stacks with nothing.
   */
  shortcutsOpen: false,

  /**
   * Measured heights of the two surfaces everything else docks above, in px.
   *
   * Measured rather than declared because the timeline's height is not a
   * constant the shell gets to pick: it grows with the expanded lane region,
   * with the shortcut strip, and — at a phone width, where the transport wraps
   * onto a second row — with the viewport itself. The first version of this
   * used rem constants, and the wrapped transport promptly grew under the rail
   * and swallowed its clicks.
   */
  timelineHeight: 0,
  railHeight: 0,
});

export function isToolOpen(id: ToolId): boolean {
  return shell.openTools.includes(id);
}

/** Opens `id`, or raises it to the top of the stack if already open. */
export function openTool(id: ToolId) {
  closeTool(id);
  shell.openTools.push(id);
}

export function closeTool(id: ToolId) {
  const i = shell.openTools.indexOf(id);
  if (i >= 0) shell.openTools.splice(i, 1);
}

export function toggleTool(id: ToolId) {
  if (isToolOpen(id)) closeTool(id);
  else openTool(id);
}

/**
 * Closes the most recently opened surface. Returns whether there was one, so
 * Escape can fall through to clearing the selection and resetting the camera
 * exactly as it did before.
 */
export function closeTopTool(): boolean {
  const top = shell.openTools.pop();
  return top !== undefined;
}

export function closeAllTools() {
  shell.openTools.length = 0;
}

/** Open surfaces of one presentation, in the order they should be laid out. */
export function openToolsWith(presentation: ToolPresentation, dock?: 'left' | 'right'): ToolDef[] {
  return shell.openTools
    .map(toolDef)
    .filter((t) => t.presentation === presentation && (dock === undefined || t.dock === dock));
}

export function setLayout(layout: 'desktop' | 'compact') {
  shell.layout = layout;
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
