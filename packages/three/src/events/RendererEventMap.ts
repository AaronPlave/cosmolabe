import type { UniverseEventMap } from '@cosmolabe/core';

/** Renderer events extend core Universe events with 3D-specific events. */
export interface RendererEventMap extends UniverseEventMap {
  /** Emitted on double-click of a body or label. Consumer decides what to do (flyTo, show info, etc.) */
  'body:dblclick': { bodyName: string; et: number; screenX: number; screenY: number };
  /** @deprecated Use 'body:dblclick' instead. Still emitted for backward compat. */
  'body:picked': { bodyName: string; et: number };
  'body:hovered': { bodyName: string | null };
  'camera:targetChanged': { bodyName: string | null };
  'renderer:resize': { width: number; height: number };
}
