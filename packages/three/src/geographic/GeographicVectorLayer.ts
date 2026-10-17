import * as THREE from 'three';
import { bodyFixedToGeodetic, geodeticToBodyFixed, isSupportedGeodeticDatum, wrapLon,
  type GeographicLayer, type BodyFixedPosition, type Universe } from '@cosmolabe/core';
import type { BodyMesh } from '../BodyMesh.js';
import type { SurfacePoint } from '../SceneHit.js';
import { GeographicIndex, type GeographicFeatureRef, type GeographicRenderDiagnostic } from './GeographicIndex.js';
import { GeographicMaterial } from './GeographicMaterial.js';

export type GeographicPlacement =
  | { mode: 'clamp' }
  | { mode: 'terrain-relative'; offsetKm: number }
  /** Reserved: diagnosed and omitted until an error-bounded surface exists. */
  | { mode: 'body-fixed-height'; heightKm: number };

interface Batch {
  layers: GeographicLayer[];
  index: GeographicIndex;
  material: GeographicMaterial;
  placement: GeographicPlacement;
  datum: GeographicLayer['datum'];
  bodyName: string;
  proxies: Map<THREE.Mesh, Proxy>;
}
interface Proxy {
  mesh: THREE.Mesh;
  sourceGeometry: THREE.BufferGeometry;
  localToBody: THREE.Matrix4;
  worldMatrix: THREE.Matrix4;
  owned: boolean;
  seen: boolean;
}
export interface GeographicVectorStatus {
  bodyName: string;
  layerIds: string[];
  features: number;
  primitives: number;
  /** Body-wide rendering mode; does not assert coverage at any feature. */
  bodySurfaceMode: 'reference-globe' | 'terrain-streaming';
  featureTerrainCoverage: 'not-assessed';
  /** This describes the drawing, never a source's scientific height accuracy. */
  accuracy: 'rendered-triangles; source uncertainty unknown';
}
const MAX_BATCHES = 16;
const MAX_OFFSET_VERTICES = 250_000;
const MAX_SURFACE_MESHES = 2048;

function positions(g: GeographicLayer['features'][number]['geometry']): BodyFixedPosition[] {
  switch (g.type) {
    case 'Point': return [g.coordinates];
    case 'MultiPoint': case 'LineString': return g.coordinates;
    case 'MultiLineString': case 'Polygon': return g.coordinates.flat();
    case 'MultiPolygon': return g.coordinates.flat(2);
  }
}
const sameShape = (a: GeographicLayer['datum'], b: GeographicLayer['datum']) => JSON.stringify(a.referenceShape) === JSON.stringify(b.referenceShape);
const sameTransform = (a: THREE.Matrix4, b: THREE.Matrix4) => a.elements.every((v, i) => Math.abs(v - b.elements[i]) <= 1e-8 * Math.max(1, Math.abs(v)));
export const sameGeographicFeature = (a: GeographicFeatureRef | null, b: GeographicFeatureRef | null): boolean =>
  a === b || (!!a && !!b && a.layerId === b.layerId && a.featureId === b.featureId && a.bodyName === b.bodyName);

/** Owns only vector textures/materials and projected proxy objects. Source
 * geometry, terrain residency, imagery and surface appearance remain owned by
 * their existing renderers. No object, worker or draw call per feature. */
export class GeographicVectorLayer {
  private readonly scene = new THREE.Scene();
  private batches: Batch[] = [];
  private dirty = true;
  private readonly unsubscribe: () => void;
  private readonly placements = new Map<string, GeographicPlacement>();
  private readonly visibility = new Map<string, boolean>();
  private selected: GeographicFeatureRef | null = null;
  private hovered: GeographicFeatureRef | null = null;
  private _diagnostics: GeographicRenderDiagnostic[] = [];
  private _status: GeographicVectorStatus[] = [];
  private offsetVertices = 0;
  private proxyCount = 0;

