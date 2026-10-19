import * as THREE from 'three';
import type { SurfaceAppearanceSettings } from './SurfaceAppearance.js';
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
  geometry: THREE.BufferGeometry;
  heights: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  cursor: number;
  anchors: Map<number, { score: number; anchor: ContourAnchor }>;
}
interface Placement { mesh: THREE.Mesh; anchor: ContourAnchor; }

/** Sparse, bounded annotations. Scan ground triangles incrementally (2 ms/frame)
 * and retain at most 64 deterministic candidates per resident visible source.
 * Never extract polylines or duplicate the cube imagery's clipped geometry.
 * Textures/sprites are pooled, and hidden/evicted LOD tiles lose their anchors. */
export class TerrainContourLabels {
  readonly group = new THREE.Group();
  private readonly caches = new Map<THREE.Mesh, Cache>();
  private readonly sprites: THREE.Sprite[] = [];
  private placements: Placement[] = [];
  private selected = new Set<ContourAnchor>();
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

  constructor() { this.group.name = 'terrain-contour-labels'; }

  update(camera: THREE.Camera, width: number, height: number, sources: THREE.Mesh[],
    settings: SurfaceAppearanceSettings, enabled = true, obstacles: readonly ScreenRect[] = []): void {
    const interval = settings.contourIntervalKm ?? 0;
    const active = enabled && settings.contours && settings.contourLabels && interval > 0 && (settings.contourOpacity ?? 0.35) > 0;
    this.group.visible = !!active;
    if (!active) { this.clear(); return; }
    if (interval !== this.interval) { this.clear(); this.interval = interval; }
    const live = new Set(sources);
    for (const mesh of this.caches.keys()) if (!live.has(mesh)) this.caches.delete(mesh);
    for (const mesh of sources) {
      const heights = mesh.geometry.getAttribute('surfaceHeightKm');
      if (!heights) continue;
      const existing = this.caches.get(mesh);
      if (!existing || existing.geometry !== mesh.geometry || existing.heights !== heights) {
        this.caches.set(mesh, { geometry: mesh.geometry, heights, cursor: 0, anchors: new Map() });
      }
      mesh.updateWorldMatrix(true, false);
    }
    const start = performance.now();
    for (const cache of this.caches.values()) {
      this.scan(cache, interval, start + 2);
      if (performance.now() - start >= 2) break;
    }
    camera.updateWorldMatrix(true, false);
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    this.group.updateWorldMatrix(true, false);
    if (performance.now() >= this.nextLayout) {
      this.layout(camera, width, height);
      this.nextLayout = performance.now() + 250;
    }
    const occupied: Array<{ x: number; y: number; w: number }> = [];
    const selected = new Set<ContourAnchor>();
    let drawn = 0;
    for (const placement of this.placements) {
      if (!live.has(placement.mesh)) continue;
      const screen = this.project(placement, camera, width, height);
      if (!screen) continue;
      const text = formatContourHeight(placement.anchor.heightKm), w = text.length * 7 + 12;
      if (obstacles.some(r => screen.x - w / 2 - 4 < r.x1 && screen.x + w / 2 + 4 > r.x0
        && screen.y - 15 < r.y1 && screen.y + 15 > r.y0)) continue;
      if (occupied.some(r => Math.abs(r.x - screen.x) < (r.w + w) / 2 + 35 && Math.abs(r.y - screen.y) < 65)) continue;
      occupied.push({ ...screen, w });
      const sprite = this.sprites[drawn] ?? this.createSprite();
      this.setText(sprite, text);
      const material = sprite.material as THREE.SpriteMaterial;
      material.color.set(settings.contourColor ?? '#f2e6c9');
      material.opacity = Math.min(1, (settings.contourOpacity ?? 0.35) * 2);
      const worldPerPx = screen.worldPerPx;
      const uniforms = sprite.userData.depthUniforms;
      uniforms.saLabelNormal.value.copy(this.normal).normalize();
      uniforms.saLabelBias.value = worldPerPx * 2;
      uniforms.saLabelProjection.value.copy(camera.projectionMatrix);
      sprite.position.copy(this.point);
      this.group.worldToLocal(sprite.position);
      const scale = this.group.matrixWorld.getMaxScaleOnAxis();
      sprite.scale.set(w * worldPerPx / scale, 22 * worldPerPx / scale, 1);
      sprite.visible = true;
      selected.add(placement.anchor);
      drawn++;
      if (drawn === 16) break;
    }
    for (let i = drawn; i < this.sprites.length; i++) this.sprites[i].visible = false;
    this.selected = selected;
  }

