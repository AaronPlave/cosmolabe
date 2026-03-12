import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import type { BodyMesh } from '../BodyMesh.js';

export class CameraController {
  readonly controls: TrackballControls;
  readonly camera: THREE.PerspectiveCamera;
  private _trackTarget: BodyMesh | null = null;
  get trackedBody(): BodyMesh | null { return this._trackTarget; }
  private readonly _prevTargetPos = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
    this.camera = camera;
    this.controls = new TrackballControls(camera, domElement);
    this.controls.rotateSpeed = 2.0;
    this.controls.zoomSpeed = 1.2;
    this.controls.panSpeed = 0.3;
    this.controls.staticMoving = false;
    this.controls.dynamicDampingFactor = 0.15;
    this.controls.minDistance = 1e-10;
    this.controls.maxDistance = 1e12;
  }

  /** Focus on a body — move orbit target to body position */
  focusOn(bodyMesh: BodyMesh): void {
    this.controls.target.copy(bodyMesh.position);
  }

  /** Focus and zoom to a body — positions camera at a good viewing distance.
   *  With origin-shifting, the tracked body will be at (0,0,0) after the next frame. */
  zoomTo(bodyMesh: BodyMesh, scaleFactor: number): void {
    this.controls.target.set(0, 0, 0);
    // Position camera at 3× the body's display radius
    const viewDist = bodyMesh.displayRadius * scaleFactor * 3;
    const dir = this.camera.position.clone();
    if (dir.lengthSq() < 1e-20) dir.set(0, 0, 1);
    dir.normalize();
    this.camera.position.copy(dir).multiplyScalar(viewDist);
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
      // With origin-shifting, the tracked body is always at scene origin.
      // Just keep the orbit target at (0,0,0).
      this.controls.target.set(0, 0, 0);
    }
    this.controls.update();
  }

  dispose(): void {
    this.controls.dispose();
  }
}
