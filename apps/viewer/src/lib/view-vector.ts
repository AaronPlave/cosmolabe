export type ParsedViewVector = { ok: true; vector: [number, number, number] } | { ok: false; reason: string };

/** Validate the X/Y/Z fields of a vector view; a zero or blank vector has no direction. */
export function parseViewVector(x: string, y: string, z: string): ParsedViewVector {
  const raw = [x, y, z];
  if (raw.some(v => v.trim() === '')) return { ok: false, reason: 'Enter all three components (X, Y, Z).' };
  const vector = raw.map(Number) as [number, number, number];
  if (!vector.every(Number.isFinite)) return { ok: false, reason: 'X, Y and Z must be numbers.' };
  if (vector.every(v => v === 0)) return { ok: false, reason: 'A zero vector has no direction. Enter at least one non-zero component.' };
  return { ok: true, vector };
}
