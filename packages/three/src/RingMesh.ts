import * as THREE from 'three';
import { DDSLoader } from 'three/examples/jsm/loaders/DDSLoader.js';
import {
  injectShadowIntoShader,
  makeShadowUniforms,
  MAX_SHADOW_OCCLUDERS,
  type ShadowUniforms,
} from './EclipseShadow.js';

/** Check if an ArrayBuffer starts with the DDS magic bytes "DDS " (0x44445320) */
function isDDSMagic(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const h = new Uint8Array(buffer, 0, 4);
  return h[0] === 0x44 && h[1] === 0x44 && h[2] === 0x53 && h[3] === 0x20;
}

// Ring lighting injected after the eclipse-shadow injection. Reuses
// vShadowWorldPos / uSunWorldPos declared by SHADOW_FRAG_PARS.
const RING_FRAG_PARS = /* glsl */`
varying vec3 vRingWorldNormal;

float computeRingLighting() {
  vec3 N = normalize(vRingWorldNormal);
  vec3 L = normalize(uSunWorldPos - vShadowWorldPos);
  vec3 V = normalize(cameraPosition - vShadowWorldPos);
  // Rings are double-sided — abs() lights both faces.
  float NdotL = abs(dot(N, L));
  // When the camera and sun are on the same side of the ring plane, the ring
  // is seen by reflection (bright). On opposite sides it is seen by
  // transmission through partially transparent particles (dimmer).
  float sameSide = step(0.0, dot(N, L) * dot(N, V));
  // Multi-scatter inside the ring keeps the lit side bright even at oblique
  // sun angles; back-lit transmission is noticeably dimmer.
  float refl  = 0.5  + 0.5  * NdotL;
  float trans = 0.15 + 0.25 * NdotL;
  return mix(trans, refl, sameSide);
}
`;

/**
 * Planetary ring (e.g. Saturn's rings).
 *
 * Creates a flat annulus in the equatorial plane with UV mapping
 * suitable for radial ring textures (U=0 at inner edge, U=1 at outer).
 * The ring inherits orientation from its parent body via SPICE rotation.
 *
 * Shading: sun-direction Lambertian (double-sided) plus an eclipse shadow
 * from the parent body so the planet's shadow falls correctly on the rings.
 */
export class RingMesh extends THREE.Object3D {
  readonly innerRadius: number;
  readonly outerRadius: number;
  private ringMesh: THREE.Mesh;
  /** Shared uniforms patched into the compiled program by reference. */
  private readonly shadowUniforms: ShadowUniforms = makeShadowUniforms();

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
      // Write depth where alphaTest passes (opaque ring material). This lets
      // the atmosphere shell — which keeps depthWrite=false — correctly draw
      // IN FRONT only where it's physically closer than the rings, and BEHIND
      // where the rings occlude it. Transparent gaps (Cassini Division, etc.)
      // discard via alphaTest and so don't write depth.
      depthWrite: true,
    });
    this.injectRingShading(material);

    this.ringMesh = new THREE.Mesh(geometry, material);
    this.ringMesh.frustumCulled = false;
    this.add(this.ringMesh);
  }

  /** Inject sun illumination + parent-planet eclipse shadow into the ring material. */
  private injectRingShading(mat: THREE.MeshBasicMaterial): void {
    const su = this.shadowUniforms;
    const matExt = mat as THREE.MeshBasicMaterial & {
      onBeforeCompile: (shader: {
        vertexShader: string;
        fragmentShader: string;
        uniforms: Record<string, unknown>;
      }) => void;
      customProgramCacheKey: () => string;
    };
    matExt.onBeforeCompile = (shader) => {
      injectShadowIntoShader(shader, su as unknown as Record<string, { value: unknown }>);
      // Add ring world-normal varying. injectShadowIntoShader has already
      // inserted `vShadowWorldPos = ...` after <project_vertex>; append the
      // normal assignment to the same line so we don't depend on the chunk
      // tag still being present.
      shader.vertexShader = 'varying vec3 vRingWorldNormal;\n' +
        shader.vertexShader.replace(
          'vShadowWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
          'vShadowWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n' +
          'vRingWorldNormal = normalize(mat3(modelMatrix) * normal);',
        );
      // Insert ring lighting AFTER the shadow uniforms (so it sees
      // uSunWorldPos / vShadowWorldPos) and BEFORE computeEclipseShadow.
      // Then multiply outgoingLight by it alongside the shadow factor that
      // injectShadowIntoShader already installed.
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'float computeEclipseShadow()',
          RING_FRAG_PARS + '\nfloat computeEclipseShadow()',
        )
        .replace(
          'outgoingLight *= computeEclipseShadow();',
          'outgoingLight *= computeEclipseShadow() * computeRingLighting();',
        );
    };
    matExt.customProgramCacheKey = () => 'ring_shading_v1';
    mat.needsUpdate = true;
  }

  /**
   * Update eclipse shadow occluder uniforms for this frame.
   * For rings, the parent body is typically the dominant occluder.
   */
  setShadowOccluders(
    occluders: { pos: THREE.Vector3; radius: number }[],
    sunPos: THREE.Vector3,
    sunRadius: number,
  ): void {
    const u = this.shadowUniforms;
    const count = Math.min(occluders.length, MAX_SHADOW_OCCLUDERS);
    u.uShadowOccluderCount.value = count;
    u.uSunWorldPos.value.copy(sunPos);
    u.uSunRadius.value = sunRadius;
    for (let i = 0; i < count; i++) {
      u.uShadowOccluderPos.value[i].copy(occluders[i].pos);
      u.uShadowOccluderRadius.value[i] = occluders[i].radius;
    }
  }

  /**
   * Load a ring texture. The texture is a radial cross-section strip:
   * left edge = inner radius, right edge = outer radius.
   * Alpha channel controls ring transparency (gaps between ring divisions).
   */
  async loadTexture(url: string): Promise<THREE.Texture | null> {
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
      console.log(`[Cosmolabe] Loaded ring texture: ${url}`);
      return texture;
    } catch (e) {
      console.warn(`[Cosmolabe] Failed to load ring texture:`, e);
      return null;
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
