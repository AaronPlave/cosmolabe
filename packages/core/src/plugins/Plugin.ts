import type { Universe } from '../Universe.js';

export interface CosmolabePlugin {
  readonly name: string;
  onUniverseLoaded?(universe: Universe): void;
  onTimeChange?(et: number, universe: Universe): void;
  /** Names of external resources the plugin consumes; the host owns subscriptions. */
  resources?: string[];
  /** Called by the host when external resource values change. */
  onResourceUpdate?(resources: Record<string, number | boolean | string>): void;
  dispose?(): void;
}
