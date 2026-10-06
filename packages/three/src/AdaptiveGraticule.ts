import * as THREE from 'three';
import { bodyFixedToSurfacePosition, surfacePositionToBodyFixed, formatSurfaceAngle, wrapLongitude, type SurfaceCoordinates } from '@cosmolabe/core';
import { ANGULAR_GRID_STEPS, type GridSettings } from '@cosmolabe/control';
import type { BodyMesh } from './BodyMesh.js';
import type { LabelManager } from './LabelManager.js';
import { applyGraticuleMaterial, applyGraticuleToScene, makeGraticuleUniforms } from './GraticuleShader.js';

export const GRID_STEPS = ANGULAR_GRID_STEPS;
/** Screen separation is measured locally; global diameter is never the density input. */
export function chooseGridStep(pixelsPerDegree: number, previous = 30, targetPx = 100): number {
  if (!Number.isFinite(pixelsPerDegree) || pixelsPerDegree <= 0) return 30;
  const spacing = pixelsPerDegree * previous;
  if (spacing >= targetPx * 0.6 && spacing <= targetPx * 1.8) return previous;
  return GRID_STEPS.reduce((best, step) => Math.abs(Math.log(step * pixelsPerDegree / targetPx)) < Math.abs(Math.log(best * pixelsPerDegree / targetPx)) ? step : best, 30 as number);
}
interface Anchor { id: string; axis: 'latitude' | 'longitude'; angle: number; lat: number; lon: number; score: number; }
interface Label { sprite: THREE.Sprite; anchor: Anchor; text: string; width: number; }
interface SurfaceHit { point: THREE.Vector3 | null; projectedAnchor: THREE.Vector3; time: number; }
const MAX_LABELS = 24;
const MAX_CANDIDATES = 96;
const DEG = Math.PI / 180;

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
  private dpr = 0;
  private readonly cachedHits = new Map<string, SurfaceHit>();
  private visible = false;
  private labelVisible = true;
  private transition = 1;
  private settings: GridSettings | null = null;
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
    this.clearLabels();
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
    this.uniforms.uGridMinor.value = settings?.minorLines ? 1 : 0;
    if (!visible || !labels) for (const label of this.labels.values()) label.sprite.visible = false;
  }
  private point(lat: number, lon: number, heightKm = 0): THREE.Vector3 {
    const p = surfacePositionToBodyFixed({ latDeg: lat, lonDeg: lon, heightKm }, this.coordinates);
    return new THREE.Vector3(p.xKm, p.yKm, p.zKm).applyMatrix4(this.toWorld);
  }
  /** Ray/reference-ellipsoid intersection in physical body-fixed coordinates. */
  private referenceHit(x: number, y: number, camera: THREE.PerspectiveCamera): { latDeg: number; lonDeg: number } | null {
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
    const origin = this.raycaster.ray.origin.clone().applyMatrix4(this.bodyFromWorld);
    const direction = this.raycaster.ray.direction.clone().transformDirection(this.bodyFromWorld);
    const shape = this.coordinates.datum.referenceShape;
    const radii = shape.kind === 'sphere' ? [shape.radiusKm, shape.radiusKm, shape.radiusKm] : shape.radiiKm;
    const o = origin.clone().divide(new THREE.Vector3(...radii));
    const d = direction.clone().divide(new THREE.Vector3(...radii));
    const a = d.dot(d), b = o.dot(d), c = o.dot(o) - 1;
    const disc = b * b - a * c;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / a;
    if (t <= 0) return null;
    origin.addScaledVector(direction, t);
    return bodyFixedToSurfacePosition({ xKm: origin.x, yKm: origin.y, zKm: origin.z }, this.coordinates);
  }
  private plan(camera: THREE.PerspectiveCamera, width: number, height: number): void {
    const samples: Array<{ latDeg: number; lonDeg: number; score: number }> = [];
    const latScale: number[] = [], lonScale: number[] = [];
    // A fixed screen lattice also samples a regional view when the body fills the viewport.
    // Include the projected centre for tiny/distant discs missed by the lattice.
    const center = this.bm.position.clone().project(camera);
    const probes: [number, number][] = [[center.x, center.y]];
    for (let y = -0.8; y <= 0.801; y += 0.2666667) for (let x = -0.8; x <= 0.801; x += 0.2666667) probes.push([x, y]);
    for (const [x, y] of probes) {
      if (Math.abs(x) > 1 || Math.abs(y) > 1) continue;
      const hit = this.referenceHit(x, y, camera);
      if (!hit) continue;
      samples.push({ ...hit, score: x * x + y * y });
      const p = this.point(hit.latDeg, hit.lonDeg).project(camera);
      // Small local angular derivatives account for latitude and foreshortening independently.
      const delta = 0.0001;
      const a = this.point(Math.min(89.9999, hit.latDeg + delta), hit.lonDeg).project(camera);
      const b = this.point(hit.latDeg, hit.lonDeg + delta).project(camera);
      latScale.push(Math.hypot((a.x - p.x) * width / 2, (a.y - p.y) * height / 2) / delta);
      lonScale.push(Math.hypot((b.x - p.x) * width / 2, (b.y - p.y) * height / 2) / delta);
    }
    const median = (v: number[]) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
    const previous = this.uniforms.uGridStep.value;
    const latStep = this.settings?.density === 'manual' ? this.settings.spacingDeg : chooseGridStep(median(latScale), previous.x);
    const lonStep = this.settings?.density === 'manual' ? this.settings.spacingDeg : chooseGridStep(median(lonScale), previous.y);
    if (latStep !== previous.x || lonStep !== previous.y) {
      this.uniforms.uGridPreviousStep.value.copy(previous);
      previous.set(latStep, lonStep);
      this.transition = 0;
    }
    const candidates: Anchor[] = [];
    samples.sort((a, b) => a.score - b.score);
    for (const sample of samples) {
      for (const axis of ['latitude', 'longitude'] as const) {
        const step = axis === 'latitude' ? latStep : lonStep;
        const angle = axis === 'latitude' ? Math.round(sample.latDeg / step) * step : wrapLongitude(Math.round(sample.lonDeg / step) * step);
        if ((axis === 'latitude' && Math.abs(angle) >= 90) || (axis === 'longitude' && Math.abs(sample.latDeg) > 88)) continue;
        candidates.push({ id: `${axis}:${angle.toFixed(6)}`, axis, angle,
          lat: axis === 'latitude' ? angle : sample.latDeg,
          lon: axis === 'longitude' ? angle : sample.lonDeg, score: sample.score });
      }
    }
    // Stable anchors are preferred whenever still visible; seam identities use canonical longitude.
    this.candidates = [...this.labels.values()].map(l => l.anchor)
      .filter(a => Math.abs(a.angle / (a.axis === 'latitude' ? latStep : lonStep) - Math.round(a.angle / (a.axis === 'latitude' ? latStep : lonStep))) < 1e-5)
      .concat(candidates).slice(0, MAX_CANDIDATES);
  }
  update(camera: THREE.PerspectiveCamera, viewport: { width: number; height: number }, manager: LabelManager | null, occluders: readonly BodyMesh[] = [this.bm]): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.uniforms.uGridPixelRatio.value = Math.max(1, globalThis.devicePixelRatio ?? 1);
    this.transition = Math.min(1, this.transition + dt / 0.18);
    this.uniforms.uGridBlend.value = this.transition;
    this.bm.bodyToWorldQuaternion(this.rotation);
    this.toWorld.compose(this.bm.position, this.rotation, this.v.setScalar(this.bm.scaleFactor));
    this.bodyFromWorld.copy(this.toWorld).invert();
    this.group.position.copy(this.group.parent === this.bm ? this.v.set(0, 0, 0) : this.bm.position);
    this.group.quaternion.copy(this.rotation);
    this.group.scale.setScalar(this.bm.scaleFactor);
    if (!this.visible || !this.bm.visible || this.bm.hasModel) {
      for (const label of this.labels.values()) label.sprite.visible = false;
      return;
    }
    // Analytical coordinates cannot be registered to minimum-pixel exaggerated bodies.
    const ratio = this.bm.mesh.scale.x / (this.bm.scaleFactor * this.bm.ellipsoidRatios[0]);
    this.uniforms.uGridVisible.value = ratio > 1.001 ? 0 : 1;
    if (ratio > 1.001) { for (const label of this.labels.values()) label.sprite.visible = false; return; }
    camera.updateMatrixWorld(true);
    this.bm.updateMatrixWorld(true);
    const { width, height } = viewport;
    if (width <= 0 || height <= 0) return;
    if (now - this.lastPlan >= 150) { this.plan(camera, width, height); this.lastPlan = now; }
    if (!this.labelVisible || !manager) return;
    const dpr = Math.max(1, globalThis.devicePixelRatio ?? 1);
    if (dpr !== this.dpr) { this.clearLabels(); this.dpr = dpr; }
    const active = new Set<string>();
    const targets: THREE.Object3D[] = [];
    const overlayTargets = new Set<THREE.Object3D>();
    for (const body of occluders) {
      if (!body.visible) continue;
      if (body.mesh.visible && (body !== this.bm || body.body.geometryData?.displacementMap)) targets.push(body.mesh);
      if (body.terrainTileGroup?.visible) targets.push(body.terrainTileGroup);
      for (const overlay of body.getSurfaceOverlays()) if (overlay.group.visible) {
        targets.push(overlay.group); overlayTargets.add(overlay.group);
      }
    }
    // Keep cheap horizon/viewport checks current even when a triangle recheck
    // is deferred. Cache points in body coordinates so body motion cannot leave
    // an annotation attached to an old world-space location.
    const prepared: Array<{ candidate: Anchor; key: string; p: THREE.Vector3; view: THREE.Vector3 }> = [];
    const cameraFixed = camera.position.clone().applyMatrix4(this.bodyFromWorld);
    for (const candidate of this.candidates) {
      const heightKm = this.bm.sampleTerrain(candidate.lat, candidate.lon)?.elevationKm ?? 0;
      const physical = surfacePositionToBodyFixed({ latDeg: candidate.lat, lonDeg: candidate.lon, heightKm }, this.coordinates);
      const shape = this.coordinates.datum.referenceShape;
      const radii = shape.kind === 'sphere' ? [shape.radiusKm, shape.radiusKm, shape.radiusKm] : shape.radiiKm;
      const normal = this.coordinates.latitudeType === 'geodetic'
        ? new THREE.Vector3(Math.cos(candidate.lat * DEG) * Math.cos(candidate.lon * DEG), Math.cos(candidate.lat * DEG) * Math.sin(candidate.lon * DEG), Math.sin(candidate.lat * DEG))
        : new THREE.Vector3(physical.xKm / radii[0] ** 2, physical.yKm / radii[1] ** 2, physical.zKm / radii[2] ** 2).normalize();
      const fixedAnchor = new THREE.Vector3(physical.xKm, physical.yKm, physical.zKm);
      if (cameraFixed.clone().sub(fixedAnchor).normalize().dot(normal) < 0.08) continue;
      const p = fixedAnchor.applyMatrix4(this.toWorld);
      const view = p.clone().project(camera);
      if (view.z < -1 || view.z > 1 || Math.abs(view.x) > 0.94 || Math.abs(view.y) > 0.92) continue;
      const key = `${candidate.id}:${candidate.lat.toFixed(6)}:${candidate.lon.toFixed(6)}`;
      if (!prepared.some(anchor => anchor.key === key)) prepared.push({ candidate, key, p, view });
    }
    const screenShift = (cached: SurfaceHit, view: THREE.Vector3) => Math.hypot(
      (cached.projectedAnchor.x - view.x) * width / 2, (cached.projectedAnchor.y - view.y) * height / 2);
    if (targets.length) {
      const eligibleKeys = new Set(prepared.map(anchor => anchor.key));
      for (const key of this.cachedHits.keys()) if (!eligibleKeys.has(key)) this.cachedHits.delete(key);
      // Refresh existing annotations first, oldest check first. A 32 ms minimum
      // refresh interval also leaves budget for discovering new anchors while
      // navigating. Deferred results expire after 150 ms or an 8 CSS-pixel move.
      const pending = prepared.filter(({ candidate, key, view }) => {
        const label = this.labels.get(candidate.id);
        // Alternative positions on an already annotated line need no queries
        // while its preferred anchor remains visible.
        if (label?.sprite.visible && (label.anchor.lat !== candidate.lat || label.anchor.lon !== candidate.lon)) return false;
        const cached = this.cachedHits.get(key);
        return !cached || now - cached.time >= 150 || screenShift(cached, view) > 8
          || (now - cached.time >= 32 && !cached.projectedAnchor.equals(view));
      }).sort((a, b) => {
        const visible = (anchor: Anchor) => {
          const label = this.labels.get(anchor.id);
          return label?.sprite.visible && label.anchor.lat === anchor.lat && label.anchor.lon === anchor.lon ? 1 : 0;
        };
        return visible(b.candidate) - visible(a.candidate)
          || (this.cachedHits.get(a.key)?.time ?? -1) - (this.cachedHits.get(b.key)?.time ?? -1);
      });
      for (const { key, view } of pending.slice(0, 8)) {
        this.raycaster.setFromCamera(new THREE.Vector2(view.x, view.y), camera);
        const intersections = this.raycaster.intersectObjects(targets, true);
        // The local overlay pass clears depth, matching Point Probe precedence.
        const intersection = intersections.find(hit => {
          let object: THREE.Object3D | null = hit.object;
          while (object) { if (overlayTargets.has(object)) return true; object = object.parent; }
          return false;
        }) ?? intersections[0];
        this.cachedHits.set(key, { point: intersection?.point.clone().applyMatrix4(this.bodyFromWorld) ?? null,
          projectedAnchor: view.clone(), time: now });
      }
    }
    for (const { candidate, key, p, view } of prepared) {
      if (active.size >= MAX_LABELS) break;
      if (active.has(candidate.id)) continue;
      // Surface-anchor visibility, using actual rendered geometry, including terrain ridges.
      let hit: { point: THREE.Vector3; distance: number } | undefined;
      if (targets.length) {
        const cached = this.cachedHits.get(key);
        if (!cached || now - cached.time >= 150 || screenShift(cached, view) > 8) continue;
        if (cached.point) {
          const point = cached.point.clone().applyMatrix4(this.toWorld);
          hit = { point, distance: camera.position.distanceTo(point) };
        }
      }
      const registeredTerrain = !this.bm.mesh.visible || !!this.bm.body.geometryData?.displacementMap || this.bm.getSurfaceOverlays().some(o => o.group.visible);
      if (registeredTerrain && !hit) continue;
      let fixed: THREE.Vector3;
      let coordinate: { latDeg: number; lonDeg: number };
      if (registeredTerrain) {
        fixed = hit!.point.clone().applyMatrix4(this.bodyFromWorld);
        coordinate = bodyFixedToSurfacePosition({ xKm: fixed.x, yKm: fixed.y, zKm: fixed.z }, this.coordinates);
        if (p.distanceTo(hit!.point) > this.bm.displayRadius * this.bm.scaleFactor * 0.05) continue;
      } else {
        // Analytic reference visibility avoids traversing thousands of sphere triangles per label.
        const front = this.referenceHit(view.x, view.y, camera);
        if (!front || Math.abs(front.latDeg - candidate.lat) > 0.001 || Math.abs(wrapLongitude(front.lonDeg - candidate.lon)) > 0.001) continue;
        if (hit && hit.distance < camera.position.distanceTo(p) - this.bm.scaleFactor * 0.001) continue;
        coordinate = front;
        fixed = p.clone().applyMatrix4(this.bodyFromWorld);
      }
      const difference = candidate.axis === 'latitude' ? Math.abs(coordinate.latDeg - candidate.angle) : Math.abs(wrapLongitude(coordinate.lonDeg - candidate.angle));
      const step = candidate.axis === 'latitude' ? this.uniforms.uGridStep.value.x : this.uniforms.uGridStep.value.y;
      // Reject far-side and tangent hits: the annotation must remain associated with its line.
      if (difference > step * 0.015) continue;
      const text = formatSurfaceAngle(candidate.angle, candidate.axis, step);
      const labelWidth = text.length * 7 + 8;
      const x = (view.x + 1) * width / 2, y = (1 - view.y) * height / 2;
      const rect = { x0: x - labelWidth / 2 - 3, x1: x + labelWidth / 2 + 3, y0: y - 10, y1: y + 10 };
      if (!manager.reserveContextRect(rect)) continue;
      let label = this.labels.get(candidate.id);
      if (label && label.text !== text) { this.disposeLabel(label); this.labels.delete(candidate.id); label = undefined; }
      if (!label) {
        if (this.labels.size >= MAX_LABELS) {
          const old = [...this.labels.keys()].find(id => !active.has(id));
          if (old) { this.disposeLabel(this.labels.get(old)!); this.labels.delete(old); }
        }
        label = this.createLabel(candidate, text, labelWidth, dpr);
        this.labels.set(candidate.id, label);
      }
      label.anchor = candidate;
      label.sprite.position.copy(fixed);
      // Non-attenuated sprites are sized in camera plane units; parent km scaling is compensated.
      const unitsPerPixel = 2 * Math.tan(camera.fov * DEG / 2) / height / this.bm.scaleFactor;
      label.sprite.scale.set(labelWidth * unitsPerPixel, 20 * unitsPerPixel, 1);
      label.sprite.visible = true;
      label.sprite.material.opacity = Math.min(0.85, label.sprite.material.opacity + dt * 5);
      active.add(candidate.id);
    }
    for (const [id, label] of this.labels) if (!active.has(id)) label.sprite.visible = false;
  }
  private createLabel(anchor: Anchor, text: string, width: number, dpr: number): Label {
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * dpr * 2); canvas.height = Math.ceil(20 * dpr * 2);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr * 2, dpr * 2);
    ctx.font = '12px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = '#101725'; ctx.strokeText(text, width / 2, 10);
    ctx.fillStyle = anchor.angle === 0 ? (anchor.axis === 'latitude' ? '#eeb76a' : '#ee8982') : '#aac5e8';
    ctx.fillText(text, width / 2, 10);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true,
      // Like body labels, annotation rectangles use CPU anchor occlusion instead of
      // cutting the billboard's glyphs against the curved surface's depth buffer.
      depthTest: false, depthWrite: false, sizeAttenuation: false, opacity: 0 }));
    this.group.add(sprite);
    return { sprite, anchor, text, width };
  }
  get metrics(): { candidates: number; labels: number; latitudeStep: number; longitudeStep: number } {
    return { candidates: this.candidates.length, labels: [...this.labels.values()].filter(l => l.sprite.visible).length,
      latitudeStep: this.uniforms.uGridStep.value.x, longitudeStep: this.uniforms.uGridStep.value.y };
  }
  private disposeLabel(label: Label): void { label.sprite.removeFromParent(); label.sprite.material.map?.dispose(); label.sprite.material.dispose(); }
  private clearLabels(): void { for (const l of this.labels.values()) this.disposeLabel(l); this.labels.clear(); }
  dispose(): void { this.clearLabels(); this.group.removeFromParent(); }
}
