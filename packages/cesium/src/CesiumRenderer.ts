/**
 * CesiumRenderer — orchestrates SpiceCraft Body visualization on a CesiumJS globe.
 *
 * Two modes:
 * 1. Create a new Viewer: `new CesiumRenderer(container, universe, Cesium, options)`
 * 2. Use existing Viewer: `new CesiumRenderer(viewer, universe, Cesium)`
 *
 * This is a convenience orchestrator. The individual pieces (BodyEntity,
 * TrajectoryTrail, SurfacePoints, CameraManager) are usable standalone.
 */

import type { Body, Universe } from '@spicecraft/core';
import { BodyEntity } from './BodyEntity.js';
import type { BodyEntityOptions } from './BodyEntity.js';
import { TrajectoryTrail } from './TrajectoryTrail.js';
import type { TrajectoryTrailOptions } from './TrajectoryTrail.js';
import { SurfacePoints } from './SurfacePoints.js';
import type { SurfacePointsOptions } from './SurfacePoints.js';
import { CameraManager } from './CameraManager.js';
import { createGlobeViewer } from './GlobeSetup.js';
import type { GlobeSetupOptions } from './GlobeSetup.js';

/** Options for the CesiumRenderer. */
export interface CesiumRendererOptions extends GlobeSetupOptions {
  /** Options applied to all body entities. Can be overridden per-body. */
  entityDefaults?: BodyEntityOptions;
  /** Options for trajectory trails. */
  trailDefaults?: TrajectoryTrailOptions;
  /** Options for surface points. */
  surfacePointDefaults?: SurfacePointsOptions;
  /** Per-body style overrides keyed by body name. */
  bodyStyles?: Record<string, BodyEntityOptions>;
  /** Filter which bodies get trajectory trails. Default: all with trajectories. */
  trailFilter?: (body: Body) => boolean;
  /** Filter which bodies are rendered as surface points. Default: bodies with lat/lon in geometryData. */
  surfacePointFilter?: (body: Body) => boolean;
}

/**
 * Orchestrates SpiceCraft visualization on a CesiumJS globe.
 */
export class CesiumRenderer {
  readonly viewer: any; // Cesium.Viewer
  readonly universe: Universe;
  readonly camera: CameraManager;

  private readonly _Cesium: any;
  private readonly _options: CesiumRendererOptions;
  private readonly _ownsViewer: boolean;
  private readonly _bodyEntities = new Map<string, BodyEntity>();
  private readonly _trails = new Map<string, TrajectoryTrail>();
  private _surfacePoints: SurfacePoints | null = null;

  /**
   * Create a CesiumRenderer.
   *
   * @param viewerOrContainer Existing Cesium.Viewer, or HTML element / element ID to create one
   * @param universe SpiceCraft Universe instance
   * @param Cesium The CesiumJS namespace
   * @param options Renderer options (only used when creating a new Viewer)
   */
  constructor(
    viewerOrContainer: any,
    universe: Universe,
    Cesium: any,
    options?: CesiumRendererOptions,
  ) {
    this._Cesium = Cesium;
    this.universe = universe;
    this._options = options ?? {};

    // Determine if we're creating a new viewer or using an existing one
    if (viewerOrContainer?.scene && viewerOrContainer?.entities) {
      // It's an existing Viewer
      this.viewer = viewerOrContainer;
      this._ownsViewer = false;
    } else {
      // It's a container — create a new Viewer
      this.viewer = createGlobeViewer(viewerOrContainer, Cesium, this._options);
      this._ownsViewer = true;
    }

    this.camera = new CameraManager(this.viewer, Cesium);

    // Initialize from current universe state
    this._syncBodies();

    // Listen for body changes
    universe.events.on('body:added', ({ body }) => this._addBody(body));
    universe.events.on('body:removed', ({ bodyName }) => this._removeBody(bodyName));
  }

