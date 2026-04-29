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
 * Real star field using HYG catalog data with physically-based colors and brightness.
 *
 * Star colors use black body chromaticity (pre-baked at build time from B-V index).
 * Brightness follows Pogson's law: flux = 10^(-m/2.5), giving correct logarithmic
 * dynamic range between bright and faint stars.
 *
 * Renders stars as a skybox: the vertex shader strips camera translation so
 * stars appear at infinity regardless of camera position.
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
      console.warn('[Cosmolabe] Failed to load star catalog, using random stars:', err);
      this.buildRandom(options);
    }
  }

  /**
   * Parse binary star catalog.
   * Supports v2 compact format (STR2 magic) and v1 legacy format (STAR magic).
   */
  private buildFromBinary(buffer: ArrayBuffer, options: StarFieldOptions): void {
    const view = new DataView(buffer);
    const magic = String.fromCharCode(
      view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)
    );

    if (magic === 'STR2') {
      this.parseCompactFormat(view, options);
    } else if (magic === 'STAR') {
      this.parseLegacyFormat(view, options);
    } else {
      console.warn('[Cosmolabe] Unknown star catalog format, using random stars');
      this.buildRandom(options);
    }
  }

  /**
   * Parse v2 compact format (10 bytes/star, pre-baked black body colors).
   * Header (16b): "STR2" + uint32 count + float32 magBright + float32 magFaint
   * Per star (10b): 3×Int16 position + Uint8 magnitude + 3×Uint8 RGB
   */
  private parseCompactFormat(view: DataView, options: StarFieldOptions): void {
    const count = view.getUint32(4, true);
    const magBright = view.getFloat32(8, true);
    const magFaint = view.getFloat32(12, true);
    const maxSize = options.maxSize ?? 3.5;
    const magLimit = options.magLimit ?? magFaint;
    const HEADER = 16;
    const STRIDE = 10;

    // Filter stars within magnitude limit
    const magRange = magFaint - magBright;
    const magLimitNorm = magRange > 0 ? (magLimit - magBright) / magRange : 1;
    let starCount = 0;
    for (let i = 0; i < count; i++) {
      if (view.getUint8(HEADER + i * STRIDE + 6) / 255 <= magLimitNorm) starCount++;
    }

    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);
    const mags = new Float32Array(starCount);
    let idx = 0;

    for (let i = 0; i < count; i++) {
      const off = HEADER + i * STRIDE;
      const magNorm = view.getUint8(off + 6) / 255;
      if (magNorm > magLimitNorm) continue;

      positions[idx * 3]     = view.getInt16(off, true) / 0x7FFF;
      positions[idx * 3 + 1] = view.getInt16(off + 2, true) / 0x7FFF;
      positions[idx * 3 + 2] = view.getInt16(off + 4, true) / 0x7FFF;
      mags[idx] = magNorm;
      colors[idx * 3]     = view.getUint8(off + 7) / 255;
      colors[idx * 3 + 1] = view.getUint8(off + 8) / 255;
      colors[idx * 3 + 2] = view.getUint8(off + 9) / 255;
      idx++;
    }

    this.buildPoints(positions, colors, mags, idx, maxSize);
    console.log(`[Cosmolabe] StarField: ${idx} stars (mag ${magBright.toFixed(1)} to ${magLimit.toFixed(1)})`);
  }

  /**
   * Parse v1 legacy format (20 bytes/star: 5×Float32 x,y,z,mag,bv).
   * Converts B-V to black body colors at load time.
   */
  private parseLegacyFormat(view: DataView, options: StarFieldOptions): void {
    const count = view.getUint32(4, true);
    const maxSize = options.maxSize ?? 3.5;
    const magLimit = options.magLimit ?? 6.5;
    const HEADER = 8;
    const STRIDE = 20;

    let magBright = 10;
    let starCount = 0;
    for (let i = 0; i < count; i++) {
      const mag = view.getFloat32(HEADER + i * STRIDE + 12, true);
      if (mag < -10 || mag > magLimit) continue;
      if (mag < magBright) magBright = mag;
      starCount++;
    }

    const magFaint = magLimit;
    const magRange = magFaint - magBright;
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);
    const mags = new Float32Array(starCount);
    let idx = 0;

    for (let i = 0; i < count; i++) {
      const off = HEADER + i * STRIDE;
      const mag = view.getFloat32(off + 12, true);
      if (mag < -10 || mag > magLimit) continue;

      positions[idx * 3]     = view.getFloat32(off, true);
      positions[idx * 3 + 1] = view.getFloat32(off + 4, true);
      positions[idx * 3 + 2] = view.getFloat32(off + 8, true);
      mags[idx] = magRange > 0 ? (mag - magBright) / magRange : 0;

      const bv = view.getFloat32(off + 16, true);
      const [r, g, b] = bvToBlackBodyRGB(isNaN(bv) ? 0.65 : bv);
      colors[idx * 3] = r;
      colors[idx * 3 + 1] = g;
      colors[idx * 3 + 2] = b;
      idx++;
    }

    this.buildPoints(positions, colors, mags, idx, maxSize);
    console.log(`[Cosmolabe] StarField: ${idx} stars (mag ${magBright.toFixed(1)} to ${magFaint.toFixed(1)}), legacy format`);
  }

  private buildRandom(options: StarFieldOptions): void {
    const count = 5000;
    const maxSize = options.maxSize ?? 2.0;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const mags = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const theta = Math.random() * 2 * Math.PI;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = Math.cos(phi);
      colors[i * 3] = 1;
      colors[i * 3 + 1] = 1;
      colors[i * 3 + 2] = 1;
      mags[i] = Math.random();
    }

    this.buildPoints(positions, colors, mags, count, maxSize);
  }

  private buildPoints(
    positions: Float32Array,
    colors: Float32Array,
    mags: Float32Array,
    count: number,
    maxSize: number,
  ): void {
    if (this.points) {
      this.points.geometry.dispose();
      (this.points.material as THREE.Material).dispose();
      this.remove(this.points);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(0, count * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors.slice(0, count * 3), 3));
    geometry.setAttribute('aMag', new THREE.BufferAttribute(mags.slice(0, count), 1));

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uMaxSize: { value: maxSize },
      },
      vertexShader: /* glsl */ `
        attribute float aMag;
        uniform float uMaxSize;
        varying vec3 vColor;
        void main() {
          // aMag: 0 = brightest, 1 = faintest (normalized magnitude).
          // Magnitude is already a log scale (each step = 2.512× flux),
          // so linear-in-magnitude gives correct perceptual brightness on screen.
          float t = 1.0 - aMag;

          // Brightness: linear ramp with floor so faintest stars remain visible
          float brightness = 0.15 + 0.85 * t;

          // Color: pre-baked spectral chromaticity × brightness
          vColor = color * brightness;

          // Variable point size: cubic curve — only the brightest stars
          // get noticeably larger, dim stars stay at minimum 2px.
          gl_PointSize = 2.0 + (uMaxSize - 2.0) * t * t * t;

          // Skybox: strip translation from modelView, keep only rotation.
          // Stars are at infinity — camera movement doesn't affect them.
          vec3 viewDir = mat3(modelViewMatrix) * position;
          vec4 clipPos = projectionMatrix * vec4(viewDir, 1.0);
          // Push to far plane so stars are always behind everything
          clipPos.z = clipPos.w;
          gl_Position = clipPos;
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

/**
 * B-V color index → linear sRGB unit chromaticity via black body radiation.
 * Used for legacy v1 format conversion at load time.
 */
function bvToBlackBodyRGB(bv: number): [number, number, number] {
  const bvClamped = Math.max(-0.4, Math.min(2.0, bv));
  const T = 4600 * (1 / (0.92 * bvClamped + 1.7) + 1 / (0.92 * bvClamped + 0.62));

  const T2 = T * T;
  const u = (0.860117757 + 1.54118254e-4 * T + 1.28641212e-7 * T2) /
            (1 + 8.42420235e-4 * T + 7.08145163e-7 * T2);
  const v = (0.317398726 + 4.22806245e-5 * T + 4.20481691e-8 * T2) /
            (1 - 2.89741816e-5 * T + 1.61456053e-7 * T2);

  const denom = 2 * u - 8 * v + 4;
  const x = (3 * u) / denom;
  const y = (2 * v) / denom;

  const Y = 1;
  const X = y > 0 ? (x * Y) / y : 0;
  const Z = y > 0 ? ((1 - x - y) * Y) / y : 0;

  let r =  3.2406255 * X - 1.5372080 * Y - 0.4986286 * Z;
  let g = -0.9689307 * X + 1.8757561 * Y + 0.0415175 * Z;
  let b =  0.0557101 * X - 0.2040211 * Y + 1.0569959 * Z;

  r = Math.max(0, r);
  g = Math.max(0, g);
  b = Math.max(0, b);

  const maxC = Math.max(r, g, b);
  if (maxC > 0) return [r / maxC, g / maxC, b / maxC];
  return [1, 1, 1];
}
