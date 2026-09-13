import { describe, it, expect, beforeEach } from 'vitest';
import {
  TOOLS, PANEL_KEYS, shell, toolDef, isToolOpen, openTool, closeTool, toggleTool,
  closeTopTool, closeAllTools, openToolsWith, setLayout, setTimelineDepth,
  watchLayout, isToolId, isMinimized, minimizePanel, restorePanel, toggleMinimized,
  isFloating, setFloat, dockPanel, floatOf, reclampFloats, activateSheet,
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
  for (const key of PANEL_KEYS) {
    shell.panels[key].minimized = false;
    shell.panels[key].float = null;
  }
});

describe('the tool table', () => {
  it('gives every tool a unique id', () => {
    expect(new Set(TOOLS.map((t) => t.id)).size).toBe(TOOLS.length);
  });

  it('gives every shortcut to at most one tool', () => {
    const keys = TOOLS.map((t) => t.shortcut).filter((k) => k != null);
    expect(new Set(keys).size).toBe(keys.length);
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
    openTool('measure');
    openTool('events');
    expect(shell.openTools).toEqual(['measure', 'events']);
  });

  it('closes a tool that is not open without disturbing the rest', () => {
    openTool('events');
    closeTool('measure');
    expect(shell.openTools).toEqual(['events']);
  });
});

describe('what Escape closes', () => {
  it('closes the most recently opened tool, not the first one listed', () => {
    openTool('events');
    openTool('debug');
    expect(closeTopTool()).toBe(true);
    expect(shell.openTools).toEqual(['events']);
  });

  it('reports that there was nothing to close, so Escape can fall through', () => {
    expect(closeTopTool()).toBe(false);
  });
});

describe('dock layout', () => {
  it('lays panels out in the order they were opened', () => {
    openTool('measure');
    openTool('events');
    expect(openToolsWith('panel', 'left').map((t) => t.id)).toEqual(['measure', 'events']);
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

  it('keeps surfaces with their own presentation out of the panel docks', () => {
    openTool('catalog');
    openTool('display');
    expect(openToolsWith('panel')).toEqual([]);
    expect(openToolsWith('drawer').map((t) => t.id)).toEqual(['catalog']);
    expect(openToolsWith('menu').map((t) => t.id)).toEqual(['display']);
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

  it('is dropped entirely when the layout goes compact, which has no room for it', () => {
    setFloat('events', { x: 200, y: 80, w: 380, h: 300 }, viewport);
    setLayout('compact');
    expect(isFloating('events')).toBe(false);
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
