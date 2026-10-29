import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { UniverseRenderer } from '../UniverseRenderer.js';

function fixture() {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.z = 10; camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const terrain = new THREE.Group();
  const tile = (z: number, height: number) => {
    const geometry = new THREE.PlaneGeometry(2, 2);
    geometry.setAttribute('surfaceHeightKm', new THREE.Float32BufferAttribute([height, height, height, height], 1));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.position.z = z; return mesh;
  };
  const active = tile(1, -3), cached = tile(2, 99);
  const hidden = new THREE.Group(); hidden.visible = false; hidden.add(cached);
  terrain.add(active, hidden);
  const body = Object.assign(new THREE.Group(), {
    body: { name: 'Mars' }, displayRadius: 1, mesh: new THREE.Mesh(), terrainTileGroup: terrain,
    getDskMeshes: () => [], getSurfaceOverlays: () => [],
  });
  body.mesh.visible = false; body.add(terrain); body.updateMatrixWorld(true);
  const renderer = Object.assign(Object.create(UniverseRenderer.prototype), {
    camera, scaleFactor: 1, bodyMeshes: new Map([['Mars', body]]),
    _surfaceRaycaster: new THREE.Raycaster(), _surfaceTileRaycaster: new THREE.Raycaster(),
    renderer: { domElement: { clientWidth: 800, clientHeight: 800, style: {} } },
  }) as UniverseRenderer;
  return { renderer, active, hidden, body };
}

describe('appearance integration with shared surface discovery', () => {
  it('uses only visible LOD meshes, honoring ancestor visibility in the shared cast', () => {
    const { renderer, hidden } = fixture();
    expect(renderer.pickSurfaceTintHeight(400, 400)).toEqual({ bodyName: 'Mars', heightKm: -3 });
    // Both queries call _castSurfaces; changing the visible LOD affects both.
    hidden.visible = true;
    expect(renderer.pickSurfaceTintHeight(400, 400)).toEqual({ bodyName: 'Mars', heightKm: 99 });
    hidden.visible = false;
    const cast = (renderer as unknown as { _castSurfaces(): { worldPoint: THREE.Vector3 } })._castSurfaces();
    expect(cast.worldPoint.z).toBeCloseTo(1);
  });

  it('discovers cube points through a nearer visible visual-only reconstruction', () => {
    const { renderer, body } = fixture();
    const reconstruction = new THREE.Group();
    const triangle = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
    triangle.position.z = 3; reconstruction.add(triangle); reconstruction.updateMatrixWorld(true);
    // This would have won the old tileScene cast at z=3 over the cube at z=1.
    const setCameraRelativeTransform = vi.fn(() => {
      reconstruction.position.copy(renderer.camera.position).negate();
      reconstruction.updateMatrixWorld(true);
    });
    body.getSurfaceOverlays = () => [{ group: reconstruction, physicalQueryPolicy: 'visual-only',
      setCameraRelativeTransform }] as never;
    const seen: any[] = [];
    Object.assign(renderer, { _surfacePointFromHit: (hit: any) => { seen.push(hit); return { source: hit.source }; } });
    const internal = renderer as unknown as { _discoverSurface(x: number, y: number, sample?: boolean): any };
    for (const sample of [false, true]) {
      const result = internal._discoverSurface(0, 0, sample);
      expect(result.ray.source).toBe('terrain');
      expect(result.ray.worldPoint.z).toBeCloseTo(1);
      expect(result.cameraRangeKm).toBeCloseTo(9);
    }
    expect(seen).toHaveLength(2);
    expect(setCameraRelativeTransform).not.toHaveBeenCalled();
    expect(reconstruction.visible).toBe(true);
    expect(triangle.visible).toBe(true);
  });

  it('can preview rendered geometry without CPU sampling or coverage requests', () => {
    const { renderer } = fixture();
    const discover = vi.fn(() => null);
    Object.assign(renderer, { _discoverSurface: discover });
    Object.assign(renderer.renderer.domElement, { getBoundingClientRect: () => ({ width: 800, height: 800 }) });
    renderer.pickScene(400, 400, 'probe', { renderedOnly: true });
    expect(discover).toHaveBeenLastCalledWith(0, 0, false);
    renderer.pickScene(400, 400, 'probe');
    expect(discover).toHaveBeenLastCalledWith(0, 0, true);
  });

  it('owns clicks independently of measurements, and consumes misses before probe/selection', () => {
    const { renderer } = fixture();
    const pick = vi.fn();
    Object.assign(renderer, { clearSpatialPickPreview: vi.fn(), _probeActive: true, pickScene: vi.fn() });
    renderer.setSurfacePointerTool({ pick, preview: vi.fn() });
    const internal = renderer as unknown as { _selectAt(x: number, y: number): boolean; _surfaceCursorOwnsPointer(): boolean };
    expect(internal._surfaceCursorOwnsPointer()).toBe(true);
    expect(internal._selectAt(3, 4)).toBe(true);
    expect(pick).toHaveBeenCalledWith(3, 4);
    expect(renderer.pickScene).not.toHaveBeenCalled();
    renderer.setSurfacePointerTool(null);
    expect(renderer.renderer.domElement.style.cursor).toBe('');
  });
});