  constructor(private readonly universe: Universe, private readonly scaleFactor: number) {
    this.unsubscribe = universe.events.on('geographic:changed', () => { this.dirty = true; });
  }
  get diagnostics(): readonly GeographicRenderDiagnostic[] { return this._diagnostics; }
  get status(): readonly GeographicVectorStatus[] { return this._status; }
  get featureCount(): number { return this.batches.reduce((n, b) => n + b.index.features.length, 0); }
  get metrics(): { batches: number; surfaceMeshes: number; offsetVertices: number; textureBytes: number } {
    return { batches: this.batches.length, surfaceMeshes: this.proxyCount, offsetVertices: this.offsetVertices,
      textureBytes: this.batches.reduce((n, b) => n + b.material.textures.reduce((sum, t) => sum + (t.image.data?.byteLength ?? 0), 0), 0) };
  }
  setVisible(layerId: string, visible: boolean): void {
    if (this.visibility.get(layerId) === visible) return;
    this.visibility.set(layerId, visible); this.dirty = true;
  }
  setPlacement(layerId: string, placement: GeographicPlacement): void {
    const height = placement.mode === 'clamp' ? 0 : placement.mode === 'terrain-relative' ? placement.offsetKm : placement.heightKm;
    if (!Number.isFinite(height)) throw new Error('Geographic placement height must be finite kilometres');
    if (JSON.stringify(this.placements.get(layerId)) === JSON.stringify(placement)) return;
    this.placements.set(layerId, { ...placement }); this.dirty = true;
  }
  setSelected(feature: GeographicFeatureRef | null): void { this.selected = feature; this.updateHighlights(); }
  setHovered(feature: GeographicFeatureRef | null): void { this.hovered = feature; this.updateHighlights(); }

  private updateHighlights(): void {
    for (const batch of this.batches) {
      const id = (feature: GeographicFeatureRef | null) => batch.index.features.findIndex(f => sameGeographicFeature(f, feature)) + 1;
      batch.material.uniforms.vectorSelected.value = id(this.selected) || -1;
      batch.material.uniforms.vectorHovered.value = id(this.hovered) || -1;
    }
  }

  private rebuild(): void {
    this.clear(); this._diagnostics = []; this._status = [];
    const groups = new Map<string, { layers: GeographicLayer[]; placement: GeographicPlacement }>();
    for (const layer of this.universe.geographicLayers.layers) {
      if (!(this.visibility.get(layer.id) ?? layer.definition.display?.visible ?? true) || layer.definition.display?.opacity === 0) continue;
      const subsets = new Map<string, { layer: GeographicLayer; placement: GeographicPlacement }>();
      for (const feature of layer.features) {
        const points = positions(feature.geometry);
        let placement = this.placements.get(layer.id);
        if (!placement) {
          const heights = points.filter(p => p.heightKm !== undefined).map(p => p.heightKm!);
          if (heights.length && (heights.length !== points.length || heights.some(h => h !== heights[0]))) {
            this._diagnostics.push({ layerId: layer.id, featureId: feature.id, code: 'unsupported-height',
              message: 'Varying or mixed vertex heights require an unattached 3D renderer. Choose an explicit layer placement to drape this feature; source coordinates are preserved.' });
            continue;
          }
          placement = heights.length ? { mode: 'body-fixed-height', heightKm: heights[0] } : { mode: 'clamp' };
        }
        if (placement.mode === 'body-fixed-height') {
          this._diagnostics.push({ layerId: layer.id, featureId: feature.id, code: 'unsupported-height',
            message: 'Absolute datum-height drawing is unavailable until its surface has a bounded height error. Choose explicit clamp or terrain-relative placement to drape this feature; source coordinates are preserved.' });
          continue;
        }
        const key = JSON.stringify(placement);
        let subset = subsets.get(key);
        if (!subset) {
          subset = { layer: { ...layer, definition: { ...layer.definition, display: { ...layer.definition.display, visible: true } }, features: [] }, placement };
          subsets.set(key, subset);
        }
        subset.layer.features.push(feature);
      }
      for (const { layer: subset, placement } of subsets.values()) {
        const key = JSON.stringify([layer.body, layer.frame, layer.datum.referenceShape, placement]);
        let group = groups.get(key);
        if (!group) {
          if (groups.size >= MAX_BATCHES) {
            this._diagnostics.push({ layerId: layer.id, code: 'vector-budget', message: `At most ${MAX_BATCHES} body/placement batches can draw at once` });
            continue;
          }
          group = { layers: [], placement }; groups.set(key, group);
        }
        group.layers.push(subset);
      }
    }
    for (const { layers, placement } of groups.values()) {
      const datum = layers[0].datum;
      const shape = datum.referenceShape;
      if (!isSupportedGeodeticDatum(datum)) continue;
      const a = shape.kind === 'sphere' ? shape.radiusKm : shape.radiiKm[0];
      const c = shape.kind === 'sphere' ? shape.radiusKm : shape.radiiKm[2];
      const index = new GeographicIndex(layers);
      this._diagnostics.push(...index.diagnostics);
      if (!index.primitives.length) continue;
      const material = new GeographicMaterial(index, a, c);
      const batch: Batch = { layers, index, material, placement, datum, bodyName: layers[0].body, proxies: new Map() };
      this.batches.push(batch);
    }
    this.updateHighlights(); this.dirty = false;
  }

