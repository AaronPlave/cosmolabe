import { describe, it, expect, beforeEach } from 'vitest';
import {
  TOOLS, PANEL_KEYS, shell, toolDef, isToolOpen, openTool, closeTool, toggleTool,
  closeAllTools, openToolsWith, setLayout, setTimelineDepth,
  watchLayout, isToolId, isMinimized, minimizePanel, toggleMinimized,
  isFloating, setFloat, dockPanel, floatOf, reclampFloats, activateSheet,
  raisePanel, panelZIndex, setPanelMounted, isPanelVisible, topVisiblePanel,
  FLOAT_Z_BASE, type PanelKey,
} from '../shell.svelte';

/**
 * The regression this file exists for: three panels — the event finder, the
 * measure tool and the diagnostics panel — each positioned themselves at
 * `top-3 left-3`, so opening two drew one on top of the other. The fix is that
 * panels no longer position themselves; a dock lays out whatever is open, in
 * the order it was opened. These tests pin the ordering that dock depends on,
 * and that no two open panels can resolve to the same place.
 */

const viewport = { width: 1440, height: 900 };

beforeEach(() => {
  setLayout('desktop');
  closeAllTools();
  setTimelineDepth('transport');
  shell.shortcutsOpen = false;
  shell.activeSheet = null;
  shell.panelOrder.length = 0;
  for (const key of PANEL_KEYS) {
    shell.panels[key].minimized = false;
    shell.panels[key].float = null;
    shell.mounted[key] = false;
  }
});

/** Stands in for the panels registering themselves as they render. */
function mount(...keys: PanelKey[]) {
  for (const key of keys) setPanelMounted(key, true);
}

