import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { TilesFadePlugin } from '3d-tiles-renderer/three/plugins';
import type { BodyMesh } from '../BodyMesh.js';
import { EntityOcclusion } from '../EntityOcclusion.js';
import { LabelManager } from '../LabelManager.js';
import { PositionGlyphs } from '../PositionGlyphs.js';

const viewport = { width: 800, height: 600 };
const scene = new THREE.Group();

function body(name: string, position: THREE.Vector3, surfaceLock?: boolean): BodyMesh {
  return {
    body: name === 'Moon'
      ? { name, geometryType: 'Globe', classification: 'moon', radii: [100, 100, 100] }
      : { name, parentName: 'Moon', geometryType: 'Point', classification: 'spacecraft', geometryData: { surfaceLock } },
    parent: scene, position, present: true, visible: true,
    mesh: new THREE.Mesh(new THREE.SphereGeometry(100, 64, 64)),
    getDskMeshes: () => [],
    displayRadius: name === 'Moon' ? 100 : 1e-6, scaleFactor: 1,
  } as unknown as BodyMesh;
}

function surface(z: number, x = 0, width = 20): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, 20));
  mesh.position.set(x, 0, z);
  mesh.updateMatrixWorld(true);
  return mesh;
}

function setup(surfaceLock: boolean, terrainInnerRadius = 94) {
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 96, height: 24,
      getContext: () => ({ measureText: () => ({ width: 80 }), fillText() {} }),
    }),
  });
  vi.stubGlobal('window', { devicePixelRatio: 1 });

  const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.01, 1e6);
  camera.position.set(0, 0, 104);
  camera.lookAt(0, 0, 98);
  camera.updateMatrixWorld(true);
  const moon = body('Moon', new THREE.Vector3());
  const rover = body('Rover', new THREE.Vector3(0, 0, 98), surfaceLock);
  moon.mesh.visible = false;
  const terrain = new THREE.Group();
  Object.assign(moon, { terrainTileGroup: terrain, terrainInnerRadius });
  const floor = surface(surfaceLock ? 98 : 97.5);
  terrain.add(floor);
  const bodies = [moon, rover];
  const occlusion = new EntityOcclusion(() => terrain.visible
    ? terrain.children.filter((mesh): mesh is THREE.Mesh => mesh instanceof THREE.Mesh && mesh.visible)
    : [moon.mesh]);
  const labels = new LabelManager(undefined as unknown as HTMLElement);
  labels.addLabel(rover);
  labels.setLabelPinned('Rover', true);
  const glyphs = new PositionGlyphs(2);
  const anchorVisibility = (body: BodyMesh) => occlusion.visibility(body, camera, bodies);
  const step = (frames = 1) => {
    for (let i = 0; i < frames; i++) {
      occlusion.beginFrame();
      labels.update(bodies, camera, viewport, undefined, anchorVisibility);
      glyphs.update(bodies, camera, {
        viewport, device: { ...viewport, pixelRatio: 1 },
        isEligible: bm => bm === rover, isPinned: () => true,
        trackedName: null, hoveredName: null,
        labelState: name => labels.getLabelState(name), anchorVisibility,
      });
    }
  };
  return { camera, moon, rover, terrain, floor, labels, glyphs, step };
}

afterEach(() => {
  scene.clear();
  vi.unstubAllGlobals();
});

