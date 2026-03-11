import * as THREE from 'three';
import type { Body } from '@spicecraft/core';
import type { PositionResolver } from './TrajectoryLine.js';

export interface SensorFrustumOptions {
  /** Color of the frustum wireframe */
  color?: number;
  /** Opacity of the filled frustum (0 = wireframe only) */
  opacity?: number;
  /** Length of the frustum cone in km (default: auto-scale to target distance) */
  length?: number;
  /** Number of segments around the cone circumference */
  segments?: number;
}

export class SensorFrustum extends THREE.Object3D {
  readonly body: Body;
  readonly targetName: string | undefined;
  private readonly cone: THREE.Mesh;
  private readonly wireframe: THREE.LineSegments;
  private readonly hFov: number; // radians
  private readonly vFov: number; // radians
  private readonly fixedLength: number | undefined;

  constructor(body: Body, options: SensorFrustumOptions = {}) {
    super();
    this.body = body;
    this.name = `${body.name}_sensor`;

    const sensor = body.geometryData?.sensor as {
      horizontalFov?: number;
      verticalFov?: number;
      frustumColor?: number[];
      target?: string;
    } | undefined;

    this.hFov = ((sensor?.horizontalFov ?? 10) * Math.PI) / 180;
    this.vFov = ((sensor?.verticalFov ?? sensor?.horizontalFov ?? 10) * Math.PI) / 180;
    this.targetName = sensor?.target;
    this.fixedLength = options.length;

    const color = options.color
      ?? (sensor?.frustumColor
        ? new THREE.Color(
            sensor.frustumColor[0],
            sensor.frustumColor[1],
            sensor.frustumColor[2],
          ).getHex()
        : 0x00ffff);
    const segments = options.segments ?? 32;

    // Create cone geometry — will be rescaled each frame
    const geometry = new THREE.ConeGeometry(1, 1, segments, 1, true);
    // Cone points along +Y by default; we'll orient it each frame
    geometry.translate(0, -0.5, 0); // move origin to apex

    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: options.opacity ?? 0.15,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.cone = new THREE.Mesh(geometry, material);
    this.add(this.cone);

    // Wireframe edges
    const edgesGeo = new THREE.EdgesGeometry(geometry);
    const wireMat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.6,
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

    // Determine cone length
    let length: number;
    if (this.fixedLength != null) {
      length = this.fixedLength * scaleFactor;
    } else if (targetBody && resolvePos) {
      const tPos = resolvePos(targetBody.name, et);
      const targetPos = new THREE.Vector3(tPos[0] * scaleFactor, tPos[1] * scaleFactor, tPos[2] * scaleFactor);
      length = bodyPos.distanceTo(targetPos) * 0.5;
    } else if (targetBody) {
      const targetState = targetBody.stateAt(et);
      const targetPos = new THREE.Vector3(
        targetState.position[0] * scaleFactor, targetState.position[1] * scaleFactor, targetState.position[2] * scaleFactor,
      );
      length = bodyPos.distanceTo(targetPos) * 0.5;
    } else {
      length = 1000 * scaleFactor; // 1000 km default
    }

    // Scale cone: radius from FOV, height = length
    const radiusH = length * Math.tan(this.hFov / 2);
    const radiusV = length * Math.tan(this.vFov / 2);
    const avgRadius = (radiusH + radiusV) / 2;
    this.cone.scale.set(avgRadius, length, avgRadius);
    this.wireframe.scale.copy(this.cone.scale);

    // Orient toward target
    if (targetBody) {
      const tPos = resolvePos
        ? resolvePos(targetBody.name, et)
        : targetBody.stateAt(et).position as [number, number, number];
      const targetPos = new THREE.Vector3(tPos[0] * scaleFactor, tPos[1] * scaleFactor, tPos[2] * scaleFactor);
      const dir = targetPos.clone().sub(bodyPos).normalize();
      const up = new THREE.Vector3(0, 1, 0);
      const quat = new THREE.Quaternion().setFromUnitVectors(up.clone().negate(), dir);
      this.cone.quaternion.copy(quat);
      this.wireframe.quaternion.copy(quat);
    }
  }

  dispose(): void {
    this.cone.geometry.dispose();
    (this.cone.material as THREE.Material).dispose();
    this.wireframe.geometry.dispose();
    (this.wireframe.material as THREE.Material).dispose();
  }
}
