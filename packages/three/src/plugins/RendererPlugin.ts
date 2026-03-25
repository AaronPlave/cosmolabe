import type { SpiceCraftPlugin } from '@spicecraft/core';
import type { Body } from '@spicecraft/core';
import type { RendererContext } from './RendererContext.js';

/**
 * Three.js renderer plugin. Extends the core plugin with 3D lifecycle hooks.
 *
 * Tier 2: Configurable built-in plugins (TrajectoryColor, LinkLine, ActivityMarker)
 * Tier 3: Custom mission plugins (radar swath, instrument FOV, etc.)
 */
export interface RendererPlugin extends SpiceCraftPlugin {
  /** Called once when the renderer scene is initialized. */
  onSceneSetup?(ctx: RendererContext): void;

  /** Called each frame before render. Update meshes, materials, etc. */
  onBeforeRender?(et: number, ctx: RendererContext): void;

  /** Called each frame after render. */
  onAfterRender?(et: number, ctx: RendererContext): void;

  /** Called each frame to update HTML overlay elements (labels, readouts). */
  onOverlayUpdate?(et: number, container: HTMLElement, ctx: RendererContext): void;

  /** Called when a body is picked/clicked in the 3D view. */
  onPick?(body: Body, et: number, ctx: RendererContext): void;

  /** Called when the renderer is resized. */
  onResize?(width: number, height: number): void;
}
