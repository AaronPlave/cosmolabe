import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ModelSurfaceDepth } from '../ModelSurfaceDepth.js';

describe('physical overlay depth', () => {
  it('borrows exact selected geometry with opaque two-sided depth, independent of fading color', () => {
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: .1, depthWrite: false });
    const source = new THREE.Mesh(geometry, material); source.position.set(1, 2, 3);
    const before = Array.from(geometry.attributes.position.array), disposed = vi.fn(); geometry.addEventListener('dispose', disposed);
    const depth = new ModelSurfaceDepth({ logarithmicDepth: true, side: THREE.DoubleSide, layer: 0, measureDistance: false });
    depth.update([source], new THREE.Vector3());
    const proxy = depth.scene.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    expect(proxy.geometry).toBe(geometry); expect(proxy.material.colorWrite).toBe(false);
    expect(proxy.material.depthWrite).toBe(true); expect(proxy.material.transparent).toBe(false);
    expect(proxy.material.side).toBe(THREE.DoubleSide); expect(proxy.matrix.equals(source.matrixWorld)).toBe(true);
    expect(Array.from(geometry.attributes.position.array)).toEqual(before);
    depth.update([], new THREE.Vector3()); expect(depth.scene.children).toHaveLength(0);
    depth.dispose(); expect(disposed).not.toHaveBeenCalled(); expect(source.material).toBe(material);
  });
});
