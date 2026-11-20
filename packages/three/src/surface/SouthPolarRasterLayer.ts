import * as THREE from 'three';
import type { SurfaceRasterDefinition, Universe } from '@cosmolabe/core';
import type { BodyMesh } from '../BodyMesh.js';
import { SURFACE_DRAPE_VERTEX, SURFACE_DRAPE_FADE } from '../geographic/SurfaceDrapeShader.js';
import { tileFade } from '../geographic/TileFade.js';
import { footprintScreenRect, type GeographicFootprint } from '../geographic/GeographicFootprint.js';
import { SouthPolarRaster, type PolarRasterManifest } from './SouthPolarRaster.js';

function palette(definition: SurfaceRasterDefinition): THREE.DataTexture {
  const colors = definition.colorScale.map(stop => new THREE.Color(stop.color));
  const { colorScale } = definition;
  const start = colorScale[0].value, end = colorScale.at(-1)!.value;
  const values = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const value = start + (end - start) * i / 255;
    const upper = i === 255 ? colorScale.length - 1 : Math.max(1, colorScale.findIndex(stop => stop.value >= value));
    const a = colorScale[upper - 1].value, b = colorScale[upper].value;
    const c = colors[upper - 1].clone().lerp(colors[upper], (value - a) / (b - a));
    values.set([c.r * 255, c.g * 255, c.b * 255, 255], i * 4);
  }
  const texture = new THREE.DataTexture(values, 256, 1);
  texture.needsUpdate = true;
  return texture;
}

