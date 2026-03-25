/** Shared state managed by Universe. Plugins namespace their keys with 'plugin:' prefix. */
export interface UniverseState {
  selectedBody: string | null;
  hoveredBody: string | null;
  timeRate: number;
  paused: boolean;
  [key: `plugin:${string}`]: unknown;
}

export const DEFAULT_UNIVERSE_STATE: UniverseState = {
  selectedBody: null,
  hoveredBody: null,
  timeRate: 1,
  paused: false,
};
