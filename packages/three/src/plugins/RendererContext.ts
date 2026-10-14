import type * as THREE from 'three';
import type { Universe, EventBus, StateStore, UniverseState } from '@cosmolabe/core';
import type { BodyMesh } from '../BodyMesh.js';
import type { TrajectoryLine } from '../TrajectoryLine.js';
import type { AttachedVisual, AttachOptions } from './AttachedVisual.js';
import type { RendererEventMap } from '../events/RendererEventMap.js';

/**
 * Typed context passed to RendererPlugin lifecycle hooks.
 * Replaces the previous (scene: unknown, camera: unknown, universe) pattern.
 */
export interface RendererContext {
  /**
   * Shared scene. Directional lights are reserved for solar illumination:
   * atmospheric body/terrain materials attenuate every directional light with
   * the Sun's atmospheric transmittance. Plugins must use PointLight or
   * SpotLight for local illumination, rather than adding DirectionalLight.
   */
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
  /**
   * Trigger a full multi-pass render synchronously. Useful for capture features
   * (screenshot, video frame) so the canvas backing store reflects the complete
   * composite (bodies + tiles + models + markers + bloom) at the time of capture,
   * rather than a single-pass `webglRenderer.render(scene, camera)` which would
   * overwrite the multi-pass result with just Pass 1.
   */
  renderFrame(): void;
}
