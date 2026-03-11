import * as THREE from 'three';
import type { Body } from '@spicecraft/core';

const DEFAULT_BODY_COLORS: Record<string, number> = {
  star: 0xffdd44,
  planet: 0x8888cc,
  moon: 0xaaaaaa,
  spacecraft: 0x44ff44,
  asteroid: 0x886644,
  comet: 0x668899,
  barycenter: 0x444444,
};

export class BodyMesh extends THREE.Object3D {
  readonly body: Body;
  readonly mesh: THREE.Mesh;
  /** Display radius in km (before scale factor) */
  readonly displayRadius: number;

  constructor(body: Body) {
    super();
    this.body = body;
    this.name = body.name;

    this.displayRadius = this.getDisplayRadius();
    const geometry = new THREE.SphereGeometry(this.displayRadius, 32, 24);
    const color = DEFAULT_BODY_COLORS[body.classification ?? ''] ?? 0xcccccc;
    const material = new THREE.MeshPhongMaterial({ color });

    // Stars emit light
    if (body.classification === 'star') {
      (material as THREE.MeshPhongMaterial).emissive = new THREE.Color(0xffdd44);
      (material as THREE.MeshPhongMaterial).emissiveIntensity = 0.8;
    }

    this.mesh = new THREE.Mesh(geometry, material);
    this.add(this.mesh);
  }

  /** Update position from absolute coordinates (km) and apply rotation. */
  updatePosition(absolutePos: [number, number, number], et: number, scaleFactor: number): void {
    this.position.set(
      absolutePos[0] * scaleFactor,
      absolutePos[1] * scaleFactor,
      absolutePos[2] * scaleFactor,
    );

    // Apply rotation if available
    const q = this.body.rotationAt(et);
    if (q) {
      this.mesh.quaternion.set(q[1], q[2], q[3], q[0]); // SPICE [w,x,y,z] → Three [x,y,z,w]
    }
  }

  private getDisplayRadius(): number {
    if (this.body.radii) {
      return Math.max(this.body.radii[0], this.body.radii[1], this.body.radii[2]);
    }
    // Fallback display sizes by classification
    switch (this.body.classification) {
      case 'star': return 696000;    // Sun ~696,000 km
      case 'planet': return 6371;    // Earth-like default
      case 'moon': return 1737;
      case 'spacecraft': return 10;
      default: return 100;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
