import type * as THREE from 'three';

export interface AttachOptions {
  /** Rotate with the body's body-fixed frame? Default: false (inertial). */
  followRotation?: boolean;
  /** Auto-hide when the body is hidden? Default: true. */
  autoHide?: boolean;
}

/** Handle returned by RendererContext.attachToBody(). */
export interface AttachedVisual {
  readonly object: THREE.Object3D;
  readonly bodyName: string;
  /** Remove from scene and clean up. */
  detach(): void;
}
