import * as THREE from 'three';
import { decodeStarCatalog, type DecodedStarCatalog } from './StarCatalog.js';

export interface StarFieldOptions {
  /** URL of the HYG STR2/legacy STAR catalog. Omit to show no stars, not random directions. */
  catalogUrl?: string;
  /**
   * Legacy size control. Now sets a single normalized optical PSF width for
   * all stars, rather than linking magnitude to an invented visible disc.
   * Defaults to 3.5 (sigma 0.875 CSS pixels).
   */
  maxSize?: number;
  /** Faintest apparent magnitude to decode (default: catalog limit). */
  magLimit?: number;
  /**
   * Provisional magnitude-zero linear-light signal in CSS-pixel units.
   * This is a single normalization hook for #212's shared scene exposure, NOT
   * a camera- or FOV-dependent star-specific auto exposure pipeline.
   */
  linearFluxScale?: number;
}

export type StarCatalogStatus =
  | { state: 'unconfigured' }
  | { state: 'loading'; url: string }
  | { state: 'ready'; url: string; count: number; format: 'STR2' | 'STAR' }
  | { state: 'error'; url: string; message: string };

/**
 * HYG stars at infinity, with relative apparent-magnitude flux and a
 * normalized Gaussian point-spread function (PSF) rather than visible disks.
 *
 * m1 vs m2 in a common bandpass: F1/F2 = 10^(-0.4*(m1-m2)).
 * STR2 B-V-derived RGB is only approximate chromaticity, not calibrated
 * detector/spectral flux. The CSS-pixel integral of a star's pre-tone signal
 * is relativeFlux * linearFluxScale, independent of DPR and subpixel phase.
 * Unlike physical source radiance, this provisional signal normalization is
 * intended to be connected to the common scene exposure policy in #212.
 *
 * No Milky Way, twinkle, speculative stars, or Sun/bloom routing.
 */
export class StarField extends THREE.Object3D {
  private points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  private skyBrightness = 0;
  private fluxScale: number;
  private readonly psfSigmaCss: number;
  private requestId = 0;
  private disposed = false;
  private status: StarCatalogStatus = { state: 'unconfigured' };

  constructor(options: StarFieldOptions = {}) {
    super();
    this.renderOrder = -1000;
    this.frustumCulled = false;
    this.fluxScale = StarField.safeFluxScale(options.linearFluxScale ?? 0.06);
    const nominalSize = Number.isFinite(options.maxSize)
      ? options.maxSize! : 3.5;
    this.psfSigmaCss = Math.max(0.7, Math.min(2.5, nominalSize / 4));

    if (options.catalogUrl) void this.loadCatalog(options.catalogUrl, options);
  }

