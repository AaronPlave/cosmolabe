import { geodeticToBodyFixed, PLACE_LIMIT, PlaceIndex, type Place, type Universe } from '@cosmolabe/core';
import { Vector3, type PerspectiveCamera } from 'three';
import type { BodyMesh } from '../BodyMesh.js';
import type { ScreenRect } from '../EventCallout.js';
import { AnnotationBudget, PersistentLabels, type LabelCandidate } from '../annotations/PersistentLabels.js';
import type { GeographicFeatureRef } from './GeographicIndex.js';
import { placeAnchor } from './PlaceSurface.js';

export function placeLabelBox(x: number, y: number, textWidth: number, fontSize = 12): ScreenRect {
  // Centered on the geographic anchor, with a consistent text baseline.
  const half = Math.min(272, textWidth) / 2;
  return { x0: x - half - 3, y0: y - fontSize / 2 - 3, x1: x + half + 3, y1: y + fontSize / 2 + 3 };
}
interface Projection extends LabelCandidate {
  place: Place;
  world: Vector3;
  source: 'source-height' | 'terrain-sample' | 'reference-shape';
  font: number;
}
interface Visibility { anchor: NonNullable<ReturnType<typeof placeAnchor>>; eye: Vector3; point: Vector3; hidden: boolean; at: number }

/** Text-only cartographic annotations over the existing scientific features.
 * Cheap projection covers every relevant indexed point before admission; only
 * 512 projected candidates, 32 placements and 2ms scheduled LOS work survive. */
export class PlaceNames {
  index: PlaceIndex;
  selectedRef: string | null = null;
  readonly bodies = new Set<string>();
  readonly hiddenLayers = new Set<string>();
  metrics = { scanned: 0, candidates: 0, drawn: 0, terrain: 0, reference: 0, cpuMs: 0, enters: 0, exits: 0, losChecks: 0, losDeferred: 0, handoffs: 0 };
  indexBuildMs = 0;
  private drawn: Array<{ place: Place; box: ScreenRect }> = [];
  private readonly labels = new Map<string, HTMLDivElement>();
  private readonly layout = new PersistentLabels();
  private readonly text = document.createElement('canvas').getContext('2d');
  private readonly widths = new Map<string, number>();
  private readonly visibility = new Map<string, Visibility>();
  private readonly anchors = new Map<string, { offset: Vector3; normal: Vector3 }>();
  private readonly unsubscribe: () => void;

