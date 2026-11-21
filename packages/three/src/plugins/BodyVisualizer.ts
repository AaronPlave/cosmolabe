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

  /**
   * Whether a click that landed on `bodyName`'s surface at `worldPoint` hit
   * this visual — for visuals drawn on another body's surface (observation
   * footprints). Optional; without it the visual is not pickable. A
   * containment test on the surface point, so a click never raycasts the
   * visual's own geometry.
   */
  pickOnSurface?(object: THREE.Object3D, bodyName: string, worldPoint: THREE.Vector3): boolean;

  /**
   * Whether the visual should still be updated (and decide its own visibility)
   * while its body is outside its existence window. Optional; absent means no
   * — the renderer hides it, as it does every other body. Observations use it
   * so a selected one stays drawn after its window closes.
   */
  showsWhenAbsent?(object: THREE.Object3D): boolean;

  /** Clean up GPU resources. */
  dispose?(object: THREE.Object3D): void;
}
