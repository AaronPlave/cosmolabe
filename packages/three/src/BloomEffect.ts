import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/**
 * Layer reserved for bloom-eligible objects (Sun, engine plumes, glowing instruments).
 * Objects on this layer are rendered into the bloom offscreen target and produce a
 * glow that is additively composited over the main canvas.
 *
 * Use `mesh.layers.enable(BLOOM_LAYER)` to opt in (the mesh stays visible in its
 * normal layer too).
 */
export const BLOOM_LAYER = 3;

export interface BloomConfig {
  /** Whether the bloom pass runs. Default true. */
  enabled?: boolean;
  /** Bloom intensity multiplier. Default 0.8. */
  strength?: number;
  /** Bloom blur radius. Default 0.4. */
  radius?: number;
  /** Luminance threshold below which fragments don't bloom. Default 0.5 — only the brightest
   *  parts of emissive bodies (Sun core) glow, leaving the disk gradient visible. */
  threshold?: number;
}

/**
 * Selective bloom overlay.
 *
 * Renders the full scene into an offscreen target with all non-{@link BLOOM_LAYER}
 * meshes temporarily swapped to a flat black material — this way the blacked-out
 * geometry still writes depth and properly occludes bloom-layer objects (e.g.
 * Earth correctly hides the Sun when it's behind). UnrealBloomPass then blooms
 * only the bright (non-black) pixels, and the result is additively composited
 * over the host canvas.
 *
 * The host renderer's existing multi-pass pipeline is untouched.
 */
export class BloomEffect {
  enabled: boolean;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly bloomComposer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly bloomPass: UnrealBloomPass;

  private readonly darkMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
  private readonly originalMaterials = new Map<string, THREE.Material | THREE.Material[]>();
  private readonly forcedVisibleMeshes: THREE.Mesh[] = [];
  private readonly hiddenNonMesh: THREE.Object3D[] = [];

  private readonly compositeScene: THREE.Scene;
  private readonly compositeCamera: THREE.OrthographicCamera;
  private readonly compositeMaterial: THREE.ShaderMaterial;
  private readonly compositeQuad: THREE.Mesh;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    width: number,
    height: number,
    config: BloomConfig = {},
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.enabled = config.enabled ?? true;

