import * as THREE from 'three';

/** Annotation-owned cone: true vector orientation, view-relative illumination,
 * and a subpixel dark silhouette independent of scene lighting. */
export class MeasurementArrow extends THREE.Group {
  readonly cone: THREE.Mesh<THREE.ConeGeometry, THREE.ShaderMaterial>;
  readonly outline: THREE.Mesh<THREE.ConeGeometry, THREE.ShaderMaterial>;
  constructor() {
    super();
    const geometry = new THREE.ConeGeometry(0.5, 1, 24, 1);
    geometry.translate(0, -0.5, 0); // Tip at zero; base exactly one head length behind it.
    const material = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color('#82aabd') }, opacity: { value: 1 } },
      vertexShader: `varying vec3 viewNormal; varying float baseFace;
        void main() {
          viewNormal = normalize(normalMatrix * normal);
          baseFace = normal.y < -0.9 ? 1.0 : 0.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `uniform vec3 color; uniform float opacity; varying vec3 viewNormal; varying float baseFace;
        void main() {
          float light = 0.72 + 0.28 * max(0.0, dot(normalize(viewNormal), normalize(vec3(-0.4, 0.6, 0.7))));
          // A darker flat cap distinguishes the rear base from the curved sides.
          light *= mix(1.0, 0.78, baseFace);
          gl_FragColor = vec4(color * light, opacity);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    });
    const outlineMaterial = new THREE.ShaderMaterial({
      uniforms: { resolution: { value: new THREE.Vector2(1, 1) }, opacity: { value: 0.55 } },
      vertexShader: `uniform vec2 resolution;
        void main() {
          vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          vec2 normalXY = (normalMatrix * normal).xy;
          float size = length(normalXY);
          if (size > 0.00001) clip.xy += normalXY / size * (1.3 / resolution) * clip.w;
          gl_Position = clip;
        }`,
      fragmentShader: `uniform float opacity;
        void main() { gl_FragColor = vec4(0.025, 0.035, 0.045, opacity); }`,
      side: THREE.BackSide, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.cone = new THREE.Mesh(geometry, material);
    this.outline = new THREE.Mesh(geometry, outlineMaterial);
    this.cone.renderOrder = 102; this.outline.renderOrder = 99;
    this.cone.frustumCulled = this.outline.frustumCulled = false;
    this.outline.onBeforeRender = renderer => {
      renderer.getSize(outlineMaterial.uniforms.resolution.value);
    };
    this.add(this.outline, this.cone);
  }
  setDirection(direction: THREE.Vector3): void {
    this.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  }
  setLength(length: number, headLength: number, headWidth: number): void {
    for (const mesh of [this.cone, this.outline]) {
      mesh.position.set(0, length, 0); mesh.scale.set(headWidth, headLength, headWidth);
      mesh.visible = headLength > 0;
    }
  }
  setStyle(color: string, opacity: number): void {
    this.cone.material.uniforms.color.value.set(color);
    this.cone.material.uniforms.opacity.value = opacity;
    this.outline.material.uniforms.opacity.value = opacity * 0.55;
  }
  dispose(): void {
    this.cone.geometry.dispose(); this.cone.material.dispose(); this.outline.material.dispose();
  }
}
