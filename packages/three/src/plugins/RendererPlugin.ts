import type { CosmolabePlugin } from '@cosmolabe/core';
import type { Body } from '@cosmolabe/core';
import type { RendererContext } from './RendererContext.js';
import type { PluginUISlots } from './PluginUI.js';

/**
 * Three.js renderer plugin. Extends the core plugin with 3D lifecycle hooks.
 *
 * Tier 2: Configurable built-in plugins (TrajectoryColor, LinkLine, ActivityMarker)
 * Tier 3: Custom mission plugins (radar swath, instrument FOV, etc.)
 */
export interface RendererPlugin extends CosmolabePlugin {
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

  /**
   * Declarative UI contributions. The host UI renders these in the appropriate
   * locations (overlays, info cards, timeline, command palette, toolbar).
   * Same plugin works in standalone viewer, Aerie panel, or any other host.
   */
  ui?: PluginUISlots;
}