  /**
   * Update all entities for the given ephemeris time.
   */
  setTime(et: number): void {
    for (const bodyEntity of this._bodyEntities.values()) {
      bodyEntity.update(et);
    }

    for (const trail of this._trails.values()) {
      trail.update(et);
    }

    // Update camera tracking after positions are set
    this.camera.update();
  }

  /**
   * Focus the camera on a body by name.
   */
  focusBody(bodyName: string): void {
    const bodyEntity = this._bodyEntities.get(bodyName);
    if (bodyEntity) {
      this.camera.focusEntity(bodyEntity.entity);
      return;
    }
    // Surface points: fly to but don't track (they're static)
    const surfaceEntity = this._surfacePoints?.getEntity(bodyName);
    if (surfaceEntity) {
      this.camera.focusEntity(surfaceEntity, { track: false });
    }
  }

  /**
   * Trigger a pulse animation on a body (e.g., on telemetry arrival).
   */
  pulseBody(bodyName: string): void {
    this._bodyEntities.get(bodyName)?.pulse();
  }

  /**
   * Get a BodyEntity by name.
   */
  getBodyEntity(bodyName: string): BodyEntity | undefined {
    return this._bodyEntities.get(bodyName);
  }

  /**
   * Clean up all entities and optionally destroy the viewer.
   */
  dispose(): void {
    this.camera.dispose();
    this._surfacePoints?.dispose();

    for (const trail of this._trails.values()) {
      trail.dispose();
    }
    this._trails.clear();

    for (const entity of this._bodyEntities.values()) {
      entity.dispose();
    }
    this._bodyEntities.clear();

    if (this._ownsViewer) {
      this.viewer.destroy();
    }
  }

  private _syncBodies(): void {
    const surfaceBodies: Body[] = [];

    for (const body of this.universe.getAllBodies()) {
      if (this._isSurfacePoint(body)) {
        surfaceBodies.push(body);
      } else if (body.trajectory) {
        this._addBody(body);
      }
    }

    if (surfaceBodies.length > 0) {
      this._surfacePoints = new SurfacePoints(
        this.viewer,
        surfaceBodies,
        this._Cesium,
        this._options.surfacePointDefaults,
      );
    }
  }

  private _addBody(body: Body): void {
    if (this._bodyEntities.has(body.name)) return;
    if (this._isSurfacePoint(body)) return;
    if (!body.trajectory) return;
    // Skip planets/stars — they are the globe itself, not entities on it
    if (body.classification === 'planet' || body.classification === 'star' || body.classification === 'barycenter') return;

    // Create body entity
    const style = {
      ...this._options.entityDefaults,
      ...this._options.bodyStyles?.[body.name],
      positionResolver: (b: Body, et: number) => {
        return this.universe.absolutePositionOf(b.name, et);
      },
    };

    const bodyEntity = new BodyEntity(this.viewer, body, this._Cesium, style);
    this._bodyEntities.set(body.name, bodyEntity);

    // Create trajectory trail if applicable
    const shouldTrail = this._options.trailFilter
      ? this._options.trailFilter(body)
      : true;

    if (shouldTrail) {
      const trail = new TrajectoryTrail(
        bodyEntity.entity,
        this.viewer,
        this._Cesium,
        this._options.trailDefaults,
      );
      this._trails.set(body.name, trail);

      // Sync lead entity position when BodyEntity resamples
      bodyEntity.onResample((newProp) => trail.syncPosition(newProp));
    }
  }

  private _removeBody(bodyName: string): void {
    this._bodyEntities.get(bodyName)?.dispose();
    this._bodyEntities.delete(bodyName);

    this._trails.get(bodyName)?.dispose();
    this._trails.delete(bodyName);
  }

  private _isSurfacePoint(body: Body): boolean {
    if (this._options.surfacePointFilter) {
      return this._options.surfacePointFilter(body);
    }
    const geo = body.geometryData as Record<string, unknown> | undefined;
    return geo?.lat != null && geo?.lon != null;
  }
}
