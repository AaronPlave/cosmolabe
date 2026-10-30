import * as THREE from 'three';
import { MissionStateRotation, mat3Mul, quatToMat3, type Body, type Universe } from '@cosmolabe/core';
import type { PositionResolver } from './TrajectoryLine.js';
import {
  fovBaseParams, fovBoundaryDirection, rectangularFov,
  type FovBoundaryShape, type FovPerimeterSample, type FovSurfaceSource, type Vec3,
} from './surface/FovClipper.js';

export interface SensorFrustumOptions {
  /** Color of the frustum (hex, overrides catalog frustumColor) */
  color?: number;
  /** Opacity of the filled frustum (overrides catalog frustumOpacity) */
  opacity?: number;
  /** Length of the frustum in km (overrides catalog range) */
  length?: number;
  /** Base perimeter samples (elliptical), or total across all edges (polygon). Default 32. */
  segments?: number;
}

/**
 * Clips a sensor's FOV perimeter. Receives the sensor origin (origin-relative km,
 * same frame as `resolvePos`), the world-frame boundary direction at perimeter
 * parameter t, the fixed base parameters, and the maximum visualization range.
 */
export type SensorFovClipper = (
  originKm: Vec3,
  directionAt: (t: number) => Vec3,
  baseParams: readonly number[],
  maxRangeKm: number,
) => FovPerimeterSample[];

/** What the last update drew, for diagnostics. */
export interface SensorClipSummary {
  /** False when the perimeter was drawn unclipped (clipping off, or no clipper). */
  clipped: boolean;
  samples: number;
  hitSamples: number;
  /** Bodies that terminated at least one perimeter ray. */
  bodies: string[];
  /** Surface kinds that answered: reference shape, terrain, or irregular mesh. */
  sources: FovSurfaceSource[];
  /** Any hit came from coarse/provisional data. */
  coarse: boolean;
  /** Any hit fell back from an unavailable detailed surface to a later one. */
  fallback: boolean;
  maxRangeKm: number;
}

// Reusable temp objects for per-frame orientation (avoids GC pressure)
const _dir = new THREE.Vector3();
const _camZ = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _v = new THREE.Vector3();

/**
 * A sensor's declared mounting on its spacecraft — `geometry.mounting:
 * { "boresight": [x, y, z], "up": [x, y, z] }`, both in the spacecraft body
 * frame — as the instrument → body rotation (row-major; instrument +X right,
 * +Y up, +Z boresight, as SPICE). Used where the spacecraft's attitude is
 * host-supplied and SPICE cannot point the instrument.
 */
export function parseSensorMounting(spec: unknown): { matrix?: number[]; error?: string } {
  if (spec === undefined) return {};
  const m = spec as { boresight?: unknown; up?: unknown };
  const vec = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? v as number[] : null;
  const z = vec(m?.boresight), u = vec(m?.up);
  if (!z || !u) return { error: 'geometry.mounting needs boresight and up, each three finite numbers in the spacecraft body frame' };
  const nz = Math.hypot(z[0], z[1], z[2]);
  if (nz === 0) return { error: 'geometry.mounting.boresight is zero' };
  const Z = z.map((x) => x / nz);
  const d = u[0] * Z[0] + u[1] * Z[1] + u[2] * Z[2];
  const y = [u[0] - d * Z[0], u[1] - d * Z[1], u[2] - d * Z[2]];
  const ny = Math.hypot(y[0], y[1], y[2]);
  if (ny < 1e-9 * Math.hypot(u[0], u[1], u[2]) || ny === 0) return { error: 'geometry.mounting.up is parallel to the boresight' };
  const Y = y.map((x) => x / ny);
  const X = [Y[1] * Z[2] - Y[2] * Z[1], Y[2] * Z[0] - Y[0] * Z[2], Y[0] * Z[1] - Y[1] * Z[0]];
  // Columns are the instrument axes in body coordinates.
  return { matrix: [X[0], Y[0], Z[0], X[1], Y[1], Z[1], X[2], Y[2], Z[2]] };
}

/**
 * Instrument → scene (ECLIPJ2000) rotation for a sensor, row-major, and its
 * source. A sensor on a spacecraft whose attitude the host supplies is pointed
 * by that attitude and the catalog `mounting` — SPICE knows nothing of a host
 * attitude — and without a mounting it has no truthful pointing: `unavailable`
 * says why. Otherwise SPICE (instrument frame), else the frustum aims at its
 * target.
 */