  /** Start after terrain traversal has selected this frame's visible triangles. */
  begin(): void {
    if (this.dirty) this.rebuild();
    this._status = [];
    for (const b of this.batches) for (const p of b.proxies.values()) p.seen = false;
  }

  /** Draw with the SAME camera/depth state as the source surface pass. For the
   * local tile pass origin is the saved main-camera scene position. */
  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera, bodies: Iterable<BodyMesh>, overlays = false, origin = new THREE.Vector3()): void {
    if (!this.batches.length) return;
    this.scene.clear();
    const byName = new Map(Array.from(bodies, b => [b.body.name, b]));
    for (const batch of this.batches) {
      const bm = byName.get(batch.bodyName);
      if (!bm?.visible) continue;
      if (bm.body.geometryType !== 'Globe') {
        this.diagnose(batch, 'unsupported-surface', 'Geographic draping requires a globe; mesh/DSK does not expose a latitude/longitude heightfield.'); continue;
      }
      if (bm.terrainDatum && !sameShape(batch.datum, bm.terrainDatum)) {
        this.diagnose(batch, 'datum-mismatch', 'Layer and rendered terrain reference shapes differ; no implicit datum conversion is applied.'); continue;
      }
      const radii = bm.body.radii;
      if (!bm.terrainDatum && radii) {
        const shape = batch.datum.referenceShape;
        const layerRadii = shape.kind === 'sphere' ? [shape.radiusKm, shape.radiusKm, shape.radiusKm] : shape.radiiKm;
        if (layerRadii.some((r, i) => Math.abs(r - radii[i]) > 1e-8)) {
          this.diagnose(batch, 'datum-mismatch', 'Layer and reference globe shapes differ; provide the physical body datum.'); continue;
        }
      }
      const rotation = bm.bodyToWorldQuaternion(new THREE.Quaternion());
      const bodyMatrix = new THREE.Matrix4().compose(bm.position.clone().sub(origin), rotation, new THREE.Vector3().setScalar(this.scaleFactor));
      const toBody = bodyMatrix.clone().invert();
      batch.material.uniforms.vectorPixelRatio.value = renderer.getPixelRatio();
      if (!overlays) this._status.push({ bodyName: batch.bodyName, layerIds: batch.layers.map(l => l.id),
        features: batch.index.features.length, primitives: batch.index.primitives.length,
        bodySurfaceMode: bm.surfaceTransitionState === 'streamed' && !bm.isImageryOnlySurface ? 'terrain-streaming' : 'reference-globe',
        featureTerrainCoverage: 'not-assessed',
        accuracy: 'rendered-triangles; source uncertainty unknown' });
      const roots = overlays ? bm.getSurfaceOverlays().map(o => o.group) : [bm.mesh, bm.terrainTileGroup].filter((o): o is THREE.Object3D => o !== null);
      for (const root of roots) root.traverseVisible(object => {
        if (!(object instanceof THREE.Mesh) || !(object.geometry instanceof THREE.BufferGeometry)) return;
        const localToBody = toBody.clone().multiply(object.matrixWorld);
        this.addProxy(batch, object, object.geometry, object.matrixWorld, localToBody, origin, batch.placement.mode === 'terrain-relative');
      });
    }
    if (this.scene.children.length) renderer.render(this.scene, camera);
  }

  private diagnose(batch: Batch, code: string, message: string): void {
    const layerId = batch.layers[0].id;
    if (!this._diagnostics.some(d => d.layerId === layerId && d.code === code)) this._diagnostics.push({ layerId, code, message });
  }

  private addProxy(batch: Batch, source: THREE.Mesh, geometry: THREE.BufferGeometry, matrix: THREE.Matrix4,
    localToBody: THREE.Matrix4, origin: THREE.Vector3, offset: boolean): void {
    let proxy = batch.proxies.get(source);
    if (proxy && (proxy.sourceGeometry !== geometry || (offset && !sameTransform(proxy.localToBody, localToBody)))) {
      this.dropProxy(batch, source, proxy); proxy = undefined;
    }
    if (!proxy) {
      if (this.proxyCount >= MAX_SURFACE_MESHES) { this.diagnose(batch, 'vector-budget', 'Visible surface mesh budget exceeded'); return; }
      let drawing = geometry;
      if (offset) {
        const count = geometry.getAttribute('position').count;
        if (this.offsetVertices + count > MAX_OFFSET_VERTICES) { this.diagnose(batch, 'vector-budget', 'Terrain offset vertex budget exceeded'); return; }
        drawing = geometry.clone();
        const attribute = drawing.getAttribute('position'), toLocal = localToBody.clone().invert();
        const v = new THREE.Vector3();
        const height = (batch.placement as Extract<GeographicPlacement, { mode: 'terrain-relative' }>).offsetKm;
        for (let i = 0; i < attribute.count; i++) {
          v.fromBufferAttribute(attribute, i).applyMatrix4(localToBody);
          const p = bodyFixedToGeodetic({ xKm: v.x, yKm: v.y, zKm: v.z }, batch.datum);
          const displaced = geodeticToBodyFixed({ ...p, heightKm: p.heightKm! + height }, batch.datum);
          v.set(displaced.xKm, displaced.yKm, displaced.zKm).applyMatrix4(toLocal);
          attribute.setXYZ(i, v.x, v.y, v.z);
        }
        drawing.computeBoundingSphere();
        this.offsetVertices += count;
      }
      const mesh = new THREE.Mesh(drawing, batch.material);
      mesh.matrixAutoUpdate = false; mesh.frustumCulled = false;
      // The first geometry group is ground; remaining groups are skirts/caps.
      const ground = geometry.groups[0];
      if (ground && !offset) {
        const view = new THREE.BufferGeometry();
        for (const [name, attribute] of Object.entries(drawing.attributes)) view.setAttribute(name, attribute);
        view.setIndex(drawing.index);
        mesh.geometry = view;
      }
      if (ground) { mesh.geometry.clearGroups(); mesh.geometry.setDrawRange(ground.start, ground.count); }
      // A shallow view is sufficient for clamp; its attributes/index stay shared.
      const owned = offset || !!ground;
      proxy = { mesh, sourceGeometry: geometry, localToBody: localToBody.clone(), worldMatrix: new THREE.Matrix4(), owned, seen: false };
      mesh.onBeforeRender = () => {
        batch.material.uniforms.vectorLocalToBody.value.copy(proxy!.localToBody);
        const sourceMaterial = (Array.isArray(source.material) ? source.material[0] : source.material) as THREE.MeshStandardMaterial;
        const map = sourceMaterial.displacementMap;
        batch.material.uniforms.vectorDisplacement.value.set(map ? 1 : 0, sourceMaterial.displacementScale ?? 0, sourceMaterial.displacementBias ?? 0);
        batch.material.uniforms.vectorDisplacementMap.value = map ?? null;
        if (map) {
          if (map.matrixAutoUpdate) map.updateMatrix();
          batch.material.uniforms.vectorDisplacementTransform.value.copy(map.matrix);
        }
        batch.material.uniformsNeedUpdate = true;
      };
      batch.proxies.set(source, proxy); this.proxyCount++;
    }
    proxy.seen = true;
    proxy.localToBody.copy(localToBody);
    proxy.mesh.matrix.copy(matrix);
    proxy.mesh.matrixWorld.copy(matrix);
    proxy.worldMatrix.copy(matrix);
    proxy.worldMatrix.elements[12] += origin.x;
    proxy.worldMatrix.elements[13] += origin.y;
    proxy.worldMatrix.elements[14] += origin.z;
    this.scene.add(proxy.mesh);
  }

  end(): void {
    for (const batch of this.batches) for (const [source, proxy] of batch.proxies) if (!proxy.seen) this.dropProxy(batch, source, proxy);
  }
  private dropProxy(batch: Batch, source: THREE.Mesh, proxy: Proxy): void {
    if (batch.placement.mode === 'terrain-relative') this.offsetVertices -= proxy.mesh.geometry.getAttribute('position').count;
    if (proxy.owned) {
      if (batch.placement.mode !== 'terrain-relative') {
        // The source owns the shared attributes' GPU buffers.
        proxy.mesh.geometry.setIndex(null);
        for (const name of Object.keys(proxy.mesh.geometry.attributes)) proxy.mesh.geometry.deleteAttribute(name);
      }
      proxy.mesh.geometry.dispose();
    }
    proxy.mesh.removeFromParent(); batch.proxies.delete(source); this.proxyCount--;
  }

  /** Surface discovery already established nearest-body/terrain occlusion.
   * Neighbour rays intersect its tangent plane, matching fragment derivatives. */
  pick(screenX: number, screenY: number, width: number, height: number, camera: THREE.Camera,
    bodies: ReadonlyMap<string, BodyMesh>, surface: { point: SurfacePoint; cameraRangeKm: number } | null): GeographicFeatureRef | null {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(screenX / width * 2 - 1, 1 - screenY / height * 2), camera);
    let best: { ref: GeographicFeatureRef; distance: number } | null = null;
    for (const batch of this.batches) {
      const bm = bodies.get(batch.bodyName);
      if (!bm?.visible) continue;
      const rotation = bm.bodyToWorldQuaternion(new THREE.Quaternion());
      const toBody = new THREE.Matrix4().compose(bm.position, rotation, new THREE.Vector3().setScalar(this.scaleFactor)).invert();
      let hit: THREE.Vector3 | null = null;
      let normal: THREE.Vector3 | null = null;
      let distance = Infinity;
      if (batch.placement.mode === 'clamp') {
        if (!surface || surface.point.bodyName !== batch.bodyName || !batch.proxies.size) continue;
        hit = new THREE.Vector3(...surface.point.bodyFixedPositionKm).multiplyScalar(this.scaleFactor).applyQuaternion(rotation).add(bm.position);
        normal = new THREE.Vector3(...(surface.point.surfaceNormal ?? [0, 0, 1])).applyQuaternion(rotation);
        distance = surface.cameraRangeKm;
      } else {
        for (const proxy of batch.proxies.values()) {
          if (!proxy.seen) continue;
          proxy.mesh.matrixWorld.copy(proxy.worldMatrix);
          const intersection = raycaster.intersectObject(proxy.mesh, false)[0];
          if (!intersection || intersection.distance / this.scaleFactor >= distance) continue;
          distance = intersection.distance / this.scaleFactor; hit = intersection.point;
          normal = intersection.face?.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(proxy.worldMatrix)).normalize() ?? null;
        }
        if (surface && distance > surface.cameraRangeKm + 1e-6) continue;
      }
      if (!hit || !normal || (best && best.distance < distance)) continue;
      const local = hit.clone().applyMatrix4(toBody);
      const position = bodyFixedToGeodetic({ xKm: local.x, yKm: local.y, zKm: local.z }, batch.datum);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit);
      const neighbour = (x: number, y: number): readonly [number, number] | null => {
        const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(x / width * 2 - 1, 1 - y / height * 2), camera);
        const world = ray.ray.intersectPlane(plane, new THREE.Vector3());
        if (!world) return null;
        world.applyMatrix4(toBody);
        const p = bodyFixedToGeodetic({ xKm: world.x, yKm: world.y, zKm: world.z }, batch.datum);
        return [wrapLon(p.lonDeg - position.lonDeg), p.latDeg - position.latDeg];
      };
      const dx = neighbour(screenX + 1, screenY), dy = neighbour(screenX, screenY + 1);
      if (!dx || !dy) continue;
      const ref = batch.index.pick(position, dx, dy);
      if (ref) best = { ref, distance };
    }
    return best?.ref ?? null;
  }

  private clear(): void {
    this.scene.clear();
    for (const batch of this.batches) {
      for (const [source, proxy] of batch.proxies) this.dropProxy(batch, source, proxy);
      batch.material.dispose();
    }
    this.batches = []; this.offsetVertices = 0; this.proxyCount = 0;
  }
  dispose(): void { this.unsubscribe(); this.clear(); }
}
