import * as THREE from 'three';
import type { SurfaceAppearanceSettings } from './SurfaceAppearance.js';
import { buildContourPaths, type ContourSegment, type ContourPath, type ContourEdge } from './ContourPaths.js';
import type { ScreenRect } from './EventCallout.js';

export interface ContourAnchor {
  point: THREE.Vector3;
  end: THREE.Vector3;
  normal: THREE.Vector3;
  gradient: THREE.Vector3;
  heightKm: number;
}

/** Intersect the shader's linearly interpolated height field, not radial
 * height at the chord midpoint. Half-open edges avoid duplicate vertex hits;
 * level plateaus have no unique line and deliberately produce no label. */
export function contourAnchor(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3,
  heights: readonly number[], level: number): ContourAnchor | undefined {
  const points = [a, b, c], intersections: THREE.Vector3[] = [];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3, low = Math.min(heights[i], heights[j]), high = Math.max(heights[i], heights[j]);
    if (level < low || level >= high || high === low) continue;
    intersections.push(points[i].clone().lerp(points[j], (level - heights[i]) / (heights[j] - heights[i])));
  }
  if (intersections.length !== 2 || intersections[0].distanceToSquared(intersections[1]) < 1e-12) return;
  const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
  const u = b.clone().sub(a), v = c.clone().sub(a), cross = u.clone().cross(v);
  if (cross.lengthSq() < 1e-20) return;
  const gradient = v.clone().cross(cross).multiplyScalar(heights[1] - heights[0])
    .add(cross.clone().cross(u).multiplyScalar(heights[2] - heights[0])).divideScalar(cross.lengthSq());
  return { point: intersections[0].clone().add(intersections[1]).multiplyScalar(0.5), end: intersections[0], normal, gradient, heightKm: level };
}

export function formatContourHeight(heightKm: number): string {
  // Settings support whole-metre intervals.
  const metres = Math.round(heightKm * 1000);
  return `${Object.is(metres, -0) ? 0 : metres} m`;
}

interface Cache {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  heights: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  cursor: number;
  nextLevel?: number;
  segments: ContourSegment[];
  segmentMap: Map<string, ContourSegment>;
  previousSegments?: Map<string, ContourSegment>;
  complete: boolean;
}
interface PointReference { mesh: THREE.Mesh; point: THREE.Vector3; }
interface Placement {
  mesh: THREE.Mesh;
  anchor: ContourAnchor;
  segment: ContourSegment;
  t: number;
  tangentStart: PointReference;
  tangentEnd: PointReference;
}
interface Pixel { x: number; y: number; }
interface EdgeView {
  edge: ContourEdge;
  a: Pixel;
  b: Pixel;
  depthA: number;
  depthB: number;
  screenStart: number;
  screenEnd: number;
  length: number;
  distance: number;
}
interface Run { edges: EdgeView[]; length: number; }
interface Box { x0: number; y0: number; x1: number; y1: number; }
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/** Labels belong to connected index contours, rather than random triangle
 * anchors. Extraction yields between triangles/levels; there is no label-count
 * or candidate reservoir cap. A path gets one label wherever a readable span
 * fits without colliding. Hidden and retired source tiles leave the topology. */
export class TerrainContourLabels {
  readonly group = new THREE.Group();
  private readonly caches = new Map<THREE.Mesh, Cache>();
  private readonly sprites: THREE.Sprite[] = [];
  private paths: ContourPath[] = [];
  private placements: Placement[] = [];
  private selected = new Map<ContourSegment, Placement>();
  private dirty = true;
  private topology?: Generator<void, ContourPath[]>;
  private layoutJob?: Generator<void, Placement[]>;
  private interval = 0;
  private nextLayout = 0;
  private readonly point = new THREE.Vector3();
  private readonly projected = new THREE.Vector3();
  private readonly end = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly gradient = new THREE.Vector3();
  private readonly view = new THREE.Vector3();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly normalMatrix = new THREE.Matrix3();
  private readonly screenSources = new Map<THREE.Mesh, { projection: THREE.Matrix4; view: THREE.Matrix4; camera: THREE.Vector3 }>();
  private readonly edgeA = new THREE.Vector3();
  private readonly edgeB = new THREE.Vector3();
  private readonly edgeC = new THREE.Vector3();
  private readonly screenRight = new THREE.Vector3();
  private readonly screenUp = new THREE.Vector3();
  private viewSnapshot?: { eye: THREE.Vector3; forward: THREE.Vector3; up: THREE.Vector3; projection: number; width: number; height: number };
  private nextViewCheck = 0;
  private focusDistance = Infinity;
  private occlusionDeadline = 0;
  private sourceRevision = 0;
  private occlusionSources = new Set<THREE.Mesh>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly occlusion = new WeakMap<Placement, { time: number; revision: number; eye: THREE.Vector3; point: THREE.Vector3; hidden: boolean }>();

