/**
 * Copying a picked surface point's coordinates (#190) as the pair the
 * coordinate input reads back: "18.4447° N, 77.4508° E", planetocentric and
 * east-positive, to the precision the pick justifies.
 */
import { surfacePointCoordinatePair, type SurfacePoint } from '@cosmolabe/three';

/** What the copy writes to: the browser clipboard by default. */
export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

/** Copy `point`'s coordinate pair. The text copied, or null when the clipboard refused it. */
export async function copySurfacePointCoordinates(
  point: SurfacePoint,
  clipboard: ClipboardWriter | undefined = globalThis.navigator?.clipboard,
): Promise<string | null> {
  const text = surfacePointCoordinatePair(point);
  try {
    if (!clipboard) throw new Error('No clipboard');
    await clipboard.writeText(text);
    return text;
  } catch (err) {
    console.warn('[Cosmolabe] Copy failed:', err);
    return null;
  }
}