function materialFor(product: SouthPolarRaster) {
  const m = product.manifest!;
  const d = product.definition;
  const { westM, northM, width, height, stepM } = m.grid;
  const w = product.texture!.image.width, h = product.texture!.image.height;
  const step = stepM * m.displayStride;
  const uniforms = {
    grid: { value: product.texture },
    projectedRect: { value: new THREE.Vector4(westM, northM, step * w, step * h) },
    dataLimit: { value: new THREE.Vector2(width / w / m.displayStride, height / h / m.displayStride) },
    radiusM: { value: m.radiusKm * 1000 },
    latitudeLimit: { value: Math.sin(m.polarLimitDeg * Math.PI / 180) },
    range: { value: new THREE.Vector2(d.colorScale[0].value, d.colorScale.at(-1)!.value) },
    palette: { value: palette(d) },
    layerOpacity: { value: product.opacity },
    vectorAnchor: { value: new THREE.Vector3() },
    vectorLocalToAnchor: { value: new THREE.Matrix4() },
    vectorDisplacement: { value: new THREE.Vector3() },
    vectorDisplacementMap: { value: null as THREE.Texture | null },
    vectorDisplacementTransform: { value: new THREE.Matrix3() },
    vectorFadeIn: { value: 1 },
    vectorFadeOut: { value: 0 },
  };
  return new THREE.ShaderMaterial({
    uniforms,
    defines: m.features ? { PSR_COVERAGE: 1 } : m.overviewEncoding === 'mean-with-coverage' ? { VALID_FRACTION: 1 } : {},
    transparent: true, depthTest: true, depthWrite: false, depthFunc: THREE.LessEqualDepth,
    vertexShader: SURFACE_DRAPE_VERTEX,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform highp sampler2D grid;
      uniform sampler2D palette;
      uniform vec4 projectedRect;
      uniform vec2 dataLimit, range;
      uniform vec3 vectorAnchor;
      uniform float radiusM, latitudeLimit, layerOpacity, vectorFadeIn, vectorFadeOut;
      varying vec3 vectorOffset;
      ${SURFACE_DRAPE_FADE}
      void main() {
        if (vectorFadedOut()) discard;
        vec3 p = vectorAnchor + vectorOffset;
        float r = length(p);
        if (p.z > latitudeLimit * r) discard;
        // South polar stereographic: +X east along 90 E, +Y along 0 E.
        vec2 metres = (2.0 * radiusM / (r - p.z)) * p.yx;
        vec2 uv = (metres - projectedRect.xy) * vec2(1.0, -1.0) / projectedRect.zw;
        if (any(lessThan(uv, vec2(0.0))) || any(greaterThanEqual(uv, dataLimit))) discard;
        vec2 cell = texture2D(grid, uv).rg;
        float coverage = 1.0;
        #ifdef PSR_COVERAGE
          coverage = cell.r;
          vec3 color = texture2D(palette, vec2(0.5)).rgb;
        #else
          #ifdef VALID_FRACTION
            coverage = cell.g;
          #endif
          if (isnan(cell.r)) discard;
          float t = clamp((cell.r - range.x) / (range.y - range.x), 0.0, 1.0);
          vec3 color = texture2D(palette, vec2(t, 0.5)).rgb;
        #endif
        if (coverage <= 0.0) discard;
        #include <logdepthbuf_fragment>
        #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
          // Separate shaders can round the same terrain depth differently.
          // Allow one 24-bit depth step for the drape, while retaining the
          // terrain depth test at ridges and the lunar limb.
          gl_FragDepth = max(0.0, gl_FragDepth - 1.0 / 16777216.0);
        #endif
        gl_FragColor = vec4(color, layerOpacity * coverage);
        #include <colorspace_fragment>
      }
    `,
  });
}

/** Conservative projected bounds for undisplaced triangle geometry. */
function overlapsGrid(bounds: THREE.Box3, radial: { low: number; high: number }, m: PolarRasterManifest): boolean {
  if (bounds.min.z >= 0) return false;
  // The denominator of the stereographic projection is positive in the
  // southern hemisphere. Use interval endpoints so the bound includes the
  // entire triangle, including its interior.
  const minDenominator = radial.low - bounds.max.z;
  if (minDenominator <= 0) return true;
  const maxDenominator = radial.high - bounds.min.z;
  const minimumScale = 2000 * m.radiusKm / maxDenominator;
  const maximumScale = 2000 * m.radiusKm / minDenominator;
  const { westM, northM, stepM, width, height } = m.grid;
  const eastM = westM + stepM * width, southM = northM - stepM * height;
  // Allow for shader float rounding at the grid edge.
  const marginM = 1;
  return Math.min(bounds.min.y * minimumScale, bounds.min.y * maximumScale) <= eastM + marginM &&
    Math.max(bounds.max.y * minimumScale, bounds.max.y * maximumScale) >= westM - marginM &&
    Math.min(bounds.min.x * minimumScale, bounds.min.x * maximumScale) <= northM + marginM &&
    Math.max(bounds.max.x * minimumScale, bounds.max.x * maximumScale) >= southM - marginM;
}

interface Proxy {
  mesh: THREE.Mesh;
  sourceGeometry: THREE.BufferGeometry;
  localToBody: THREE.Matrix4;
  seen: boolean;
  bounds: THREE.Box3;
  radial: { low: number; high: number } | null;
}

export class SouthPolarRasterLayer {
  readonly products = new Map<string, SouthPolarRaster>();
  private readonly materials = new Map<SouthPolarRaster, ReturnType<typeof materialFor>>();
  private readonly proxies = new Map<THREE.Mesh, Proxy>();
  private readonly scene = new THREE.Scene();

  constructor(private readonly universe: Universe, private readonly scaleFactor: number) {}

  async show(definition: SurfaceRasterDefinition): Promise<void> {
    if (this.products.has(definition.id)) return;
    const scale = definition.colorScale;
    if (!Number.isFinite(definition.opacity) || !Array.isArray(scale) || scale.length < 2 || scale.some((stop, i) =>
      !Number.isFinite(stop.value) || !/^#[\da-f]{6}$/i.test(stop.color) || (i > 0 && stop.value <= scale[i - 1].value))) {
      throw new Error('Science display requires at least two ordered, finite color stops');
    }
    const p = new SouthPolarRaster(definition);
    this.products.set(definition.id, p);
    await p.load();
  }

  hide(id: string): void {
    const p = this.products.get(id);
    if (!p) return;
    this.products.delete(id);
    const material = this.materials.get(p);
    if (material) {
      material.uniforms.palette.value.dispose();
      material.dispose();
      this.materials.delete(p);
    }
    p.dispose();
    if (!this.products.size) this.end();
  }

  begin(): void {
    for (const proxy of this.proxies.values()) proxy.seen = false;
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera, bodies: Iterable<BodyMesh>, overlays = false, origin = new THREE.Vector3()): void {
    if (!this.products.size) return;
    for (const bm of bodies) {
      if (!bm.visible || bm.body.geometryType !== 'Globe') continue;
      const frame = bm.body.rotation?.bodyFixedFrame ?? this.universe.frames.bodyFixedFrameFor(bm.body.name);
      const active = [...this.products.values()].filter(p => p.manifest && p.texture &&
        p.opacity > 0 && p.definition.body === bm.body.name && this.universe.frames.sameFrame(p.manifest.frame, frame));
      // Draw the thematic boundary mask above temperature and ratio colors.
      active.sort((a, b) => Number(!!a.manifest?.features) - Number(!!b.manifest?.features));
      if (!active.length) continue;
      const datum = bm.terrainDatum;
      if (datum && (datum.referenceShape.kind !== 'sphere' || datum.referenceShape.radiusKm !== active[0].manifest!.radiusKm)) continue;
      const rotation = bm.bodyToWorldQuaternion(new THREE.Quaternion());
      const bodyMatrix = new THREE.Matrix4().compose(bm.position.clone().sub(origin), rotation, new THREE.Vector3().setScalar(this.scaleFactor));
      const toBody = bodyMatrix.clone().invert();
      const anchor = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld).applyMatrix4(toBody);
      const roots = overlays ? bm.getSurfaceOverlays().map(o => o.group) : [bm.mesh, bm.terrainTileGroup];
      const draws: Proxy[] = [];
      const bodyOrigin = new THREE.Vector3();
      this.scene.clear();
      for (const root of roots) root?.traverseVisible(object => {
        if (!(object instanceof THREE.Mesh) || !(object.geometry instanceof THREE.BufferGeometry)) return;
        const proxy = this.proxyFor(object);
        proxy.seen = true;
        const sourceMaterial = (Array.isArray(object.material) ? object.material[0] : object.material) as THREE.MeshStandardMaterial;
        proxy.radial = null;
        proxy.mesh.matrix.copy(object.matrixWorld);
        proxy.localToBody.multiplyMatrices(toBody, object.matrixWorld);
        if (!sourceMaterial.displacementMap) {
          if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
          const box = proxy.bounds.copy(object.geometry.boundingBox!).applyMatrix4(proxy.localToBody);
          const { min, max } = box;
          proxy.radial = {
            low: box.distanceToPoint(bodyOrigin),
            high: Math.hypot(Math.max(Math.abs(min.x), Math.abs(max.x)),
              Math.max(Math.abs(min.y), Math.abs(max.y)), Math.max(Math.abs(min.z), Math.abs(max.z))),
          };
        }
        proxy.localToBody.elements[12] -= anchor.x;
        proxy.localToBody.elements[13] -= anchor.y;
        proxy.localToBody.elements[14] -= anchor.z;
        this.scene.add(proxy.mesh);
        draws.push(proxy);
      });
      if (!draws.length) continue;
      const scissor = renderer.getScissor(new THREE.Vector4()), scissorTest = renderer.getScissorTest();
      try {
        for (const p of active) {
          const m = p.manifest!;
          let rect: THREE.Vector4 | null | 'empty' = null;
          let low = Infinity, high = -Infinity, bounded = true, visible = false;
          for (const proxy of draws) {
            const radial = proxy.radial;
            proxy.mesh.visible = !radial || overlapsGrid(proxy.bounds, radial, m);
            if (!proxy.mesh.visible) continue;
            visible = true;
            if (!radial || radial.low <= 0.75 * m.radiusKm) {
              bounded = false;
              continue;
            }
            low = Math.min(low, radial.low - m.radiusKm);
            high = Math.max(high, radial.high - m.radiusKm);
          }
          if (!visible) continue;
          if (datum && bounded && !renderer.getRenderTarget()) {
            const footprint: GeographicFootprint = { kind: 'polar-cap', pole: -1, colatitude: 90 + m.polarLimitDeg };
            rect = footprintScreenRect(footprint, low, high, datum, bodyMatrix, camera, renderer.getViewport(new THREE.Vector4()), 1);
          }
          if (rect === 'empty') continue;
          renderer.setScissor(rect ?? scissor);
          renderer.setScissorTest(rect !== null || scissorTest);
          let material = this.materials.get(p);
          if (!material) {
            material = materialFor(p);
            this.materials.set(p, material);
          }
          material.uniforms.vectorAnchor.value.copy(anchor);
          material.uniforms.layerOpacity.value = p.opacity;
          for (const proxy of draws) proxy.mesh.material = material;
          renderer.render(this.scene, camera);
        }
      } finally {
        renderer.setScissor(scissor);
        renderer.setScissorTest(scissorTest);
      }
    }
  }

  end(): void {
    for (const [source, proxy] of this.proxies) {
      if (!proxy.seen || !this.products.size) this.dropProxy(source, proxy);
    }
  }

  dispose(): void {
    for (const id of this.products.keys()) this.hide(id);
  }

  private proxyFor(source: THREE.Mesh): Proxy {
    const cached = this.proxies.get(source);
    if (cached?.sourceGeometry === source.geometry) return cached;
    if (cached) this.dropProxy(source, cached);
    const ground = source.geometry.groups[0];
    let geometry = source.geometry;
    if (ground) {
      geometry = new THREE.BufferGeometry();
      for (const [name, attribute] of Object.entries(source.geometry.attributes)) geometry.setAttribute(name, attribute);
      geometry.setIndex(source.geometry.index);
      geometry.setDrawRange(ground.start, ground.count);
    }
    const mesh = new THREE.Mesh(geometry);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    const proxy: Proxy = {
      mesh, sourceGeometry: source.geometry, localToBody: new THREE.Matrix4(),
      seen: false, bounds: new THREE.Box3(), radial: null,
    };
    mesh.onBeforeRender = () => {
      const material = mesh.material as ReturnType<typeof materialFor>;
      const uniforms = material.uniforms;
      const sourceMaterial = (Array.isArray(source.material) ? source.material[0] : source.material) as THREE.MeshStandardMaterial;
      const map = sourceMaterial.displacementMap;
      uniforms.vectorLocalToAnchor.value.copy(proxy.localToBody);
      uniforms.vectorDisplacement.value.set(map ? 1 : 0, sourceMaterial.displacementScale ?? 0, sourceMaterial.displacementBias ?? 0);
      uniforms.vectorDisplacementMap.value = map ?? null;
      if (map) {
        if (map.matrixAutoUpdate) map.updateMatrix();
        uniforms.vectorDisplacementTransform.value.copy(map.matrix);
      }
      const fade = tileFade(source.material);
      uniforms.vectorFadeIn.value = fade && fade !== 'unreadable' ? fade.fadeIn : 1;
      uniforms.vectorFadeOut.value = fade && fade !== 'unreadable' ? fade.fadeOut : 0;
      material.uniformsNeedUpdate = true;
    };
    this.proxies.set(source, proxy);
    return proxy;
  }

  private dropProxy(source: THREE.Mesh, proxy: Proxy): void {
    proxy.mesh.removeFromParent();
    const geometry = proxy.mesh.geometry;
    if (geometry !== proxy.sourceGeometry) {
      geometry.setIndex(null);
      for (const name of Object.keys(geometry.attributes)) geometry.deleteAttribute(name);
      geometry.dispose();
    }
    this.proxies.delete(source);
  }
}