  constructor() { this.group.name = 'terrain-contour-labels'; }

  get settled(): boolean { return !this.dirty && !this.topology && !this.layoutJob && [...this.caches.values()].every(cache => cache.complete); }

  update(camera: THREE.Camera, width: number, height: number, sources: THREE.Mesh[],
    settings: SurfaceAppearanceSettings, enabled = true, obstacles: readonly ScreenRect[] = []): void {
    const interval = settings.contourIntervalKm ?? 0;
    const active = enabled && settings.contours && settings.contourLabels && interval > 0;
    this.group.visible = !!active;
    if (!active) { this.clear(); return; }
    if (interval !== this.interval) { this.clear(); this.interval = interval; }
    const live = new Set(sources);
    if (live.size !== this.occlusionSources.size || sources.some(mesh => !this.occlusionSources.has(mesh))) {
      this.sourceRevision++; this.occlusionSources = live;
    }
    for (const mesh of this.caches.keys()) if (!live.has(mesh)) {
      this.caches.delete(mesh); this.sourceRevision++; this.dirty = true; this.topology = undefined; this.layoutJob = undefined; this.nextLayout = 0;
    }
    for (const mesh of sources) {
      mesh.updateWorldMatrix(true, false);
      const heights = mesh.geometry.getAttribute('surfaceHeightKm');
      if (!heights) continue;
      const existing = this.caches.get(mesh);
      if (!existing || existing.geometry !== mesh.geometry || existing.heights !== heights) {
        this.sourceRevision++;
        this.caches.set(mesh, { mesh, geometry: mesh.geometry, heights, cursor: 0, segments: [], segmentMap: new Map(), complete: false });
        this.dirty = true;
        this.topology = undefined;
      }
    }
    camera.updateWorldMatrix(true, false);
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    this.group.updateWorldMatrix(true, false);
    // Use visible source vertices, rather than tile centres (which can be far
    // outside a close-up view), to establish the local distance scale.
    let nearestDistance = Infinity;
    for (const mesh of sources) {
      const positions = mesh.geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i += Math.max(1, Math.floor(positions.count / 32))) {
        this.point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
        this.projected.copy(this.point).project(camera);
        if (Math.abs(this.projected.x) < 1 && Math.abs(this.projected.y) < 1 && this.projected.z > -1 && this.projected.z < 1)
          nearestDistance = Math.min(nearestDistance, this.point.distanceTo(this.cameraPosition));
      }
    }
    if (!Number.isFinite(this.focusDistance) || nearestDistance < this.focusDistance * 0.75 || nearestDistance > this.focusDistance * 1.25)
      this.focusDistance = nearestDistance;
    this.refreshView(camera, width, height, sources);
    const start = performance.now();
    const orderedCaches = [...this.caches.values()].sort((a, b) => this.sourcePriority(a.mesh, camera) - this.sourcePriority(b.mesh, camera));
    for (const cache of orderedCaches) {
      const count = cache.segments.length;
      this.scan(cache, interval * 5, start + 2, camera, width, height);
      if (count !== cache.segments.length) this.dirty = true;
      if (performance.now() - start >= 2) break;
    }
    if (!this.topology && this.dirty && (!this.paths.length || [...this.caches.values()].every(cache => cache.complete))) {
      this.topology = buildContourPaths([...this.segments()], this.group, camera, height);
      this.dirty = false;
    }
    const topologyStart = performance.now();
    while (this.topology) {
      const result = this.topology.next();
      if (result.done) { this.paths = result.value; this.topology = undefined; this.layoutJob = undefined; this.nextLayout = 0; break; }
      if (performance.now() - topologyStart >= 2) break;
    }
    if (!this.layoutJob && performance.now() >= this.nextLayout) {
      this.layoutJob = this.layout(camera, width, height, obstacles);
    }
    const layoutStart = performance.now();
    while (this.layoutJob) {
      const result = this.layoutJob.next();
      if (result.done) { this.placements = result.value; this.layoutJob = undefined; this.nextLayout = performance.now() + 250; break; }
      if (performance.now() - layoutStart >= 2) break;
    }
    const occupied: Box[] = [...obstacles];
    const selected = new Map<ContourSegment, Placement>();
    let drawn = 0;
    this.occlusionDeadline = performance.now() + 2;
    for (const placement of this.placements) {
      if (!live.has(placement.mesh) || !live.has(placement.tangentStart.mesh) || !live.has(placement.tangentEnd.mesh)) continue;
      const screen = this.project(placement, camera, width, height);
      if (!screen) continue;
      // Occlusion or a transient obstacle must not discard the path's chosen
      // anchor: reusing it avoids a new position whenever a ridge crosses it.
      selected.set(placement.segment, placement);
      if (occupied.some(box => overlaps(box, screen.box))) continue;
      if (this.hidden(placement, camera, sources, screen.worldPerPx)) continue;
      occupied.push(screen.box);
      const sprite = this.sprites[drawn] ?? this.createSprite();
      this.setText(sprite, formatContourHeight(placement.anchor.heightKm));
      const material = sprite.material as THREE.SpriteMaterial;
      material.rotation = screen.angle;
      material.color.set('#fff8e8');
      material.opacity = 1;
      const uniforms = sprite.userData.depthUniforms;
      uniforms.saLabelNormal.value.copy(this.normal).normalize();
      uniforms.saLabelBias.value = screen.worldPerPx * 0.15;
      uniforms.saLabelProjection.value.copy(camera.projectionMatrix);
      sprite.position.copy(this.point);
      this.group.worldToLocal(sprite.position);
      const scale = this.group.matrixWorld.getMaxScaleOnAxis();
      sprite.scale.set(screen.width * screen.worldPerPx / scale, 26 * screen.size * screen.worldPerPx / scale, 1);
      sprite.visible = true;
      sprite.userData.heightKm = placement.anchor.heightKm;
      drawn++;
    }
    for (let i = drawn; i < this.sprites.length; i++) this.sprites[i].visible = false;
    this.selected = selected;
  }

  private sourcePriority(mesh: THREE.Mesh, camera: THREE.Camera): number {
    const center = (mesh.geometry.boundingSphere?.center ?? new THREE.Vector3()).clone().applyMatrix4(mesh.matrixWorld);
    const distance = center.distanceTo(this.cameraPosition);
    center.project(camera);
    return distance * (1 + Math.hypot(center.x, center.y));
  }

  private hidden(placement: Placement, camera: THREE.Camera, sources: THREE.Mesh[], worldPerPx: number): boolean {
    const now = performance.now(), old = this.occlusion.get(placement);
    const valid = old && old.revision === this.sourceRevision
      && old.eye.distanceToSquared(this.cameraPosition) < worldPerPx ** 2
      && old.point.distanceToSquared(this.point) < worldPerPx ** 2;
    if (valid && now - old.time < 1000) return old.hidden;
    if (now >= this.occlusionDeadline) return valid ? old.hidden : true;
    // An anchor LOS check complements glyph depth testing: tangent-plane
    // extrapolation and fading/non-depth-writing tiles must not expose text
    // through a foreground ridge. Test original ground meshes, even when cube
    // imagery has replaced their rendered material/visibility.
    const origin = this.cameraPosition.clone();
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const forward = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2);
      origin.copy(this.point).addScaledVector(forward, this.cameraPosition.clone().sub(this.point).dot(forward));
    }
    const direction = this.point.clone().sub(origin), distance = direction.length();
    this.raycaster.set(origin, direction.divideScalar(distance));
    this.raycaster.far = Math.max(0, distance - worldPerPx * 0.15);
    const hits: THREE.Intersection[] = [];
    for (const mesh of sources) {
      mesh.raycast(this.raycaster, hits);
      if (hits.length) break;
    }
    const hidden = hits.length > 0;
    this.occlusion.set(placement, { time: now, revision: this.sourceRevision, eye: this.cameraPosition.clone(), point: this.point.clone(), hidden });
    return hidden;
  }

  private *segments(): Iterable<ContourSegment> {
    for (const cache of this.caches.values()) yield* cache.segments;
  }

  private refreshView(camera: THREE.Camera, width: number, height: number, sources: THREE.Mesh[]): void {
    if (performance.now() < this.nextViewCheck) return;
    this.nextViewCheck = performance.now() + 250;
    const inverse = this.group.matrixWorld.clone().invert();
    const eye = this.cameraPosition.clone().applyMatrix4(inverse);
    const forward = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2).transformDirection(inverse);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).transformDirection(inverse);
    let nearest = Infinity;
    for (const mesh of sources) {
      const center = mesh.geometry.boundingSphere?.center ?? new THREE.Vector3();
      const local = center.clone().applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
      nearest = Math.min(nearest, local.distanceTo(eye));
    }
    const old = this.viewSnapshot;
    const changed = old && (old.eye.distanceTo(eye) > nearest * 0.15 || old.forward.angleTo(forward) > 0.15
      || old.up.angleTo(up) > 0.15 || Math.abs(old.projection / camera.projectionMatrix.elements[5] - 1) > 0.05
      || old.width !== width || old.height !== height);
    if (!old || changed) this.viewSnapshot = { eye, forward, up, projection: camera.projectionMatrix.elements[5], width, height };
    if (!changed) return;
    // Retain matching segment objects so labels on unchanged source triangles
    // keep their anchors while the visible extraction is rebuilt.
    for (const cache of this.caches.values()) {
      cache.previousSegments = cache.segmentMap; cache.segmentMap = new Map();
      cache.segments = []; cache.cursor = 0; cache.nextLevel = undefined; cache.complete = false;
    }
    this.dirty = true; this.topology = undefined; this.layoutJob = undefined;
  }

  private scan(cache: Cache, interval: number, deadline: number, camera: THREE.Camera, width: number, height: number): void {
    const g = cache.geometry, p = g.getAttribute('position'), ground = g.getAttribute('surfaceGround');
    const surface = g.userData.surfaceTriangles;
    const range = Number.isSafeInteger(surface) && surface > 0 ? { start: 0, count: surface * 3 }
      : g.groups[0] ?? { start: 0, count: g.index?.count ?? p.count };
    if (cache.cursor >= range.count) return;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const projection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,
      new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, cache.mesh.matrixWorld));
    for (; cache.cursor < range.count; cache.cursor += 3) {
      if (cache.cursor % 96 === 0 && performance.now() >= deadline) return;
      const offset = range.start + cache.cursor;
      const ids = [0, 1, 2].map(i => g.index ? g.index.getX(offset + i) : offset + i);
      if (ground && ids.some(i => ground.getX(i) < 0.999)) continue;
      const h = ids.map(i => cache.heights.getX(i));
      if (h.some(v => !Number.isFinite(v))) continue;
      const low = Math.min(...h), high = Math.max(...h);
      if (high - low < 1e-9) continue;
      a.fromBufferAttribute(p, ids[0]); b.fromBufferAttribute(p, ids[1]); c.fromBufferAttribute(p, ids[2]);
      if ([a, b, c].every(point => this.point.copy(point).applyMatrix4(cache.mesh.matrixWorld).distanceTo(this.cameraPosition) > this.focusDistance * 6)) {
        cache.nextLevel = undefined; continue;
      }
      const pa = this.edgeA.copy(a).applyMatrix4(projection), pb = this.edgeB.copy(b).applyMatrix4(projection), pc = this.edgeC.copy(c).applyMatrix4(projection);
      if ([pa, pb, pc].some(v => v.z < -1 || v.z > 1)
        || Math.min(pa.x, pb.x, pc.x) > 1.3 || Math.max(pa.x, pb.x, pc.x) < -1.3
        || Math.min(pa.y, pb.y, pc.y) > 1.3 || Math.max(pa.y, pb.y, pc.y) < -1.3) { cache.nextLevel = undefined; continue; }
      const bx = (pb.x - pa.x) * width / 2, by = (pb.y - pa.y) * height / 2;
      const cx = (pc.x - pa.x) * width / 2, cy = (pc.y - pa.y) * height / 2, determinant = bx * cy - cx * by;
      if (determinant <= 1e-8) { cache.nextLevel = undefined; continue; }
      const delta = Math.hypot(((h[1] - h[0]) * cy - (h[2] - h[0]) * by) / determinant,
        (bx * (h[2] - h[0]) - cx * (h[1] - h[0])) / determinant);
      // The shader retains nested index levels when dense bands cannot be
      // resolved. Extract those same levels instead of allocating thousands
      // of invisible lines on a distant coverage tile.
      const stride = 5 ** Math.max(0, Math.ceil(Math.log(Math.max(1, delta / (interval * 0.3))) / Math.log(5)));
      const first = Math.ceil((cache.nextLevel ?? Math.ceil(low / interval)) / stride) * stride, last = Math.ceil(high / interval) - 1;
      for (let index = first; index <= last; index += stride) {
        if ((index - first) % 16 === 0 && performance.now() >= deadline) { cache.nextLevel = index; return; }
        const key = `${offset}:${index}`;
        let segment = cache.previousSegments?.get(key);
        if (!segment) {
          const anchor = contourAnchor(a, b, c, h, index * interval);
          if (anchor) segment = { mesh: cache.mesh, start: anchor.end,
            end: anchor.point.clone().multiplyScalar(2).sub(anchor.end), normal: anchor.normal,
            gradient: anchor.gradient, heightKm: anchor.heightKm };
        }
        if (segment) { cache.segments.push(segment); cache.segmentMap.set(key, segment); }
      }
      cache.nextLevel = undefined;
    }
    cache.complete = true;
    cache.previousSegments = undefined;
  }

  private project(placement: Placement, camera: THREE.Camera, width: number, height: number, frames?: Map<THREE.Mesh, THREE.Matrix4>):
    { box: Box; worldPerPx: number; width: number; angle: number; size: number } | undefined {
    const { mesh, anchor } = placement;
    const matrix = frames?.get(mesh) ?? mesh.matrixWorld;
    this.point.copy(anchor.point).applyMatrix4(matrix);
    this.view.setFromMatrixPosition(camera.matrixWorld).sub(this.point);
    this.normal.copy(anchor.normal).applyMatrix3(this.normalMatrix.getNormalMatrix(matrix));
    if (this.normal.dot(this.view) <= 0) return;
    this.projected.copy(this.point).project(camera);
    if (this.projected.z < -1 || this.projected.z > 1 || Math.abs(this.projected.x) > 0.98 || Math.abs(this.projected.y) > 0.98) return;
    const distance = this.view.length();
    const reference = this.focusDistance / this.group.matrixWorld.getMaxScaleOnAxis();
    // Snapshot layout is in body coordinates; drawing uses world coordinates.
    const relativeDistance = distance / (frames ? reference : this.focusDistance);
    if (relativeDistance > 6) return;
    const size = THREE.MathUtils.clamp(1 / Math.sqrt(Math.max(1, relativeDistance)), 0.86, 1);
    const depth = -this.point.clone().applyMatrix4(camera.matrixWorldInverse).z;
    const worldPerPx = (camera as THREE.PerspectiveCamera).isPerspectiveCamera
      ? 2 * depth / camera.projectionMatrix.elements[5] / height : 2 / camera.projectionMatrix.elements[5] / height;
    this.gradient.copy(anchor.gradient).applyMatrix3(this.normalMatrix);
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) this.view.normalize();
    else this.view.setFromMatrixColumn(camera.matrixWorld, 2).normalize();
    this.screenRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    this.screenUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const normalView = this.normal.dot(this.view), gradientView = this.gradient.dot(this.view);
    const dx = this.gradient.dot(this.screenRight) - gradientView * this.normal.dot(this.screenRight) / normalView;
    const dy = this.gradient.dot(this.screenUp) - gradientView * this.normal.dot(this.screenUp) / normalView;
    const delta = worldPerPx * Math.hypot(dx, dy);
    const major = this.interval * 5;
    const spacing = major * 5 ** Math.max(0, Math.ceil(Math.log(Math.max(1, delta / (major * 0.3))) / Math.log(5)));
    if (delta >= major * 0.3 && Math.abs(anchor.heightKm - Math.round(anchor.heightKm / spacing) * spacing) > 1e-6) return;
    const start = placement.tangentStart, end = placement.tangentEnd;
    this.end.copy(start.point).applyMatrix4(frames?.get(start.mesh) ?? start.mesh.matrixWorld).project(camera);
    const ax = this.end.x, ay = this.end.y;
    this.end.copy(end.point).applyMatrix4(frames?.get(end.mesh) ?? end.mesh.matrixWorld).project(camera);
    let angle = Math.atan2((this.end.y - ay) * height, (this.end.x - ax) * width);
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle < -Math.PI / 2) angle += Math.PI;
    const w = (formatContourHeight(anchor.heightKm).length * 8.5 + 12) * size;
    const boxWidth = Math.abs(Math.cos(angle)) * w + Math.abs(Math.sin(angle)) * 26 * size;
    const boxHeight = Math.abs(Math.sin(angle)) * w + Math.abs(Math.cos(angle)) * 26 * size;
    const x = (this.projected.x + 1) * width / 2, y = (1 - this.projected.y) * height / 2;
    const box = { x0: x - boxWidth / 2 - 5, x1: x + boxWidth / 2 + 5, y0: y - boxHeight / 2 - 5, y1: y + boxHeight / 2 + 5 };
    if (box.x0 < 0 || box.x1 > width || box.y0 < 0 || box.y1 > height) return;
    return { box, worldPerPx, width: w, angle, size };
  }

  private edgeView(edge: ContourEdge, camera: THREE.Camera, width: number, height: number, distance: number,
    frames: Map<THREE.Mesh, THREE.Matrix4>): EdgeView | undefined {
    const s = edge.segment;
    if (!this.caches.has(s.mesh)) return;
    let source = this.screenSources.get(s.mesh);
    if (!source) {
      const matrix = frames.get(s.mesh)!;
      const view = new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, matrix);
      source = { view, projection: new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, view),
        camera: new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld).applyMatrix4(matrix.clone().invert()) };
      this.screenSources.set(s.mesh, source);
    }
    this.view.subVectors(source.camera, s.start);
    if (s.normal.dot(this.view) <= 0) return;
    const start = edge.reverse ? s.end : s.start, end = edge.reverse ? s.start : s.end;
    const v = source.view.elements;
    const depthA = -(v[2] * start.x + v[6] * start.y + v[10] * start.z + v[14]);
    const depthB = -(v[2] * end.x + v[6] * end.y + v[10] * end.z + v[14]);
    if (depthA <= 0 || depthB <= 0) return;
    const a = this.edgeA.copy(start).applyMatrix4(source.projection), b = this.edgeB.copy(end).applyMatrix4(source.projection);
    const pa = { x: (a.x + 1) * width / 2, y: (1 - a.y) * height / 2 };
    const pb = { x: (b.x + 1) * width / 2, y: (1 - b.y) * height / 2 };
    let t0 = 0, t1 = 1;
    for (const [v, d, low, high] of [[pa.x, pb.x - pa.x, 8, width - 8], [pa.y, pb.y - pa.y, 8, height - 8]]) {
      if (Math.abs(d) < 1e-9) { if (v < low || v > high) return; }
      else { const u = (low - v) / d, w = (high - v) / d; t0 = Math.max(t0, Math.min(u, w)); t1 = Math.min(t1, Math.max(u, w)); }
    }
    if (t1 <= t0) return;
    const length = Math.hypot(pb.x - pa.x, pb.y - pa.y) * (t1 - t0);
    if (length < 1e-5) return;
    return { edge, a: pa, b: pb, depthA, depthB, screenStart: t0, screenEnd: t1, length, distance };
  }

  private at(run: Run, distance: number, camera: THREE.Camera): { pixel: Pixel; reference: PointReference; edge: EdgeView; t: number } {
    let low = 0, high = run.edges.length - 1;
    while (low < high) { const mid = (low + high) >>> 1; if (run.edges[mid].distance + run.edges[mid].length < distance) low = mid + 1; else high = mid; }
    const edge = run.edges[low], fraction = THREE.MathUtils.clamp((distance - edge.distance) / edge.length, 0, 1);
    const screenT = edge.screenStart + (edge.screenEnd - edge.screenStart) * fraction;
    const orientedT = (camera as THREE.PerspectiveCamera).isPerspectiveCamera
      ? screenT * edge.depthA / ((1 - screenT) * edge.depthB + screenT * edge.depthA) : screenT;
    const t = edge.edge.reverse ? 1 - orientedT : orientedT, s = edge.edge.segment;
    return { pixel: { x: edge.a.x + (edge.b.x - edge.a.x) * screenT, y: edge.a.y + (edge.b.y - edge.a.y) * screenT },
      reference: { mesh: s.mesh, point: s.start.clone().lerp(s.end, t) }, edge, t };
  }

  private candidate(run: Run, distance: number, width: number, camera: THREE.Camera): Placement | undefined {
    const half = width / 2 + 5;
    if (distance < half || distance > run.length - half) return;
    const center = this.at(run, distance, camera), before = this.at(run, distance - half, camera), after = this.at(run, distance + half, camera);
    const dx = after.pixel.x - before.pixel.x, dy = after.pixel.y - before.pixel.y, length = Math.hypot(dx, dy);
    if (length < width * 0.9) return;
    // Fit a locally straight span, rather than printing a straight word across
    // a sharp contour bend. The angle then follows that span and stays upright.
    for (const fraction of [0.25, 0.5, 0.75]) {
      const p = this.at(run, distance - half + half * 2 * fraction, camera).pixel;
      if (Math.abs(dx * (p.y - before.pixel.y) - dy * (p.x - before.pixel.x)) / length > 3.5) return;
    }
    const segment = center.edge.edge.segment;
    const previous = this.selected.get(segment);
    if (previous && Math.abs(previous.t - center.t) < 1e-8) return previous;
    return { mesh: segment.mesh, segment, t: center.t,
      anchor: { point: center.reference.point, end: segment.start, normal: segment.normal, gradient: segment.gradient, heightKm: segment.heightKm },
      tangentStart: before.reference, tangentEnd: after.reference };
  }

  private *layout(camera: THREE.Camera, width: number, height: number, obstacles: readonly ScreenRect[]): Generator<void, Placement[]> {
    // Snapshot in the body's frame. Body motion and floating-origin changes
    // during a cooperative layout cannot mix matrices from different frames.
    const inverse = this.group.matrixWorld.clone().invert(), frames = new Map<THREE.Mesh, THREE.Matrix4>();
    for (const mesh of this.caches.keys()) frames.set(mesh, new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld));
    camera = camera.clone(); camera.matrixWorld.premultiply(inverse); camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    const selected = new Map(this.selected);
    let work = 0;
    this.screenSources.clear();
    const occupied: Box[] = [...obstacles], placements: Placement[] = [];
    const processed = new Set<ContourSegment>();
    // Retain existing anchors first. New paths are processed near the eye and
    // view centre first, and published progressively instead of waiting for
    // every distant contour to finish layout.
    const paths = this.paths.filter(path => path.edges.length && path.edges.every(e => frames.has(e.segment.mesh))).map(path => {
      const segment = path.edges[Math.floor(path.edges.length / 2)].segment;
      const point = segment.start.clone().applyMatrix4(frames.get(segment.mesh)!);
      const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
      const distance = point.distanceTo(eye);
      point.project(camera);
      return { path, priority: path.edges.some(e => selected.has(e.segment)) ? -1e9 : distance * (1 + Math.hypot(point.x, point.y)) };
    }).sort((a, b) => a.priority - b.priority);
    for (const { path } of paths) {
      for (const edge of path.edges) processed.add(edge.segment);
      const runs: Run[] = []; let run: Run = { edges: [], length: 0 };
      for (const edge of path.edges) {
        if (++work % 128 === 0) yield;
        const view = this.edgeView(edge, camera, width, height, run.length, frames);
        if (!view) { if (run.edges.length) runs.push(run); run = { edges: [], length: 0 }; continue; }
        run.edges.push(view); run.length += view.length;
      }
      if (run.edges.length) runs.push(run);
      const w = formatContourHeight(path.heightKm).length * 8.5 + 12;
      const candidates: Array<{ run: Run; distance: number; priority: number }> = [];
      for (const run of runs) {
        for (const edge of run.edges) {
          if (++work % 128 === 0) yield;
          const previous = selected.get(edge.edge.segment);
          if (!previous) continue;
          const t = edge.edge.reverse ? 1 - previous.t : previous.t;
          const s = (camera as THREE.PerspectiveCamera).isPerspectiveCamera
            ? t * edge.depthB / ((1 - t) * edge.depthA + t * edge.depthB) : t;
          const distance = edge.distance + (s - edge.screenStart) / (edge.screenEnd - edge.screenStart) * edge.length;
          candidates.push({ run, distance, priority: -1e9 });
        }
        for (let offset = 0; offset < run.length / 2; offset += 24) for (const sign of offset === 0 ? [1] : [-1, 1]) {
          if (++work % 128 === 0) yield;
          const distance = run.length / 2 + sign * offset, at = this.at(run, distance, camera);
          const eccentricity = Math.hypot((at.pixel.x - width / 2) / width, (at.pixel.y - height / 2) / height);
          candidates.push({ run, distance, priority: (at.edge.depthA + at.edge.depthB) * (1 + eccentricity) });
        }
      }
      candidates.sort((a, b) => a.priority - b.priority);
      for (const option of candidates) {
        if (++work % 128 === 0) yield;
        const placement = this.candidate(option.run, option.distance, w, camera);
        if (!placement) continue;
        const screen = this.project(placement, camera, width, height, frames);
        if (!screen || occupied.some(box => overlaps(box, screen.box))) continue;
        occupied.push(screen.box); placements.push(placement);
        this.placements = [...placements, ...this.placements.filter(p => !processed.has(p.segment))];
        break;
      }
    }
    return placements;
  }

  private createSprite(): THREE.Sprite {
    const material = new THREE.SpriteMaterial({ depthTest: true, depthWrite: false, toneMapped: false });
    const uniforms = {
      saLabelNormal: { value: new THREE.Vector3() }, saLabelBias: { value: 0 }, saLabelProjection: { value: new THREE.Matrix4() },
    };
    // Keep screen-aligned glyphs, but test their depth on the anchor triangle's
    // tangent plane. A flat billboard intersects its own slope and cuts words
    // in half. Per-fragment depth preserves UVs and both ordinary/log depth.
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, uniforms);
      const varyings = 'varying vec3 vContourLabelView, vContourLabelAnchor, vContourLabelNormal;\n';
      shader.vertexShader = 'uniform vec3 saLabelNormal;\n' + varyings + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('gl_Position = projectionMatrix * mvPosition;', `
vContourLabelView = mvPosition.xyz;
vContourLabelAnchor = modelViewMatrix[3].xyz;
vContourLabelNormal = mat3(viewMatrix) * saLabelNormal;
gl_Position = projectionMatrix * mvPosition;`);
      shader.fragmentShader = 'uniform float saLabelBias; uniform mat4 saLabelProjection;\n' + varyings + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <logdepthbuf_fragment>', `
