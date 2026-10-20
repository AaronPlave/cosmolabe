import * as THREE from 'three';
import type { CameraSurfacePickResult } from './CameraModes.js';
import type { BodyMesh } from '../BodyMesh.js';
import {
  bodyFixedToGeodeticRad, headingPitchOf, localFrame, type Ellipsoid, type Vec3,
} from './surfaceNavigation.js';

/**
 * Where a change of camera mode into Surface Flight or Surface Explorer puts
 * the observer when no surface destination was named (#253). Latitude and
 * longitude are in the rendered body-fixed frame (`BodyMesh.bodyToWorldQuaternion`).
 *
 * Location, in order of preference:
 * - `near-surface`: the camera is already within flight altitude of the
 *   surface, so it descends (or climbs) straight to the point beneath it,
 *   keeping its heading and pitch.
 * - `sightline`: from higher up, the point the centre of the view rests on —
 *   the rendered surface pick when it lands on this body, else the reference
 *   ellipsoid.
 * - `sub-camera`: the view misses the body (looking away, or at a spacecraft
 *   against the sky), so the point beneath the camera.
 * - `view-direction`: the camera sits at the body's centre, where nothing is
 *   beneath it; the point the view direction leaves the body through.
 *
 * Altitude is a practical height for the mode, never an orbital one carried
 * over: Surface Flight enters at the camera's own height, capped at
 * `flightEntryCapKm`; Surface Explorer at its own height capped at
 * `EXPLORER_ENTRY_CLEARANCE_KM`. Both are clearance above sampled terrain
 * where the body has terrain, and above the reference ellipsoid where it has
 * none.
 *
 * Heading follows the incoming view's horizontal direction; when that view
 * is close to straight down (as from orbit), the screen's up becomes forward
 * instead, so what was at the top of the screen is ahead. From orbit the
 * pitch is levelled toward the horizon; from near the surface it is kept.
 */
export interface SurfaceEntryPose {
  latDeg: number;
  lonDeg: number;
  /** Surface Flight: height above the reference ellipsoid. Surface Explorer:
   *  clearance above terrain (the mode adds the sampled elevation). */
  altKm: number;
  /** Clockwise from north. */
  headingDeg: number;
  /** Positive up from the local horizon. */
  pitchDeg: number;
  source: 'near-surface' | 'sightline' | 'sub-camera' | 'view-direction';
}

export type SurfaceEntryKind = 'flight' | 'explorer';

/** Surface Explorer's eye height above terrain when entering from higher up, km. */
export const EXPLORER_ENTRY_CLEARANCE_KM = 0.05;
/** Lowest entry clearance, km — the explorer's dolly floor. */
const MIN_ENTRY_CLEARANCE_KM = 0.002;
/** Lowest Surface Flight entry clearance, km. */
const MIN_FLIGHT_CLEARANCE_KM = 0.1;
/** From orbit, pitch is levelled into this range (radians): down toward the horizon, never up. */
const ORBITAL_ENTRY_PITCH_MIN = -0.35;
/** Below this horizontal share of the view direction it is "straight down/up"; screen-up gives the heading. */
const STEEP_VIEW_HORIZONTAL = 0.2;

/**
 * Surface Flight's entry ceiling, km: half a percent of the equatorial radius,
 * between 1 and 50 km (Moon ≈ 8.7 km, Mars ≈ 17 km, Earth ≈ 32 km). Also the
 * height under which a camera counts as already near the surface.
 */
export function flightEntryCapKm(equatorialRadiusKm: number): number {
  return Math.min(50, Math.max(1, equatorialRadiusKm * 0.005));
}

const _q = /* @__PURE__ */ new THREE.Quaternion();
const _v = /* @__PURE__ */ new THREE.Vector3();

/**
 * The entry pose on `bm` for the camera as it stands. Camera and body
 * position must be in the same scene coordinates (the last frame's). Null
 * when the body has no radii, so there is no surface to enter.
 */