describe('entity anchor visibility', () => {
  it.each([false, true])('shares the terrain verdict for surfaceLock=%s', surfaceLock => {
    const { terrain, floor, rover, labels, glyphs, step } = setup(surfaceLock);
    const label = () => labels.getLabelState('Rover')!.occlusion;
    const ring = () => glyphs.readout()[0].visibility;
    step(60);
    expect(label()).toBe(1);
    expect(ring()).toBeCloseTo(1);
    expect(glyphs.pickNearest(400, 300, 6)).toBe('Rover');

    // A single replacement frame intersects the segment. The old result holds.
    const ridge = surface(100);
    terrain.add(ridge);
    step();
    expect(label()).toBe(1);
    expect(ring()).toBeCloseTo(1);
    ridge.visible = false;
    step();
    expect(label()).toBe(1);

    // A settled ridge hides both, even though it is separate from the floor.
    ridge.visible = true;
    step(60);
    expect(label()).toBeLessThan(0.001);
    expect(ring()).toBeLessThan(0.001);
    expect(glyphs.pickNearest(400, 300, 6)).toBeNull();

    // Replace the coarse floor with a refined one well inside the lunar radius.
    terrain.remove(ridge, floor);
    terrain.add(surface(surfaceLock ? 98 : 97.75));
    step(60);
    expect(label()).toBeCloseTo(1);
    expect(ring()).toBeCloseTo(1);
    expect(rover.position.toArray()).toEqual([0, 0, 98]);
  });

  it.each([94, 0])('handles missing front terrain with interior radius %s', terrainInnerRadius => {
    const { camera, rover, terrain, floor, labels, glyphs, step } = setup(false, terrainInnerRadius);
    // Terrain is enabled but the only resident tile is off this ray.
    terrain.remove(floor);
    terrain.add(surface(97, 40));
    rover.position.z = -101;
    camera.lookAt(rover.position);
    camera.updateMatrixWorld(true);
    step(60);
    expect(labels.getLabelState('Rover')!.occlusion).toBe(0);
    expect(glyphs.readout()[0].occluded).toBe(true);

    // An anchor in a near-side depression remains visible during the tile gap.
    rover.position.z = 98;
    camera.lookAt(rover.position);
    camera.updateMatrixWorld(true);
    step(60);
    expect(labels.getLabelState('Rover')!.occlusion).toBeCloseTo(1);
    expect(glyphs.readout()[0].visibility).toBeCloseTo(1);
  });

  it('keeps a grazing anchor visible when terrain has no certified interior', () => {
    const { camera, rover, terrain, floor, labels, glyphs, step } = setup(false, 0);
    terrain.remove(floor);
    terrain.add(surface(97, 40));
    // The segment grazes inside the nominal sphere, and the anchor is just
    // across the hemisphere boundary from a distant camera.
    camera.position.set(0, 0, 1000);
    rover.position.set(99, 0, -0.01);
    camera.lookAt(rover.position);
    camera.updateMatrixWorld(true);
    step(60);
    expect(labels.getLabelState('Rover')!.occlusion).toBe(1);
    expect(glyphs.readout()[0].visibility).toBeCloseTo(1);
  });

  it('shares a monotonic fade as a blocking parent gives way to clear relief while the camera moves', () => {
    const { camera, rover, terrain, floor, labels, glyphs, step } = setup(false);
    const parent = surface(100);
    terrain.add(parent);
    const plugin = new TilesFadePlugin() as unknown as {
      _fadeMaterialManager: {
        prepareScene(scene: THREE.Object3D): void;
        setFade(scene: THREE.Object3D, fadeIn: number, fadeOut: number): void;
      };
    };
    const manager = plugin._fadeMaterialManager;
    manager.prepareScene(parent);
    manager.prepareScene(floor);
    step(60);
    expect(labels.getLabelState('Rover')!.occlusion).toBe(0);
    let previous = 0;
    for (let i = 1; i < 18; i++) {
      const t = i / 18;
      manager.setFade(parent, 1, t);
      manager.setFade(floor, t, 0);
      camera.position.set(i / 5, 0.3, 104 + t);
      camera.lookAt(rover.position);
      camera.updateMatrixWorld(true);
      step();
      const visibility = labels.getLabelState('Rover')!.occlusion;
      expect(visibility).toBeGreaterThan(previous);
      expect(visibility - previous).toBeLessThan(0.1);
      expect(glyphs.readout()[0].visibility).toBeCloseTo(visibility, 6);
      previous = visibility;
    }
    terrain.remove(parent);
    manager.setFade(floor, 1, 0);
    step(60);
    expect(glyphs.readout()[0].visibility).toBeCloseTo(1);
  });

  it('uses the drawn globe when there is no streamed surface and hides a far-side anchor', () => {
    const { camera, moon, terrain, rover, labels, glyphs, step } = setup(false);
    terrain.visible = false;
    moon.mesh.visible = true;
    rover.position.set(0, 0, -101);
    camera.lookAt(rover.position);
    camera.updateMatrixWorld(true);
    step(60);
    expect(labels.getLabelState('Rover')!.occlusion).toBe(0);
    expect(glyphs.readout()[0].occluded).toBe(true);

    camera.position.set(0, 0, -105);
    camera.lookAt(rover.position);
    camera.updateMatrixWorld(true);
    step(60);
    expect(labels.getLabelState('Rover')!.occlusion).toBeCloseTo(1);
    expect(glyphs.readout()[0].visibility).toBeCloseTo(1);

    camera.lookAt(0, 0, -106);
    camera.updateMatrixWorld(true);
    step();
    expect(labels.getLabelState('Rover')!.occlusion).toBe(0);
    expect(glyphs.readout()[0].visibility).toBe(0);
  });
});
