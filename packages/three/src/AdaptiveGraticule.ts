import * as THREE from 'three';
import { bodyFixedToSurfacePosition, surfacePositionToBodyFixed, formatSurfaceAngle, wrapLongitude, type SurfaceCoordinates } from '@cosmolabe/core';
import { ANGULAR_GRID_STEPS, type GridSettings } from '@cosmolabe/control';
import type { BodyMesh } from './BodyMesh.js';
import { GraticuleFrame } from './GraticuleFrame.js';
import type { LabelManager } from './LabelManager.js';
import { applyGraticuleMaterial, applyGraticuleToScene, makeGraticuleUniforms, GRID_PRESENTATION, gridSmoothstep, GRID_AUTO_STEPS } from './GraticuleShader.js';

export const GRID_STEPS = ANGULAR_GRID_STEPS;
export const AUTO_GRID_STEPS = GRID_AUTO_STEPS;
/** Screen separation is measured locally; global diameter is never the density input. */
export function chooseGridStep(pixelsPerDegree: number, previous = 30, targetPx = 180): number {
  if (!Number.isFinite(pixelsPerDegree) || pixelsPerDegree <= 0) return 30;
  const spacing = pixelsPerDegree * previous;
  if ((AUTO_GRID_STEPS as readonly number[]).includes(previous) && spacing >= targetPx * 0.7 && spacing <= targetPx * 1.5) return previous;
  return AUTO_GRID_STEPS.reduce((best, step) => Math.abs(Math.log(step * pixelsPerDegree / targetPx)) < Math.abs(Math.log(best * pixelsPerDegree / targetPx)) ? step : best, 30 as number);
}
export interface GeographicGridAnchor {
  readonly id: string; readonly tier: string; readonly axis: 'latitude' | 'longitude';
  readonly lat: number; readonly lon: number;
}
type Anchor = GeographicGridAnchor;
interface Label { sprite: THREE.Sprite; readonly anchor: Anchor; text: string; width: number; visibleSince: number; }
interface SurfaceHit { overlay: boolean; point: THREE.Vector3 | null; projectedAnchor: THREE.Vector3; time: number; }
const MAX_LABELS = 24;
const MAX_CANDIDATES = 96;
// Current geometry must validate every displayed terrain/occluder label. Leave
// two of the eight queries for discovery rather than rendering cached positives.
const MAX_TERRAIN_LABELS = 3;
const ENTRY_DWELL_MS = 100;
const LABEL_HEIGHT = 24;
const LABEL_FONT_SIZE = 14;
const DEG = Math.PI / 180;
const siteId = (anchor: Anchor) => `${anchor.axis}:${anchor.lat.toFixed(6)}:${anchor.lon.toFixed(6)}`;
/** Fixed geographic ruler bands, with captions between crossings. */
export function annotationPattern(latStep: number, lonStep: number) {
  const step = Math.max(latStep, lonStep);
  return { latitudeStride: latStep, longitudeStride: lonStep,
    labelStride: step <= 0.02 ? 3 : step <= 1 ? 2 : 1,
    meridianStride: lonStep === 30 ? 360 : Math.min(360, lonStep * 8),
    parallelStride: latStep === 30 ? 360 : Math.min(180, latStep * 8),
    meridianOffset: lonStep === 30 ? 5 : lonStep * 0.5,
    parallelOffset: latStep === 30 ? 3 : latStep * 0.5 };
}
function inPattern(anchor: Anchor, latStep: number, lonStep: number): boolean {
  const pattern = annotationPattern(latStep, lonStep);
  const row = anchor.lat / (latStep * pattern.labelStride), column = anchor.lon / (lonStep * pattern.labelStride);
  const onInteger = (value: number) => Math.abs(value - Math.round(value)) < 1e-5;
  const onCarrier = (value: number, stride: number, offset: number) =>
    Math.abs((value - offset) / stride - Math.round((value - offset) / stride)) < 1e-5;
  return anchor.axis === 'latitude' ? onInteger(row) && onCarrier(anchor.lon, pattern.meridianStride, pattern.meridianOffset)
    : onInteger(column) && onCarrier(anchor.lat, pattern.parallelStride, pattern.parallelOffset);
}