export function sensorPointing(
  universe: Universe,
  sf: Pick<SensorFrustum, 'body' | 'mounting' | 'mountingError' | 'spiceFovFrame' | 'spiceInertialFrame'>,
  et: number,
  spiceInst: Universe['spiceInstance'],
): { rotation?: number[]; from: 'spice' | 'attitude' | 'target'; unavailable?: string } {
  const own = sf.body.rotation;
  const parent = sf.body.parentName ? universe.getBody(sf.body.parentName) : undefined;
  // The sensor's own attitude if it has one, else its spacecraft's.
  const carrier = own ? (own instanceof MissionStateRotation ? sf.body : undefined)
    : parent?.rotation instanceof MissionStateRotation ? parent : undefined;
  if (carrier) {
    if (!sf.mounting) {
      return { from: 'attitude', unavailable: sf.mountingError
        ? `${sf.body.name}: ${sf.mountingError}.`
        : `${carrier.name}'s attitude is host-supplied and ${sf.body.name} declares no mounting on it (geometry.mounting), so its pointing is unknown.` };
    }
    const q = universe.bodyToWorldQuat(carrier, et);
    if (!q) return { from: 'attitude', unavailable: `${carrier.name}'s attitude is unavailable at this time.` };
    return { from: 'attitude', rotation: mat3Mul(quatToMat3(q), sf.mounting as Parameters<typeof mat3Mul>[1]) };
  }
  // SPICE pointing through the cached FOV frame (enrichSensorFromSpice), in
  // the inertial frame that matches scene positions.
  if (sf.spiceFovFrame && spiceInst) {
    try {
      return { from: 'spice', rotation: spiceInst.pxform(sf.spiceFovFrame, sf.spiceInertialFrame, et) as unknown as number[] };
    } catch { /* no CK coverage at this time: aim at the target */ }
  }
  return { from: 'target' };
}

export class SensorFrustum extends THREE.Object3D {
  readonly body: Body;
  /** Instrument → spacecraft body rotation from the catalog's `mounting`, if declared. */
  readonly mounting: number[] | undefined;
  /** Why a declared `mounting` was rejected. */
  readonly mountingError: string | undefined;
  /** Why the sensor cannot be pointed at the last update (and is not drawn), or null. */
  pointingUnavailable: string | null = null;
  readonly targetName: string | undefined;
  /** NAIF instrument ID for SPICE-based orientation (e.g. -82360 for Cassini ISS NAC) */
  readonly spiceId: number | undefined;
  /** Cached SPICE instrument frame name (from getfov during construction). Avoids per-frame getfov calls. */
  spiceFovFrame: string | undefined;
  /** Inertial frame matching the scene positions for this sensor's parent body ('J2000' or 'ECLIPJ2000'). */
  spiceInertialFrame: string = 'ECLIPJ2000';
  /**
   * Instrument-frame boundary from SPICE getfov (RECTANGLE/POLYGON bounds), used
   * whenever the frustum is oriented by SPICE pointing. Catalog angles are used otherwise.
   */
  spiceFovBoundary: FovBoundaryShape | undefined;
  private readonly frustumMesh: THREE.Mesh;
  private readonly wireframe: THREE.LineSegments;
  readonly labelSprite: THREE.Sprite;
  private readonly hFov: number; // full angle in radians
  private readonly vFov: number; // full angle in radians
  private readonly fixedLength: number | undefined;
  private readonly shape: 'elliptical' | 'rectangular';
  private readonly sensorOrientation: THREE.Quaternion;
  private _userVisible = true;
  private _present = true;

  /** The user's show/hide choice for this sensor. */
  get userVisible(): boolean { return this._userVisible; }
  set userVisible(v: boolean) { this._userVisible = v; this.visible = v && this._present; }
  /** Whether the sensor's body is in the scene now; drawn only when present and user-visible. */
  get present(): boolean { return this._present; }
  set present(v: boolean) {
    if (v === this._present) return;
    this._present = v;
    this.visible = v && this._userVisible;
  }
  private readonly segments: number;
  private readonly catalogBoundary: FovBoundaryShape;
  /** Mesh-local (X horizontal, -Y boresight, Z vertical) → world rotation. */
  private readonly frameQuat = new THREE.Quaternion();
  private _perimeter: FovPerimeterSample[] = [];
  private _clipSummary: SensorClipSummary | null = null;

