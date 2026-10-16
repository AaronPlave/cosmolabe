import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { ModelSurfaceDepth } from './ModelSurfaceDepth.js';

describe('model-pass physical surface depth', () => {
  it('borrows exact transformed geometry, writes only linear depth, and releases hidden surfaces', () => {
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const tree = new MeshBVH(geometry, { indirect: true });
    geometry.boundsTree = tree;
    const source = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    source.position.set(10, 20, 30);
    source.rotation.set(0.2, 0.4, 0.6);
    source.scale.setScalar(0.001);
    source.updateWorldMatrix(true, false);
    const camera = source.localToWorld(new THREE.Vector3(0, 0, 1.1));
    const depth = new ModelSurfaceDepth();
    expect(depth.update([source], camera)).toBeCloseTo(0.0001, 10);
    const proxy = depth.scene.children[0] as THREE.Mesh;
    expect(proxy.geometry).toBe(geometry);
    expect(proxy.matrix.equals(source.matrixWorld)).toBe(true);
    depth.scene.updateMatrixWorld(true);
    expect(proxy.matrixWorld.equals(source.matrixWorld)).toBe(true);
    expect(proxy.layers.isEnabled(1)).toBe(true);
    expect(proxy.material).not.toBe(source.material);
    const material = proxy.material as THREE.MeshBasicMaterial;
    expect(material.colorWrite).toBe(false);
    expect(material.depthWrite).toBe(true);
    const shader = { vertexShader: '#include <logdepthbuf_pars_vertex>\n#include <logdepthbuf_vertex>', fragmentShader: '#include <logdepthbuf_pars_fragment>\n#include <logdepthbuf_fragment>', uniforms: {} };
    material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).not.toContain('logdepthbuf');
    expect(shader.fragmentShader).not.toContain('logdepthbuf');
    source.position.x += 1;
    depth.update([source], camera);
    expect(depth.scene.children[0]).toBe(proxy);
    expect(proxy.matrix.equals(source.matrixWorld)).toBe(true);
    geometry.computeBoundingSphere();
    const closest = vi.spyOn(tree, 'closestPointToPoint');
    expect(depth.update([source], new THREE.Vector3(1e9, 0, 0), 1)).toBe(1);
    expect(closest).not.toHaveBeenCalled(); // distant shape cannot tighten the model near plane
    const disposeGeometry = vi.spyOn(geometry, 'dispose');
    const disposeMaterial = vi.spyOn(material, 'dispose');
    depth.update([], camera);
    expect(depth.scene.children).toHaveLength(0);
    depth.dispose();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(disposeGeometry).not.toHaveBeenCalled();
  });
});
