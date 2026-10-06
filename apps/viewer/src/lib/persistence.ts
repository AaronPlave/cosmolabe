import { normalizeGridSettings, type GridSettings } from '@cosmolabe/control';
/**
 * Layout & display settings persistence via localStorage.
 */

const STORAGE_KEY = 'cosmolabe-viewer-prefs';

export interface ViewerPrefs {
  showTrajectories: boolean;
  showLabels: boolean;
  showGrid: boolean;
  grid: GridSettings;
  showAxes: boolean;
  showSensors: boolean;
  showSensorLabels: boolean;
  lightingMode: 'natural' | 'shadow' | 'flood';
  fov: number;
}

const DEFAULTS: ViewerPrefs = {
  showTrajectories: true,
  showLabels: true,
  showGrid: false,
  grid: normalizeGridSettings(),
  showAxes: false,
  showSensors: true,
  showSensorLabels: true,
  lightingMode: 'natural',
  fov: 60,
};

export function loadPrefs(): ViewerPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS, grid: normalizeGridSettings() };
    const saved = JSON.parse(raw);
    return { ...DEFAULTS, ...saved, grid: normalizeGridSettings(saved.grid) };
  } catch {
    return { ...DEFAULTS, grid: normalizeGridSettings() };
  }
}

export function savePrefs(prefs: Partial<ViewerPrefs>): void {
  try {
    const current = loadPrefs();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...prefs }));
  } catch {
    // localStorage unavailable — silently ignore
  }
}
