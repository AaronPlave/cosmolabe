import type { ScreenRect } from '../EventCallout.js';
import type { GeographicVectorStatus } from './GeographicVectorLayer.js';

/**
 * The scene readout: only actionable problems, the render diagnostics (datum
 * mismatch, a surface vectors cannot drape on, budgets that suppressed
 * drawing, features left out). Nothing when vectors draw as intended: the
 * routine caveat of which surface they follow belongs with the layer
 * (`geographicSurfaceNote`), not floating over the scene.
 */
export function geographicStatusText(problems: number): string {
  return problems ? `Surface vectors · ${problems} problem${problems === 1 ? '' : 's'}` : '';
}

/** What a body's vectors are drawn on, and what that does not establish: for a layer's details. */
export function geographicSurfaceNote(status: readonly GeographicVectorStatus[], bodyName: string): string | null {
  const s = status.find(x => x.bodyName === bodyName);
  if (!s) return null;
  return s.bodySurfaceMode === 'terrain-streaming'
    ? 'Drawn on the streamed terrain as displayed. Whether terrain covers each feature is not checked, and drawing is not an elevation measurement.'
    : 'Drawn on the reference globe; terrain is not shown under these features.';
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