/** Constant-cost surface shader plus a bounded pool of line-associated annotations. */
export class AdaptiveGraticule {
  readonly uniforms;
  readonly bodyFromWorld = new THREE.Matrix4();
  private readonly labels = new Map<string, Label>();
  private readonly group = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private readonly rotation = new THREE.Quaternion();
  private readonly toWorld = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private lastPlan = -Infinity;
  private lastFrame = 0;
  private candidates: Anchor[] = [];
  private readonly eligibility = new Map<string, number>();
  private dpr = 0;
  private readonly cachedHits = new Map<string, SurfaceHit>();
  private visible = false;
  private labelVisible = true;
  private transition = 1;
  private globeScale = true;
  private latitudeCarrier: number | null = null;
  private longitudeCarrier: number | null = null;
  private carrierTier = '';
  private settings: GridSettings | null = null;
  private frame: GraticuleFrame | null = null;
  constructor(private readonly bm: BodyMesh, public coordinates: SurfaceCoordinates) {
    this.uniforms = makeGraticuleUniforms(coordinates);
    bm.add(this.group);
    applyGraticuleMaterial(bm.mesh.material as THREE.Material, this.uniforms, this.bodyFromWorld);
  }
  setCoordinates(coordinates: SurfaceCoordinates): void {
    this.coordinates = coordinates;
    this.uniforms.uGridShape.value.copy(makeGraticuleUniforms(coordinates).uGridShape.value);
    this.lastPlan = -Infinity;
    this.cachedHits.clear();
    this.clearLabels(); this.frame?.hide();
  }
  setAnnotationScene(scene: THREE.Scene): void {
    if (this.group.parent !== scene) scene.add(this.group);
  }
  invalidateSurface(): void { this.cachedHits.clear(); }
  attachSurfaceOverlay(group: THREE.Object3D): void { applyGraticuleToScene(group, this.uniforms, this.bodyFromWorld); }
  setCameraRelativeOrigin(origin: THREE.Vector3 | null): void {
    this.bodyFromWorld.copy(this.toWorld).invert();
    if (origin) this.bodyFromWorld.multiply(new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z));
  }
  configure(visible: boolean, labels: boolean, settings?: GridSettings): void {
    this.visible = visible;
    this.labelVisible = labels;
    if (settings !== this.settings) { this.settings = settings ?? null; this.lastPlan = -Infinity; }
    this.uniforms.uGridVisible.value = visible && !this.bm.hasModel ? 1 : 0;
    this.uniforms.uGridMinor.value = settings?.density === 'manual' ? (settings.minorLines ? 1 : 0) : 1;
    if (!visible || !labels) this.frame?.hide();
    if (!visible || !labels) for (const label of this.labels.values()) label.sprite.visible = false;
  }
  private point(lat: number, lon: number, heightKm = 0): THREE.Vector3 {
    const p = surfacePositionToBodyFixed({ latDeg: lat, lonDeg: lon, heightKm }, this.coordinates);
    return new THREE.Vector3(p.xKm, p.yKm, p.zKm).applyMatrix4(this.toWorld);
  }
  /** Ray/reference-ellipsoid intersection in physical body-fixed coordinates. */
  private referenceHit(x: number, y: number, camera: THREE.PerspectiveCamera, heightKm = 0): { latDeg: number; lonDeg: number; heightKm: number } | null {
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
    const origin = this.raycaster.ray.origin.clone().applyMatrix4(this.bodyFromWorld);
    const direction = this.raycaster.ray.direction.clone().transformDirection(this.bodyFromWorld);
    const shape = this.coordinates.datum.referenceShape;
    const radii = (shape.kind === 'sphere' ? [shape.radiusKm, shape.radiusKm, shape.radiusKm] : shape.radiiKm).map(r => r + heightKm);
    if (radii.some(r => r <= 0)) return null;
    const o = origin.clone().divide(new THREE.Vector3(...radii));
    const d = direction.clone().divide(new THREE.Vector3(...radii));
    const a = d.dot(d), b = o.dot(d), c = o.dot(o) - 1;
    const disc = b * b - a * c;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / a;
    if (t <= 0) return null;
    origin.addScaledVector(direction, t);
    const hit = bodyFixedToSurfacePosition({ xKm: origin.x, yKm: origin.y, zKm: origin.z }, this.coordinates);
    return { ...hit, heightKm: hit.heightKm ?? 0 };
  }
  /** Intersect the nearby resident height surface; never take a far-side exit. */
  private planningHit(x: number, y: number, camera: THREE.PerspectiveCamera, seed: number | null) {
    const reference = this.referenceHit(x, y, camera);
    let height = reference ? this.bm.sampleTerrain(reference.latDeg, reference.lonDeg)?.elevationKm ?? seed : seed;
    if (height === null) return reference;
    for (let i = 0; i < 6; i++) {
      const hit = this.referenceHit(x, y, camera, height);
      if (!hit) return null;
      const sample = this.bm.sampleTerrain(hit.latDeg, hit.lonDeg);
      if (!sample) return reference;
      const error = sample.elevationKm - hit.heightKm;
      if (Math.abs(error) < 1e-6) return { ...hit, heightKm: sample.elevationKm };
      height += error;
    }
    return null;
  }
  private plan(camera: THREE.PerspectiveCamera, width: number, height: number): void {
    const cameraFixed = camera.position.clone().applyMatrix4(this.bodyFromWorld);
    const foot = bodyFixedToSurfacePosition({ xKm: cameraFixed.x, yKm: cameraFixed.y, zKm: cameraFixed.z }, this.coordinates);
    const seed = this.bm.sampleTerrain(foot.latDeg, foot.lonDeg)?.elevationKm ?? null;
    const samples: Array<{ latDeg: number; lonDeg: number }> = [];
    const latScale: number[] = [], lonScale: number[] = [];
    const center = this.bm.position.clone().project(camera);
    const probes: [number, number][] = [[center.x, center.y]];
    for (let y = -0.8; y <= 0.801; y += 0.2666667) for (let x = -0.8; x <= 0.801; x += 0.2666667) probes.push([x, y]);
    for (const [x, y] of probes) {
      if (Math.abs(x) > 1 || Math.abs(y) > 1) continue;
      const hit = this.planningHit(x, y, camera, seed);
      if (!hit) continue;
      samples.push(hit);
      const p = this.point(hit.latDeg, hit.lonDeg, hit.heightKm).project(camera);
      const delta = 0.0001;
      const latitude = Math.min(89.9999, hit.latDeg + delta);
      const a = this.point(latitude, hit.lonDeg, this.bm.sampleTerrain(latitude, hit.lonDeg)?.elevationKm ?? hit.heightKm).project(camera);
      const b = this.point(hit.latDeg, hit.lonDeg + delta, this.bm.sampleTerrain(hit.latDeg, hit.lonDeg + delta)?.elevationKm ?? hit.heightKm).project(camera);
      latScale.push(Math.hypot((a.x - p.x) * width / 2, (a.y - p.y) * height / 2) / delta);
      lonScale.push(Math.hypot((b.x - p.x) * width / 2, (b.y - p.y) * height / 2) / delta);
    }
    const median = (v: number[]) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
    const previous = this.uniforms.uGridStep.value;
    const shape = this.coordinates.datum.referenceShape;
    const radius = shape.kind === 'sphere' ? shape.radiusKm : Math.max(...shape.radiiKm);
    // Project the reference silhouette into the viewport. Optical zoom must
    // refine just like approaching the surface; height alone cannot veto it.
    // Separate entry/exit sizes keep the old rulers stable near the boundary.
    const cameraDistance = cameraFixed.length();
    const diameter = cameraDistance > radius ? radius / Math.sqrt(cameraDistance * cameraDistance - radius * radius)
      * camera.projectionMatrix.elements[5] * height : Infinity;
    const viewportDiameters = diameter / Math.min(width, height);
    this.globeScale = viewportDiameters <= (this.globeScale ? 2.3 : 1.95);
    const globeScale = this.globeScale;
    const automatic = this.settings?.density !== 'manual';
    // A grid that has just filled the viewport needs broad geographic cells.
    // Relax toward the original fine spacing only at genuinely close scales.
    const regionalTarget = Math.min(500, Math.min(width, height) * 0.5);
    const closeBlend = THREE.MathUtils.clamp((viewportDiameters - 6) / 12, 0, 1);
    const targetPx = THREE.MathUtils.lerp(regionalTarget, 180, closeBlend);
    const regionalStep = (scales: number[], oldStep: number) => Math.min(10, scales.length ? chooseGridStep(median(scales), oldStep, targetPx) : oldStep);
    const latStep = !automatic ? this.settings!.spacingDeg : globeScale ? 30 : regionalStep(latScale, previous.x);
    const lonStep = !automatic ? this.settings!.spacingDeg : globeScale ? 30 : regionalStep(lonScale, previous.y);
    const detail = (step: number) => step / 5;
    const detailLat = detail(latStep), detailLon = detail(lonStep), hierarchy = automatic ? 1 : 0;
    if (latStep !== previous.x || lonStep !== previous.y || detailLat !== this.uniforms.uGridDetailStep.value.x
      || detailLon !== this.uniforms.uGridDetailStep.value.y || hierarchy !== this.uniforms.uGridHierarchy.value) {
      this.uniforms.uGridPreviousStep.value.copy(previous);
      this.uniforms.uGridPreviousDetailStep.value.copy(this.uniforms.uGridDetailStep.value);
      this.uniforms.uGridPreviousHierarchy.value = this.uniforms.uGridHierarchy.value;
      previous.set(latStep, lonStep);
      this.uniforms.uGridDetailStep.value.set(detailLat, detailLon);
      this.uniforms.uGridHierarchy.value = hierarchy;
      this.transition = 0;
    }
    const tier = `${latStep}:${lonStep}`;
    const discovered = new Map<string, Anchor>();
    const add = (axis: Anchor['axis'], lat: number, lon: number) => {
      lat = Number(lat.toFixed(6)) || 0;
      lon = Number(wrapLongitude(Number(lon.toFixed(6))).toFixed(6)) || 0;
      if (Math.abs(lat) >= 85) return;
      const id = `${this.bm.body.name}:${tier}:${axis}:${lat.toFixed(6)}:${lon.toFixed(6)}`;
      discovered.set(id, { id, tier, axis, lat, lon });
    };
    const pattern = annotationPattern(latStep, lonStep);
    if (this.carrierTier !== tier) {
      this.latitudeCarrier = null; this.longitudeCarrier = null; this.carrierTier = tier;
    }
    // Select a whole prescribed band. The incumbent survives small camera
    // changes; switching bands retires its entire sequence in one step.
    const carrier = (center: number, stride: number, offset: number, previous: number | null) => {
      const nearest = (Math.round((center - offset) / stride) * stride + offset);
      return previous !== null && Math.abs(center - previous) < stride * 0.75 ? previous : nearest;
    };
    this.latitudeCarrier = carrier(foot.lonDeg, pattern.meridianStride, pattern.meridianOffset, this.latitudeCarrier);
    this.longitudeCarrier = carrier(foot.latDeg, pattern.parallelStride, pattern.parallelOffset, this.longitudeCarrier);
    // Enumerate a bounded contiguous subset of the prescribed block indices.
    // Bounds may exclude sites, but never change the pattern stride or phase.
    const values = (lo: number, hi: number, stride: number, phase: number, limit: number) => {
      const first = Math.ceil(lo / stride - phase), end = Math.floor(hi / stride - phase);
      const middle = Math.round((lo + hi) / (2 * stride) - phase);
      const start = Math.max(first, Math.min(end - limit + 1, middle - Math.floor(limit / 2)));
      const result: number[] = [];
      for (let i = start; i <= Math.min(end, start + limit - 1); i++) result.push((i + phase) * stride);
      return result;
    };
    if (samples.length) {
      const latitudes = samples.map(p => p.latDeg);
      const longitudes = samples.map(p => foot.lonDeg + wrapLongitude(p.lonDeg - foot.lonDeg));
      const south = Math.max(-84, Math.min(...latitudes) - latStep * 2);
      const north = Math.min(84, Math.max(...latitudes) + latStep * 2);
      const west = Math.max(foot.lonDeg - 180, Math.min(...longitudes) - lonStep * 2);
      const east = Math.min(foot.lonDeg + 180, Math.max(...longitudes) + lonStep * 2);
      for (const lat of values(south, north, pattern.latitudeStride * pattern.labelStride, 0, 24))
        if (this.latitudeCarrier >= west && this.latitudeCarrier <= east) add('latitude', lat, this.latitudeCarrier);
      for (const lon of values(west, east, pattern.longitudeStride * pattern.labelStride, 0, 24))
        if (this.longitudeCarrier >= south && this.longitudeCarrier <= north) add('longitude', this.longitudeCarrier, lon);
    }
    // Retain only shared active sites or sites still fading from the immediately
    // previous pattern. A surviving line alone does not preserve an old site.
    for (const label of this.labels.values()) if (label.sprite.visible && label.anchor.tier === tier
      && (label.anchor.axis === 'latitude' ? Math.abs(wrapLongitude(label.anchor.lon - this.latitudeCarrier!)) < 1e-5
        : Math.abs(label.anchor.lat - this.longitudeCarrier!) < 1e-5) && this.lineWeight(label.anchor) > 0) {
      for (const [id, candidate] of discovered) if (siteId(candidate) === siteId(label.anchor)) discovered.delete(id);
      discovered.set(label.anchor.id, label.anchor);
    }
    const distance = (anchor: Anchor) => Math.min(...samples.map(p =>
      Math.hypot((anchor.lat - p.latDeg) / latStep, wrapLongitude(anchor.lon - p.lonDeg) / lonStep)), Infinity);
    const ordered = [...discovered.values()].sort((a, b) => {
      const visible = (anchor: Anchor) => this.labels.get(anchor.id)?.sprite.visible ? 1 : 0;
      return visible(b) - visible(a) || distance(a) - distance(b) || a.id.localeCompare(b.id);
    });
    this.candidates = ordered.slice(0, MAX_CANDIDATES);
  }
  private lineWeight(anchor: Anchor): number {
    const current = this.uniforms.uGridStep.value, previous = this.uniforms.uGridPreviousStep.value;
    const contains = (steps: THREE.Vector2) => inPattern(anchor, steps.x, steps.y);
    return (contains(current) ? this.transition : 0) + (contains(previous) ? 1 - this.transition : 0);
  }
  update(camera: THREE.PerspectiveCamera, viewport: { width: number; height: number }, manager: LabelManager | null, occluders: readonly BodyMesh[] = [this.bm]): void {
    const now = performance.now();
    this.frame?.hide();
    const dt = Math.max(0, Math.min(0.1, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.uniforms.uGridPixelRatio.value = Math.max(1, globalThis.devicePixelRatio ?? 1);
    this.transition = Math.min(1, this.transition + dt / 0.18);
    this.bm.bodyToWorldQuaternion(this.rotation);
    this.toWorld.compose(this.bm.position, this.rotation, this.v.setScalar(this.bm.scaleFactor));
    this.bodyFromWorld.copy(this.toWorld).invert();
    this.group.position.copy(this.group.parent === this.bm ? this.v.set(0, 0, 0) : this.bm.position);
    this.group.quaternion.copy(this.rotation);
    this.group.scale.setScalar(this.bm.scaleFactor);
    const hide = (label: Label | undefined) => {
      if (label) { label.sprite.visible = false; label.sprite.material.opacity = 0; }
    };
    if (!this.visible || !this.bm.visible || this.bm.hasModel) {
      for (const label of this.labels.values()) hide(label);
      this.eligibility.clear(); return;
    }
    const ratio = this.bm.mesh.scale.x / (this.bm.scaleFactor * this.bm.ellipsoidRatios[0]);
    this.uniforms.uGridVisible.value = ratio > 1.001 ? 0 : 1;
    if (ratio > 1.001) { for (const label of this.labels.values()) hide(label); return; }
    camera.updateMatrixWorld(true); this.bm.updateMatrixWorld(true);
    const { width, height } = viewport;
    if (width <= 0 || height <= 0) return;
    if (now - this.lastPlan >= 150) { this.plan(camera, width, height); this.lastPlan = now; }
    this.uniforms.uGridBlend.value = this.transition;
    if (!this.labelVisible || !manager) return;
    if (this.settings?.coordinateFrame && !this.globeScale) {
      for (const label of this.labels.values()) hide(label);
      this.frame ??= new GraticuleFrame(this.group);
      const targets: THREE.Object3D[] = [], own = new Set<THREE.Object3D>();
      for (const body of occluders.length ? occluders : [this.bm]) {
        if (!body.visible) continue;
        const meshes = [body.mesh.visible ? body.mesh : null, body.terrainTileGroup?.visible ? body.terrainTileGroup : null,
          ...body.getSurfaceOverlays().filter(o => o.group.visible).map(o => o.group)].filter((o): o is THREE.Object3D => !!o);
        for (const mesh of meshes) { targets.push(mesh); if (body === this.bm) own.add(mesh); }
      }
      const materials = Array.isArray(this.bm.mesh.material) ? this.bm.mesh.material : [this.bm.mesh.material];
      if (this.bm.mesh.visible && materials.some(m => (m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshPhongMaterial) && m.displacementMap && (m.displacementScale !== 0 || m.displacementBias !== 0))) return;
      const cameraFixed = camera.position.clone().applyMatrix4(this.bodyFromWorld);
      const foot = bodyFixedToSurfacePosition({ xKm: cameraFixed.x, yKm: cameraFixed.y, zKm: cameraFixed.z }, this.coordinates);
      const seed = this.bm.sampleTerrain(foot.latDeg, foot.lonDeg)?.elevationKm ?? null;
      const sample = (x: number, y: number) => {
        const h = this.planningHit(x / width * 2 - 1, 1 - y / height * 2, camera, seed);
        if (!h) return null;
        const point = this.point(h.latDeg, h.lonDeg, h.heightKm);
        const normal = new THREE.Vector3(Math.cos(h.latDeg * DEG) * Math.cos(h.lonDeg * DEG), Math.cos(h.latDeg * DEG) * Math.sin(h.lonDeg * DEG), Math.sin(h.latDeg * DEG)).applyQuaternion(this.rotation);
        return { ...h, incidence: camera.position.clone().sub(point).normalize().dot(normal) };
      };
      const steps = this.uniforms.uGridStep.value;
      this.frame.update(width, height, [steps.x, steps.y], manager, sample, tick => {
        this.raycaster.setFromCamera(new THREE.Vector2(tick.x / width * 2 - 1, 1 - tick.y / height * 2), camera);
        const intersection = this.raycaster.intersectObjects(targets, true).find(hit => {
          // Raycaster traverses invisible objects; only rendered ancestry can
          // certify a coordinate, especially during terrain LOD replacement.
          for (let object: THREE.Object3D | null = hit.object; object; object = object.parent) if (!object.visible) return false;
          return true;
        });
        if (!intersection) return false;
        let object: THREE.Object3D | null = intersection.object;
        while (object && !own.has(object)) object = object.parent;
        if (!object) return false;
        const p = intersection.point.clone().applyMatrix4(this.bodyFromWorld);
        const h = bodyFixedToSurfacePosition({ xKm: p.x, yKm: p.y, zKm: p.z }, this.coordinates);
        return Math.abs(tick.axis === 'latitude' ? h.latDeg - tick.value : wrapLongitude(h.lonDeg - tick.value)) < (tick.axis === 'latitude' ? steps.x : steps.y) * 0.015;
      });
      this.frame.sprite.position.copy(new THREE.Vector3(0, 0, -Math.max(camera.near * 2, 1)).applyMatrix4(camera.matrixWorld).applyMatrix4(this.bodyFromWorld));
      const pixel = 2 / camera.projectionMatrix.elements[5] / height / this.bm.scaleFactor;
      this.frame.sprite.scale.set(width * pixel, height * pixel, 1);
      return;
    }
    const materials = Array.isArray(this.bm.mesh.material) ? this.bm.mesh.material : [this.bm.mesh.material];
    // Three's triangle picker cannot see vertex displacement performed only in
    // the shader. Keep the surface grid, but never certify those labels against
    // undisplaced triangles as if they were the rendered terrain.
    if (this.bm.mesh.visible && materials.some(material => (material instanceof THREE.MeshStandardMaterial
      || material instanceof THREE.MeshPhongMaterial) && material.displacementMap
      && (material.displacementScale !== 0 || material.displacementBias !== 0))) {
      for (const label of this.labels.values()) hide(label);
      this.eligibility.clear(); return;
    }
    const dpr = Math.max(1, globalThis.devicePixelRatio ?? 1);
    if (dpr !== this.dpr) { this.clearLabels(); this.dpr = dpr; }
    const targets: THREE.Object3D[] = [];
    const overlayTargets = new Set<THREE.Object3D>();
    const ownTargets: THREE.Object3D[] = [];
    const foreignOccluders: Array<{ sphere: THREE.Sphere; targets: THREE.Object3D[] }> = [];
    for (const body of occluders) {
      if (!body.visible) continue;
      const bodyTargets: THREE.Object3D[] = [];
      if (body.mesh.visible && (body !== this.bm || body.body.geometryData?.displacementMap)) {
        bodyTargets.push(body.mesh);
      }
      if (body.terrainTileGroup?.visible) bodyTargets.push(body.terrainTileGroup);
      for (const overlay of body.getSurfaceOverlays()) if (overlay.group.visible) {
        bodyTargets.push(overlay.group); overlayTargets.add(overlay.group);
      }
      targets.push(...bodyTargets);
      if (body === this.bm) ownTargets.push(...bodyTargets);
      else if (bodyTargets.length) foreignOccluders.push({
        // Only a ray that reaches this conservative bound can hit the body's
        // geometry. Most unrelated bodies never require a triangle query.
        sphere: new THREE.Sphere(body.getWorldPosition(new THREE.Vector3()), body.displayRadius * body.scaleFactor * 1.25),
        targets: bodyTargets,
      });
    }
    const registeredTerrain = !this.bm.mesh.visible || !!this.bm.body.geometryData?.displacementMap || this.bm.getSurfaceOverlays().some(o => o.group.visible);
    const prepared: Array<{ anchor: Anchor; p: THREE.Vector3; view: THREE.Vector3; incidence: number; strength: number }> = [];
    const cameraFixed = camera.position.clone().applyMatrix4(this.bodyFromWorld);
    const shape = this.coordinates.datum.referenceShape;
    const radii = shape.kind === 'sphere' ? [shape.radiusKm, shape.radiusKm, shape.radiusKm] : shape.radiiKm;
    for (const anchor of this.candidates) {
      const lineWeight = this.lineWeight(anchor);
      if (lineWeight <= 0) continue;
      const heightKm = this.bm.sampleTerrain(anchor.lat, anchor.lon)?.elevationKm ?? 0;
      const physical = surfacePositionToBodyFixed({ latDeg: anchor.lat, lonDeg: anchor.lon, heightKm }, this.coordinates);
      const fixed = new THREE.Vector3(physical.xKm, physical.yKm, physical.zKm);
      const normal = this.coordinates.latitudeType === 'geodetic'
        ? new THREE.Vector3(Math.cos(anchor.lat * DEG) * Math.cos(anchor.lon * DEG), Math.cos(anchor.lat * DEG) * Math.sin(anchor.lon * DEG), Math.sin(anchor.lat * DEG))
        : new THREE.Vector3(fixed.x / radii[0] ** 2, fixed.y / radii[1] ** 2, fixed.z / radii[2] ** 2).normalize();
      const incidence = cameraFixed.clone().sub(fixed).normalize().dot(normal);
      if (incidence < 0.08) continue;
      const p = fixed.applyMatrix4(this.toWorld), view = p.clone().project(camera);
      if (view.z < -1 || view.z > 1 || Math.abs(view.x) > 0.99 || Math.abs(view.y) > 0.99) continue;
      // Match the shader's congestion suppression; labels need not annotate
      // every rendered line, and cannot float over a subpixel suppressed lattice.
      const latStep = this.uniforms.uGridStep.value.x, lonStep = this.uniforms.uGridStep.value.y;
      const delta = 0.0001;
      const latitude = this.point(anchor.lat + delta, anchor.lon, heightKm).project(camera);
      const longitude = this.point(anchor.lat, anchor.lon + delta, heightKm).project(camera);
      const ax = (latitude.x - view.x) * width / 2 / delta, ay = (latitude.y - view.y) * height / 2 / delta;
      const bx = (longitude.x - view.x) * width / 2 / delta, by = (longitude.y - view.y) * height / 2 / delta;
      // Invert the local screen Jacobian to approximate the shader's fwidth of
      // this coordinate, including skew in rolled/oblique regional views.
      const determinant = Math.abs(ax * by - ay * bx);
      const latGradient = Math.abs(bx) + Math.abs(by), lonGradient = Math.abs(ax) + Math.abs(ay);
      const latSeparation = latGradient > 0 ? latStep * determinant / latGradient : 0;
      const lonSeparation = lonGradient > 0 ? lonStep * determinant / lonGradient : 0;
      const congestion = gridSmoothstep(GRID_PRESENTATION.congestion, anchor.axis === 'latitude' ? latSeparation : lonSeparation);
      const presentation = lineWeight * gridSmoothstep(GRID_PRESENTATION.horizon, incidence) * congestion;
      if (presentation < 0.012) continue;
      prepared.push({ anchor, p, view, incidence, strength: presentation });
    }
    // Existing suitable labels win collisions and stay within the discovery
    // subset. Neither scoring nor visibility may rewrite an anchor's location.
    prepared.sort((a, b) => {
      const left = this.labels.get(a.anchor.id), right = this.labels.get(b.anchor.id);
      const visible = (label: Label | undefined) => label?.sprite.visible ? 1 : 0;
      return visible(right) - visible(left)
        || (left?.sprite.visible && right?.sprite.visible ? left.visibleSince - right.visibleSince : 0)
        || Number(b.anchor.lat === 0 || b.anchor.lon === 0) - Number(a.anchor.lat === 0 || a.anchor.lon === 0)
        || a.anchor.id.localeCompare(b.anchor.id);
    });
    // Deduplicate only the same prescribed geographic site across tiers.
    // Repeated coordinate values at distinct regular sites remain independent.
    const sites = new Set<string>();
    const available = prepared.filter(p => { const site = siteId(p.anchor); if (sites.has(site)) return false; sites.add(site); return true; });
    const keys = new Set(available.map(p => p.anchor.id));
    for (const key of this.cachedHits.keys()) if (!keys.has(key)) this.cachedHits.delete(key);
    for (const key of this.eligibility.keys()) if (!keys.has(key)) this.eligibility.delete(key);
    if (registeredTerrain && targets.length) {
      const ordered = [...available].sort((a, b) => {
        const visible = (anchor: Anchor) => this.labels.get(anchor.id)?.sprite.visible ? 1 : 0;
        return visible(b.anchor) - visible(a.anchor)
          || Number(this.eligibility.has(b.anchor.id)) - Number(this.eligibility.has(a.anchor.id))
          || (this.cachedHits.get(a.anchor.id)?.time ?? -1) - (this.cachedHits.get(b.anchor.id)?.time ?? -1);
      });
      const pending = ordered;
      let queries = 0;
      const preferredHit = (intersections: THREE.Intersection[]) => {
        const overlay = intersections.find(hit => {
          let object: THREE.Object3D | null = hit.object;
          while (object) { if (overlayTargets.has(object)) return true; object = object.parent; }
          return false;
        });
        return { intersection: overlay ?? intersections[0], overlay: !!overlay };
      };
      for (const { anchor, view } of pending) {
        if (queries + 2 > 8) break;
        let surface: THREE.Vector3 | null = null;
        let overlay = false;
        // Register the fixed latitude/longitude on the actual rendered surface,
        // independently of the camera. A second ray checks current occlusion.
        const base = surfacePositionToBodyFixed({ latDeg: anchor.lat, lonDeg: anchor.lon }, this.coordinates);
        const normal = this.coordinates.latitudeType === 'geodetic'
          ? new THREE.Vector3(Math.cos(anchor.lat * DEG) * Math.cos(anchor.lon * DEG), Math.cos(anchor.lat * DEG) * Math.sin(anchor.lon * DEG), Math.sin(anchor.lat * DEG))
          : new THREE.Vector3(base.xKm, base.yKm, base.zKm).normalize();
        const reach = Math.max(...radii) * 0.1;
        const start = new THREE.Vector3(base.xKm, base.yKm, base.zKm).addScaledVector(normal, reach).applyMatrix4(this.toWorld);
        this.raycaster.set(start, normal.clone().negate().transformDirection(this.toWorld));
        this.raycaster.far = reach * 2 * this.bm.scaleFactor;
        const radial = preferredHit(this.raycaster.intersectObjects(ownTargets, true)); queries++;
        this.raycaster.far = Infinity;
        overlay = radial.overlay;
        if (radial.intersection) {
          const target = radial.intersection.point;
          this.raycaster.set(camera.position, target.clone().sub(camera.position).normalize());
          const visible = preferredHit(this.raycaster.intersectObjects(targets, true)); queries++;
          if (visible.intersection && visible.intersection.point.distanceTo(target) <= Math.max(...radii) * this.bm.scaleFactor * 1e-7) {
            surface = target.clone().applyMatrix4(this.bodyFromWorld);
          }
        }
        this.cachedHits.set(anchor.id, { overlay, point: surface, projectedAnchor: view.clone(), time: now });
      }
    }
    const active = new Set<string>();
    const ready: Array<{ anchor: Anchor; fixed: THREE.Vector3; text: string; labelWidth: number; offsetX: number; offsetY: number;
      rect: { x0: number; x1: number; y0: number; y1: number }; eligible: boolean; strength: number }> = [];
    const limit = registeredTerrain ? MAX_TERRAIN_LABELS : MAX_LABELS;
    for (const { anchor, p, view, incidence, strength } of available) {
      const label = this.labels.get(anchor.id);
      const reject = () => { hide(label); this.eligibility.delete(anchor.id); };
      let hit: THREE.Vector3 | null = null;
      if (registeredTerrain) {
        const cached = this.cachedHits.get(anchor.id);
        // A deferred positive is never permission to display through terrain.
        if (!cached || cached.time !== now) { hide(label); continue; }
        hit = cached.point;
      }
      const fixed = p.clone().applyMatrix4(this.bodyFromWorld);
      if (registeredTerrain) {
        if (!hit) { reject(); continue; }
        const surface = bodyFixedToSurfacePosition({ xKm: hit.x, yKm: hit.y, zKm: hit.z }, this.coordinates);
        // Check both coordinates: a foreground ridge on the same latitude line
        // is not the anchor's surface, even if its latitude happens to match.
        if (Math.abs(surface.latDeg - anchor.lat) > this.uniforms.uGridStep.value.x * 0.015
          || Math.abs(wrapLongitude(surface.lonDeg - anchor.lon)) > this.uniforms.uGridStep.value.y * 0.015) { reject(); continue; }
        const heightKm = surface.heightKm ?? 0;
        const physical = surfacePositionToBodyFixed({ latDeg: anchor.lat, lonDeg: anchor.lon, heightKm }, this.coordinates);
        fixed.set(physical.xKm, physical.yKm, physical.zKm);
      } else {
        const front = this.referenceHit(view.x, view.y, camera);
        if (!front || Math.abs(front.latDeg - anchor.lat) > 0.001 || Math.abs(wrapLongitude(front.lonDeg - anchor.lon)) > 0.001) { reject(); continue; }
        const distance = camera.position.distanceTo(p);
        const direction = p.clone().sub(camera.position).normalize();
        const ray = new THREE.Ray(camera.position, direction);
        let obscured = false;
        for (const occluder of foreignOccluders) {
          const bound = ray.intersectSphere(occluder.sphere, new THREE.Vector3());
          if (!bound || camera.position.distanceTo(bound) >= distance - this.bm.scaleFactor * 0.001) continue;
          this.raycaster.set(camera.position, direction);
          this.raycaster.far = distance - this.bm.scaleFactor * 0.001;
          obscured = this.raycaster.intersectObjects(occluder.targets, true).length > 0;
          this.raycaster.far = Infinity;
          if (obscured) break;
        }
        if (obscured) { reject(); continue; }
      }
      const projected = fixed.clone().applyMatrix4(this.toWorld).project(camera);
      const text = anchor.axis === 'latitude'
        ? anchor.lat === 0 ? '0°N' : formatSurfaceAngle(anchor.lat, 'latitude', this.uniforms.uGridStep.value.x * annotationPattern(this.uniforms.uGridStep.value.x, this.uniforms.uGridStep.value.y).labelStride)
        : anchor.lon === 0 ? '0°E' : formatSurfaceAngle(anchor.lon, 'longitude', this.uniforms.uGridStep.value.y * annotationPattern(this.uniforms.uGridStep.value.x, this.uniforms.uGridStep.value.y).labelStride);
      const labelWidth = text.length * 8.5 + 10;
      const offsetX = 0, offsetY = -LABEL_HEIGHT / 2 - 6;
      const x = (projected.x + 1) * width / 2 + offsetX, y = (1 - projected.y) * height / 2 + offsetY;
      const padding = label?.sprite.visible ? 3 : 6;
      const rect = { x0: x - labelWidth / 2 - padding, x1: x + labelWidth / 2 + padding,
        y0: y - LABEL_HEIGHT / 2 - padding, y1: y + LABEL_HEIGHT / 2 + padding };
      if (strength < 0.012 || projected.z < -1 || projected.z > 1 || rect.x0 < 4 || rect.x1 > width - 4 || rect.y0 < 4 || rect.y1 > height - 4
        || manager.canReserveContextRect?.(rect) === false) { reject(); continue; }
      // Billboard rectangles must fit the actual reference silhouette too.
      // A front-facing anchor alone does not certify its offset text corners.
      if (!registeredTerrain && [[rect.x0, rect.y0], [rect.x1, rect.y0], [rect.x0, rect.y1], [rect.x1, rect.y1]]
        .some(([px, py]) => !this.referenceHit(px / width * 2 - 1, 1 - py / height * 2, camera))) { reject(); continue; }
      const tierUseful = inPattern(anchor, this.uniforms.uGridStep.value.x, this.uniforms.uGridStep.value.y);
      const eligible = tierUseful && strength >= (label?.sprite.visible ? 0.02 : 0.04) && incidence >= (label?.sprite.visible ? 0.18 : 0.28)
        && Math.abs(projected.x) <= (label?.sprite.visible ? 0.96 : 0.9) && Math.abs(projected.y) <= (label?.sprite.visible ? 0.94 : 0.88);
      if (eligible) {
        if (!this.eligibility.has(anchor.id)) this.eligibility.set(anchor.id, now);
      } else this.eligibility.delete(anchor.id);
      if (!label?.sprite.visible && (!eligible || now - this.eligibility.get(anchor.id)! < ENTRY_DWELL_MS)) continue;
      ready.push({ anchor, fixed, text, labelWidth, offsetX, offsetY, rect, eligible, strength });
    }
    // Resource limits only cap work/display; they are never coverage targets.
    for (const { anchor, fixed, text, labelWidth, offsetX, offsetY, rect, eligible, strength } of ready) {
      if (active.size >= limit) break;
      let label = this.labels.get(anchor.id);
      if (!manager.reserveContextRect(rect)) { hide(label); this.eligibility.delete(anchor.id); continue; }
      if (!label) {
        if (this.labels.size >= MAX_LABELS) {
          const old = [...this.labels.values()].find(l => !l.sprite.visible);
          if (!old) continue;
          this.disposeLabel(old); this.labels.delete(old.anchor.id);
        }
        label = this.createLabel(anchor, text, labelWidth, dpr); this.labels.set(anchor.id, label);
      }
      if (!label.sprite.visible) label.visibleSince = now;
      label.sprite.position.copy(fixed);
      label.sprite.center.set(0.5 - offsetX / labelWidth, 0.5 + offsetY / LABEL_HEIGHT);
      const unitsPerPixel = 2 * Math.tan(camera.fov * DEG / 2) / height / this.bm.scaleFactor;
      label.sprite.scale.set(labelWidth * unitsPerPixel, LABEL_HEIGHT * unitsPerPixel, 1);
      label.sprite.material.opacity = Math.min(0.72 * strength, Math.max(0,
        label.sprite.material.opacity + (eligible ? dt * 5 : -dt * 4)));
      label.sprite.visible = label.sprite.material.opacity > 0;
      if (label.sprite.visible) active.add(anchor.id);
    }
    for (const [id, label] of this.labels) if (!active.has(id)) hide(label);
  }
  private createLabel(anchor: Anchor, text: string, width: number, dpr: number): Label {
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * dpr * 2); canvas.height = Math.ceil(LABEL_HEIGHT * dpr * 2);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr * 2, dpr * 2);
    ctx.font = `${LABEL_FONT_SIZE}px monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 2; ctx.strokeStyle = '#101725'; ctx.strokeText(text, width / 2, LABEL_HEIGHT / 2);
    ctx.fillStyle = '#b8c8da';
    ctx.fillText(text, width / 2, LABEL_HEIGHT / 2);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true,
      // Like body labels, annotation rectangles use CPU anchor occlusion instead of
      // cutting the billboard's glyphs against the curved surface's depth buffer.
      depthTest: false, depthWrite: false, sizeAttenuation: false, opacity: 0 }));
    sprite.userData.gridLineId = anchor.id;
    sprite.userData.gridLabelWidth = width;
    this.group.add(sprite);
    return { sprite, anchor, text, width, visibleSince: Infinity };
  }
  get metrics(): { candidates: number; labels: number; latitudeStep: number; longitudeStep: number; densityBlend: number; layout: 'geographic' | 'frame'; frameTicks: readonly import('./GraticuleFrame.js').FrameTick[];
    anchors: readonly GeographicGridAnchor[]; annotations: Array<{ id: string; tier: string; axis: Anchor['axis']; latDeg: number; lonDeg: number; text: string; opacity: number }> } {
    return { candidates: this.candidates.length, labels: [...this.labels.values()].filter(l => l.sprite.visible).length,
      latitudeStep: this.uniforms.uGridStep.value.x, longitudeStep: this.uniforms.uGridStep.value.y,
      densityBlend: this.uniforms.uGridBlend.value, layout: this.frame?.sprite.visible ? 'frame' : 'geographic', frameTicks: this.frame?.ticks ?? [], anchors: this.candidates,
      annotations: [...this.labels.values()].filter(l => l.sprite.visible).map(l => ({ id: l.anchor.id, tier: l.anchor.tier,
        axis: l.anchor.axis, latDeg: l.anchor.lat, lonDeg: l.anchor.lon,
        text: l.text, opacity: l.sprite.material.opacity })) };
  }
  private disposeLabel(label: Label): void { label.sprite.removeFromParent(); label.sprite.material.map?.dispose(); label.sprite.material.dispose(); }
  private clearLabels(): void { this.eligibility.clear(); for (const l of this.labels.values()) this.disposeLabel(l); this.labels.clear(); }
  dispose(): void { this.frame?.dispose(); this.clearLabels(); this.group.removeFromParent(); }
}
