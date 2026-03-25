import type * as THREE from 'three';
import type { Universe, EventBus, StateStore, UniverseState } from '@spicecraft/core';
import type { BodyMesh } from '../BodyMesh.js';
import type { TrajectoryLine } from '../TrajectoryLine.js';
import type { AttachedVisual, AttachOptions } from './AttachedVisual.js';
import type { RendererEventMap } from '../events/RendererEventMap.js';

/**
 * Typed context passed to RendererPlugin lifecycle hooks.
 * Replaces the previous (scene: unknown, camera: unknown, universe) pattern.
 */
export interface RendererContext {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly webglRenderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly universe: Universe;
  readonly scaleFactor: number;
  readonly events: EventBus<RendererEventMap>;
  readonly state: StateStore<UniverseState>;
  getBodyMesh(name: string): BodyMesh | undefined;
  getTrajectoryLine(name: string): TrajectoryLine | undefined;
  /** Attach a Three.js object to a body. Renderer manages positioning each frame. */
  attachToBody(bodyName: string, object: THREE.Object3D, options?: AttachOptions): AttachedVisual;
}
