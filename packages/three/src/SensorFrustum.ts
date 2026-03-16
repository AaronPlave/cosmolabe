import * as THREE from 'three';
import type { Body } from '@spicecraft/core';
import type { PositionResolver } from './TrajectoryLine.js';

export interface SensorFrustumOptions {
  /** Color of the frustum (hex, overrides catalog frustumColor) */
  color?: number;
  /** Opacity of the filled frustum (overrides catalog frustumOpacity) */
  opacity?: number;
  /** Length of the frustum in km (overrides catalog range) */
  length?: number;
  /** Number of segments for elliptical shape (default: 32) */
  segments?: number;
}

// Reusable temp objects for per-frame orientation (avoids GC pressure)
const _dir = new THREE.Vector3();
const _targetPos = new THREE.Vector3();
const _camZ = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _corner = new THREE.Vector3();

export class SensorFrustum extends THREE.Object3D {
  readonly body: Body;
  readonly targetName: string | undefined;
  /** NAIF instrument ID for SPICE-based orientation (e.g. -82360 for Cassini ISS NAC) */
  readonly spiceId: number | undefined;
  /** Cached SPICE instrument frame name (from getfov during construction). Avoids per-frame getfov calls. */
  spiceFovFrame: string | undefined;
  private readonly frustumMesh: THREE.Mesh;
  private readonly wireframe: THREE.LineSegments;
  private readonly labelSprite: THREE.Sprite;
  private readonly hFov: number; // full angle in radians
  private readonly vFov: number; // full angle in radians
  private readonly fixedLength: number | undefined;
  private readonly shape: 'elliptical' | 'rectangular';
  private readonly sensorOrientation: THREE.Quaternion;

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
    this.spiceId = geo?.spiceId as number | undefined;
    this.shape = (geo?.shape as string) === 'rectangular' ? 'rectangular' : 'elliptical';

    // Range from catalog (in km) or from options
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
    const segments = options.segments ?? 32;

    // Build geometry based on shape
    let geometry: THREE.BufferGeometry;
    if (this.shape === 'rectangular') {
      geometry = createPyramidGeometry();
    } else {
      geometry = new THREE.ConeGeometry(1, 1, segments, 1, true);
      geometry.translate(0, -0.5, 0); // apex at origin
    }

    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.frustumMesh = new THREE.Mesh(geometry, material);
    this.add(this.frustumMesh);

