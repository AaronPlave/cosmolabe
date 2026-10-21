import { PlaceIndex, type Place, type Universe } from '@cosmolabe/core';
import { Vector3, type PerspectiveCamera } from 'three';
import type { BodyMesh } from '../BodyMesh.js';
import type { ScreenRect } from '../EventCallout.js';
import type { GeographicFeatureRef } from './GeographicIndex.js';
import { placeAnchor } from './PlaceSurface.js';

const overlaps = (a: ScreenRect, b: ScreenRect) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
export function placeLabelBox(x: number, y: number, textWidth: number): ScreenRect {
  return { x0: x + 6, y0: y - 9, x1: x + 16 + Math.min(272, textWidth), y1: y + 11 };
}

/** Optional annotation view over the shared imported feature index. At most
 * 512 spatial candidates/body, 32 DOM labels and 2ms of LOS work per frame.
 * Text is always textContent, including untrusted mission/user names. */
export class PlaceNames {
  index: PlaceIndex;
  selectedRef: string | null = null;
  readonly bodies = new Set<string>();
  readonly hiddenLayers = new Set<string>();
  metrics = { candidates: 0, drawn: 0, terrain: 0, reference: 0, cpuMs: 0 };
  indexBuildMs = 0;
  private drawn: Array<{ place: Place; box: ScreenRect }> = [];
  private labels: HTMLDivElement[] = [];
  private readonly text = document.createElement('canvas').getContext('2d');
  private readonly widths = new Map<string, number>();
  private readonly visibility = new Map<string, { eye: Vector3; point: Vector3; hidden: boolean; at: number }>();
  private readonly unsubscribe: () => void;

  constructor(universe: Universe, private readonly container: HTMLElement) {
    const start = performance.now();
    this.index = new PlaceIndex(universe.geographicLayers.layers);
    this.indexBuildMs = performance.now() - start;
    this.unsubscribe = universe.events.on('geographic:changed', () => {
      const start = performance.now();
      this.index = new PlaceIndex(universe.geographicLayers.layers);
      this.widths.clear(); this.visibility.clear();
      this.indexBuildMs = performance.now() - start;
      if (this.selectedRef && !this.index.byRef.has(this.selectedRef)) this.selectedRef = null;
    });
  }
  setBodyVisible(body: string, visible: boolean): void { if (visible) this.bodies.add(body); else this.bodies.delete(body); }
  pick(x: number, y: number): GeographicFeatureRef | null {
    const hit = this.drawn.find(({ box }) => x >= box.x0 - 5 && x <= box.x1 && y >= box.y0 && y <= box.y1);
    return hit ? { layerId: hit.place.layer.id, featureId: hit.place.feature.id, bodyName: hit.place.layer.body } : null;
  }
  getScreenRects(): ScreenRect[] { return this.drawn.map(d => d.box); }

  update(camera: PerspectiveCamera, meshes: ReadonlyMap<string, BodyMesh>, scale: number, width: number, height: number,
    obstacles: readonly ScreenRect[], occluded: (world: Vector3) => boolean): void {
    const start = performance.now();
    const occupied = [...obstacles];
    this.drawn = [];
    this.metrics = { candidates: 0, drawn: 0, terrain: 0, reference: 0, cpuMs: 0 };
    const candidates: Place[] = [];
    for (const name of this.bodies) {
      const body = meshes.get(name);
      if (!body?.visible) continue;
      const eye = camera.position.clone().sub(body.position).applyQuaternion(body.mesh.quaternion.clone().invert());
      const lat = Math.atan2(eye.y, Math.hypot(eye.x, eye.z)) * 180 / Math.PI;
      const lon = Math.atan2(-eye.z, eye.x) * 180 / Math.PI;
      const ratio = eye.length() / (body.displayRadius * scale);
      const angle = Math.min(100, Math.max(0.1, Math.acos(Math.min(1, 1 / Math.max(1, ratio))) * 180 / Math.PI * 1.5));
      candidates.push(...this.index.nearby(name, lon, lat, angle));
    }
    const selected = this.selectedRef ? this.index.byRef.get(this.selectedRef) : undefined;
    if (selected) candidates.unshift(selected);
    const seen = new Set<string>();
    const deadline = performance.now() + 2;
    for (const place of candidates) {
      if (this.drawn.length >= 32) break;
      if (seen.has(place.ref) || (place !== selected && this.hiddenLayers.has(place.layer.id))) continue;
      seen.add(place.ref); this.metrics.candidates++;
      const body = meshes.get(place.layer.body);
      if (!body?.visible) continue;
      const anchor = placeAnchor(place, body);
      if (!anchor) continue;
      const offset = anchor.offsetKm.clone().multiplyScalar(scale).applyQuaternion(body.mesh.quaternion);
      const world = offset.clone().add(body.position);
      if (offset.dot(camera.position.clone().sub(world)) <= 0) continue;
      const p = world.clone().project(camera);
      if (p.z < -1 || p.z > 1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) continue;
      const x = (p.x + 1) * width / 2, y = (1 - p.y) * height / 2;
      let textWidth = this.widths.get(place.ref);
      if (textWidth === undefined) {
        if (this.text) this.text.font = '12px sans-serif';
        textWidth = this.text?.measureText(place.name).width ?? place.name.length * 12;
        this.widths.set(place.ref, textWidth);
      }
      const box = placeLabelBox(x, y, textWidth);
      if (box.x1 > width - 8 || box.y0 < 8 || box.y1 > height - 8 || occupied.some(r => overlaps(r, box))) continue;
      // Unknown LOS under budget pressure is hidden, never drawn through a ridge.
      let los = this.visibility.get(place.ref);
      if (!los || !los.eye.equals(camera.position) || !los.point.equals(world) || performance.now() - los.at > 250) {
        if (performance.now() > deadline) continue;
        los = { eye: camera.position.clone(), point: world.clone(), hidden: occluded(world), at: performance.now() };
        this.visibility.set(place.ref, los);
      }
      if (los.hidden) continue;
      occupied.push(box); this.drawn.push({ place, box });
      const i = this.drawn.length - 1;
      if (!this.labels[i]) {
        const label = document.createElement('div');
        label.className = 'cl-place-name';
        label.style.cssText = 'position:absolute;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px;font:12px sans-serif;padding:2px 4px;border-radius:3px;background:#101923bb;color:#dce6ed;pointer-events:none';
        this.container.appendChild(label); this.labels.push(label);
      }
      const el = this.labels[i];
      el.textContent = place.name;
      el.style.display = 'block'; el.style.left = `${box.x0}px`; el.style.top = `${box.y0}px`;
      el.style.color = place === selected ? '#ffd17a' : '#dce6ed';
      el.dataset.placeRef = place.ref;
      el.dataset.anchor = anchor.source;
      this.metrics[anchor.source === 'terrain-sample' ? 'terrain' : 'reference']++;
    }
    for (let i = this.drawn.length; i < this.labels.length; i++) this.labels[i].style.display = 'none';
    this.metrics.drawn = this.drawn.length;
    this.metrics.cpuMs = performance.now() - start;
  }

  dispose(): void { this.unsubscribe(); for (const label of this.labels) label.remove(); this.labels = []; }
}
