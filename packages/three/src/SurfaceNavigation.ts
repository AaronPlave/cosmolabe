/**
 * Surface navigation (#190): the renderer-side half. Core resolves a target
 * and its placements body-fixed (`@cosmolabe/core`'s geographic navigation);
 * this turns them into `SurfacePose`s in a body's mesh frame for the camera
 * controller, and answers the questions core asks of the scene — the body's
 * physical shape and its terrain — without a parallel raycast or the
 * renderer's display radius.
 */
import * as THREE from 'three';
import { refineWithTerrain, type NavigationBodyShape, type SurfaceNavigationTarget, type SurfacePoint } from '@cosmolabe/core';
import type { BodyMesh } from './BodyMesh.js';
import type { SurfacePose } from './controls/CameraController.js';

type Vec3 = [number, number, number];

/**
 * Body-fixed Z-up km → the globe's Y-up mesh frame, in scene units. The same
 * axis map picking uses the other way (`SurfacePoint.bodyFixedPositionKm`).
 */
export function bodyFixedToMeshLocal(v: readonly number[], scaleFactor: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(v[0], v[2], -v[1]).multiplyScalar(scaleFactor);
}

/** The globe's mesh frame (scene units) → body-fixed Z-up km. */
export function meshLocalToBodyFixed(v: THREE.Vector3, scaleFactor: number): Vec3 {
  return [v.x / scaleFactor, -v.z / scaleFactor, v.y / scaleFactor];
}

/** What core's `navigationReference` needs to know about `bm`'s shape. */
export function navigationShapeOf(bm: BodyMesh): NavigationBodyShape {
  return {
    name: bm.body.name,
    radii: bm.body.radii,
    geometryType: bm.body.geometryType,
    terrainDatum: bm.terrainDatum,
    irregular: bm.getDskMeshes().length > 0,
  };
}

/**
 * The ground's distance from the body's centre along body-fixed `p`, from
 * decoded terrain; null without coverage there. For lifting a placement's eye
 * clear of a hill before the camera ever gets there.
 */
export function terrainGroundRadius(bm: BodyMesh): (p: readonly number[]) => number | null {
  return (p) => {
    if (!bm.hasTerrain) return null;
    const point = { xKm: p[0], yKm: p[1], zKm: p[2] };
    const sample = bm.sampleTerrainBodyFixed(point);
    const position = bm.terrainBodyFixedToGeodetic(point);
    if (!sample || !position || position.heightKm === undefined) return null;
    // Height is along the datum normal, close enough to radial for a clearance.
    return Math.hypot(p[0], p[1], p[2]) - position.heightKm + sample.elevationKm;
  };
}

/** A body-fixed placement (km) as a pose the camera controller flies to. */
export function surfacePoseFromBodyFixed(
  placement: { eyeKm: readonly number[]; targetKm: readonly number[]; upKm: readonly number[] },
  scaleFactor: number,
): SurfacePose {
  return {
    position: bodyFixedToMeshLocal(placement.eyeKm, scaleFactor),
    target: bodyFixedToMeshLocal(placement.targetKm, scaleFactor),
    up: bodyFixedToMeshLocal(placement.upKm, 1).normalize(),
  };
}

/**
 * Whether surface navigation can go to `point`. A DSK pick is in the shape
 * model's native Z-up frame, oriented by the model container
 * (`bodyToWorldQuaternion`), not the globe mesh frame `SurfacePose` is in;
 * until navigation handles that frame, it is not offered there rather than
 * landing somewhere else on an irregular body (#107).
 */
export function surfaceNavigable(point: Pick<SurfacePoint, 'source'>): boolean {
  return point.source !== 'dsk';
}

/** How much closer "Zoom to here" brings the camera, and its nearest approach. */
export const SURFACE_ZOOM_FRACTION = 0.25;
export const SURFACE_ZOOM_MIN_RANGE_KM = 0.01;

/**
 * "Zoom to here": the camera moved along its own line of sight to `point`,
 * a quarter of the way out from the point (never nearer than 10 m), the view
 * direction and up kept. That segment is the ray the point was seen along,
 * so the new position is clear of the surface by construction; no flight
 * over the globe is needed. Already nearer than that, the camera stays and
 * only pivots on the point. Null when the point is not on `bm`, or is a DSK
 * pick (`surfaceNavigable`).
 */
export function zoomTowardSurfacePoint(
  bm: BodyMesh, camera: THREE.Camera, point: SurfacePoint, scaleFactor: number,
  fraction = SURFACE_ZOOM_FRACTION,
): SurfacePose | null {
  if (point.bodyName !== bm.body.name || !surfaceNavigable(point)) return null;
  const inv = bm.mesh.quaternion.clone().invert();
  const target = bodyFixedToMeshLocal(point.bodyFixedPositionKm, scaleFactor);
  const eye = camera.position.clone().sub(bm.position).applyQuaternion(inv);
  const back = eye.clone().sub(target);
  const range = back.length();
  if (!(range > 0) || !Number.isFinite(range)) return null;
  const minRange = SURFACE_ZOOM_MIN_RANGE_KM * scaleFactor;
  // Already that close: stay, and only re-anchor on the point.
  const next = Math.min(range, Math.max(minRange, range * fraction));
  return {
    position: target.clone().addScaledVector(back, next / range),
    target,
    up: camera.up.clone().applyQuaternion(inv).normalize(),
  };
}

/** The terrain a `SurfaceTerrainAnchor` follows: a body's CPU terrain. */
export interface AnchorTerrain {
  /** `BodyMesh.terrainRevision`; null without terrain. */
  readonly terrainRevision: number | null;
  sampleTerrain(latDeg: number, lonDeg: number): { elevationKm: number; source: { id: string }; tileId?: string } | null;
}

/**
 * Keeps a coordinate target on a terrain body's ground while its terrain
 * streams (#190): the cold-cache sample, then each finer tile that replaces
 * a coarse parent. `update` re-samples only when the terrain's revision has
 * moved, refines through core's `refineWithTerrain` (which ignores changes
 * under half a metre), and hands the body-fixed shift to `apply` — the
 * camera's `retargetSurface`, so the pivot and the camera move with it.
 */
export class SurfaceTerrainAnchor {
  private revision: number | null;

  constructor(public target: SurfaceNavigationTarget, terrain: AnchorTerrain) {
    this.revision = terrain.terrainRevision;
  }

  /**
   * The refined target when it moved; `null` when nothing changed; `'released'`
   * when `apply` reports the navigation it would move is gone.
   */
  update(terrain: AnchorTerrain, apply: (shiftKm: readonly [number, number, number]) => boolean): SurfaceNavigationTarget | null | 'released' {
    const revision = terrain.terrainRevision;
    if (revision === null || revision === this.revision) return null;
    this.revision = revision;
    const sample = terrain.sampleTerrain(this.target.latGraphicDeg, this.target.lonEastDeg);
    if (!sample) return null;
    const refined = refineWithTerrain(this.target, { elevationKm: sample.elevationKm, sourceId: sample.source.id, tileId: sample.tileId });
    if (!refined) return null;
    if (!apply(refined.shiftKm)) return 'released';
    this.target = refined.target;
    return refined.target;
  }
}
