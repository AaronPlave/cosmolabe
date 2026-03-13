import * as THREE from 'three';

export interface StarFieldOptions {
  /** URL to the binary star catalog (stars.bin). If not provided, uses a random fallback. */
  catalogUrl?: string;
  /** Radius of the star sphere in scene units. Default 1e8. */
  radius?: number;
  /** Minimum point size in pixels (faintest stars). Default 0.5. */
  minSize?: number;
  /** Maximum point size in pixels (brightest stars). Default 4.0. */
  maxSize?: number;
  /** Faintest magnitude to display. Default 6.5. */
  magLimit?: number;
}

/**
 * B-V color index to RGB color.
 * Attempt to reproduce the spectral colors:
 *   B-V < 0    → blue-white  (hot O/B stars)
 *   B-V ~ 0.6  → white-yellow (G stars like the Sun)
 *   B-V > 1.4  → orange-red  (K/M stars)
 */
function bvToColor(bv: number): [number, number, number] {
  // Clamp to valid range
  const t = Math.max(-0.4, Math.min(2.0, bv));

  let r: number, g: number, b: number;

  if (t < 0) {
    // Blue-white (O/B stars)
    r = 0.7 + 0.3 * (t + 0.4) / 0.4;
    g = 0.8 + 0.2 * (t + 0.4) / 0.4;
    b = 1.0;
  } else if (t < 0.4) {
    // White to yellow-white (A/F stars)
    r = 1.0;
    g = 1.0 - 0.15 * (t / 0.4);
    b = 1.0 - 0.4 * (t / 0.4);
  } else if (t < 0.8) {
    // Yellow-white to yellow (F/G stars)
    const u = (t - 0.4) / 0.4;
    r = 1.0;
    g = 0.85 - 0.15 * u;
    b = 0.6 - 0.25 * u;
  } else if (t < 1.4) {
    // Yellow to orange (G/K stars)
    const u = (t - 0.8) / 0.6;
    r = 1.0;
    g = 0.7 - 0.25 * u;
    b = 0.35 - 0.2 * u;
  } else {
    // Orange to red (M stars)
    const u = (t - 1.4) / 0.6;
    r = 1.0 - 0.2 * u;
    g = 0.45 - 0.2 * u;
    b = 0.15 - 0.1 * u;
  }

  return [Math.max(0, Math.min(1, r)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b))];
}

export class StarField extends THREE.Object3D {
  private points: THREE.Points | null = null;

  constructor(options: StarFieldOptions = {}) {
    super();
    const catalogUrl = options.catalogUrl;
    if (catalogUrl) {
      this.loadCatalog(catalogUrl, options);
    } else {
      // Fallback: random stars (no catalog provided)
      this.buildRandom(options);
    }
  }

  private async loadCatalog(url: string, options: StarFieldOptions): Promise<void> {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const arrayBuf = await resp.arrayBuffer();
      this.buildFromBinary(arrayBuf, options);
    } catch (err) {
      console.warn('[SpiceCraft] Failed to load star catalog, using random stars:', err);
      this.buildRandom(options);
    }
  }

  /**
   * Parse the binary star catalog and build the point cloud.
   * Format: 4-byte magic "STAR", 4-byte uint32 count, then count × 5 Float32 (x, y, z, mag, bv)
   */
  private buildFromBinary(buffer: ArrayBuffer, options: StarFieldOptions): void {
    const view = new DataView(buffer);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== 'STAR') {
      console.warn('[SpiceCraft] Invalid star catalog magic:', magic);
      this.buildRandom(options);
      return;
    }

    const count = view.getUint32(4, true);
    const radius = options.radius ?? 1e8;
    const minSize = options.minSize ?? 0.5;
    const maxSize = options.maxSize ?? 4.0;
    const magLimit = options.magLimit ?? 6.5;

    // Find magnitude range for normalization (skip Sun if present)
    let magBright = 10;
    let starCount = 0;
    const HEADER = 8;
    const STRIDE = 20; // 5 Float32s

    for (let i = 0; i < count; i++) {
      const off = HEADER + i * STRIDE;
      const mag = view.getFloat32(off + 12, true);
      if (mag < -10) continue; // Skip Sun
      if (mag > magLimit) continue;
      if (mag < magBright) magBright = mag;
      starCount++;
    }

    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);
    const sizes = new Float32Array(starCount);

    const magRange = magLimit - magBright;
    let idx = 0;

    for (let i = 0; i < count; i++) {
      const off = HEADER + i * STRIDE;
      const x = view.getFloat32(off, true);
      const y = view.getFloat32(off + 4, true);
      const z = view.getFloat32(off + 8, true);
      const mag = view.getFloat32(off + 12, true);
      const bv = view.getFloat32(off + 16, true);

      if (mag < -10 || mag > magLimit) continue;

      // Unit vector × radius
      positions[idx * 3] = x * radius;
      positions[idx * 3 + 1] = y * radius;
      positions[idx * 3 + 2] = z * radius;

      // Size: logarithmic brightness scaling
      // Brighter stars (lower mag) → larger points
      const t = 1 - (mag - magBright) / magRange; // 1 = brightest, 0 = faintest
      sizes[idx] = minSize + (maxSize - minSize) * (t * t); // quadratic for more contrast

      // Color from B-V index
      const [r, g, b] = bvToColor(bv);
      colors[idx * 3] = r;
      colors[idx * 3 + 1] = g;
      colors[idx * 3 + 2] = b;

      idx++;
    }

    this.buildPoints(positions, colors, sizes, idx);
    console.log(`[SpiceCraft] StarField: ${idx} real stars loaded (mag ${magBright.toFixed(1)} to ${magLimit})`);
  }

  /** Fallback: random uniformly distributed white stars */
  private buildRandom(options: StarFieldOptions): void {
    const count = 5000;
    const radius = options.radius ?? 1e8;
    const minSize = options.minSize ?? 0.5;
    const maxSize = options.maxSize ?? 2.0;

    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const theta = Math.random() * 2 * Math.PI;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = radius * Math.cos(phi);
      sizes[i] = minSize + Math.random() * (maxSize - minSize);
      colors[i * 3] = 1;
      colors[i * 3 + 1] = 1;
      colors[i * 3 + 2] = 1;
    }

    this.buildPoints(positions, colors, sizes, count);
  }

  private buildPoints(positions: Float32Array, colors: Float32Array, sizes: Float32Array, count: number): void {
    // Clean up previous
    if (this.points) {
      this.points.geometry.dispose();
      (this.points.material as THREE.Material).dispose();
      this.remove(this.points);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(0, count * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors.slice(0, count * 3), 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes.slice(0, count), 1));

    const material = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: `
        attribute float aSize;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          // Soft circular point with glow falloff
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;
          float alpha = 1.0 - smoothstep(0.0, 0.5, d);
          gl_FragColor = vec4(vColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      vertexColors: true,
    });

    this.points = new THREE.Points(geometry, material);
    this.add(this.points);
  }

  dispose(): void {
    if (this.points) {
      this.points.geometry.dispose();
      (this.points.material as THREE.Material).dispose();
    }
  }
}