    const renderTarget = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      magFilter: THREE.LinearFilter,
      minFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });

    this.bloomComposer = new EffectComposer(renderer, renderTarget);
    this.bloomComposer.renderToScreen = false;

    this.renderPass = new RenderPass(scene, camera);
    this.renderPass.clearColor = new THREE.Color(0, 0, 0);
    this.renderPass.clearAlpha = 1;
    this.bloomComposer.addPass(this.renderPass);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      config.strength ?? 0.8,
      config.radius ?? 0.4,
      config.threshold ?? 0.5,
    );
    this.bloomComposer.addPass(this.bloomPass);

    this.compositeScene = new THREE.Scene();
    this.compositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        bloomTex: { value: this.bloomComposer.renderTarget2.texture },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D bloomTex;
        varying vec2 vUv;
        void main() {
          gl_FragColor = texture2D(bloomTex, vUv);
        }
      `,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.compositeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMaterial);
    this.compositeQuad.frustumCulled = false;
    this.compositeScene.add(this.compositeQuad);
  }

  setSize(width: number, height: number): void {
    this.bloomComposer.setSize(width, height);
    this.bloomPass.setSize(width, height);
  }

  setConfig(config: BloomConfig): void {
    if (config.enabled !== undefined) this.enabled = config.enabled;
    if (config.strength !== undefined) this.bloomPass.strength = config.strength;
    if (config.radius !== undefined) this.bloomPass.radius = config.radius;
    if (config.threshold !== undefined) this.bloomPass.threshold = config.threshold;
  }

  get strength(): number { return this.bloomPass.strength; }
  get radius(): number { return this.bloomPass.radius; }
  get threshold(): number { return this.bloomPass.threshold; }

  /**
   * Render the bloom layer offscreen and additively composite it over the canvas.
   *
   * Renders the full scene into the bloom target with non-bloom meshes swapped
   * to a flat black material — they still write depth and occlude bloom-layer
   * objects, so e.g. the Sun is correctly hidden behind Earth on the dark side.
   */
  render(): void {
    if (!this.enabled) return;

    this.darkenNonBloom();

    const savedTarget = this.renderer.getRenderTarget();
    // RenderPass holds its own scene/camera refs (the live host scene + camera).
    // We rely on the camera's current layer mask, which the host renderer leaves
    // at enableAll() before this point — so all geometry contributes depth.
    this.bloomComposer.render();
    this.renderer.setRenderTarget(savedTarget);

    this.restoreMaterials();

    const savedAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.render(this.compositeScene, this.compositeCamera);
    this.renderer.autoClear = savedAutoClear;
  }

  /**
   * For non-bloom-layer objects:
   *   - Meshes: swap to a black `MeshBasicMaterial` so they still write depth and occlude bloom-layer objects.
   *   - Lines / Points / Sprites: hide entirely, since they would otherwise contribute bright color into the
   *     bloom RT (trajectory lines, sensor frustums, star points) and bloom alongside the Sun. They aren't
   *     meaningful occluders for the Sun anyway.
   */
  private darkenNonBloom(): void {
    this.scene.traverse((obj) => {
      if (obj.layers.test(_bloomTestLayers)) return;

      if (obj instanceof THREE.Mesh) {
        // Transparent / non-depth-writing meshes (atmosphere shells, rings) are
        // visual overlays. Hide them in the bloom pass — using them as occluders
        // dims a planet-shell-shaped region across the screen, which is wrong for
        // the Sun behind atmosphere problem (a real fix needs path-length-aware
        // attenuation in the atmosphere shader itself).
        const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
        if (mat && (mat.transparent || mat.depthWrite === false)) {
          if (obj.visible) {
            obj.visible = false;
            this.hiddenNonMesh.push(obj);
          }
          return;
        }
        this.originalMaterials.set(obj.uuid, obj.material);
        obj.material = this.darkMaterial;
        // Mesh may be hidden by host LOD logic (e.g. body sphere hidden when 3D-tile
        // terrain takes over). For bloom occlusion we need it to render anyway —
        // force-visible while we have the dark material on.
        if (!obj.visible) {
          obj.visible = true;
          this.forcedVisibleMeshes.push(obj);
        }
      } else if (
        obj instanceof THREE.Line
        || obj instanceof THREE.Points
        || obj instanceof THREE.Sprite
      ) {
        if (obj.visible) {
          obj.visible = false;
          this.hiddenNonMesh.push(obj);
        }
      }
    });
  }

  private restoreMaterials(): void {
    if (this.originalMaterials.size > 0) {
      this.scene.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        const mat = this.originalMaterials.get(obj.uuid);
        if (mat) obj.material = mat;
      });
      this.originalMaterials.clear();
    }
    if (this.forcedVisibleMeshes.length > 0) {
      for (const m of this.forcedVisibleMeshes) m.visible = false;
      this.forcedVisibleMeshes.length = 0;
    }
    if (this.hiddenNonMesh.length > 0) {
      for (const obj of this.hiddenNonMesh) obj.visible = true;
      this.hiddenNonMesh.length = 0;
    }
  }

  dispose(): void {
    this.bloomComposer.dispose();
    this.compositeMaterial.dispose();
    this.compositeQuad.geometry.dispose();
    this.darkMaterial.dispose();
  }
}

/** Reusable Layers object that has only BLOOM_LAYER enabled — used for `mesh.layers.test()`. */
const _bloomTestLayers = /* @__PURE__ */ (() => {
  const l = new THREE.Layers();
  l.set(BLOOM_LAYER);
  return l;
})();
