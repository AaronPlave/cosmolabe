import * as THREE from 'three';

export interface StarFieldOptions {
  /** URL to the binary star catalog (stars.bin). If not provided, uses a random fallback. */
  catalogUrl?: string;
  /** Maximum point size in pixels (brightest stars). Default 3.5. */
  maxSize?: number;
  /** Faintest magnitude to display. Default 6.5. */
  magLimit?: number;
}

/**
 * B-V color index to RGB tint.
 * Near-white with subtle spectral tinting — most stars appear white.
 */
function bvToRGB(bv: number): [number, number, number] {
  const t = Math.max(-0.4, Math.min(2.0, bv));
  if (t < -0.1) return [0.85, 0.9, 1.0];     // Blue-white (O/B)
  if (t < 0.3)  return [0.97, 0.97, 1.0];     // White (A)
  if (t < 0.6)  return [1.0, 0.97, 0.92];     // Yellow-white (F/G)
  if (t < 1.0)  return [1.0, 0.9, 0.75];      // Yellow-orange (G/K)
  if (t < 1.5)  return [1.0, 0.82, 0.6];      // Orange (K)
  return [1.0, 0.7, 0.5];                      // Red-orange (M)
}

/**
 * Real star field using HYG catalog data.
 *
 * Renders stars as a skybox: the vertex shader strips camera translation so
 * stars appear at infinity regardless of camera position. No followCamera()
 * call needed, no far-plane clipping, no precision issues.
 */
export class StarField extends THREE.Object3D {
  private points: THREE.Points | null = null;

  constructor(options: StarFieldOptions = {}) {
    super();
    this.renderOrder = -1000;
    this.frustumCulled = false;

    if (options.catalogUrl) {
      this.loadCatalog(options.catalogUrl, options);
    } else {
      this.buildRandom(options);
    }
  }

  private async loadCatalog(url: string, options: StarFieldOptions): Promise<void> {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      this.buildFromBinary(await resp.arrayBuffer(), options);
    } catch (err) {
      console.warn('[SpiceCraft] Failed to load star catalog, using random stars:', err);
      this.buildRandom(options);
    }
  }

  /**
   * Parse binary star catalog.
   * Format: "STAR" magic (4b) + uint32 count (4b) + count × [x,y,z,mag,bv] Float32 (20b each)
   */
  private buildFromBinary(buffer: ArrayBuffer, options: StarFieldOptions): void {
    const view = new DataView(buffer);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== 'STAR') {
      this.buildRandom(options);
      return;
    }

    const count = view.getUint32(4, true);
    const maxSize = options.maxSize ?? 3.5;
    const magLimit = options.magLimit ?? 6.5;
    const HEADER = 8;
    const STRIDE = 20;

    // Find magnitude range (skip Sun)
    let magBright = 10;
    let starCount = 0;
    for (let i = 0; i < count; i++) {
      const mag = view.getFloat32(HEADER + i * STRIDE + 12, true);
      if (mag < -10 || mag > magLimit) continue;
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

      // Unit vector — direction only (shader handles the rest)
      positions[idx * 3] = x;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = z;

      // Brightness: 1=brightest, 0=faintest
      const t = 1 - (mag - magBright) / magRange;

      // Size: minimum 2px to avoid sub-pixel aliasing flicker.
      // Bright stars get larger (up to maxSize).
      sizes[idx] = 2.0 + (maxSize - 2.0) * (t * t * t);

      // Color: spectral tint × brightness.
      // Linear with high floor: faintest=0.15 (visible on any monitor), brightest=1.0
      const brightness = 0.15 + 0.85 * t;
      const [r, g, b] = bvToRGB(bv);
      colors[idx * 3] = r * brightness;
      colors[idx * 3 + 1] = g * brightness;
      colors[idx * 3 + 2] = b * brightness;

      idx++;
    }

    this.buildPoints(positions, colors, sizes, idx);
    console.log(`[SpiceCraft] StarField: ${idx} real stars (mag ${magBright.toFixed(1)} to ${magLimit})`);
  }

  private buildRandom(options: StarFieldOptions): void {
    const count = 5000;
    const maxSize = options.maxSize ?? 2.0;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const theta = Math.random() * 2 * Math.PI;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = Math.cos(phi);
      const b = 0.5 + Math.random() * 0.5;
      sizes[i] = 2.0 + Math.random() * (maxSize - 2.0);
      colors[i * 3] = b;
      colors[i * 3 + 1] = b;
      colors[i * 3 + 2] = b;
    }

    this.buildPoints(positions, colors, sizes, count);
  }

  private buildPoints(positions: Float32Array, colors: Float32Array, sizes: Float32Array, count: number): void {
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
      vertexShader: /* glsl */ `
        attribute float aSize;
        varying vec3 vColor;
        void main() {
          vColor = color;
          // Skybox: strip translation from modelView, keep only rotation.
          // Stars are at infinity — camera movement doesn't affect them.
          vec3 viewDir = mat3(modelViewMatrix) * position;
          vec4 clipPos = projectionMatrix * vec4(viewDir, 1.0);
          // Push to far plane so stars are always behind everything
          clipPos.z = clipPos.w;
          gl_Position = clipPos;
          gl_PointSize = aSize;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main() {
          // Soft circle via alpha — no discard, so no pixel-boundary flicker.
          // Additive blending means black/transparent edges add nothing.
          float d = length(gl_PointCoord - vec2(0.5));
          float alpha = 1.0 - smoothstep(0.45, 0.5, d);
          gl_FragColor = vec4(vColor * alpha, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.add(this.points);
  }

  dispose(): void {
    if (this.points) {
      this.points.geometry.dispose();
      (this.points.material as THREE.Material).dispose();
    }
  }
}