  private static safeFluxScale(value: number): number {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('StarField linear flux scale must be finite and nonnegative');
    }
    return value;
  }

  /** Metadata for diagnostics/UI; no random placeholder stars on failure. */
  getCatalogStatus(): StarCatalogStatus {
    return { ...this.status };
  }

  /** The fixed relative-flux normalization hook to be driven by #212. */
  setLinearFluxScale(value: number): void {
    this.fluxScale = StarField.safeFluxScale(value);
    if (this.points) this.points.material.uniforms.uLinearFluxScale.value = value;
  }

  /**
   * Transitional scalar atmospheric attenuation, retained for compatibility.
   * Replacing this with direction-dependent extinction is owned by #219.
   */
  setSkyBrightness(value: number): void {
    this.skyBrightness = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    if (this.points) {
      this.points.material.uniforms.uSkyBrightness.value = this.skyBrightness;
    }
  }

  /**
   * Load or reload a catalog. Old geometry is cleared at once so an invalid
   * request never masquerades as a trusted sky. Async responses are guarded
   * against disposal and out-of-order catalog reloads.
   */
  async loadCatalog(url: string, options: StarFieldOptions = {}): Promise<void> {
    if (this.disposed) return;
    const request = ++this.requestId;
    this.clearPoints();
    this.status = { state: 'loading', url };
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const decoded = decodeStarCatalog(await response.arrayBuffer(), options.magLimit);
      if (this.disposed || request !== this.requestId) return;
      this.buildPoints(decoded);
      this.status = { state: 'ready', url, count: decoded.count, format: decoded.format };
      console.info(`[Cosmolabe] StarField: ${decoded.count} HYG stars (${decoded.format})`);
    } catch (err) {
      if (this.disposed || request !== this.requestId) return;
      const message = err instanceof Error ? err.message : String(err);
      this.status = { state: 'error', url, message };
      console.warn(`[Cosmolabe] Star catalog unavailable (${url}): ${message}. No stars rendered.`);
    }
  }

  private buildPoints(data: DecodedStarCatalog): void {
    if (data.count === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.setAttribute('aMagnitude', new THREE.BufferAttribute(data.magnitudes, 1));

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uSigmaCss: { value: this.psfSigmaCss },
        uPixelRatio: { value: 1 },
        uLinearFluxScale: { value: this.fluxScale },
        uSkyBrightness: { value: this.skyBrightness },
      },
      vertexShader: /* glsl */ `
        attribute float aMagnitude;
        uniform float uSigmaCss;
        uniform float uPixelRatio;
        uniform float uLinearFluxScale;
        uniform float uSkyBrightness;
        varying vec3 vColor;
        varying float vSignal;
        varying float vSigmaPx;
        varying float vDiameterPx;
        void main() {
          // Approximate V-band flux, represented in CSS pixel integral units.
          // Divide packed chromaticity by its luminance so colors do not
          // change the relative luminance-flux relationship.
          float y = max(dot(color, vec3(0.2126, 0.7152, 0.0722)), 0.05);
          vColor = color / y;
          vSignal = uLinearFluxScale * pow(10.0, -0.4 * aMagnitude)
                    * uPixelRatio * uPixelRatio * (1.0 - uSkyBrightness);
          vSigmaPx = uSigmaCss * uPixelRatio;
          // A 4-sigma footprint + guard pixels avoids clipping PSF energy.
          // The hardware point size is *support*, not apparent star diameter.
          vDiameterPx = ceil(8.0 * vSigmaPx + 2.0);
          gl_PointSize = vDiameterPx;

          // Strip camera translation: directions are at infinity. Depth test
          // against the real scene so limb/terrain/body silhouettes occlude.
          vec3 direction = mat3(modelViewMatrix) * normalize(position);
          vec4 clip = projectionMatrix * vec4(direction, 1.0);
          if (clip.w <= 0.0) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            gl_PointSize = 0.0;
          } else {
            clip.z = clip.w;
            gl_Position = clip;
          }
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vSignal;
        varying float vSigmaPx;
        varying float vDiameterPx;
        void main() {
          vec2 deltaPx = (gl_PointCoord - vec2(0.5)) * vDiameterPx;
          float r2 = dot(deltaPx, deltaPx);
          // Gaussian normalized to integral 1 over *physical* pixels.
          // Sampled in a broad footprint for stable subpixel motion; vSignal
          // includes DPR squared to preserve CSS-resolution integrated flux.
          float kernel = exp(-0.5 * r2 / (vSigmaPx * vSigmaPx))
                       / (6.28318530718 * vSigmaPx * vSigmaPx);
          gl_FragColor = vec4(vColor * (vSignal * kernel), 1.0);
          // Shared Three renderer output/tone convention, pending the full
          // linear HDR intermediate and display contract in #212.
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      toneMapped: true,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = -1000;
    // Once per draw, not once per star. Supports live DPR changes as well as
    // alternate viewers rendering through the same material.
    points.onBeforeRender = renderer => {
      material.uniforms.uPixelRatio.value = Math.max(1, renderer.getPixelRatio());
    };
    this.points = points;
    this.add(points);
  }

  private clearPoints(): void {
    if (!this.points) return;
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.remove(this.points);
    this.points = null;
  }

  dispose(): void {
    this.disposed = true;
    ++this.requestId;
    this.clearPoints();
  }
}