  private scan(cache: Cache, interval: number, deadline: number): void {
    const g = cache.geometry, p = g.getAttribute('position'), ground = g.getAttribute('surfaceGround');
    const surface = g.userData.surfaceTriangles;
    const range = Number.isSafeInteger(surface) && surface > 0 ? { start: 0, count: surface * 3 }
      : g.groups[0] ?? { start: 0, count: g.index?.count ?? p.count };
    if (cache.cursor >= range.count) return;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (; cache.cursor < range.count; cache.cursor += 3) {
      if (cache.cursor % 192 === 0 && performance.now() >= deadline) return;
      const offset = range.start + cache.cursor;
      const ids = [0, 1, 2].map(i => g.index ? g.index.getX(offset + i) : offset + i);
      if (ground && ids.some(i => ground.getX(i) < 0.999)) continue;
      const h = ids.map(i => cache.heights.getX(i));
      if (h.some(v => !Number.isFinite(v))) continue;
      const low = Math.min(...h), high = Math.max(...h);
      if (high - low < 1e-9) continue;
      a.fromBufferAttribute(p, ids[0]); b.fromBufferAttribute(p, ids[1]); c.fromBufferAttribute(p, ids[2]);
      // At most eight well-spread levels on very coarse triangles. This is a
      // label candidate bound only; shader contour coverage remains unlimited.
      const first = Math.ceil(low / interval), last = Math.ceil(high / interval) - 1;
      const stride = Math.max(1, Math.ceil((last - first + 1) / 8));
      for (let index = first; index <= last; index += stride) {
        const anchor = contourAnchor(a, b, c, h, index * interval);
        if (!anchor) continue;
        let score = Math.imul(offset + 1, 73856093) ^ Math.imul(index, 19349663);
        score = (Math.imul(score ^ (score >>> 16), 0x45d9f3b) >>> 0);
        const bucket = score % 64;
        if (!cache.anchors.has(bucket) || score < cache.anchors.get(bucket)!.score) cache.anchors.set(bucket, { score, anchor });
      }
    }
  }

  private project(placement: Placement, camera: THREE.Camera, width: number, height: number):
    { x: number; y: number; worldPerPx: number } | undefined {
    const { mesh, anchor } = placement;
    this.point.copy(anchor.point).applyMatrix4(mesh.matrixWorld);
    this.view.subVectors(this.cameraPosition, this.point);
    this.normal.copy(anchor.normal).applyMatrix3(this.normalMatrix.getNormalMatrix(mesh.matrixWorld));
    if (this.normal.dot(this.view) <= 0) return;
    this.projected.copy(this.point).project(camera);
    if (this.projected.z < -1 || this.projected.z > 1 || Math.abs(this.projected.x) > 0.9 || Math.abs(this.projected.y) > 0.9) return;
    this.end.copy(anchor.end).applyMatrix4(mesh.matrixWorld).project(camera);
    if (Math.hypot((this.end.x - this.projected.x) * width, (this.end.y - this.projected.y) * height) < 2) return;
    const depth = -this.point.clone().applyMatrix4(camera.matrixWorldInverse).z;
    const worldPerPx = (camera as THREE.PerspectiveCamera).isPerspectiveCamera
      ? 2 * depth / camera.projectionMatrix.elements[5] / height
      : 2 / camera.projectionMatrix.elements[5] / height;
    // Conservative counterpart to the shader's unresolved-band fade. Avoid
    // labeling a fixed interval whose lines have merged below pixel scale.
    this.gradient.copy(anchor.gradient).applyMatrix3(this.normalMatrix);
    const facing = this.normal.dot(this.view) / (this.normal.length() * this.view.length());
    if (worldPerPx * this.gradient.length() / facing >= this.interval * 0.45) return;
    return { x: (this.projected.x + 1) * width / 2, y: (1 - this.projected.y) * height / 2, worldPerPx };
  }

