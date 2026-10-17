import type { ScreenRect } from '../EventCallout.js';
import type { GeographicVectorStatus } from './GeographicVectorLayer.js';

export function geographicStatusText(status: readonly GeographicVectorStatus[], warnings: number): string {
  const modes = [...new Set(status.map(s => `${s.bodyName}: ${s.bodySurfaceMode === 'terrain-streaming' ? 'terrain mode (coverage unverified)' : 'reference globe'}`))];
  return modes.length || warnings ? `Vector base · ${modes.join(', ')}${warnings ? `${modes.length ? ' · ' : ''}${warnings} limitation${warnings === 1 ? '' : 's'}` : ''}` : '';
}

/** Keep the compact readout clear of host panels, tracking HUD and timeline.
 * If the host covers the viewport, hide it until space becomes available. */
export function geographicStatusPosition(width: number, height: number, boxWidth: number, boxHeight: number,
  blockers: readonly ScreenRect[]): { left: number; top: number } | null {
  const gap = 8;
  const rows = [gap, ...blockers.map(b => b.y1 + gap), height - boxHeight - gap,
    ...blockers.map(b => b.y0 - boxHeight - gap)];
  for (const top of rows) for (const left of [width - boxWidth - gap, gap, ...blockers.map(b => b.x1 + gap)]) {
    if (left < gap || left + boxWidth > width - gap || top < gap || top + boxHeight > height - gap) continue;
    if (blockers.some(b => left < b.x1 + gap && left + boxWidth > b.x0 - gap && top < b.y1 + gap && top + boxHeight > b.y0 - gap)) continue;
    return { left, top };
  }
  return null;
}