  constructor(body: Body, options: SensorFrustumOptions = {}) {
    super();
    this.body = body;
    this.name = `${body.name}_sensor`;

    // Read from geometryData directly — Cosmographia puts sensor fields on the geometry object
    const geo = body.geometryData as Record<string, unknown> | undefined;

    const hFovDeg = (geo?.horizontalFov as number) ?? 10;
    const vFovDeg = (geo?.verticalFov as number) ?? hFovDeg;
    this.hFov = (hFovDeg * Math.PI) / 180;
    this.vFov = (vFovDeg * Math.PI) / 180;
    this.targetName = geo?.target as string | undefined;
    ({ matrix: this.mounting, error: this.mountingError } = parseSensorMounting(geo?.mounting));
    this.spiceId = geo?.spiceId as number | undefined;
    this.shape = (geo?.shape as string) === 'rectangular' ? 'rectangular' : 'elliptical';
    const tanH = Math.tan(this.hFov / 2), tanV = Math.tan(this.vFov / 2);
    this.catalogBoundary = this.shape === 'rectangular'
      ? rectangularFov(tanH, tanV)
      : { kind: 'elliptical', tanHalfH: tanH, tanHalfV: tanV };

    // Range from catalog (in km) or from options: a maximum visualization range,
    // never a substitute for the physical surface intersection.
    const rangeKm = options.length ?? parseRange(geo?.range);
    this.fixedLength = rangeKm;

    // Sensor orientation quaternion (body-frame relative)
    const orient = geo?.orientation as number[] | undefined;
    this.sensorOrientation = orient && orient.length >= 4
      ? new THREE.Quaternion(orient[0], orient[1], orient[2], orient[3])
      : new THREE.Quaternion();

    // Color
    const frustumColor = geo?.frustumColor as number[] | undefined;
    const color = options.color
      ?? (frustumColor
        ? new THREE.Color(frustumColor[0], frustumColor[1], frustumColor[2]).getHex()
        : 0x00ffff);
    const opacity = options.opacity ?? (geo?.frustumOpacity as number) ?? 0.3;
    this.segments = options.segments ?? 32;

    // Explicit dynamic geometry: once clipped, rays have individual lengths, so
    // a uniformly scaled cone/pyramid can no longer represent the FOV.
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.frustumMesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.add(this.frustumMesh);

    const wireMat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: Math.min(1, opacity * 2.5),
    });
    this.wireframe = new THREE.LineSegments(new THREE.BufferGeometry(), wireMat);
    this.add(this.wireframe);

    // Label sprite at the far end of the frustum
    const labelTexture = createTextTexture(body.name, color);
    const labelMat = new THREE.SpriteMaterial({
      map: labelTexture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: false,
    });
    this.labelSprite = new THREE.Sprite(labelMat);
    const labelAspect = labelTexture.image.width / labelTexture.image.height;
    const labelH = 11 / 600; // ~11px at 600px viewport height
    this.labelSprite.scale.set(labelH * labelAspect, labelH, 1);
    this.labelSprite.center.set(0, 0); // anchor at bottom-left
    this.labelSprite.renderOrder = 999;
    this.add(this.labelSprite);
  }

  /** Perimeter drawn by the last update: world-frame unit directions + endpoint distances (km). */
  get perimeter(): readonly FovPerimeterSample[] { return this._perimeter; }

  /** Summary of the last update's clipping, or null before the first update. */
  get clipSummary(): SensorClipSummary | null { return this._clipSummary; }

  /**
   * @param spiceRotation Optional 3x3 rotation matrix (row-major, 9 elements) from
   *   instrument frame → inertial frame (J2000 or ECLIPJ2000, matching scene positions),
   *   obtained via pxform(instrumentFrame, inertialFrame, et).
   *   When provided, the frustum is oriented using real SPICE pointing data.
   * @param clip Optional physical-surface clipper. Without it every ray is drawn
   *   to the maximum visualization range.
   */
  update(
    et: number, scaleFactor: number, targetBody?: Body, resolvePos?: PositionResolver,
    spiceRotation?: number[], clip?: SensorFovClipper,
  ): void {
    const pos = resolvePos
      ? resolvePos(this.body.name, et)
      : this.body.stateAt(et).position as [number, number, number];
    this.position.set(pos[0] * scaleFactor, pos[1] * scaleFactor, pos[2] * scaleFactor);

    // Maximum visualization range (km): catalog range, else target-center distance, else a fallback.
    let tPos: [number, number, number] | undefined;
    if (targetBody) {
      tPos = resolvePos
        ? resolvePos(targetBody.name, et)
        : targetBody.stateAt(et).position as [number, number, number];
    }
    let maxRangeKm: number;
    if (this.fixedLength != null) {
      maxRangeKm = this.fixedLength;
    } else if (tPos) {
      maxRangeKm = Math.hypot(tPos[0] - pos[0], tPos[1] - pos[1], tPos[2] - pos[2]);
    } else {
      maxRangeKm = 1000;
    }

    // Orient frustum
    let boundary = this.catalogBoundary;
    if (spiceRotation && spiceRotation.length === 9) {
      // SPICE pxform returns instrument→inertial rotation R (row-major).
      // Instrument frame: +X = horizontal, +Y = vertical, +Z = boresight.
      // Mesh-local frame: X = horizontal,  -Y = boresight, Z = vertical.
      //
      // Build mesh→inertial matrix from R columns:
      //   mesh X  → instr X in inertial: col0 = (r[0], r[3], r[6])
      //   mesh Y  → -instr Z in inertial: (-r[2], -r[5], -r[8])
      //   mesh Z  → instr Y in inertial: col1 = (r[1], r[4], r[7])
      const r = spiceRotation;
      _m4.set(
        r[0], -r[2], r[1], 0,
        r[3], -r[5], r[4], 0,
        r[6], -r[8], r[7], 0,
        0,     0,    0,    1,
      );
      this.frameQuat.setFromRotationMatrix(_m4);
      if (this.spiceFovBoundary) boundary = this.spiceFovBoundary;
    } else if (tPos) {
      // Fallback: point toward target, using same up convention as the PiP
      // camera (lookAt with worldUp = +Y) so the cone and PiP agree on
      // which direction is "up" in the instrument view.
      //
      // Mesh-local axes: X = horizontal, -Y = boresight, Z = vertical.
      // Camera axes:     X = right,      -Z = forward,   Y = up.
      // Mapping mesh→camera: meshX→camX, mesh(-Y)→cam(-Z), meshZ→camY.
      // But (camX, -dir, camY) has det=-1 (improper). Negating the right
      // vector gives det=+1 — a valid quaternion rotation. This mirrors the
      // cone's horizontal axis, which is invisible for symmetric FOVs.
      _dir.set(tPos[0] - pos[0], tPos[1] - pos[1], tPos[2] - pos[2]).normalize();

      _camZ.copy(_dir).negate();
      _right.crossVectors(_up.set(0, 1, 0), _camZ);
      if (_right.lengthSq() < 1e-10) _right.set(1, 0, 0);
      _right.normalize();
      _up.crossVectors(_camZ, _right);

      _m4.makeBasis(_right.negate(), _camZ, _up);
      _quat.setFromRotationMatrix(_m4);
      _quat.multiply(this.sensorOrientation);
      this.frameQuat.copy(_quat);
    }

    const q = this.frameQuat;
    const directionAt = (t: number): Vec3 => {
      const d = fovBoundaryDirection(boundary, t);
      // Instrument (x, y, z) → mesh-local (x, -z, y) → world.
      _v.set(d[0], -d[2], d[1]).applyQuaternion(q);
      return [_v.x, _v.y, _v.z];
    };
    const baseParams = fovBaseParams(boundary, this.segments);
    const perimeter = clip
      ? clip([pos[0], pos[1], pos[2]], directionAt, baseParams, maxRangeKm)
      : baseParams.map(t => ({ t, direction: directionAt(t), distanceKm: maxRangeKm, hit: null, base: true }));
    this._perimeter = perimeter;
    this._clipSummary = summarize(perimeter, !!clip, maxRangeKm);
    this.rebuildGeometry(perimeter, scaleFactor, boundary.kind === 'elliptical' ? null : boundary.vertices.length);

    // Label at the top-left of the far boundary.
    const labelT = labelParam(boundary);
    let label: FovPerimeterSample | undefined;
    for (const s of perimeter) {
      if (s.base && (!label || cyclicDistance(s.t, labelT) < cyclicDistance(label.t, labelT))) label = s;
    }
    if (label) {
      const k = label.distanceKm * scaleFactor;
      this.labelSprite.position.set(label.direction[0] * k, label.direction[1] * k, label.direction[2] * k);
    }
  }

  /**
   * Side faces fanned from the apex to each perimeter endpoint, the perimeter
   * loop, and side lines at stable base samples (corners only for polygons).
   * No end cap: the physical body, not a plane through it, terminates the FOV.
   */
  private rebuildGeometry(perimeter: readonly FovPerimeterSample[], scaleFactor: number, polygonVertices: number | null): void {
    const n = perimeter.length;
    const ends = new Float32Array(n * 3);
    perimeter.forEach((s, i) => {
      const k = s.distanceKm * scaleFactor;
      ends[i * 3] = s.direction[0] * k;
      ends[i * 3 + 1] = s.direction[1] * k;
      ends[i * 3 + 2] = s.direction[2] * k;
    });

    const fill = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      fill.set([0, 0, 0, ends[i * 3], ends[i * 3 + 1], ends[i * 3 + 2], ends[j * 3], ends[j * 3 + 1], ends[j * 3 + 2]], i * 9);
    }

    const isSide = (s: FovPerimeterSample) => s.base && (polygonVertices == null
      || Math.abs(s.t * polygonVertices - Math.round(s.t * polygonVertices)) < 1e-9);
    let sides = 0;
    for (const s of perimeter) if (isSide(s)) sides++;
    const lines = new Float32Array((n + sides) * 6);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      lines.set([ends[i * 3], ends[i * 3 + 1], ends[i * 3 + 2], ends[j * 3], ends[j * 3 + 1], ends[j * 3 + 2]], k); k += 6;
    }
    for (let i = 0; i < n; i++) {
      if (!isSide(perimeter[i])) continue;
      lines.set([0, 0, 0, ends[i * 3], ends[i * 3 + 1], ends[i * 3 + 2]], k); k += 6;
    }

    setPositions(this.frustumMesh.geometry, fill);
    setPositions(this.wireframe.geometry, lines);
  }

  dispose(): void {
    this.frustumMesh.geometry.dispose();
    (this.frustumMesh.material as THREE.Material).dispose();
    this.wireframe.geometry.dispose();
    (this.wireframe.material as THREE.Material).dispose();
    (this.labelSprite.material as THREE.SpriteMaterial).map?.dispose();
    (this.labelSprite.material as THREE.Material).dispose();
  }
}

