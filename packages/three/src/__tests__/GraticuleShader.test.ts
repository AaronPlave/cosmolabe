import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Body, FixedPointTrajectory, bodySurfaceCoordinates } from '@cosmolabe/core';
import { applyGraticuleToScene, makeGraticuleUniforms } from '../GraticuleShader.js';
import { TerrainManager } from '../TerrainManager.js';
import type { Tile } from '3d-tiles-renderer';

const coordinates = bodySurfaceCoordinates(new Body({ name: 'Moon', trajectory: new FixedPointTrajectory([0, 0, 0]),
  radii: [1737.4, 1737.4, 1737.4], geometryType: 'Globe' }))!;
const renderer = undefined as unknown as THREE.WebGLRenderer;
function compile(material: THREE.Material) {
  const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms) };
  material.onBeforeCompile(shader as Parameters<typeof material.onBeforeCompile>[0], renderer);
  return shader;
}

describe('graticule surface materials', () => {
  for (const resident of [false, true]) {
    it(`preserves upstream fade updates and eviction for ${resident ? 'resident' : 'new'} terrain tiles`, () => {
      const tm = new TerrainManager({ type: 'quantized-mesh', url: 'https://example.invalid/moon/', fadeDurationMs: 300 },
        [1737.4, 1737.4, 1737.4], renderer);
      const scene = new THREE.Group();
      const material = new THREE.MeshStandardMaterial();
      const disposed = vi.fn(); material.addEventListener('dispose', disposed);
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1737400, 8, 4), material);
      scene.add(mesh); tm.group.add(scene);
      const tile = { content: { uri: '0/0/0.terrain' }, traversal: { visible: false, active: false },
        engineData: { scene, materials: [material], geometry: [mesh.geometry], textures: [] } };
      const uniforms = makeGraticuleUniforms(coordinates);
      if (!resident) tm.enableGraticule(uniforms, new THREE.Matrix4());
      tm.tiles.dispatchEvent({ type: 'load-model', scene, tile: tile as unknown as Tile, url: 'https://example.invalid/moon/0/0/0.terrain' });
      // Exercise the actual upstream plugin's WeakMap-based update path.
      const plugin = tm.tiles.getPluginByName('FADE_TILES_PLUGIN') as unknown as {
        _fadeMaterialManager: { setFade(scene: THREE.Object3D, fadeIn: number, fadeOut: number): void };
      };
      plugin._fadeMaterialManager.setFade(scene, 0.25, 0);
      if (resident) tm.enableGraticule(uniforms, new THREE.Matrix4());
      const shader = compile(mesh.material);
      expect(mesh.material).toBe(material);
      expect(material.defines!.FEATURE_FADE).toBe(1);
      expect(shader.uniforms.fadeIn.value).toBe(0.25);
      expect(shader.vertexShader).toContain('uGridViewToBody * modelViewMatrix');
      expect(shader.fragmentShader).toContain('mix(outgoingLight, grid.rgb, grid.a * horizon * uGridVisible)');
      plugin._fadeMaterialManager.setFade(scene, 1, 0);
      expect(shader.uniforms.fadeIn.value).toBe(1);
      expect(material.defines!.FEATURE_FADE).toBe(0);
      expect(disposed).not.toHaveBeenCalled();
      // Actual TilesRenderer eviction must dispose the material being rendered.
      (tm.tiles as unknown as { disposeTile(tile: unknown): void }).disposeTile(tile);
      expect(disposed).toHaveBeenCalledTimes(1);
      tm.dispose();
    });
  }

  it('uses per-object model-view transforms without cloning a shared surface material', () => {
    const material = new THREE.MeshStandardMaterial();
    const priorCompile = vi.fn(); material.onBeforeCompile = priorCompile;
    const priorRender = vi.fn(); material.onBeforeRender = priorRender;
    const scene = new THREE.Scene();
    const a = new THREE.Mesh(new THREE.BoxGeometry(), material);
    const b = new THREE.Mesh(a.geometry, material);
    a.position.set(1e8 + 1, -2e8 + 2, 3e8 + 3); b.position.set(1e8 + 4, -2e8 + 5, 3e8 + 6);
    scene.add(a, b); scene.updateMatrixWorld(true);
    const bodyFromWorld = new THREE.Matrix4().makeTranslation(-1e8, 2e8, -3e8);
    const camera = new THREE.PerspectiveCamera(); camera.position.set(1e8 + 100, -2e8, 3e8); camera.updateMatrixWorld(true);
    applyGraticuleToScene(scene, makeGraticuleUniforms(coordinates), bodyFromWorld);
    applyGraticuleToScene(scene, makeGraticuleUniforms(coordinates), bodyFromWorld);
    const shader = compile(material);
    expect(priorCompile).toHaveBeenCalledTimes(1);
    for (const mesh of [a, b]) {
      expect(mesh.material).toBe(material);
      material.onBeforeRender(renderer, scene, camera, mesh.geometry, mesh, new THREE.Group());
      const viewToBody = shader.uniforms.uGridViewToBody.value as THREE.Matrix4;
      const modelView = new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
      const position = new THREE.Vector3().applyMatrix4(modelView).applyMatrix4(viewToBody);
      expect(position.distanceTo(mesh.position.clone().applyMatrix4(bodyFromWorld))).toBeLessThan(1e-6);
    }
    expect(priorRender).toHaveBeenCalledTimes(2);
    material.dispose(); a.geometry.dispose();
  });
});
