import * as THREE from 'three';
import type { SunVisual } from './SunVisual.js';
import { isMesh, isLine, isPoints, isSprite } from './internal/three-typeguards.js';

/** One solar-only HDR/depth pass and a bounded two-scale optical halo.
 * Source sampling happens after opaque occlusion and atmospheric transmission.
 * No scene overlay, star point, or generic emissive object can enter this pass.
 */
export class SunGlareEffect {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly signalTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private readonly blurTargets = Array.from({ length: 3 }, () =>
    new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }));
  private readonly blurScene = new THREE.Scene();
  private readonly blurQuad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly dark = new THREE.MeshBasicMaterial({ color: 0 });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly size = new THREE.Vector2();
  private readonly projected = new THREE.Vector3();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.blurQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: { source: { value: this.target.texture }, stepUV: { value: new THREE.Vector2() } },
      vertexShader: `varying vec2 uvScreen;
        void main() { uvScreen = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `uniform sampler2D source; uniform vec2 stepUV; varying vec2 uvScreen;
        void main() {
          vec3 signal = vec3(0.0); float total = 0.0;
          for (int i = -4; i <= 4; i++) {
            float offset = float(i) * 0.5;
            float weight = exp(-0.5 * offset * offset);
            vec2 sampleUV = uvScreen + stepUV * offset;
            if (all(greaterThanEqual(sampleUV, vec2(0.0))) && all(lessThanEqual(sampleUV, vec2(1.0))))
              signal += texture2D(source, sampleUV).rgb * weight;
            total += weight;
          }
          gl_FragColor = vec4(signal / total, 1.0);
        }`,
      depthTest: false, depthWrite: false, toneMapped: false,
    }));
    this.blurQuad.frustumCulled = false;
    this.blurScene.add(this.blurQuad);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: {
        source: { value: this.target.texture },
        resolveSignal: { value: false },
        pointSignal: { value: this.signalTarget.texture },
        compactTex: { value: this.blurTargets[1].texture },
        tailTex: { value: this.blurTargets[2].texture },
        sourceCenter: { value: new THREE.Vector2() },
        sourceRadius: { value: new THREE.Vector2() },
        haloRadius: { value: 1 },
        unresolved: { value: 0 },
        strength: { value: 1 },
        quadCenter: { value: new THREE.Vector2() },
        quadSize: { value: new THREE.Vector2() },
      },
      vertexShader: /* glsl */ `
        uniform vec2 quadCenter, quadSize;
        uniform bool resolveSignal;
        varying vec2 p;
        void main() {
          p = position.xy;
          gl_Position = resolveSignal ? vec4(position.xy, 0.0, 1.0) :
            vec4(quadCenter + position.xy * quadSize, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D source, pointSignal, compactTex, tailTex;
        uniform bool resolveSignal;
        uniform vec2 quadSize;
        uniform vec2 sourceCenter, sourceRadius;
        uniform float haloRadius, unresolved, strength;
        varying vec2 p;
        void main() {
          // A deterministic equal-area disk quadrature. Hidden portions of the
          // photosphere contribute zero; a total eclipse leaves no optical halo.
          vec3 signal = vec3(0.0);
          if (resolveSignal) {
            for (int i = 0; i < 32; i++) {
              float r = sqrt((float(i) + 0.5) / 32.0);
              float a = float(i) * 2.39996323;
              vec2 uv = sourceCenter + sourceRadius * r * vec2(cos(a), sin(a));
              if (all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0))))
                signal += texture2D(source, uv).rgb / 32.0;
            }
            gl_FragColor = vec4(signal, 1.0);
            return;
          }
          // Preserve the spatial occultation/transmission mask in both scales.
          // Averaging a half-visible disk into one scalar creates a false full ring.
          vec2 screenUV = sourceCenter + p * quadSize * 0.5;
          vec3 raw = texture2D(source, screenUV).rgb;
          float outsideSource = 1.0 - smoothstep(0.001, 0.1, max(raw.r, max(raw.g, raw.b)));
          vec3 glare = (0.07 * texture2D(compactTex, screenUV).rgb +
            0.007 * texture2D(tailTex, screenUV).rgb) * outsideSource * strength;
          float radius = length(p) * haloRadius;
          float point = unresolved * exp(-0.5 * radius * radius);
          glare += texture2D(pointSignal, vec2(0.5)).rgb * point;
          gl_FragColor = vec4(glare, 1.0);
          #include <colorspace_fragment>
        }
      `,
      transparent: true, blending: THREE.AdditiveBlending,
      depthTest: false, depthWrite: false, toneMapped: false,
    }));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera,
    sources: ReadonlyMap<THREE.Mesh, SunVisual>, strength = 1): void {
    this.renderer.getDrawingBufferSize(this.size);
    const visible = [...sources].filter(([mesh, visual]) => {
      if (!mesh.visible || !mesh.parent?.visible) return false;
      mesh.getWorldPosition(this.projected).applyMatrix4(camera.matrixWorldInverse);
      if (this.projected.z >= 0) return false;
      this.projected.applyMatrix4(camera.projectionMatrix);
      const halo = visual.diameterPixels / 2 + 60;
      return Math.abs(this.projected.x) < 1 + 2 * halo / this.size.x &&
        Math.abs(this.projected.y) < 1 + 2 * halo / this.size.y;
    });
    if (visible.length === 0) return;
    if (this.target.width !== this.size.x || this.target.height !== this.size.y)
      this.target.setSize(this.size.x, this.size.y);
    for (const target of this.blurTargets) {
      const width = Math.ceil(this.size.x / 2), height = Math.ceil(this.size.y / 2);
      if (target.width !== width || target.height !== height) target.setSize(width, height);
    }
    const savedTarget = this.renderer.getRenderTarget();
    const savedClear = this.renderer.getClearColor(new THREE.Color());
    const savedAlpha = this.renderer.getClearAlpha();
    const savedAutoClear = this.renderer.autoClear;
    const savedMask = camera.layers.mask;
    const savedBackground = scene.background;
    const spheres: THREE.Mesh<THREE.SphereGeometry>[] = [];
    const materials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    const visibility = new Map<THREE.Object3D, boolean>();
    try {
      scene.traverse(obj => {
        if (isMesh(obj) && sources.has(obj)) return;
        if (isMesh(obj)) {
          const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
          if (!mat.transparent && mat.depthWrite) {
            if (obj.geometry instanceof THREE.SphereGeometry && (obj.visible ||
                (obj.parent && 'hasTerrain' in obj.parent && obj.parent.hasTerrain))) {
              obj.updateWorldMatrix(true, false);
              spheres.push(obj as THREE.Mesh<THREE.SphereGeometry>);
            }
            materials.set(obj, obj.material);
            obj.material = this.dark;
            // A body sphere still occludes when its terrain owns the visible surface.
            visibility.set(obj, obj.visible);
            const owner = obj.parent;
            if (owner && (('hasTerrain' in owner && owner.hasTerrain) ||
                ('hasSurfaceTiles' in owner && owner.hasSurfaceTiles))) obj.visible = true;
            return;
          }
        }
        if (isMesh(obj) || isLine(obj) || isPoints(obj) || isSprite(obj)) {
          visibility.set(obj, obj.visible);
          obj.visible = false;
        }
      });
      for (const [source, visual] of visible) {
        visual.uniforms.sourcePass.value = true;
        visual.uniforms.occluderCount.value = 0;
        if (visual.uniforms.sourceScale.value <= 1) continue;
        const sourceCenter = source.getWorldPosition(new THREE.Vector3());
        const toSource = sourceCenter.clone().sub(camera.position);
        const distance = toSource.length();
        const direction = toSource.divideScalar(distance);
        const solarRadius = source.geometry.boundingSphere?.radius ??
          (source.geometry instanceof THREE.SphereGeometry ? source.geometry.parameters.radius : 0);
        const worldSolarRadius = solarRadius * source.matrixWorld.getMaxScaleOnAxis();
        const candidates = spheres.map(mesh => {
          const offset = mesh.getWorldPosition(new THREE.Vector3()).sub(camera.position);
          const along = offset.dot(direction);
          const radius = mesh.geometry.parameters.radius * mesh.matrixWorld.getMaxScaleOnAxis();
          const margin = radius + worldSolarRadius * Math.max(0, along) / distance;
          return { mesh, along, overlaps: along > 0 && along < distance &&
            offset.lengthSq() - along * along < margin * margin };
        }).filter(c => c.overlaps).sort((a, b) => a.along - b.along).slice(0, 8);
        visual.uniforms.occluderCount.value = candidates.length;
        candidates.forEach(({ mesh }, i) => {
          visual.uniforms.worldToOccluder.value[i].copy(mesh.matrixWorld).invert();
          visual.uniforms.occluderRadius.value[i] = mesh.geometry.parameters.radius;
        });
      }
      scene.background = null;
      camera.layers.enableAll();
      this.renderer.autoClear = true;
      this.renderer.setClearColor(0, 1);
      this.renderer.setRenderTarget(this.target);
      this.renderer.render(scene, camera);
    } finally {
      for (const [, visual] of sources) visual.uniforms.sourcePass.value = false;
      for (const [mesh, material] of materials) mesh.material = material;
      for (const [obj, value] of visibility) obj.visible = value;
      scene.background = savedBackground;
      camera.layers.mask = savedMask;
      this.renderer.setRenderTarget(savedTarget);
      this.renderer.setClearColor(savedClear, savedAlpha);
      this.renderer.autoClear = savedAutoClear;
    }
    try {
      this.renderer.autoClear = false;
      const u = this.quad.material.uniforms;
      u.strength.value = strength;
      for (const [mesh, visual] of visible) {
        mesh.getWorldPosition(this.projected);
        this.projected.applyMatrix4(camera.matrixWorldInverse);
        if (this.projected.z >= 0) continue;
        this.projected.applyMatrix4(camera.projectionMatrix);
        const disk = visual.diameterPixels / 2;
        const sigma = THREE.MathUtils.clamp(disk * 0.12, 1.5, 6);
        const halo = disk + sigma * 10;
        u.sourceCenter.value.set((this.projected.x + 1) / 2, (this.projected.y + 1) / 2);
        const sourceRadius = Math.max(1, disk);
        u.sourceRadius.value.set(sourceRadius / this.size.x, sourceRadius / this.size.y);
        u.quadCenter.value.set(this.projected.x, this.projected.y);
        u.quadSize.value.set(halo * 2 / this.size.x, halo * 2 / this.size.y);
        u.haloRadius.value = halo;
        u.unresolved.value = 1 - visual.uniforms.resolvedWeight.value;
        this.renderer.setClearColor(0, 0);
        const blur = this.blurQuad.material.uniforms;
        const drawBlur = (target: THREE.WebGLRenderTarget) => {
          // Clear old source positions, but shade only the Sun + its halo bounds.
          // A small Sun should not run four filters across the entire viewport.
          target.scissorTest = false;
          this.renderer.setRenderTarget(target);
          this.renderer.clear();
          const x = u.sourceCenter.value.x * target.width;
          const y = u.sourceCenter.value.y * target.height;
          const padX = halo * target.width / this.size.x;
          const padY = halo * target.height / this.size.y;
          const left = THREE.MathUtils.clamp(Math.floor(x - padX), 0, target.width);
          const bottom = THREE.MathUtils.clamp(Math.floor(y - padY), 0, target.height);
          const right = THREE.MathUtils.clamp(Math.ceil(x + padX), 0, target.width);
          const top = THREE.MathUtils.clamp(Math.ceil(y + padY), 0, target.height);
          target.scissor.set(left, bottom, right - left, top - bottom);
          target.scissorTest = true;
          this.renderer.setRenderTarget(target);
          this.renderer.render(this.blurScene, this.camera);
        };
        for (const [width, target] of [[sigma, this.blurTargets[1]], [sigma * 3, this.blurTargets[2]]] as const) {
          blur.source.value = this.target.texture;
          blur.stepUV.value.set(width / this.size.x, 0);
          drawBlur(this.blurTargets[0]);
          blur.source.value = this.blurTargets[0].texture;
          blur.stepUV.value.set(0, width / this.size.y);
          drawBlur(target);
        }
        // Only the unresolved point needs total flux, rather than a spatial image.
        if (u.unresolved.value > 0) {
          u.resolveSignal.value = true;
          u.source.value = this.target.texture;
          u.pointSignal.value = this.target.texture;
          this.renderer.setRenderTarget(this.signalTarget);
          this.renderer.clear();
          this.renderer.render(this.scene, this.camera);
          u.resolveSignal.value = false;
          u.pointSignal.value = this.signalTarget.texture;
        }
        u.source.value = this.target.texture;
        this.renderer.setRenderTarget(savedTarget);
        this.renderer.setClearColor(savedClear, savedAlpha);
        this.renderer.render(this.scene, this.camera);
      }
    } finally {
      this.renderer.setRenderTarget(savedTarget);
      this.renderer.setClearColor(savedClear, savedAlpha);
      this.quad.material.uniforms.resolveSignal.value = false;
      this.renderer.autoClear = savedAutoClear;
    }
  }

  dispose(): void {
    this.target.dispose();
    this.signalTarget.dispose();
    for (const target of this.blurTargets) target.dispose();
    this.blurQuad.geometry.dispose();
    this.blurQuad.material.dispose();
    this.dark.dispose();
    this.quad.geometry.dispose();
    this.quad.material.dispose();
  }
}