/** Replace a geometry's positions, reusing the attribute when the size matches. */
function setPositions(geometry: THREE.BufferGeometry, positions: Float32Array): void {
  const attr = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (attr && attr.array.length === positions.length) {
    (attr.array as Float32Array).set(positions);
    attr.needsUpdate = true;
  } else {
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  }
  geometry.computeBoundingSphere();
}

function summarize(perimeter: readonly FovPerimeterSample[], clipped: boolean, maxRangeKm: number): SensorClipSummary {
  const bodies = new Set<string>();
  const sources = new Set<FovSurfaceSource>();
  let hitSamples = 0, coarse = false, fallback = false;
  for (const s of perimeter) {
    if (!s.hit) continue;
    hitSamples++;
    bodies.add(s.hit.candidateId);
    sources.add(s.hit.source);
    coarse ||= s.hit.detail === 'coarse';
    fallback ||= s.hit.fallback;
  }
  return { clipped, samples: perimeter.length, hitSamples, bodies: [...bodies], sources: [...sources], coarse, fallback, maxRangeKm };
}

/** Perimeter parameter nearest the top-left (−X, +Y) of the boundary. */
function labelParam(boundary: FovBoundaryShape): number {
  if (boundary.kind === 'elliptical') return 0.375; // 135°
  const n = boundary.vertices.length;
  let best = 0, score = -Infinity;
  boundary.vertices.forEach((v, i) => {
    const s = (-v[0] + v[1]) / Math.abs(v[2] || 1);
    if (s > score) { score = s; best = i; }
  });
  return best / n;
}

function cyclicDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 1;
  return Math.min(d, 1 - d);
}

/** Create a small text texture for a sensor label. */
function createTextTexture(text: string, color: number): THREE.CanvasTexture {
  const fontSize = 48; // render large, display small via sprite scale
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = `${fontSize}px monospace`;
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const pad = Math.ceil(fontSize * 0.3);
  canvas.width = Math.ceil(metrics.width) + pad * 2;
  canvas.height = fontSize + pad * 2;
  ctx.font = font;
  ctx.textBaseline = 'top';
  const cssColor = '#' + new THREE.Color(color).getHexString();
  ctx.shadowColor = 'black';
  ctx.shadowBlur = fontSize * 0.15;
  ctx.fillStyle = cssColor;
  ctx.fillText(text, pad, pad);
  ctx.fillText(text, pad, pad);
  ctx.shadowBlur = 0;
  ctx.fillText(text, pad, pad);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

/** Parse a range value that may be a number or string like "1000 km" or "1 au". */
function parseRange(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^([\d.]+)\s*(km|au|m)?$/i);
  if (!match) return undefined;
  const num = parseFloat(match[1]);
  switch (match[2]?.toLowerCase()) {
    case 'au': return num * 149597870.7;
    case 'm': return num / 1000;
    default: return num; // km
  }
}
