import type { UniverseEventMap } from '@spicecraft/core';

/** Renderer events extend core Universe events with 3D-specific events. */
export interface RendererEventMap extends UniverseEventMap {
  'body:picked': { bodyName: string; et: number };
  'body:hovered': { bodyName: string | null };
  'camera:targetChanged': { bodyName: string | null };
  'renderer:resize': { width: number; height: number };
}