  constructor(universe: Universe, private readonly container: HTMLElement) {
    this.index = new PlaceIndex([]);
    const rebuild = () => {
      const start = performance.now();
      this.index = new PlaceIndex(universe.geographicLayers.layers);
      this.widths.clear(); this.visibility.clear(); this.anchors.clear(); this.layout.clear();
      for (const place of this.index.places) {
        if (place.feature.geometry.type !== 'Point') continue;
        const pos = place.feature.geometry.coordinates, p = geodeticToBodyFixed(pos, place.layer.datum);
        const lat = pos.latDeg * Math.PI / 180, lon = pos.lonDeg * Math.PI / 180;
        this.anchors.set(place.ref, { offset: new Vector3(p.xKm, p.zKm, -p.yKm), normal: new Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)) });
      }
      this.indexBuildMs = performance.now() - start;
      if (this.selectedRef && !this.index.byRef.has(this.selectedRef)) this.selectedRef = null;
    };
    rebuild(); this.unsubscribe = universe.events.on('geographic:changed', rebuild);
  }
  setBodyVisible(body: string, visible: boolean): void { if (visible) this.bodies.add(body); else this.bodies.delete(body); }
  pick(x: number, y: number): GeographicFeatureRef | null {
    const hit = this.drawn.find(({ box }) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1);
    return hit ? { layerId: hit.place.layer.id, featureId: hit.place.feature.id, bodyName: hit.place.layer.body } : null;
  }
  getScreenRects(): ScreenRect[] { return this.drawn.map(d => d.box); }

  update(camera: PerspectiveCamera, meshes: ReadonlyMap<string, BodyMesh>, scale: number, width: number, height: number,
    obstacles: readonly ScreenRect[], occluded: (world: Vector3) => boolean): void {
    const start = performance.now();
    this.metrics = { scanned: 0, candidates: 0, drawn: 0, terrain: 0, reference: 0, cpuMs: 0, enters: this.layout.enters, exits: this.layout.exits, losChecks: 0, losDeferred: 0, handoffs: 0 };
    const candidates: Projection[] = [];
    const invalidated = new Set<string>();
    const focalPixels = height / (2 * Math.tan(camera.fov * Math.PI / 360));
    const selected = this.selectedRef ? this.index.byRef.get(this.selectedRef) : undefined;
    const names = new Set(this.bodies);
    if (selected) names.add(selected.layer.body);
    for (const name of [...names].sort()) {
      const body = meshes.get(name);
      if (!body?.visible) continue;
      const eye = camera.position.clone().sub(body.position).applyQuaternion(body.mesh.quaternion.clone().invert());
      const lat = Math.atan2(eye.y, Math.hypot(eye.x, eye.z)) * 180 / Math.PI;
      const lon = Math.atan2(-eye.z, eye.x) * 180 / Math.PI;
      const ratio = eye.length() / (body.displayRadius * scale);
      const angle = Math.min(100, Math.max(.1, Math.acos(Math.min(1, 1 / Math.max(1, ratio))) * 180 / Math.PI * 1.5));
      const region = this.bodies.has(name) ? this.index.nearby(name, lon, lat, angle, PLACE_LIMIT) : [];
      // Retained IDs bypass regional and candidate admission limits so ordinary
      // scale/frustum exits can transition using a freshly projected anchor.
      for (const id of this.layout.states.keys()) {
        const retained = this.index.byRef.get(id);
        if (retained?.layer.body === name && !region.includes(retained)) region.push(retained);
      }
      if (selected?.layer.body === name && !region.includes(selected)) region.push(selected);
      for (const place of region) {
        this.metrics.scanned++;
        if (place !== selected && (!this.bodies.has(name) || this.hiddenLayers.has(place.layer.id))) { invalidated.add(place.ref); continue; }
        const cached = this.anchors.get(place.ref);
        if (!cached) continue;
        const normal = cached.normal.clone().applyQuaternion(body.mesh.quaternion);
        const world = cached.offset.clone().multiplyScalar(scale).applyQuaternion(body.mesh.quaternion).add(body.position);
        const view = camera.position.clone().sub(world);
        // Full physical disk, independent of Sun lighting. Ellipsoid normals
        // are geodetic, not radial. Hide immediately on a proven backside.
        if (normal.dot(view) <= 0) { invalidated.add(place.ref); continue; }
        const p = world.clone().project(camera);
        if (p.z < -1 || p.z > 1) { invalidated.add(place.ref); continue; }
        const inViewport = Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1;
        if (!inViewport && !this.layout.states.has(place.ref)) continue;
        const depth = -world.clone().applyMatrix4(camera.matrixWorldInverse).z;
        const extent = place.diameterKm ?? body.displayRadius * .005;
        const apparent = extent * scale * focalPixels / Math.max(1e-12, depth);
        let eligibility = place === selected ? 10 : apparent / place.label.minPixels;
        if (eligibility < .75) {
          // Still project a retained label while it fades at the exit threshold.
          if (!this.layout.states.has(place.ref)) continue;
        }
        const font = place === selected ? 14 : place.label.class === 'major' ? 13 : 12;
        const key = `${place.ref}:${font}`;
        let textWidth = this.widths.get(key);
        if (textWidth === undefined) {
          if (this.text) this.text.font = `${font}px system-ui, sans-serif`;
          textWidth = this.text?.measureText(place.name).width ?? place.name.length * font * .6;
          this.widths.set(key, textWidth);
        }
        const box = placeLabelBox((p.x + 1) * width / 2, (1 - p.y) * height / 2, textWidth, font);
        if (box.x0 < 8 || box.x1 > width - 8 || box.y0 < 8 || box.y1 > height - 8) {
          if (!this.layout.states.has(place.ref)) continue;
          eligibility = 0;
        }
        candidates.push({ id: place.ref, place, world, source: 'reference-shape', font, box, selected: place === selected,
          eligibility, priority: place.label.importance + Math.min(6, Math.log2(Math.max(1, apparent))) });
      }
    }
    // Projection/eligibility precede the cap. No cell quota can starve a major
    // visible feature behind a dense catalog cell or the invisible hemisphere.
    candidates.sort((a,b) => Number(!!b.selected) - Number(!!a.selected)
      || (b.priority + (this.layout.states.get(b.id)?.accepted ? 8 : 0)) - (a.priority + (this.layout.states.get(a.id)?.accepted ? 8 : 0)) || a.id.localeCompare(b.id));
    const retained = candidates.filter(p => this.layout.states.has(p.id));
    const retainedIds = new Set(retained.map(p => p.id));
    const projected = [...retained, ...candidates.filter(p => !retainedIds.has(p.id)).slice(0, 512 - retained.length)];
    for (const id of this.layout.states.keys()) if (!candidates.some(p => p.id === id)) invalidated.add(id);
    this.metrics.candidates = projected.length;
    const budget = new AnnotationBudget(2);
    // Oldest result first guarantees refresh progress during continuous motion.
    const scheduled = [...projected].sort((a,b) => Number(!!b.selected) - Number(!!a.selected)
      || Number(!!this.layout.states.get(b.id)?.accepted) - Number(!!this.layout.states.get(a.id)?.accepted)
      || (this.visibility.get(a.id)?.at ?? -Infinity) - (this.visibility.get(b.id)?.at ?? -Infinity) || b.priority - a.priority);
    for (const p of scheduled) {
      const body = meshes.get(p.place.layer.body)!;
      const los = this.visibility.get(p.id);
      const tolerance = Math.max(1e-10, camera.position.distanceTo(p.world) * .002);
      const due = !los || start - los.at >= 200 || los.eye.distanceTo(camera.position) > tolerance || los.point.distanceTo(p.world) > tolerance * .1;
      if (due) {
        const result = budget.run(() => {
          const anchor = placeAnchor(p.place, body);
          if (!anchor) return null;
          const world = anchor.offsetKm.clone().multiplyScalar(scale).applyQuaternion(body.mesh.quaternion).add(body.position);
          return { anchor, eye: camera.position.clone(), point: world, hidden: occluded(world), at: start };
        });
        if (result) {
          if (result.value) this.visibility.set(p.id, result.value);
          else { this.visibility.delete(p.id); invalidated.add(p.id); }
          this.metrics.losChecks++;
        } else this.metrics.losDeferred++;
      }
      const checked = this.visibility.get(p.id);
      if (!checked) continue;
      p.source = checked.anchor.source;
      p.world.copy(checked.anchor.offsetKm).multiplyScalar(scale).applyQuaternion(body.mesh.quaternion).add(body.position);
      // Refinement can move a point. Cheap projection still runs every frame,
      // using the last completed physical sample if expensive work is deferred.
      const screen = p.world.clone().project(camera);
      const cx = (p.box.x0 + p.box.x1) / 2, cy = (p.box.y0 + p.box.y1) / 2;
      const dx = (screen.x + 1) * width / 2 - cx, dy = (1 - screen.y) * height / 2 - cy;
      p.box = { x0:p.box.x0+dx, x1:p.box.x1+dx, y0:p.box.y0+dy, y1:p.box.y1+dy };
    }
    for (const p of projected) if (this.visibility.get(p.id)?.hidden) invalidated.add(p.id);
    const visible = projected.filter(p => this.visibility.get(p.id)?.hidden === false);
    // Area-aware spacing: sparse at a whole globe, progressively more at a
    // regional/surface view. This is a layout clearance, not a source footprint.
    const layoutCandidates = visible.map(p => {
      const body = meshes.get(p.place.layer.body)!;
      const disk = body.displayRadius * scale * focalPixels / Math.max(1e-12, camera.position.distanceTo(body.position));
      const spacing = p.selected ? 6 : Math.max(12, Math.min(100, 45000 / Math.max(200, disk)));
      const gap = Math.max(12, spacing * .25);
      return { ...p, entryBox: { x0:p.box.x0-spacing-gap, x1:p.box.x1+spacing+gap, y0:p.box.y0-spacing*.45-gap, y1:p.box.y1+spacing*.45+gap }, box: { x0: p.box.x0-spacing, x1:p.box.x1+spacing, y0:p.box.y0-spacing*.45, y1:p.box.y1+spacing*.45 } };
    });
    const states = this.layout.update(layoutCandidates, obstacles, start, invalidated);
    this.drawn = [];
    const alive = new Set<string>();
    const byId = new Map(visible.map(p => [p.id,p]));
    for (const state of states) {
      const p = byId.get(state.id)!;
      alive.add(p.id);
      let el = this.labels.get(p.id);
      if (!el) {
        el = document.createElement('div'); el.className = 'cl-place-name';
        el.style.cssText = 'position:absolute;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px;font-family:system-ui,sans-serif;line-height:1;letter-spacing:.02em;pointer-events:none;text-shadow:-1px -1px 1px #10151bed,1px -1px 1px #10151bed,-1px 1px 1px #10151bed,1px 1px 1px #10151bed,0 0 3px #000';
        el.textContent = p.place.name; el.dataset.placeRef = p.id;
        this.container.appendChild(el); this.labels.set(p.id, el);
      }
      el.style.display = 'block'; el.style.left = `${p.box.x0 + 3}px`; el.style.top = `${p.box.y0 + 3}px`;
      el.style.fontSize = `${p.font}px`; el.style.fontWeight = p.selected ? '600' : '400';
      el.style.color = p.selected ? '#ffe2a6' : p.place.label.class === 'major' ? '#e4e5df' : '#cbd0d0';
      el.style.opacity = String(state.opacity * (p.selected ? 1 : .85));
      el.dataset.accepted = String(state.accepted);
      el.dataset.anchor = p.source; el.dataset.labelClass = p.place.label.class;
      if (state.accepted && state.opacity >= .5) this.drawn.push({ place:p.place, box:p.box });
      this.metrics[p.source === 'terrain-sample' ? 'terrain' : 'reference']++;
    }
    for (const [id,el] of this.labels) if (!alive.has(id)) { el.remove(); this.labels.delete(id); }
    const projectedIds = new Set(projected.map(p => p.id));
    for (const id of this.visibility.keys()) if (!projectedIds.has(id)) this.visibility.delete(id);
    this.metrics.drawn = this.drawn.length;
    this.metrics.handoffs = this.layout.handoffs;
    this.metrics.enters = this.layout.enters; this.metrics.exits = this.layout.exits;
    this.metrics.cpuMs = performance.now() - start;
  }
  dispose(): void { this.unsubscribe(); for (const label of this.labels.values()) label.remove(); this.labels.clear(); this.layout.clear(); }
}
