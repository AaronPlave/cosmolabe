/**
 * Layout & display settings persistence via localStorage.
 */

const STORAGE_KEY = 'cosmolabe-viewer-prefs';

export interface ViewerPrefs {
  showTrajectories: boolean;
  showLabels: boolean;
  showGrid: boolean;
  showAxes: boolean;
  lightingMode: 'natural' | 'shadow' | 'flood';
  fov: number;
}

const DEFAULTS: ViewerPrefs = {
  showTrajectories: true,
  showLabels: true,
  showGrid: false,
  showAxes: false,
  lightingMode: 'natural',
  fov: 60,
};

export function loadPrefs(): ViewerPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
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
