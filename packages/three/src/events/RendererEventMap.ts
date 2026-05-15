import type { UniverseEventMap } from '@cosmolabe/core';

/** Renderer events extend core Universe events with 3D-specific events. */
export interface RendererEventMap extends UniverseEventMap {
  /**
   * Emitted immediately on a single-click of a body (no debounce — selection
   * shouldn't feel laggy). Note: a double-click will fire `body:click` once or
   * twice followed by `body:dblclick`, since browsers don't suppress the
   * native click events that precede a dblclick. Design selection handlers to
   * be idempotent (re-applying the same selection should be a no-op) so the
   * extra click events don't matter. Only emitted when a body is actually
   * picked — empty-space clicks produce no event.
   */
  'body:click': { bodyName: string; et: number; screenX: number; screenY: number };
  /** Emitted on double-click of a body or label. Consumer decides what to do (flyTo, show info, etc.) */
  'body:dblclick': { bodyName: string; et: number; screenX: number; screenY: number };
  /** @deprecated Use 'body:dblclick' instead. Still emitted for backward compat. */
  'body:picked': { bodyName: string; et: number };
  'body:hovered': { bodyName: string | null };
  'camera:targetChanged': { bodyName: string | null };
  'renderer:resize': { width: number; height: number };
}
