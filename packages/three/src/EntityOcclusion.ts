import * as THREE from 'three';
import type { BodyMesh } from './BodyMesh.js';
import { ContourOcclusion } from './ContourOcclusion.js';
import { tileFade, tileFadeMask } from './geographic/TileFade.js';

const ANCHOR_HEIGHT_TOLERANCE_KM = 0.003;
const MIN_GRAZING_SINE = 0.03;
const LIMB_FADE_FRACTION = 0.04;

type OccluderTest = (body: BodyMesh, ray: THREE.Ray, distance: number) => number | null;

/** Analytic limb fade for bodies without a triangle test for this anchor. */
export class AnchorOcclusion {
  private readonly ray = new THREE.Ray();
  private readonly toOccluder = new THREE.Vector3();

  fade(
    eye: THREE.Vector3, point: THREE.Vector3, distance: number, bodies: readonly BodyMesh[],
    owner?: BodyMesh, test?: OccluderTest,
  ): number {
    const ray = this.ray;
    ray.origin.copy(eye);
    ray.direction.subVectors(point, eye);
    if (!distance) return 1;
    ray.direction.divideScalar(distance);

    let fade = 1;
    for (const body of bodies) {
      if (body === owner || !body.present) continue;
      const plates = test ? null : body.dskOccludes(eye, point);
      const visibility = test ? test(body, ray, distance) : plates === null ? null : Number(!plates);
      if (visibility !== null) {
        if (visibility === 0) return 0;
        fade = Math.min(fade, visibility);
        continue;
      }

      // Large analytic occluders get a smooth fade near the limb.
      if (body.displayRadius < 50) continue;
      const radius = body.displayRadius * body.scaleFactor;
      if (radius < 1e-6) continue;
      const offset = this.toOccluder.subVectors(body.position, eye);
      const distSq = offset.lengthSq();
      if (distSq <= radius * radius) continue;
      const along = offset.dot(ray.direction);
      const closestSq = Math.max(0, distSq - along * along);
      if (closestSq >= radius * radius) continue;
      const halfChord = Math.sqrt(radius * radius - closestSq);
      if (along + halfChord <= 0 || along - halfChord >= distance) continue;
      const depth = radius - Math.sqrt(closestSq);
      const t = Math.max(0, 1 - depth / (radius * LIMB_FADE_FRACTION));
      fade = Math.min(fade, t * t * (3 - 2 * t));
    }
    return fade;
  }
}

interface Surface {
  meshes: { mesh: THREE.Mesh; sphere: THREE.Sphere; bins: number }[];
  innerRadius: number;
  farSideRadius: number;
  streamed: boolean;
}

interface Visibility {
  frame: number;
  value: number;
  target: number;
  sample: number;
}

/** A frame's line of sight to each entity's real scene position. */
export class EntityOcclusion {
  private readonly analytic = new AnchorOcclusion();
  private readonly triangles = new ContourOcclusion();
  private readonly radial = new THREE.Vector3();
  private readonly view = new THREE.Vector3();
  private readonly surfaces = new Map<BodyMesh, Surface>();
  private readonly plates = new Map<BodyMesh, Surface>();
  private readonly offset = new THREE.Vector3();
  private readonly states = new WeakMap<BodyMesh, Visibility>();
  private frame = 0;

  constructor(private readonly drawnSurfaceMeshes: (body: BodyMesh) => THREE.Mesh[]) {}

  beginFrame(): void {
    this.frame++;
    this.surfaces.clear();
    this.plates.clear();
  }

