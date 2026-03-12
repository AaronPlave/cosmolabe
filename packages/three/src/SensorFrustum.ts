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

export class SensorFrustum extends THREE.Object3D {
  readonly body: Body;
  readonly targetName: string | undefined;
  private readonly frustumMesh: THREE.Mesh;
  private readonly wireframe: THREE.LineSegments;
  private readonly hFov: number; // radians (half-angle)
  private readonly vFov: number; // radians (half-angle)
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
  }

  update(et: number, scaleFactor: number, targetBody?: Body, resolvePos?: PositionResolver): void {
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

    // Orient toward target
    if (targetBody) {
      const tPos = resolvePos
        ? resolvePos(targetBody.name, et)
        : targetBody.stateAt(et).position as [number, number, number];
      const targetPos = new THREE.Vector3(tPos[0] * scaleFactor, tPos[1] * scaleFactor, tPos[2] * scaleFactor);
      const dir = targetPos.clone().sub(bodyPos).normalize();
      // Cone apex at origin, extends along -Y → align -Y with direction
      const negY = new THREE.Vector3(0, -1, 0);
      const quat = new THREE.Quaternion().setFromUnitVectors(negY, dir);
      // Apply sensor orientation offset (body-frame relative)
      quat.multiply(this.sensorOrientation);
      this.frustumMesh.quaternion.copy(quat);
      this.wireframe.quaternion.copy(quat);
    }
  }

  dispose(): void {
    this.frustumMesh.geometry.dispose();
    (this.frustumMesh.material as THREE.Material).dispose();
    this.wireframe.geometry.dispose();
    (this.wireframe.material as THREE.Material).dispose();
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