    // Wireframe edges
    const edgesGeo = new THREE.EdgesGeometry(geometry);
    const wireMat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: Math.min(1, opacity * 2.5),
    });
    this.wireframe = new THREE.LineSegments(edgesGeo, wireMat);
    this.add(this.wireframe);

    // Label sprite at the far end of the frustum
    const labelTexture = createTextTexture(body.name, color);
    const labelMat = new THREE.SpriteMaterial({
      map: labelTexture,
      transparent: true,
      depthTest: true,
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

  /**
   * @param spiceRotation Optional 3x3 rotation matrix (row-major, 9 elements) from
   *   instrument frame → J2000, obtained via pxform(instrumentFrame, 'J2000', et).
   *   When provided, the frustum is oriented using real SPICE pointing data.
   */
  update(et: number, scaleFactor: number, targetBody?: Body, resolvePos?: PositionResolver, spiceRotation?: number[]): void {
    const pos = resolvePos
      ? resolvePos(this.body.name, et)
      : this.body.stateAt(et).position as [number, number, number];
    const bodyPos = new THREE.Vector3(
      pos[0] * scaleFactor,
      pos[1] * scaleFactor,
      pos[2] * scaleFactor,
    );

    this.position.copy(bodyPos);

    // Determine frustum length
    let length: number;
    if (this.fixedLength != null) {
      length = this.fixedLength * scaleFactor;
    } else if (targetBody) {
      const tPos = resolvePos
        ? resolvePos(targetBody.name, et)
        : targetBody.stateAt(et).position as [number, number, number];
      const targetPos = new THREE.Vector3(tPos[0] * scaleFactor, tPos[1] * scaleFactor, tPos[2] * scaleFactor);
      length = bodyPos.distanceTo(targetPos);
    } else {
      length = 1000 * scaleFactor;
    }

    // Scale: X by horizontal FOV, Z by vertical FOV, Y by length
    const radiusH = length * Math.tan(this.hFov / 2);
    const radiusV = length * Math.tan(this.vFov / 2);
    this.frustumMesh.scale.set(radiusH, length, radiusV);
    this.wireframe.scale.copy(this.frustumMesh.scale);

    // Orient frustum
    if (spiceRotation && spiceRotation.length === 9) {
      // SPICE pxform returns instrument→J2000 rotation R (row-major).
      // Instrument frame: +X = horizontal, +Y = vertical, +Z = boresight.
      // Frustum mesh:     X = horizontal,  -Y = boresight, Z = vertical.
      //
      // Build mesh→J2000 matrix from R columns:
      //   mesh X  → instr X in J2000: col0 = (r[0], r[3], r[6])
      //   mesh Y  → -instr Z in J2000: (-r[2], -r[5], -r[8])
      //   mesh Z  → instr Y in J2000: col1 = (r[1], r[4], r[7])
      const r = spiceRotation;
      _m4.set(
        r[0], -r[2], r[1], 0,
        r[3], -r[5], r[4], 0,
        r[6], -r[8], r[7], 0,
        0,     0,    0,    1,
      );
      _quat.setFromRotationMatrix(_m4);
      this.frustumMesh.quaternion.copy(_quat);
      this.wireframe.quaternion.copy(_quat);
    } else if (targetBody) {
      // Fallback: point toward target, using same up convention as the PiP
      // camera (lookAt with worldUp = +Y) so the cone and PiP agree on
      // which direction is "up" in the instrument view.
      //
      // Cone mesh axes: X = horizontal, -Y = boresight, Z = vertical.
      // Camera axes:    X = right,      -Z = forward,   Y = up.
      // Mapping cone→camera: coneX→camX, cone(-Y)→cam(-Z), coneZ→camY.
      // But (camX, -dir, camY) has det=-1 (improper). Negating the right
      // vector gives det=+1 — a valid quaternion rotation. This mirrors the
      // cone's horizontal axis, which is invisible for symmetric FOVs.
      const tPos = resolvePos
        ? resolvePos(targetBody.name, et)
        : targetBody.stateAt(et).position as [number, number, number];
      _targetPos.set(tPos[0] * scaleFactor, tPos[1] * scaleFactor, tPos[2] * scaleFactor);
      _dir.subVectors(_targetPos, bodyPos).normalize();

      _camZ.copy(_dir).negate();
      _right.crossVectors(_up.set(0, 1, 0), _camZ);
      if (_right.lengthSq() < 1e-10) _right.set(1, 0, 0);
      _right.normalize();
      _up.crossVectors(_camZ, _right);

      _m4.makeBasis(_right.negate(), _camZ, _up);
      _quat.setFromRotationMatrix(_m4);
      _quat.multiply(this.sensorOrientation);
      this.frustumMesh.quaternion.copy(_quat);
      this.wireframe.quaternion.copy(_quat);
    }

    // Position label at top-left corner of the frustum base.
    // In mesh local space: (-1, -1, +1) = (left, far end, top).
    // After scale: (-radiusH, -length, +radiusV). Then rotate by mesh quaternion.
    _corner.set(-radiusH, -length, radiusV);
    _corner.applyQuaternion(this.frustumMesh.quaternion);
    this.labelSprite.position.copy(_corner);
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

/** Create a 4-sided pyramid geometry (apex at origin, base at y=-1, unit extent). */
function createPyramidGeometry(): THREE.BufferGeometry {
  // Apex at origin, base corners at y=-1 with ±1 extent in x/z
  const apex = [0, 0, 0];
  const bl = [-1, -1, -1]; // bottom-left
  const br = [1, -1, -1];  // bottom-right
  const tr = [1, -1, 1];   // top-right
  const tl = [-1, -1, 1];  // top-left

  // 4 side triangles (no bottom cap — open frustum)
  const positions = new Float32Array([
    // Front face (z = -1 side)
    ...apex, ...bl, ...br,
    // Right face (x = +1 side)
    ...apex, ...br, ...tr,
    // Back face (z = +1 side)
    ...apex, ...tr, ...tl,
    // Left face (x = -1 side)
    ...apex, ...tl, ...bl,
  ]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
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
