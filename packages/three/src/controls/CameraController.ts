import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { BodyMesh } from '../BodyMesh.js';

export class CameraController {
  readonly controls: OrbitControls;
  readonly camera: THREE.PerspectiveCamera;
  private _trackTarget: BodyMesh | null = null;
  private readonly _prevTargetPos = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
    this.camera = camera;
    this.controls = new OrbitControls(camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.minDistance = 0.01;
    this.controls.maxDistance = 1e9;
  }

  /** Focus on a body — move orbit target to body position */
  focusOn(bodyMesh: BodyMesh): void {
    this.controls.target.copy(bodyMesh.position);
  }

  /** Track a body each frame — camera follows the body, preserving the view offset */
  track(bodyMesh: BodyMesh | null): void {
    this._trackTarget = bodyMesh;
    if (bodyMesh) {
      this.focusOn(bodyMesh);
      this._prevTargetPos.copy(bodyMesh.position);
    }
  }

  update(): void {
    if (this._trackTarget) {
      // Compute how much the tracked body moved since last frame
      const delta = this._trackTarget.position.clone().sub(this._prevTargetPos);

      // Move both camera and target by the same delta — preserves zoom/orbit offset
      this.camera.position.add(delta);
      this.controls.target.copy(this._trackTarget.position);

      this._prevTargetPos.copy(this._trackTarget.position);
    }
    this.controls.update();
  }

  dispose(): void {
    this.controls.dispose();
  }
}
