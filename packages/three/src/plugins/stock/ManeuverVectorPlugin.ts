import * as THREE from 'three';
import type { RendererPlugin } from '../RendererPlugin.js';
import type { RendererContext } from '../RendererContext.js';
import type { AttachedVisual } from '../AttachedVisual.js';

/** A maneuver event to visualize as a delta-v arrow. */
export interface ManeuverEvent {
  bodyName: string;
  /** Start time of the maneuver (ET seconds). */
  et: number;
  /** End time of the maneuver (ET seconds). Optional — if omitted, arrow is shown at a single instant. */
  endEt?: number;
  /** Delta-v vector in km/s [dx, dy, dz] in the body's trajectory frame. */
  deltaV: [number, number, number];
  /** Arrow color. Default: 0xff4400. */
  color?: number | string;
  /** Label text shown above the arrow. */
  label?: string;
}

/**
 * Stock plugin: renders delta-v arrows at maneuver times.
 * Arrows are attached to the spacecraft body and auto-positioned.
 * Visibility is toggled by the current simulation time.
 *
 * Usage:
 *   const plugin = new ManeuverVectorPlugin();
 *   plugin.setEvents([
 *     { bodyName: 'SC', et: 1000, endEt: 1100, deltaV: [0, 0, 0.5], label: 'OTM-1' },
 *   ]);
 *   renderer.use(plugin);
 */
export class ManeuverVectorPlugin implements RendererPlugin {
  readonly name = 'maneuver-vector';

  private events: ManeuverEvent[] = [];
  private handles: Array<{ event: ManeuverEvent; visual: AttachedVisual }> = [];
  private ctx: RendererContext | null = null;

  /** Set the maneuver events. Rebuilds visuals if already attached. */
  setEvents(events: ManeuverEvent[]): void {
    this.events = events;
    if (this.ctx) this.rebuild();
  }

  onSceneSetup(ctx: RendererContext): void {
    this.ctx = ctx;
    this.rebuild();
  }

  onBeforeRender(et: number, _ctx: RendererContext): void {
    for (const h of this.handles) {
      const e = h.event;
      const visible = et >= e.et && (e.endEt == null || et <= e.endEt);
      h.visual.object.visible = visible;
    }
  }

  dispose(): void {
    for (const h of this.handles) h.visual.detach();
    this.handles = [];
  }

  private rebuild(): void {
    if (!this.ctx) return;
    // Clean up old visuals
    for (const h of this.handles) h.visual.detach();
    this.handles = [];

    for (const event of this.events) {
      const mag = Math.sqrt(
        event.deltaV[0] ** 2 + event.deltaV[1] ** 2 + event.deltaV[2] ** 2,
      );
      if (mag === 0) continue;

      const dir = new THREE.Vector3(...event.deltaV).normalize();
      // Arrow length proportional to delta-v magnitude, scaled to scene
      const length = mag * 1000 * this.ctx.scaleFactor; // visual scale
      const headLength = length * 0.3;
      const headWidth = length * 0.15;
      const color = event.color ?? 0xff4400;

      const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(), length, color, headLength, headWidth);
      const visual = this.ctx.attachToBody(event.bodyName, arrow);
      arrow.visible = false; // start hidden, onBeforeRender will toggle
      this.handles.push({ event, visual });
    }
  }
}
