import type { Universe } from '../Universe.js';

export interface SpiceCraftPlugin {
  readonly name: string;
  onUniverseLoaded?(universe: Universe): void;
  onTimeChange?(et: number, universe: Universe): void;
  aerieResources?: string[];
  onAerieResourceUpdate?(resources: Record<string, number | boolean | string>): void;
  dispose?(): void;
}
