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
type Edge = 'left' | 'right' | 'bottom' | 'top';
interface Anchor { id: string; axis: 'latitude' | 'longitude'; angle: number; lat: number; lon: number; score: number; edge?: Edge; }
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
  private layout: 'globe' | 'regional' = 'globe';
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
    const samples: Array<{ latDeg: number; lonDeg: number; heightKm: number }> = [];
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
    const latStep = this.settings?.density === 'manual' ? this.settings.spacingDeg : chooseGridStep(median(latScale), previous.x);
    const lonStep = this.settings?.density === 'manual' ? this.settings.spacingDeg : chooseGridStep(median(lonScale), previous.y);
    if (latStep !== previous.x || lonStep !== previous.y) {
      this.uniforms.uGridPreviousStep.value.copy(previous);
      previous.set(latStep, lonStep);
      this.transition = 0;
    }
    const shape = this.coordinates.datum.referenceShape;
    const radius = shape.kind === 'sphere' ? shape.radiusKm : Math.max(...shape.radiiKm);
    const distance = cameraFixed.length();
    const disc = radius / Math.sqrt(Math.max(0, distance * distance - radius * radius)) / Math.tan(camera.fov * DEG / 2);
    this.layout = distance > radius && Math.abs(center.x) + disc / camera.aspect < 0.94 && Math.abs(center.y) + disc < 0.92 ? 'globe' : 'regional';
    const candidates: Anchor[] = [];
    const add = (axis: Anchor['axis'], angle: number, lat: number, lon: number, edge?: Edge) => {
      angle = axis === 'longitude' ? wrapLongitude(angle) : angle;
      if (Math.abs(lat) >= 89 || (axis === 'longitude' && Math.abs(lat) > 80)) return;
      const id = `${axis}:${angle.toFixed(6)}`;
      if (candidates.some(a => a.id === id)) return;
      const centerAngle = axis === 'latitude' ? foot.latDeg : foot.lonDeg;
      const difference = axis === 'latitude' ? angle - centerAngle : wrapLongitude(angle - centerAngle);
      candidates.push({ id, axis, angle, lat, lon: wrapLongitude(lon), edge,
        score: angle === 0 ? -1 : Math.abs(difference) / (axis === 'latitude' ? latStep : lonStep) });
    };
    const angles = (lo: number, hi: number, step: number) => {
      const start = Math.ceil(lo / step), end = Math.floor(hi / step);
      const stride = Math.max(1, Math.ceil((end - start + 1) / 32));
      const result: number[] = [];
      for (let i = start; i <= end; i += stride) result.push(i * step);
      if (lo <= 0 && hi >= 0 && !result.includes(0)) result.push(0);
      return result;
    };
    if (this.layout === 'globe') {
      // One meridian and one latitude band, including polar views. Collisions
      // remove annotations; they never scatter them onto another part of a line.
      const band = Math.max(-50, Math.min(50, foot.latDeg - 10));
      for (const angle of angles(-89, 89, latStep)) add('latitude', angle, angle, foot.lonDeg);
      for (const angle of angles(-180, 180, lonStep)) add('longitude', angle, band, angle);
    } else if (samples.length) {
      const edges: Edge[] = ['left', 'right', 'bottom', 'top'];
      const position = (edge: Edge, t: number): [number, number] => edge === 'left' ? [-0.82, t]
        : edge === 'right' ? [0.82, t] : edge === 'bottom' ? [t, -0.82] : [t, 0.82];
      const border = edges.map(edge => ({ edge, samples: Array.from({ length: 17 }, (_, i) => {
        const [x, y] = position(edge, -0.82 + i * 1.64 / 16);
        return { x, y, hit: this.planningHit(x, y, camera, seed) };
      }) }));
      for (const axis of ['latitude', 'longitude'] as const) {
        const scalar = (hit: { latDeg: number; lonDeg: number }) => axis === 'latitude' ? hit.latDeg : hit.lonDeg;
        const step = axis === 'latitude' ? latStep : lonStep;
        const span = (edge: typeof border[number]) => edge.samples.slice(1).reduce((sum, b, i) => {
          const a = edge.samples[i];
          return sum + (a.hit && b.hit ? Math.abs(axis === 'latitude' ? scalar(b.hit) - scalar(a.hit) : wrapLongitude(scalar(b.hit) - scalar(a.hit))) : 0);
        }, 0);
        const preferred = border[axis === 'latitude' ? 0 : 2];
        const best = border.reduce((a, b) => span(b) > span(a) ? b : a, preferred);
        const selected = span(preferred) >= span(best) * 0.75 ? preferred : best;
        for (let i = 1; i < selected.samples.length && candidates.filter(a => a.axis === axis).length < 32; i++) {
          const a = selected.samples[i - 1], b = selected.samples[i];
          if (!a.hit || !b.hit) continue;
          const start = scalar(a.hit);
          const end = start + (axis === 'latitude' ? scalar(b.hit) - start : wrapLongitude(scalar(b.hit) - start));
          for (const angle of angles(Math.min(start, end), Math.max(start, end), step)) {
            let lo = a, hi = b;
            for (let j = 0; j < 7; j++) {
              const x = (lo.x + hi.x) / 2, y = (lo.y + hi.y) / 2;
              const hit = this.planningHit(x, y, camera, seed);
              if (!hit) break;
              const value = axis === 'latitude' ? hit.latDeg : start + wrapLongitude(hit.lonDeg - start);
              const mid = { x, y, hit };
              if ((value < angle) === (start < end)) lo = mid; else hi = mid;
            }
            const hit = this.planningHit((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, camera, seed);
            if (hit) add(axis, angle, axis === 'latitude' ? angle : hit.latDeg, axis === 'longitude' ? angle : hit.lonDeg, selected.edge);
          }
        }
      }
    }
    // Candidate generation depends on the current pose and spacing, not retained
    // anchors from the route taken to reach it. A settled pose has one layout.
    this.candidates = candidates.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id)).slice(0, MAX_CANDIDATES);
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
      const key = `${candidate.id}:${candidate.edge ?? this.layout}`;
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
      const pending = prepared.filter(({ key, view }) => {
        const cached = this.cachedHits.get(key);
        return !cached || now - cached.time >= 150 || screenShift(cached, view) > 8
          || (now - cached.time >= 32 && !cached.projectedAnchor.equals(view));
      }).sort((a, b) => {
        const visible = (anchor: Anchor) => {
          const label = this.labels.get(anchor.id);
          return label?.sprite.visible && label.anchor.edge === anchor.edge ? 1 : 0;
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
      const text = candidate.angle === 0 ? (candidate.axis === 'latitude' ? 'Equator 0°' : 'Prime 0°') : formatSurfaceAngle(candidate.angle, candidate.axis, step);
      const labelWidth = text.length * 7 + 8;
      const offsetX = candidate.edge === 'left' ? 8 : candidate.edge === 'right' ? -8 : 0;
      const offsetY = candidate.edge === 'top' ? 8 : candidate.edge === 'bottom' ? -8 : 0;
      const x = (view.x + 1) * width / 2 + offsetX, y = (1 - view.y) * height / 2 + offsetY;
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
      label.sprite.center.set(0.5 - offsetX / labelWidth, 0.5 + offsetY / 20);
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
  get metrics(): { candidates: number; labels: number; latitudeStep: number; longitudeStep: number; layout: 'globe' | 'regional';
    annotations: Array<{ axis: Anchor['axis']; latDeg: number; lonDeg: number; text: string; edge?: Edge }> } {
    return { candidates: this.candidates.length, labels: [...this.labels.values()].filter(l => l.sprite.visible).length,
      latitudeStep: this.uniforms.uGridStep.value.x, longitudeStep: this.uniforms.uGridStep.value.y, layout: this.layout,
      annotations: [...this.labels.values()].filter(l => l.sprite.visible).map(l => ({ axis: l.anchor.axis,
        latDeg: l.anchor.lat, lonDeg: l.anchor.lon, text: l.text, edge: l.anchor.edge })) };
  }
  private disposeLabel(label: Label): void { label.sprite.removeFromParent(); label.sprite.material.map?.dispose(); label.sprite.material.dispose(); }
  private clearLabels(): void { for (const l of this.labels.values()) this.disposeLabel(l); this.labels.clear(); }
  dispose(): void { this.clearLabels(); this.group.removeFromParent(); }
}
