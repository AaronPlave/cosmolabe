import * as THREE from 'three';

export interface ContourStation { t: number; axis: number; index: number; level: number; }

/** Nested body-fixed transects. Splitting/reversing an edge or changing the
 * visible path's start cannot move a station. Coarse planes are a subset of
 * fine planes, so zoom can reveal additional stations without sliding them. */
export function* contourStations(a: THREE.Vector3, b: THREE.Vector3, normal: THREE.Vector3,
  metre: number, exponent: number, first = 0, last = 1): Generator<ContourStation> {
  const step = metre * 2 ** exponent;
  if (!Number.isFinite(step) || step <= 0) return;
  for (let axis = 0; axis < 3; axis++) {
    // Planes nearly parallel to the ground do not make useful label corridors.
    if (Math.abs(normal.getComponent(axis)) > 0.8) continue;
    const start = a.getComponent(axis), delta = b.getComponent(axis) - start;
    if (Math.abs(delta) < step * 1e-10) continue;
    const low = Math.min(start + delta * first, start + delta * last);
    const high = Math.max(start + delta * first, start + delta * last);
    for (let index = Math.ceil(low / step); index <= Math.floor(high / step); index++) {
      const t = (index * step - start) / delta;
      if (t < first - 1e-10 || t > last + 1e-10 || t >= 1 - 1e-10) continue;
      let n = Math.abs(index), level = exponent;
      if (n === 0) level = 64; // The origin plane belongs to every level.
      else while (n % 2 === 0) { level++; n /= 2; }
      yield { t: Math.max(0, t), axis, index, level };
    }
  }
}