  visibility(owner: BodyMesh, camera: THREE.PerspectiveCamera, bodies: readonly BodyMesh[]): number {
    const prev = this.states.get(owner);
    if (prev?.frame === this.frame) return prev.value;

    // The label sprite is offset on screen, but visibility belongs to the anchor.
    if (!owner.present || this.view.copy(owner.position).applyMatrix4(camera.matrixWorldInverse).z >= -camera.near) {
      this.states.delete(owner);
      return 0;
    }

    const distance = camera.position.distanceTo(owner.position);
    const raw = this.analytic.fade(camera.position, owner.position, distance, bodies, owner, (body, ray, range) => {
      if (!body.visible) return 1;
      const isParent = body.body.name === owner.body.parentName;
      const surface = this.surface(body, isParent);
      if (!surface.streamed && surface.meshes.length === 0) return null;

      if (surface.innerRadius > 0 || surface.farSideRadius > 0) {
        const toCenter = this.offset.subVectors(body.position, ray.origin);
        const along = toCenter.dot(ray.direction);
        if (along > 0 && along < range) {
          const farSide = surface.farSideRadius > 0 &&
            this.radial.subVectors(owner.position, body.position).dot(toCenter) > 0;
          const closestSq = toCenter.addScaledVector(ray.direction, -along).lengthSq();
          if (closestSq < surface.innerRadius ** 2) return 0;

          // Without a certified interior, coverage through the deep far side
          // is unknown. Suppress the marker there even if no tile is resident.
          // Leave same-side anchors and grazing paths to the drawn triangles.
          if (farSide && closestSq < surface.farSideRadius ** 2) return 0;
        }
      }

      // Stop a few metres short along the radial normal so an anchor resting
      // on a triangle doesn't occlude itself. Cap the grazing allowance.
      const radial = this.radial.subVectors(owner.position, body.position).normalize();
      const sine = Math.max(MIN_GRAZING_SINE, Math.abs(radial.dot(ray.direction)));
      const far = range - ANCHOR_HEIGHT_TOLERANCE_KM * body.scaleFactor / sine;
      if (far <= 0) return 1;

      let blocked = 0;
      for (const { mesh, sphere, bins } of surface.meshes) {
        if ((bins & ~blocked) === 0) continue;
        const offset = this.offset.subVectors(sphere.center, ray.origin);
        const along = THREE.MathUtils.clamp(offset.dot(ray.direction), 0, far);
        if (offset.addScaledVector(ray.direction, -along).lengthSq() > sphere.radius ** 2) continue;
        if (!this.triangles.intersects(mesh, ray, far)) continue;
        blocked |= bins;
        if (blocked === 0xffff) return 0;
      }

      // Resolve the whole Bayer cell so sliding across individual pixels
      // during a camera move doesn't flicker an entire label or glyph.
      let count = 0;
      for (; blocked; blocked &= blocked - 1) count++;
      return 1 - count / 16;
    });

    // Ignore a single frame of disagreement at a tile boundary. Both
    // annotations then ease toward the same verdict.
    const continuous = prev?.frame === this.frame - 1;
    let target = raw;
    if (continuous && raw !== prev.target && (raw === 0 || raw === 1) && raw !== prev.sample) {
      target = prev.target;
    }
    const value = continuous ? prev.value + (target - prev.value) * 0.25 : target;
    this.states.set(owner, { frame: this.frame, value, target, sample: raw });
    return value;
  }

  private surface(body: BodyMesh, isParent: boolean): Surface {
    const streamed = !!body.terrainTileGroup?.visible;
    const drawSurface = streamed || (isParent && body.body.geometryType === 'Globe' && body.mesh.visible);
    const cache = drawSurface ? this.surfaces : this.plates;
    let surface = cache.get(body);
    if (!surface) {
      const meshes = body.getDskMeshes();
      if (drawSurface) meshes.push(...this.drawnSurfaceMeshes(body));
      const innerRadius = streamed ? body.terrainInnerRadius : 0;
      const radii = body.body.radii;
      // Use the smaller physical axis and stay outside the analytic limb fade
      // band when making the fallback display decision for missing terrain.
      const farSideRadius = streamed && !innerRadius && !body.mesh.visible && radii
        ? Math.min(...radii) * body.scaleFactor * (1 - LIMB_FADE_FRACTION) : 0;
      surface = {
        streamed,
        innerRadius,
        farSideRadius: Math.max(0, farSideRadius),
        meshes: meshes.map(mesh => {
          mesh.updateWorldMatrix(true, false);
          const geometry = mesh.geometry;
          if (!geometry.boundingSphere) geometry.computeBoundingSphere();
          const sphere = geometry.boundingSphere!.clone().applyMatrix4(mesh.matrixWorld);
          return { mesh, sphere, bins: tileFadeMask(tileFade(mesh.material)) };
        }),
      };
      cache.set(body, surface);
    }
    return surface;
  }
}
