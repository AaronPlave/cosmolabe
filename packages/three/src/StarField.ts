import * as THREE from 'three';

export interface StarFieldOptions {
  numStars?: number;
  radius?: number;
  minSize?: number;
  maxSize?: number;
}

export class StarField extends THREE.Object3D {
  private readonly points: THREE.Points;

  constructor(options: StarFieldOptions = {}) {
    super();
    const count = options.numStars ?? 5000;
    const radius = options.radius ?? 1e8;
    const minSize = options.minSize ?? 0.5;
    const maxSize = options.maxSize ?? 2.0;

    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      // Uniform distribution on sphere
      const theta = Math.random() * 2 * Math.PI;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = radius * Math.cos(phi);
      sizes[i] = minSize + Math.random() * (maxSize - minSize);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const material = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 1.5,
      sizeAttenuation: false,
    });

    this.points = new THREE.Points(geometry, material);
    this.add(this.points);
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