describe('the tool table', () => {
  it('gives every tool a unique id', () => {
    expect(new Set(TOOLS.map((t) => t.id)).size).toBe(TOOLS.length);
  });

  it('gives every shortcut to at most one tool', () => {
    const keys = TOOLS.map((t) => t.shortcut).filter((k) => k != null);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('does not bind Events to camera roll-right', () => {
    expect(toolDef('events').shortcut).toBeUndefined();
  });

  it('resolves a tool by id, and refuses one it does not have', () => {
    expect(toolDef('events').label).toBe('Events');
    expect(() => toolDef('nonesuch' as never)).toThrow();
    expect(isToolId('events')).toBe(true);
    expect(isToolId('nonesuch')).toBe(false);
  });
});

describe('opening and closing', () => {
  it('toggles', () => {
    expect(isToolOpen('events')).toBe(false);
    toggleTool('events');
    expect(isToolOpen('events')).toBe(true);
    toggleTool('events');
    expect(isToolOpen('events')).toBe(false);
  });

  it('does not open the same tool twice', () => {
    openTool('events');
    openTool('events');
    expect(shell.openTools).toEqual(['events']);
  });

  it('raises an already-open tool to the top rather than leaving it buried', () => {
    openTool('events');
    openTool('catalog');
    openTool('events');
    expect(shell.openTools).toEqual(['catalog', 'events']);
  });

  it('closes a tool that is not open without disturbing the rest', () => {
    openTool('events');
    closeTool('catalog');
    expect(shell.openTools).toEqual(['events']);
  });
});

/**
 * Escape and the panel stack both answer "what is the user working on?", and
 * both used to answer it from the wrong list. The first version walked an
 * if/else chain in source order; the second took the end of `openTools`, which
 * ignores the selection-driven panels and can name a tool hidden behind the
 * sheet in front of the user.
 */
describe('focus order', () => {
  it('puts an opened panel on top', () => {
    openTool('events');
    openTool('debug');
    expect(shell.panelOrder.at(-1)).toBe('debug');
  });

  it('raises a panel that is merely used, without reopening it', () => {
    openTool('events');
    openTool('debug');
    raisePanel('events');
    expect(shell.panelOrder.at(-1)).toBe('events');
    // Raising is not opening: the open stack, which the docks lay out by, is
    // untouched.
    expect(shell.openTools).toEqual(['events', 'debug']);
  });

  it('does not churn the order when the top panel is raised again', () => {
    openTool('events');
    openTool('debug');
    const before = [...shell.panelOrder];
    raisePanel('debug');
    expect(shell.panelOrder).toEqual(before);
  });

  it('covers panels that no tool opens', () => {
    openTool('events');
    raisePanel('info');
    expect(shell.panelOrder.at(-1)).toBe('info');
  });

  it('stacks floating panels by that order, under transient overlay layers', () => {
    openTool('events');
    openTool('debug');
    expect(panelZIndex('debug')).toBeGreaterThan(panelZIndex('events'));
    expect(panelZIndex('events')).toBeGreaterThanOrEqual(FLOAT_Z_BASE);
    // 25+ is reserved for transient overlays. A floating instrument stays in
    // the workspace layer.
    expect(panelZIndex('debug')).toBeLessThan(25);
  });

  it('gives every panel a legal z-index even with none raised yet', () => {
    for (const key of PANEL_KEYS) {
      expect(panelZIndex(key)).toBeGreaterThanOrEqual(FLOAT_Z_BASE);
      expect(panelZIndex(key)).toBeLessThan(25);
    }
  });
});

describe('what Escape dismisses', () => {
  it('finds nothing when nothing is on screen, so Escape falls through', () => {
    expect(topVisiblePanel()).toBe(null);
  });

  it('takes the most recently touched visible panel', () => {
    openTool('events');
    openTool('debug');
    mount('events', 'debug');
    expect(topVisiblePanel()).toBe('debug');
    raisePanel('events');
    expect(topVisiblePanel()).toBe('events');
  });

  it('skips a minimized panel, which is on screen but not in the way', () => {
    openTool('events');
    openTool('debug');
    mount('events', 'debug');
    minimizePanel('debug');
    expect(isPanelVisible('debug')).toBe(false);
    expect(topVisiblePanel()).toBe('events');
  });

  it('prefers a pick readout the user is looking at over a stowed tool', () => {
    openTool('events');
    mount('events', 'pick');
    minimizePanel('events');
    raisePanel('pick');
    expect(topVisiblePanel()).toBe('pick');
  });

  it('prefers the body info panel over a tool opened earlier', () => {
    openTool('events');
    mount('events', 'info');
    raisePanel('info');
    expect(topVisiblePanel()).toBe('info');
  });

  it('never names a tool that is open but not rendered', () => {
    // The compact case: only the active sheet mounts, so a background tool must
    // not be what Escape reaches for.
    openTool('events');
    openTool('debug');
    mount('debug');
    expect(topVisiblePanel()).toBe('debug');
  });

  it('finds a panel that is on screen but has never been touched', () => {
    mount('info');
    expect(topVisiblePanel()).toBe('info');
  });
});

describe('dock layout', () => {
  it('lays panels out in the order they were opened', () => {
    openTool('catalog');
    openTool('events');
    expect(openToolsWith('panel', 'left').map((t) => t.id)).toEqual(['catalog', 'events']);
  });

  it('sends each panel to exactly one dock, so two can never share a slot', () => {
    for (const tool of TOOLS) openTool(tool.id);
    const left = openToolsWith('panel', 'left').map((t) => t.id);
    const right = openToolsWith('panel', 'right').map((t) => t.id);
    expect(left.filter((id) => right.includes(id))).toEqual([]);
    // Every open panel is accounted for by one side or the other — a panel in
    // neither would render nowhere.
    const panels = TOOLS.filter((t) => t.presentation === 'panel').map((t) => t.id);
    expect([...left, ...right].sort()).toEqual([...panels].sort());
  });

  it('puts catalog and display settings in panel docks too', () => {
    openTool('catalog');
    openTool('display');
    expect(openToolsWith('panel').map((t) => t.id)).toEqual(['catalog', 'display']);
    expect(openToolsWith('drawer')).toEqual([]);
    expect(openToolsWith('menu')).toEqual([]);
  });

  it('collects both sides into one stack when no dock is named, for the compact sheet', () => {
    openTool('debug');
    openTool('events');
    expect(openToolsWith('panel').map((t) => t.id)).toEqual(['debug', 'events']);
  });
});

describe('layout', () => {
  it('follows the media query, and keeps following it as the viewport changes', () => {
    const listeners: Array<() => void> = [];
    let matches = false;
    const fakeWindow = {
      matchMedia: () => ({
        get matches() { return matches; },
        addEventListener: (_: string, fn: () => void) => listeners.push(fn),
        removeEventListener: () => {},
      }),
    };
    const original = globalThis.window;
    // @ts-expect-error — a stand-in for the two members `watchLayout` touches.
    globalThis.window = fakeWindow;
    try {
      const stop = watchLayout();
      expect(shell.layout).toBe('desktop');
      matches = true;
      for (const fn of listeners) fn();
      expect(shell.layout).toBe('compact');
      stop();
    } finally {
      globalThis.window = original;
    }
  });

  it('is a no-op without matchMedia, so importing the shell never needs a browser', () => {
    const original = globalThis.window;
    // @ts-expect-error — deliberately absent.
    globalThis.window = undefined;
    try {
      expect(() => watchLayout()()).not.toThrow();
      expect(shell.layout).toBe('desktop');
    } finally {
      globalThis.window = original;
    }
  });
});


/**
 * Minimizing exists because closing is destructive: an event search, a measure
 * pair and a form are all state the user built, and "I want the scene back"
 * should not cost any of it.
 */
describe('minimizing', () => {
  it('leaves the tool open, so its state is still there', () => {
    openTool('events');
    minimizePanel('events');
    expect(isToolOpen('events')).toBe(true);
    expect(isMinimized('events')).toBe(true);
  });

  it('round-trips', () => {
    openTool('events');
    toggleMinimized('events');
    expect(isMinimized('events')).toBe(true);
    toggleMinimized('events');
    expect(isMinimized('events')).toBe(false);
  });

  it('is reset by closing, so a reopened panel does not come back collapsed', () => {
    openTool('events');
    minimizePanel('events');
    closeTool('events');
    openTool('events');
    expect(isMinimized('events')).toBe(false);
  });

  it('applies to the selection-driven panels too, which no tool opens', () => {
    minimizePanel('info');
    expect(isMinimized('info')).toBe(true);
  });

  it('restores rather than closes when the rail is pressed on a stowed tool', () => {
    openTool('events');
    minimizePanel('events');
    toggleTool('events');
    expect(isToolOpen('events')).toBe(true);
    expect(isMinimized('events')).toBe(false);
  });

  it('closes on the second press once the panel is showing', () => {
    openTool('events');
    toggleTool('events');
    expect(isToolOpen('events')).toBe(false);
  });
});

describe('floating', () => {
  it('starts docked', () => {
    openTool('events');
    expect(isFloating('events')).toBe(false);
  });

  it('remembers where it was put, and clamps as it stores', () => {
    setFloat('events', { x: 9999, y: 40, w: 380, h: 300 }, viewport);
    expect(isFloating('events')).toBe(true);
    expect(floatOf('events')?.x).toBeLessThan(viewport.width);
  });

  it('keeps its rect across a close, because placement is a preference', () => {
    openTool('events');
    setFloat('events', { x: 200, y: 80, w: 380, h: 300 }, viewport);
    closeTool('events');
    expect(floatOf('events')).toMatchObject({ x: 200, y: 80 });
  });

  it('goes back to the dock on request', () => {
    setFloat('events', { x: 200, y: 80, w: 380, h: 300 }, viewport);
    dockPanel('events');
    expect(isFloating('events')).toBe(false);
  });

  it('is re-clamped when the viewport shrinks under it', () => {
    setFloat('events', { x: 1200, y: 800, w: 380, h: 300 }, viewport);
    reclampFloats({ width: 800, height: 600 });
    const rect = floatOf('events');
    expect(rect!.x).toBeLessThanOrEqual(800);
    expect(rect!.y).toBeLessThanOrEqual(600);
  });

  it('is kept, not cleared, when the layout goes compact', () => {
    // Compact has nowhere to float anything and ignores the rect; storing it is
    // what lets a narrowed-and-widened window hand the arrangement back. See
    // the round-trip test below.
    setFloat('events', { x: 200, y: 80, w: 380, h: 300 }, viewport);
    setLayout('compact');
    expect(floatOf('events')).toMatchObject({ x: 200, y: 80 });
  });
});

/**
 * The compact layout shows one instrument, not a scrollable pile of every open
 * one. The others stay open and switchable — that is the difference between
 * putting something away and throwing it out.
 */
describe('the compact sheet', () => {
  beforeEach(() => setLayout('compact'));

  it('makes a newly opened tool the sheet', () => {
    openTool('events');
    expect(shell.activeSheet).toBe('events');
  });

  it('shows the newest and keeps the rest open behind it', () => {
    openTool('events');
    openTool('debug');
    expect(shell.activeSheet).toBe('debug');
    expect(isToolOpen('events')).toBe(true);
    expect(isMinimized('events')).toBe(false);
  });

  it('switches rather than closing when the rail is pressed on a background tool', () => {
    openTool('events');
    openTool('debug');
    toggleTool('events');
    expect(shell.activeSheet).toBe('events');
    expect(isToolOpen('debug')).toBe(true);
  });

  it('puts the visible sheet away without closing it', () => {
    openTool('events');
    toggleTool('events');
    expect(shell.activeSheet).toBe(null);
    expect(isToolOpen('events')).toBe(true);
    expect(isMinimized('events')).toBe(true);
  });

  it('gives the scene the whole screen rather than promoting the next panel', () => {
    openTool('events');
    openTool('debug');
    toggleTool('debug');
    expect(shell.activeSheet).toBe(null);
  });

  it('falls back to another open panel when the sheet is closed outright', () => {
    openTool('events');
    openTool('debug');
    closeTool('debug');
    expect(shell.activeSheet).toBe('events');
  });

  it('clears the sheet when the last panel closes', () => {
    openTool('events');
    closeTool('events');
    expect(shell.activeSheet).toBe(null);
  });

  it('lets the selection-driven panels take the sheet', () => {
    activateSheet('info');
    expect(shell.activeSheet).toBe('info');
    expect(isMinimized('info')).toBe(false);
  });

  it('picks up an already-open panel when the layout narrows', () => {
    setLayout('desktop');
    openTool('events');
    setLayout('compact');
    expect(shell.activeSheet).toBe('events');
  });

  it('does not promote a minimized panel when the layout narrows', () => {
    setLayout('desktop');
    openTool('events');
    minimizePanel('events');
    setLayout('compact');
    expect(shell.activeSheet).toBe(null);
  });
});


/**
 * A window narrowed to a phone and widened again should hand back the workspace
 * the user arranged. The first version cleared every float rect on the way into
 * compact, so a stray resize silently flattened the layout.
 */
describe('float rects across layout changes', () => {
  it('keeps the desktop arrangement through a round trip', () => {
    openTool('events');
    openTool('debug');
    setFloat('events', { x: 300, y: 120, w: 420, h: 360 }, viewport);
    setFloat('debug', { x: 800, y: 260, w: 300, h: 420 }, viewport);

    setLayout('compact');
    setLayout('desktop');

    expect(floatOf('events')).toMatchObject({ x: 300, y: 120, w: 420, h: 360 });
    expect(floatOf('debug')).toMatchObject({ x: 800, y: 260, w: 300, h: 420 });
    expect(isFloating('events')).toBe(true);
  });

  it('ignores a resize to a compact width even before the layout has caught up', () => {
    // `resize` and the `matchMedia` listener fire in no guaranteed order, so on
    // the way down to a phone width this runs at least once while the layout
    // still says `desktop`. Judging by the viewport rather than by the layout
    // is what keeps that from flattening the stored arrangement.
    setFloat('events', { x: 900, y: 600, w: 420, h: 360 }, viewport);
    expect(shell.layout).toBe('desktop');
    reclampFloats({ width: 390, height: 844 });
    expect(floatOf('events')).toMatchObject({ x: 900, y: 600 });
  });

  it('leaves stored rects alone while compact, where clamping would flatten them', () => {
    setFloat('events', { x: 900, y: 600, w: 420, h: 360 }, viewport);
    setLayout('compact');
    // A phone-sized resize arrives while the desktop rect is in storage.
    reclampFloats({ width: 390, height: 844 });
    setLayout('desktop');
    expect(floatOf('events')).toMatchObject({ x: 900, y: 600 });
  });

  it('still re-clamps on a desktop resize, where the rect is on screen', () => {
    setFloat('events', { x: 1200, y: 800, w: 380, h: 300 }, viewport);
    reclampFloats({ width: 800, height: 600 });
    expect(floatOf('events')!.x).toBeLessThanOrEqual(800);
  });
});
