import type { RendererPlugin } from '../RendererPlugin.js';
import type { RendererContext } from '../RendererContext.js';
import type { ColorSegment } from '../../TrajectoryLine.js';

/** A trajectory color segment definition. */
export interface TrajectoryColorSegment {
  bodyName: string;
  startEt: number;
  endEt: number;
  /** Any Three.js-compatible color: hex number, CSS string, etc. */
  color: number | string;
  label?: string;
}

/**
 * Stock plugin: colors trajectory trail segments by time range.
 * Useful for mission phases, activity types, constraint status, etc.
 *
 * Usage:
 *   const plugin = new TrajectoryColorPlugin();
 *   plugin.setSegments([
 *     { bodyName: 'Europa Clipper', startEt: 100, endEt: 200, color: '#ff8800' },
 *     { bodyName: 'Europa Clipper', startEt: 200, endEt: 300, color: '#00cc66' },
 *   ]);
 *   renderer.use(plugin);
 */
export class TrajectoryColorPlugin implements RendererPlugin {
  readonly name = 'trajectory-color';

  private segments: TrajectoryColorSegment[] = [];
  private ctx: RendererContext | null = null;

  /** Set the color segments. Applies immediately if already attached. */
  setSegments(segments: TrajectoryColorSegment[]): void {
    this.segments = segments;
    if (this.ctx) this.applySegments();
  }

  onSceneSetup(ctx: RendererContext): void {
    this.ctx = ctx;
    this.applySegments();
  }

  private applySegments(): void {
    if (!this.ctx) return;

    // Group segments by body name
    const byBody = new Map<string, ColorSegment[]>();
    for (const seg of this.segments) {
      let arr = byBody.get(seg.bodyName);
      if (!arr) { arr = []; byBody.set(seg.bodyName, arr); }
      arr.push({ startEt: seg.startEt, endEt: seg.endEt, color: seg.color });
    }

    // Apply to trajectory lines
    for (const [bodyName, colorSegs] of byBody) {
      const tl = this.ctx.getTrajectoryLine(bodyName);
      if (tl) tl.setColorSegments(colorSegs);
    }
  }
}
