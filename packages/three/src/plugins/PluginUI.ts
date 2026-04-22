import type { Body } from '@spicecraft/core';
import type { RendererContext } from './RendererContext.js';

/**
 * Plugin UI slot system — declarative UI contributions from plugins.
 *
 * Plugins declare what UI they want to contribute (overlays, info sections,
 * timeline tracks, commands, toolbar items). The host UI (standalone viewer,
 * Aerie panel, or any other consumer) decides where and how to render them.
 *
 * This means the same plugin works in any host without modification.
 */

/** A viewport overlay widget — HUD element positioned in a corner */
export interface PluginOverlay {
  id: string;
  /** Where in the viewport to anchor */
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** Stacking order within the same corner (higher = further from corner) */
  order?: number;
  /** Called each frame. Return HTML string, DOM element, or null to hide. */
  render(et: number, ctx: RendererContext): string | HTMLElement | null;
}

/** A key-value row in a structured info section */
export interface InfoRow {
  label: string;
  value: string;
  unit?: string;
}

/** Structured result (preferred) or raw HTML fallback */
export type InfoSectionResult =
  | string                    // raw HTML (escape hatch)
  | HTMLElement               // DOM element (escape hatch)
  | { rows: InfoRow[] }       // structured key-value pairs (preferred — viewer renders natively)

/** An info card section — shown when a body is selected */
export interface PluginInfoSection {
  id: string;
  label: string;
  /** Ordering priority within the info card */
  order?: number;
  /** Return structured data, HTML string, DOM element, or null to skip for this body. */
  render(body: Body, et: number, ctx: RendererContext): InfoSectionResult | null;
}

/** A timeline track — colored interval bars in the timeline */
export interface PluginTimelineTrack {
  id: string;
  label: string;
  color: string;
  /** Compute intervals for a given time range. Called when the timeline range changes. */
  getIntervals(startEt: number, endEt: number, ctx: RendererContext): TimeInterval[];
}

/** A single time interval for a timeline track */
export interface TimeInterval {
  startEt: number;
  endEt: number;
  label?: string;
  /** Override the track's default color for this interval */
  color?: string;
}

/** A command — appears in the command palette and can have a keyboard shortcut */
export interface PluginCommand {
  id: string;
  label: string;
  shortcut?: string;
  category?: string;
  icon?: string;
  /** Dynamic enable/disable check */
  enabled?: (ctx: RendererContext) => boolean;
  execute(ctx: RendererContext): void;
}

/** A toolbar item — button or toggle in the bottom bar */
export interface PluginToolbarItem {
  id: string;
  label: string;
  icon: string;
  type: 'button' | 'toggle';
  /** For toggles: whether currently active */
  isActive?: (ctx: RendererContext) => boolean;
  execute(ctx: RendererContext): void;
}

/** Declarative UI contributions from a plugin */
export interface PluginUISlots {
  /** Viewport overlay widgets — HUD elements in corners */
  overlays?: PluginOverlay[];
  /** Info card sections — shown when a body is selected */
  infoSections?: PluginInfoSection[];
  /** Timeline tracks — colored interval bars */
  timelineTracks?: PluginTimelineTrack[];
  /** Commands — added to the command palette */
  commands?: PluginCommand[];
  /** Toolbar items — buttons/toggles in the bottom bar */
  toolbarItems?: PluginToolbarItem[];
}
