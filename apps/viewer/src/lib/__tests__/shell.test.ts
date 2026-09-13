import { describe, it, expect, beforeEach } from 'vitest';
import {
  TOOLS, shell, toolDef, isToolOpen, openTool, closeTool, toggleTool,
  closeTopTool, closeAllTools, openToolsWith, setLayout, setTimelineDepth,
  watchLayout, isToolId,
} from '../shell.svelte';

/**
 * The regression this file exists for: three panels — the event finder, the
 * measure tool and the diagnostics panel — each positioned themselves at
 * `top-3 left-3`, so opening two drew one on top of the other. The fix is that
 * panels no longer position themselves; a dock lays out whatever is open, in
 * the order it was opened. These tests pin the ordering that dock depends on,
 * and that no two open panels can resolve to the same place.
 */

beforeEach(() => {
  closeAllTools();
  setLayout('desktop');
  setTimelineDepth('transport');
  shell.shortcutsOpen = false;
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
