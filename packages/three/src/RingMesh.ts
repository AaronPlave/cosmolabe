import * as THREE from 'three';
import { DDSLoader } from 'three/examples/jsm/loaders/DDSLoader.js';

/** Check if an ArrayBuffer starts with the DDS magic bytes "DDS " (0x44445320) */
function isDDSMagic(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const h = new Uint8Array(buffer, 0, 4);
  return h[0] === 0x44 && h[1] === 0x44 && h[2] === 0x53 && h[3] === 0x20;
}

/**
 * Planetary ring (e.g. Saturn's rings).
 *
 * Creates a flat annulus in the equatorial plane with UV mapping
 * suitable for radial ring textures (U=0 at inner edge, U=1 at outer).
 * The ring inherits orientation from its parent body via SPICE rotation.
 */
export class RingMesh extends THREE.Object3D {
  readonly innerRadius: number;
  readonly outerRadius: number;
  private ringMesh: THREE.Mesh;

  constructor(innerRadius: number, outerRadius: number) {
    super();
    this.innerRadius = innerRadius;
    this.outerRadius = outerRadius;
    this.frustumCulled = false;

    const geometry = this.createRingGeometry(innerRadius, outerRadius);
    // Normal blending with alpha: ring texture alpha controls transparency
    // (gaps between ring divisions). Without a texture, a subtle flat color
    // is shown as a placeholder.
    const material = new THREE.MeshBasicMaterial({
      color: 0xccbb99,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    });

    this.ringMesh = new THREE.Mesh(geometry, material);
    this.ringMesh.frustumCulled = false;
    this.add(this.ringMesh);
  }

  /**
   * Load a ring texture. The texture is a radial cross-section strip:
   * left edge = inner radius, right edge = outer radius.
   * Alpha channel controls ring transparency (gaps between ring divisions).
   */
  async loadTexture(url: string): Promise<void> {
    try {
      let texture: THREE.Texture;

      // Detect format: extension for regular URLs, magic bytes for blob URLs
      let isDDS: boolean;
      let fetchedBuffer: ArrayBuffer | undefined;
      if (url.startsWith('blob:')) {
        const resp = await fetch(url);
        fetchedBuffer = await resp.arrayBuffer();
        isDDS = isDDSMagic(fetchedBuffer);
      } else {
        isDDS = url.split('.').pop()?.toLowerCase() === 'dds';
      }

      if (isDDS) {
        if (!fetchedBuffer) {
          const resp = await fetch(url);
          fetchedBuffer = await resp.arrayBuffer();
        }
        const loader = new DDSLoader();
        const texData = loader.parse(fetchedBuffer, false);
        const ct = new THREE.CompressedTexture(
          texData.mipmaps, texData.width, texData.height,
          texData.format as THREE.CompressedPixelFormat,
        );
        ct.minFilter = texData.mipmaps.length === 1 ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
        ct.magFilter = THREE.LinearFilter;
        ct.needsUpdate = true;
        texture = ct;
      } else {
        texture = await new THREE.TextureLoader().loadAsync(url);
      }
      texture.colorSpace = THREE.SRGBColorSpace;

      const material = this.ringMesh.material as THREE.MeshBasicMaterial;
      material.map = texture;
      material.color.setHex(0xffffff);
      material.opacity = 1.0;  // Texture alpha handles gap transparency
      material.alphaTest = 0.01; // Discard fully transparent pixels
      material.needsUpdate = true;
      console.log(`[SpiceCraft] Loaded ring texture: ${url}`);
    } catch (e) {
      console.warn(`[SpiceCraft] Failed to load ring texture:`, e);
    }
  }

  /**
   * Apply scale factor accounting for the ring being in the equatorial plane.
   * The ring geometry is in the XZ plane (Y=0), and the parent BodyMesh's
   * Globe pre-rotation (rotateX π/2) maps this to the body-fixed equatorial plane.
   */
  applyScale(factor: number): void {
    this.ringMesh.scale.setScalar(factor);
  }

  dispose(): void {
    this.ringMesh.geometry.dispose();
    const mat = this.ringMesh.material as THREE.Material;
    mat.dispose();
  }

  /**
   * Create annulus geometry with radial UV mapping.
   * U = radial position (0=inner, 1=outer), V = 0.5 (texture is 1D radial strip).
   */
  private createRingGeometry(inner: number, outer: number, segments = 128): THREE.BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * 2 * Math.PI;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);

      // Inner vertex (in XZ plane, Y=0)
      positions.push(inner * cos, 0, inner * sin);
      normals.push(0, 1, 0);
      uvs.push(0, 0.5);

      // Outer vertex
      positions.push(outer * cos, 0, outer * sin);
      normals.push(0, 1, 0);
      uvs.push(1, 0.5);

      if (i < segments) {
        const base = i * 2;
        // Two triangles per quad
        indices.push(base, base + 2, base + 1);
        indices.push(base + 1, base + 2, base + 3);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);

    return geometry;
  }
}
