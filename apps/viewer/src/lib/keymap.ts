import { CAMERA_KEY_BINDINGS } from '@cosmolabe/three';

export type KeyScope = 'viewer' | 'camera';

export interface KeyBinding {
  id: string;
  key: string;
  code?: string;
  display: string;
  label: string;
  category: string;
  scope?: KeyScope;
  primary?: boolean;
  shift?: boolean;
}

/** The one inventory used by keyboard dispatch, command labels and help. */
const CAMERA_HELP_BINDINGS: KeyBinding[] = Object.entries(CAMERA_KEY_BINDINGS).map(([action, binding]) => ({
  id: `camera:${action}`,
  key: binding.key,
  display: binding.display,
  label: binding.label,
  category: 'Camera',
  scope: 'camera',
}));

export const KEYMAP: readonly KeyBinding[] = [
  { id: 'time:play', key: ' ', display: 'Space', label: 'Play / pause', category: 'Time' },
  { id: 'time:step-back', key: 'ArrowLeft', display: 'Left', label: 'Step backward', category: 'Time' },
  { id: 'time:step-fwd', key: 'ArrowRight', display: 'Right', label: 'Step forward', category: 'Time' },
  { id: 'time:slower', key: 'ArrowDown', display: 'Down', label: 'Slower', category: 'Time' },
  { id: 'time:faster', key: 'ArrowUp', display: 'Up', label: 'Faster', category: 'Time' },
  { id: 'time:reverse', key: 'r', display: 'R', label: 'Reverse time', category: 'Time' },
  { id: 'cam:fly-to', key: 'f', display: 'F', label: 'Fly to tracked body', category: 'Camera' },
  { id: 'cam:cycle', key: 'm', display: 'M', label: 'Cycle camera mode', category: 'Camera' },
  { id: 'cam:dolly-in', key: '[', code: 'BracketLeft', display: '[', label: 'Dolly in (hold)', category: 'Camera' },
  { id: 'cam:dolly-out', key: ']', code: 'BracketRight', display: ']', label: 'Dolly out (hold)', category: 'Camera' },
  { id: 'cam:crane-up', key: 'PageUp', code: 'PageUp', display: 'Page Up', label: 'Crane up (hold)', category: 'Camera' },
  { id: 'cam:crane-down', key: 'PageDown', code: 'PageDown', display: 'Page Down', label: 'Crane down (hold)', category: 'Camera' },
  { id: 'cam:escape', key: 'Escape', display: 'Esc', label: 'Stop / dismiss', category: 'Camera' },
  { id: 'disp:traj', key: 't', display: 'T', label: 'Toggle trajectories', category: 'Display' },
  { id: 'disp:labels', key: 'l', display: 'L', label: 'Toggle body labels', category: 'Display' },
  { id: 'disp:grid', key: 'g', display: 'G', label: 'Toggle grid', category: 'Display' },
  { id: 'disp:axes', key: 'x', display: 'X', label: 'Toggle axes', category: 'Display' },
  { id: 'probe:toggle', key: 'p', display: 'P', label: 'Probe point', category: 'Inspect' },
  { id: 'catalog:open', key: 'o', display: 'O', label: 'Open catalog browser', category: 'Catalog' },
  { id: 'tool:catalog', key: 'b', display: 'B', label: 'Toggle catalog panel', category: 'Tools' },
  { id: 'instr:open', key: 'i', display: 'I', label: 'Open instrument view', category: 'Tools' },
  { id: 'tool:script', key: '`', display: '`', label: 'Toggle script console', category: 'Tools' },
  { id: 'search:open', key: 'k', display: 'Cmd+K', label: 'Search commands', category: 'Tools', primary: true },
  { id: 'help:toggle', key: '?', display: '?', label: 'Keyboard help', category: 'Tools', shift: true },
  { id: 'shell:zen', key: '\\', display: '\\', label: 'Toggle zen mode', category: 'Tools' },
  ...CAMERA_HELP_BINDINGS,
];

export function shortcutFor(id: string): string | undefined {
  return KEYMAP.find(binding => binding.id === id && binding.scope !== 'camera')?.display;
}

export function matchKeyBinding(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): KeyBinding | undefined {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return KEYMAP.find(binding => {
    if (binding.scope === 'camera') return false;
    if (binding.key.toLowerCase() !== key) return false;
    if (event.altKey) return false;
    if (!!binding.primary !== (event.metaKey || event.ctrlKey)) return false;
    return !!binding.shift === event.shiftKey;
  });
}

export function heldCameraBindingForCode(code: string): KeyBinding | undefined {
  return KEYMAP.find(binding => binding.code === code && (binding.id.startsWith('cam:dolly-') || binding.id.startsWith('cam:crane-')));
}