vec3 labelView = vContourLabelView;
float labelBias = saLabelBias;
#ifndef USE_LOGARITHMIC_DEPTH_BUFFER
// Ordinary depth can quantize a distant slope by more than a fraction of a
// pixel when hosts choose a very small near plane. Allow one depth quantum;
// the viewer's logarithmic buffer keeps the smaller geometric bias.
if (saLabelProjection[3][3] == 0.0)
  labelBias = max(labelBias, 2.0 * labelView.z * labelView.z / (abs(saLabelProjection[3][2]) * 16777216.0));
#endif
if (saLabelProjection[3][3] == 0.0) {
  float denominator = dot(vContourLabelNormal, labelView);
  if (abs(denominator) < 1e-12) discard;
  float t = dot(vContourLabelNormal, vContourLabelAnchor) / denominator;
  if (t <= 0.0) discard;
  labelView *= t;
  labelView *= max(0.0, 1.0 - labelBias / length(labelView));
} else {
  if (abs(vContourLabelNormal.z) < 1e-12) discard;
  labelView.z = vContourLabelAnchor.z - dot(vContourLabelNormal.xy,
    labelView.xy - vContourLabelAnchor.xy) / vContourLabelNormal.z + labelBias;
}
vec4 labelClip = saLabelProjection * vec4(labelView, 1.0);
gl_FragDepth = labelClip.z / labelClip.w * 0.5 + 0.5;
#if defined(USE_LOGARITHMIC_DEPTH_BUFFER)
if (vIsPerspective != 0.0) gl_FragDepth = log2(max(1e-12, 1.0 - labelView.z)) * logDepthBufFC * 0.5;
#endif`);
    };
    material.customProgramCacheKey = () => 'terrain-contour-label-depth-v2';
    const sprite = new THREE.Sprite(material);
    sprite.userData.depthUniforms = uniforms;
    // Fading terrain is transparent too; render labels after its depth writes.
    sprite.renderOrder = 10;
    sprite.name = 'contour-elevation-label';
    sprite.raycast = () => {};
    this.group.add(sprite);
    this.sprites.push(sprite);
    return sprite;
  }

  private setText(sprite: THREE.Sprite, text: string): void {
    if (sprite.userData.text === text) return;
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d')!;
    canvas.width = (text.length * 8.5 + 12) * 2; canvas.height = 52;
    context.font = '600 28px monospace'; context.textAlign = 'center'; context.textBaseline = 'middle';
    context.lineWidth = 6; context.strokeStyle = '#000';
    context.strokeText(text, canvas.width / 2, 26);
    context.fillStyle = '#fff'; context.fillText(text, canvas.width / 2, 26);
    const material = sprite.material as THREE.SpriteMaterial;
    material.map?.dispose(); material.map = new THREE.CanvasTexture(canvas);
    material.map.colorSpace = THREE.SRGBColorSpace;
    material.needsUpdate = true;
    sprite.userData.text = text;
  }

  private clear(): void {
    this.caches.clear(); this.paths = []; this.placements = []; this.selected.clear();
    this.dirty = true; this.topology = undefined; this.layoutJob = undefined; this.nextLayout = 0;
    this.viewSnapshot = undefined; this.nextViewCheck = 0;
    this.screenSources.clear(); this.occlusionSources.clear(); this.sourceRevision++;
    this.focusDistance = Infinity;
    for (const sprite of this.sprites) sprite.visible = false;
  }

  dispose(): void {
    this.clear();
    for (const sprite of this.sprites) { sprite.material.map?.dispose(); sprite.material.dispose(); }
    this.sprites.length = 0; this.group.clear(); this.group.removeFromParent();
  }
}
