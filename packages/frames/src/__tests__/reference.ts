import values from '../__fixtures__/cspice-reference.json';
import type { HeritageSpice } from '../heritage-spice.js';

type Methods = Omit<HeritageSpice, 'frames'>;
const entries: Record<string, { result: unknown }> = values;

/** Read an independently captured result; missing cases fail rather than self-baseline.
 * Provenance, kernel hashes and tolerances: docs/spice-retirement.md.
 */
export function reference<K extends keyof Methods>(
  method: K, ...args: Parameters<Methods[K]>
): ReturnType<Methods[K]> {
  const key = JSON.stringify([method, args]);
  const entry = entries[key];
  if (!entry) throw new Error(`Missing pinned CSPICE reference: ${key}`);
  return structuredClone(entry.result) as ReturnType<Methods[K]>;
}
