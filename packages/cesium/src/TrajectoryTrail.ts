/**
 * Configures Cesium PathGraphics on an entity to show its trajectory.
 *
 * Solid trail (past) + dashed lead (future).
 */

/** Options for trajectory trail rendering. */
export interface TrajectoryTrailOptions {
  /** Coordinate frame — kept for API compat. */
  frame?: 'ecliptic' | 'equatorial';
  /** Seconds of past trajectory to show. Default: 2700 (45 min). */
  trailDuration?: number;
  /** Seconds of future trajectory to show. Default: 2700 (45 min). */
  leadDuration?: number;
  /** CSS color string. Default: '#00ff00'. */
  color?: string;
  /** Line width in pixels. Default: 2. */
  width?: number;
  /** Base opacity (0-1). Default: 0.6. */
  opacity?: number;
}

export class TrajectoryTrail {
  private readonly _entity: any;
  private readonly _viewer: any;
  private readonly _Cesium: any;
  private readonly _leadTime: number;
  private _leadEntity: any = null;

  constructor(entity: any, viewer: any, Cesium: any, options?: TrajectoryTrailOptions) {
    this._entity = entity;
    this._viewer = viewer;
    this._Cesium = Cesium;

    const trailTime = options?.trailDuration ?? 2700;
    this._leadTime = options?.leadDuration ?? 2700;
    const baseColor = Cesium.Color.fromCssColorString(options?.color ?? '#00ff00');
    const trailColor = baseColor.withAlpha(options?.opacity ?? 0.6);
    const width = options?.width ?? 2;

    // Solid trail (past)
    entity.path = new Cesium.PathGraphics({
      resolution: 1,
      material: trailColor,
      width,
      trailTime,
      leadTime: 0,
    });

    // Dashed lead (future)
    this._createLeadEntity(baseColor, width, options?.opacity ?? 0.6);
  }

  /**
   * Call when the position property is replaced (after resample).
   * Syncs the lead entity to the new property.
   */
  syncPosition(positionProperty: any): void {
    if (this._leadEntity) {
      this._leadEntity.position = positionProperty;
    }
  }

  /** No-op — paths update automatically. */
  update(_et: number): void {}

  dispose(): void {
    this._entity.path = undefined;
    if (this._leadEntity) {
      this._viewer.entities.remove(this._leadEntity);
      this._leadEntity = null;
    }
  }

  private _createLeadEntity(baseColor: any, width: number, opacity: number): void {
    if (this._leadTime <= 0) return;
    const Cesium = this._Cesium;
    const leadColor = baseColor.withAlpha(opacity * 0.5);

    this._leadEntity = this._viewer.entities.add({
      position: this._entity.position,
      path: new Cesium.PathGraphics({
        resolution: 1,
        material: new Cesium.PolylineDashMaterialProperty({
          color: leadColor,
          dashLength: 16,
        }),
        width,
        trailTime: 0,
        leadTime: this._leadTime,
      }),
    });
  }
}