  private layout(camera: THREE.Camera, width: number, height: number): void {
    const previous = this.selected;
    const candidates: Array<Placement & { priority: number }> = [];
    for (const [mesh, cache] of this.caches) for (const { anchor } of cache.anchors.values()) {
      const p = { mesh, anchor }, screen = this.project(p, camera, width, height);
      if (screen) candidates.push({ ...p, priority: (previous.has(anchor) ? -1e6 : 0)
        + Math.hypot(screen.x - width / 2, screen.y - height / 2) });
    }
    candidates.sort((a, b) => a.priority - b.priority);
    this.placements = candidates.slice(0, 256);
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
if (saLabelProjection[3][3] == 0.0) {
  float denominator = dot(vContourLabelNormal, labelView);
  if (abs(denominator) < 1e-12) discard;
  float t = dot(vContourLabelNormal, vContourLabelAnchor) / denominator;
  if (t <= 0.0) discard;
  labelView *= t;
  labelView *= max(0.0, 1.0 - saLabelBias / length(labelView));
} else {
  if (abs(vContourLabelNormal.z) < 1e-12) discard;
  labelView.z = vContourLabelAnchor.z - dot(vContourLabelNormal.xy,
    labelView.xy - vContourLabelAnchor.xy) / vContourLabelNormal.z + saLabelBias;
}
vec4 labelClip = saLabelProjection * vec4(labelView, 1.0);
gl_FragDepth = labelClip.z / labelClip.w * 0.5 + 0.5;
#if defined(USE_LOGARITHMIC_DEPTH_BUFFER)
if (vIsPerspective != 0.0) gl_FragDepth = log2(max(1e-12, 1.0 - labelView.z)) * logDepthBufFC * 0.5;
#endif`);
    };
    material.customProgramCacheKey = () => 'terrain-contour-label-depth-v1';
    const sprite = new THREE.Sprite(material);
    sprite.userData.depthUniforms = uniforms;
    sprite.name = 'contour-elevation-label';
    sprite.raycast = () => {};
    this.group.add(sprite);
    this.sprites.push(sprite);
    return sprite;
  }

  private setText(sprite: THREE.Sprite, text: string): void {
    if (sprite.userData.text === text) return;
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d')!;
    canvas.width = (text.length * 7 + 12) * 2; canvas.height = 44;
    context.font = '24px monospace'; context.textAlign = 'center'; context.textBaseline = 'middle';
    context.lineWidth = 6; context.strokeStyle = '#000';
    context.strokeText(text, canvas.width / 2, 22);
    context.fillStyle = '#fff'; context.fillText(text, canvas.width / 2, 22);
    const material = sprite.material as THREE.SpriteMaterial;
    material.map?.dispose(); material.map = new THREE.CanvasTexture(canvas);
    material.map.colorSpace = THREE.SRGBColorSpace;
    material.needsUpdate = true;
    sprite.userData.text = text;
  }

  private clear(): void {
    this.caches.clear(); this.placements = []; this.selected.clear(); this.nextLayout = 0;
    for (const sprite of this.sprites) sprite.visible = false;
  }

  dispose(): void {
    this.clear();
    for (const sprite of this.sprites) { sprite.material.map?.dispose(); sprite.material.dispose(); }
    this.sprites.length = 0; this.group.clear(); this.group.removeFromParent();
  }
}
