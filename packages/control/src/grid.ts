export const ANGULAR_GRID_STEPS = [30, 15, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001] as const;

/** Shared viewer/script state; no renderer-only visibility switches. */
export interface GridSettings {
  scope: 'tracked' | 'bodies' | 'all';
  bodies: string[];
  labels: boolean;
  density: 'auto' | 'manual';
  spacingDeg: number;
  minorLines: boolean;
  perBody: Record<string, { visible?: boolean; labels?: boolean }>;
}
export const DEFAULT_GRID_SETTINGS: GridSettings = {
  scope: 'tracked', bodies: [], labels: true, density: 'auto', spacingDeg: 30, minorLines: false, perBody: {},
};
export function normalizeGridSettings(value: Partial<GridSettings> = {}): GridSettings {
  const perBody: GridSettings['perBody'] = {};
  for (const [name, setting] of Object.entries(value.perBody ?? {})) {
    if (!setting || typeof setting !== 'object') continue;
    perBody[name] = { ...(typeof setting.visible === 'boolean' ? { visible: setting.visible } : {}), ...(typeof setting.labels === 'boolean' ? { labels: setting.labels } : {}) };
  }
  return {
    scope: ['tracked', 'bodies', 'all'].includes(value.scope ?? '') ? value.scope! : 'tracked',
    bodies: Array.isArray(value.bodies) ? [...new Set(value.bodies.filter(b => typeof b === 'string'))] : [],
    labels: typeof value.labels === 'boolean' ? value.labels : true,
    density: value.density === 'manual' ? 'manual' : 'auto',
    spacingDeg: Number.isFinite(value.spacingDeg) ? ANGULAR_GRID_STEPS.reduce((best, step) => Math.abs(step - value.spacingDeg!) < Math.abs(best - value.spacingDeg!) ? step : best, 30 as number) : 30,
    minorLines: value.minorLines === true, perBody,
  };
}
export function gridBodyState(settings: GridSettings, enabled: boolean, name: string, tracked: string | null): { visible: boolean; labels: boolean } {
  const target = settings.scope === 'all' || (settings.scope === 'tracked' ? name === tracked : settings.bodies.includes(name));
  return { visible: enabled && (settings.perBody[name]?.visible ?? target), labels: settings.perBody[name]?.labels ?? settings.labels };
}