export function surfaceEntryPose(
  bm: BodyMesh,
  camera: THREE.PerspectiveCamera,
  scaleFactor: number,
  kind: SurfaceEntryKind,
  pickCenter?: () => CameraSurfacePickResult | null,
): SurfaceEntryPose | null {
  const radii = bm.body.radii;
  if (!radii || !(radii[0] > 0) || !(scaleFactor > 0)) return null;
  const a = radii[0];
  const c = radii[2] ?? a;
  const ell: Ellipsoid = { a, e2: 1 - (c * c) / (a * a) };

  // World → conventional Z-up body-fixed, as the globe is rendered — with or
  // without a rotation model — so the entry lands on the terrain in view.
  const toBody = bm.bodyToWorldQuaternion(_q).invert();
  const bf = (v: THREE.Vector3): Vec3 => {
    v.applyQuaternion(toBody);
    return [v.x, v.y, v.z];
  };
  const camKm = bf(_v.copy(camera.position).sub(bm.position).divideScalar(scaleFactor));
  const dir = bf(camera.getWorldDirection(new THREE.Vector3()));
  const screenUp = bf(new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion));

  const elevationAt = (latRad: number, lonRad: number): number | null =>
    bm.hasTerrain ? bm.sampleTerrainElevation?.(latRad * 180 / Math.PI, lonRad * 180 / Math.PI)?.elevationKm ?? null : null;

  const cap = flightEntryCapKm(a);
  let entry: { latRad: number; lonRad: number };
  let source: SurfaceEntryPose['source'];
  let cameraClearanceKm = Infinity;

  if (Math.hypot(...camKm) < 1e-9 * a) {
    const g = bodyFixedToGeodeticRad([dir[0] * a, dir[1] * a, dir[2] * a], ell);
    entry = g;
    source = 'view-direction';
  } else {
    const g = bodyFixedToGeodeticRad(camKm, ell);
    cameraClearanceKm = g.altKm - (elevationAt(g.latRad, g.lonRad) ?? 0);
    if (cameraClearanceKm <= cap) {
      entry = g;
      source = 'near-surface';
    } else {
      const hit = sightlineHit(bm, camKm, dir, ell, pickCenter);
      if (hit) {
        entry = bodyFixedToGeodeticRad(hit, ell);
        source = 'sightline';
      } else {
        entry = g;
        source = 'sub-camera';
      }
    }
  }

  const frame = localFrame(entry.latRad, entry.lonRad);
  const view = headingPitchOf(dir, frame, 0);
  const steep = Math.cos(view.pitchRad) < STEEP_VIEW_HORIZONTAL;
  const headingRad = steep ? headingPitchOf(screenUp, frame, view.headingRad).headingRad : view.headingRad;
  const pitchRad = source === 'near-surface'
    ? view.pitchRad
    : Math.min(0, Math.max(ORBITAL_ENTRY_PITCH_MIN, view.pitchRad));

  // The camera's own clearance where it is near (or below) the cap; a
  // practical height for the mode otherwise.
  const clearance = kind === 'flight'
    ? Math.max(MIN_FLIGHT_CLEARANCE_KM, Math.min(cameraClearanceKm, cap))
    : Math.max(MIN_ENTRY_CLEARANCE_KM, Math.min(cameraClearanceKm, EXPLORER_ENTRY_CLEARANCE_KM));
  const altKm = kind === 'flight'
    ? (elevationAt(entry.latRad, entry.lonRad) ?? 0) + clearance
    : clearance;

  return {
    latDeg: entry.latRad * 180 / Math.PI,
    lonDeg: entry.lonRad * 180 / Math.PI,
    altKm,
    headingDeg: headingRad * 180 / Math.PI,
    pitchDeg: pitchRad * 180 / Math.PI,
    source,
  };
}

/**
 * Where the centre of the view meets the body, Z-up body-fixed km: the
 * rendered surface pick when it lands on this body, else the first
 * intersection with the reference ellipsoid in front of the camera.
 */
function sightlineHit(
  bm: BodyMesh, camKm: Vec3, dir: Vec3, ell: Ellipsoid,
  pickCenter?: () => CameraSurfacePickResult | null,
): Vec3 | null {
  const pick = pickCenter?.();
  if (pick && pick.bodyName === bm.body.name) return [...pick.bodyFixedHitKm] as Vec3;

  // Scale z so the ellipsoid of revolution becomes a sphere of radius a.
  const k = 1 / Math.sqrt(1 - ell.e2);
  const o: Vec3 = [camKm[0], camKm[1], camKm[2] * k];
  const d: Vec3 = [dir[0], dir[1], dir[2] * k];
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const od = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
  const oo = o[0] * o[0] + o[1] * o[1] + o[2] * o[2];
  const disc = od * od - dd * (oo - ell.a * ell.a);
  if (disc < 0) return null;
  const t = (-od - Math.sqrt(disc)) / dd;
  if (!(t > 0)) return null;
  return [camKm[0] + t * dir[0], camKm[1] + t * dir[1], camKm[2] + t * dir[2]];
}
