import type { CpuSurfaceMesh } from '../../surface/CpuMeshSurface.js';

/** Closed torus, 2 km major / 1 km minor radius, 1,024 outward-wound triangles.
 * The +x radial ray crosses x=1 and x=3 at identical lat/lon: no single-valued heightfield.
 * Synthetic source coordinates are authoritative for this fixture, not mission uncertainty.
 */
export function concaveSurface(): CpuSurfaceMesh {
  const columns = 32, rows = 16;
  const positionsKm = new Float64Array(columns * rows * 3);
  const indices = new Uint32Array(columns * rows * 6);
  for (let x = 0; x < columns; x++) for (let y = 0; y < rows; y++) {
    const u = 2 * Math.PI * x / columns, v = 2 * Math.PI * y / rows;
    const radius = 2 + Math.cos(v);
    positionsKm.set([radius * Math.cos(u), radius * Math.sin(u), Math.sin(v)], (x * rows + y) * 3);
    const a = x * rows + y, b = ((x + 1) % columns) * rows + y;
    const c = x * rows + (y + 1) % rows, d = ((x + 1) % columns) * rows + (y + 1) % rows;
    indices.set([a, b, c, b, d, c], (x * rows + y) * 6);
  }
  return { positionsKm, indices };
}
