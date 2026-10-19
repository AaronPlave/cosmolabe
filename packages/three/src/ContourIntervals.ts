import * as THREE from 'three';

const STEPS = [1, 2, 5];
export function niceContourInterval(targetKm: number): number {
  const value = Math.max(0.001, Math.min(1, targetKm));
  const power = 10 ** Math.floor(Math.log10(value));
  return STEPS.map(step => step * power).find(step => step >= value * (1 - 1e-5)) ?? power * 10;
}

/** One interval for the view, shared by the shader and labels. Sampling the
 * actual projected height gradients avoids treating horizontal footprint as
 * relief, and avoids different contour phases on neighbouring tiles. */
export function automaticContourInterval(camera: THREE.Camera, width: number, height: number,
  sources: THREE.Mesh[], density: number, previous: number): number {
  const gradients: Array<{ delta: number; weight: number }> = [], points = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  camera.updateWorldMatrix(true, false);
  for (const mesh of sources) {
    const g = mesh.geometry, heights = g.getAttribute('surfaceHeightKm'), p = g.getAttribute('position');
    if (!heights) continue;
    mesh.updateWorldMatrix(true, false);
    const surface = g.userData.surfaceTriangles;
    const range = Number.isSafeInteger(surface) && surface > 0 ? { start: 0, count: surface * 3 }
      : g.groups[0] ?? { start: 0, count: g.index?.count ?? p.count };
    const stride = Math.max(3, Math.ceil(range.count / 32 / 3) * 3);
    for (let offset = range.start; offset < range.start + range.count; offset += stride) {
      const ids = [0, 1, 2].map(i => g.index ? g.index.getX(offset + i) : offset + i);
      ids.forEach((id, i) => points[i].fromBufferAttribute(p, id).applyMatrix4(mesh.matrixWorld).project(camera));
      const [a, b, c] = points;
      if (points.some(v => v.z < -1 || v.z > 1) || Math.abs((a.x + b.x + c.x) / 3) > 0.85
        || Math.abs((a.y + b.y + c.y) / 3) > 0.85) continue;
      const bx = (b.x - a.x) * width / 2, by = (b.y - a.y) * height / 2;
      const cx = (c.x - a.x) * width / 2, cy = (c.y - a.y) * height / 2;
      const determinant = bx * cy - cx * by;
      if (determinant <= 1e-6) continue; // degenerate or back-facing
      const dhb = heights.getX(ids[1]) - heights.getX(ids[0]), dhc = heights.getX(ids[2]) - heights.getX(ids[0]);
      const delta = Math.hypot((dhb * cy - dhc * by) / determinant, (bx * dhc - cx * dhb) / determinant);
      if (Number.isFinite(delta) && delta > 1e-8) gradients.push({ delta, weight: Math.min(determinant, width * height * 0.1) * stride });
    }
  }
  if (!gradients.length) return previous;
  gradients.sort((a, b) => a.delta - b.delta);
  const threshold = gradients.reduce((sum, g) => sum + g.weight, 0) * 0.75;
  let sum = 0, delta = gradients[0].delta;
  for (const g of gradients) { delta = g.delta; sum += g.weight; if (sum >= threshold) break; }
  const target = Math.max(0.001, Math.min(1, delta * 4 / density));
  // Hysteresis keeps a tile refinement or a small camera move from repeatedly
  // flipping between neighbouring 1–2–5 steps.
  if (target <= previous * 1.25 && niceContourInterval(target / 0.75) >= previous) return previous;
  return niceContourInterval(target);
}
