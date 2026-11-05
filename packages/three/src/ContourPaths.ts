import * as THREE from 'three';

export interface ContourSegment {
  mesh: THREE.Mesh;
  start: THREE.Vector3;
  end: THREE.Vector3;
  normal: THREE.Vector3;
  gradient: THREE.Vector3;
  heightKm: number;
}
export interface ContourEdge { segment: ContourSegment; reverse: boolean; }
export interface ContourPath { edges: ContourEdge[]; heightKm: number; }

/** Join shared triangle edges and tile borders before assigning labels. Source
 * local coordinates are metres; infer that scale in the label group's frame
 * so the same metre tolerance works under body rotation and floating origin.
 * Different elevations never join, nor do separate loops at the same height. */
export function stitchContourPaths(segments: Iterable<ContourSegment>, group: THREE.Object3D,
  camera?: THREE.Camera, viewportHeight = 1): ContourPath[] {
  const job = buildContourPaths(segments, group, camera, viewportHeight);
  let result = job.next(); while (!result.done) result = job.next();
  return result.value;
}

/** Cooperative topology construction: bound work per frame, never the number
 * of contours admitted. The synchronous wrapper is useful for small fixtures. */
export function* buildContourPaths(segments: Iterable<ContourSegment>, group: THREE.Object3D,
  camera?: THREE.Camera, viewportHeight = 1): Generator<void, ContourPath[]> {
  let work = 0;
  const matrices = new Map<THREE.Mesh, THREE.Matrix4>();
  const nodes: Array<{ point: THREE.Vector3; level: number; edges: number[] }> = [];
  const cells = new Map<string, number[]>();
  const edges: Array<{ a: number; b: number; segment: ContourSegment }> = [];
  let tolerance = 0;
  const node = (point: THREE.Vector3, level: number): number => {
    const x = Math.floor(point.x / tolerance), y = Math.floor(point.y / tolerance), z = Math.floor(point.z / tolerance);
    const key = `${level}:${x},${y},${z}`, id = nodes.length;
    const existing = cells.get(key)?.find(i => nodes[i].point.distanceToSquared(point) <= tolerance ** 2);
    if (existing !== undefined) return existing;
    nodes.push({ point, level, edges: [] });
    const ids = cells.get(key); if (ids) ids.push(id); else cells.set(key, [id]);
    return id;
  };
  for (const segment of segments) {
    if (++work % 128 === 0) yield;
    let matrix = matrices.get(segment.mesh);
    if (!matrix) {
      matrix = new THREE.Matrix4().multiplyMatrices(group.matrixWorld.clone().invert(), segment.mesh.matrixWorld); matrices.set(segment.mesh, matrix);
      if (!tolerance) tolerance = matrix.getMaxScaleOnAxis() * 0.5;
    }
    const level = Math.round(segment.heightKm * 1e6);
    const a = node(segment.start.clone().applyMatrix4(matrix), level), b = node(segment.end.clone().applyMatrix4(matrix), level);
    if (a === b) continue;
    const id = edges.length; edges.push({ a, b, segment }); nodes[a].edges.push(id); nodes[b].edges.push(id);
  }
  // Interior triangle intersections normally match in the same cell. Only
  // dangling tile-border ends need the more expensive neighbouring-cell search.
  for (const [id, n] of nodes.entries()) {
    if (++work % 128 === 0) yield;
    if (n.edges.length !== 1) continue;
    const x = Math.floor(n.point.x / tolerance), y = Math.floor(n.point.y / tolerance), z = Math.floor(n.point.z / tolerance);
    neighbour: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const match = cells.get(`${n.level}:${x + dx},${y + dy},${z + dz}`)?.find(i => i !== id
        && nodes[i].edges.length === 1 && nodes[i].point.distanceToSquared(n.point) <= tolerance ** 2);
      if (match === undefined) continue;
      const other = nodes[match], edge = edges[other.edges[0]];
      if (edge.a === match) edge.a = id; else edge.b = id;
      n.edges.push(...other.edges); other.edges = [];
      break neighbour;
    }
  }
  if (camera) {
    camera = camera.clone();
    const groupWorld = group.matrixWorld.clone();
    // Mixed-LOD tiles approximate the same isohypse at slightly different
    // border positions. Join compatible dangling ends within three pixels,
    // checking 3D distance and tangent agreement so nearby separate loops and
    // the far side of the globe cannot merge merely by overlapping on screen.
    const screenCells = new Map<string, number[]>(), scale = groupWorld.getMaxScaleOnAxis();
    const projected = new Map<number, { x: number; y: number; tolerance: number }>();
    for (const [id, n] of nodes.entries()) {
      if (++work % 128 === 0) yield;
      if (n.edges.length !== 1) continue;
      const world = n.point.clone().applyMatrix4(groupWorld), depth = -world.clone().applyMatrix4(camera.matrixWorldInverse).z;
      if (depth <= 0) continue;
      world.project(camera);
      const x = world.x * viewportHeight / 2 * camera.projectionMatrix.elements[5] / camera.projectionMatrix.elements[0];
      const y = world.y * viewportHeight / 2;
      const pixel = 2 * ((camera as THREE.PerspectiveCamera).isPerspectiveCamera ? depth : 1) / camera.projectionMatrix.elements[5] / viewportHeight;
      projected.set(id, { x, y, tolerance: Math.max(tolerance, pixel * 3 / scale) });
      const key = `${n.level}:${Math.floor(x / 3)},${Math.floor(y / 3)}`;
      const ids = screenCells.get(key); if (ids) ids.push(id); else screenCells.set(key, [id]);
    }
    const direction = (id: number) => {
      const edge = edges[nodes[id].edges[0]], other = edge.a === id ? edge.b : edge.a;
      return nodes[other].point.clone().sub(nodes[id].point).normalize();
    };
    for (const [id, p] of projected) {
      if (++work % 128 === 0) yield;
      const n = nodes[id]; if (n.edges.length !== 1) continue;
      let best: number | undefined, bestDistance = Infinity;
      const tangent = direction(id);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const other of screenCells.get(`${n.level}:${Math.floor(p.x / 3) + dx},${Math.floor(p.y / 3) + dy}`) ?? []) {
          if (id === other || nodes[other].edges.length !== 1) continue;
          const q = projected.get(other)!;
          const distance = n.point.distanceToSquared(nodes[other].point);
          if (Math.hypot(p.x - q.x, p.y - q.y) > 3 || distance > Math.max(p.tolerance, q.tolerance) ** 2
            || distance >= bestDistance || tangent.dot(direction(other)) > -0.5) continue;
          best = other; bestDistance = distance;
        }
      }
      if (best !== undefined) {
        const other = nodes[best], edge = edges[other.edges[0]];
        if (edge.a === best) edge.a = id; else edge.b = id;
        n.edges.push(...other.edges); other.edges = [];
      }
    }
  }
  const used = new Set<number>(), paths: ContourPath[] = [];
  function* walk(start: number, first: number): Generator<void> {
    const path: ContourEdge[] = [];
    let current = start, edgeId: number | undefined = first;
    while (edgeId !== undefined && !used.has(edgeId)) {
      if (++work % 128 === 0) yield;
      used.add(edgeId);
      const edge: typeof edges[number] = edges[edgeId];
      const reverse = edge.b === current;
      path.push({ segment: edge.segment, reverse });
      current = reverse ? edge.a : edge.b;
      if (nodes[current].edges.length !== 2) break;
      edgeId = nodes[current].edges.find(id => !used.has(id));
    }
    if (path.length) paths.push({ edges: path, heightKm: path[0].segment.heightKm });
  }
  for (const [id, n] of nodes.entries()) {
    if (++work % 128 === 0) yield;
    if (n.edges.length !== 2) for (const edge of n.edges) if (!used.has(edge)) yield* walk(id, edge);
  }
  for (const [id, edge] of edges.entries()) {
    if (++work % 128 === 0) yield;
    if (!used.has(id)) yield* walk(edge.a, id); // closed loops
  }
  return paths;
}
