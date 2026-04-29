import type * as THREE from 'three';
import type { Body } from '@cosmolabe/core';
import type { RendererContext } from './RendererContext.js';

/**
 * Creates and manages Three.js objects for a custom geometry type.
 * Registered by geometry type string — when a Body has geometryType = "GroundStation",
 * the renderer delegates to the registered BodyVisualizer.
 */
export interface BodyVisualizer {
  /** The geometry type string this handles (e.g., "GroundStation", "Constellation") */
  readonly geometryType: string;

  /** Create the Three.js scene graph for this body. Called once during buildScene(). */
  createVisual(body: Body, ctx: RendererContext): THREE.Object3D;

  /** Update the visual each frame. */
  updateVisual(
    object: THREE.Object3D,
    body: Body,
    et: number,
    scaledPosition: [number, number, number],
    ctx: RendererContext,
  ): void;

  /** Clean up GPU resources. */
  dispose?(object: THREE.Object3D): void;
}
