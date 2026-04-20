/**
 * Command registry — all actions accessible via the command palette.
 * Combines built-in commands with plugin-contributed commands.
 */
import type { UniverseRenderer } from '@spicecraft/three';
import type { PluginCommand } from '@spicecraft/three';
import {
  vs, togglePlay, reverse, faster, slower, stepForward, stepBackward,
  setDisplayOption, cycleCamera, flyToTracked, resetCamera, getRenderer,
} from './viewer-state.svelte';

export interface Command {
  id: string;
  label: string;
  shortcut?: string;
  category: string;
  execute: (renderer: UniverseRenderer) => void;
}

/** Built-in commands */
function getBuiltinCommands(): Command[] {
  return [
    // Time
    { id: 'time:play', label: vs.playing ? 'Pause' : 'Play', shortcut: 'Space', category: 'Time', execute: () => togglePlay() },
    { id: 'time:reverse', label: 'Reverse', shortcut: 'R', category: 'Time', execute: () => reverse() },
    { id: 'time:faster', label: 'Faster', shortcut: '↑', category: 'Time', execute: () => faster() },
    { id: 'time:slower', label: 'Slower', shortcut: '↓', category: 'Time', execute: () => slower() },
    { id: 'time:step-fwd', label: 'Step forward', shortcut: '→', category: 'Time', execute: () => stepForward() },
    { id: 'time:step-back', label: 'Step backward', shortcut: '←', category: 'Time', execute: () => stepBackward() },

    // Camera
    { id: 'cam:fly-to', label: 'Fly to tracked body', shortcut: 'F', category: 'Camera', execute: () => flyToTracked() },
    { id: 'cam:cycle', label: 'Cycle camera mode', shortcut: 'M', category: 'Camera', execute: () => cycleCamera() },
    { id: 'cam:reset', label: 'Reset to Free Orbit', shortcut: 'Esc', category: 'Camera', execute: () => resetCamera() },

    // Display
    { id: 'disp:traj', label: vs.showTrajectories ? 'Hide trajectories' : 'Show trajectories', shortcut: 'T', category: 'Display', execute: () => setDisplayOption('trajectories', !vs.showTrajectories) },
    { id: 'disp:labels', label: vs.showLabels ? 'Hide labels' : 'Show labels', shortcut: 'L', category: 'Display', execute: () => setDisplayOption('labels', !vs.showLabels) },
    { id: 'disp:grid', label: vs.showGrid ? 'Hide grid' : 'Show grid', shortcut: 'G', category: 'Display', execute: () => setDisplayOption('grid', !vs.showGrid) },
    { id: 'disp:axes', label: vs.showAxes ? 'Hide axes' : 'Show axes', shortcut: 'X', category: 'Display', execute: () => setDisplayOption('axes', !vs.showAxes) },

    // Instrument
    { id: 'instr:cycle', label: 'Cycle instrument PiP', shortcut: 'I', category: 'Display', execute: (r) => {
      const sensors = r.getSensorNames();
      if (sensors.length === 0) return;
      const current = r.activeInstrumentView;
      const idx = current ? sensors.indexOf(current) : -1;
      r.setInstrumentView(idx + 1 < sensors.length ? sensors[idx + 1] : null, { margin: 52 });
    }},
  ];
}

/** Collect plugin-contributed commands */
function getPluginCommands(): Command[] {
  const r = getRenderer();
  if (!r) return [];
  const ctx = r.getContext();
  const cmds: Command[] = [];

  for (const plugin of r.getPlugins()) {
    if (!plugin.ui?.commands) continue;
    for (const pc of plugin.ui.commands) {
      if (pc.enabled && !pc.enabled(ctx)) continue;
      cmds.push({
        id: `plugin:${pc.id}`,
        label: pc.label,
        shortcut: pc.shortcut,
        category: pc.category ?? 'Plugin',
        execute: () => pc.execute(ctx),
      });
    }
  }
  return cmds;
}

/** All commands (built-in + plugin) */
export function getCommands(): Command[] {
  return [...getBuiltinCommands(), ...getPluginCommands()];
}

/** All command categories (for palette grouping) */
export function getCommandCategories(): string[] {
  const cats = new Set(getCommands().map(c => c.category));
  // Ensure standard categories come first
  const ordered = ['Time', 'Camera', 'Display'];
  for (const c of cats) {
    if (!ordered.includes(c)) ordered.push(c);
  }
  return ordered.filter(c => cats.has(c));
}

/** Get body names for palette search */
export function getBodyCommands(): { name: string; category?: string }[] {
  return vs.bodies.map(b => ({ name: b.name, category: b.classification }));
}
