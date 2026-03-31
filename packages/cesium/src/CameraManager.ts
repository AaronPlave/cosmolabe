/**
 * Camera management for Cesium: focus, track, flyTo.
 *
 * Uses Cesium's native trackedEntity for spacecraft (SampledPositionProperty).
 * For static entities (ground stations), just flies to them without tracking.
 */

/** Options for camera flyTo animation. */
export interface FlyToOptions {
  /** Duration of the fly animation in seconds. Default: 2.5. */
  duration?: number;
  /** Camera distance from target after flyTo, in meters. */
  offset?: number;
  /** Whether to track the entity after flying to it. Default: true. */
  track?: boolean;
}

export class CameraManager {
  private readonly _viewer: any;
  private readonly _Cesium: any;
  private readonly _handler: any;
  private _flyingTo = false;
  private _onFocusChange?: (entityId: string | null) => void;

  constructor(viewer: any, Cesium: any) {
    this._viewer = viewer;
    this._Cesium = Cesium;

    this._handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    // Double-click entity → track it. Double-click empty → unfocus.
    this._handler.setInputAction((click: any) => {
      const picked = viewer.scene.pick(click.position);
      if (picked?.id) {
        this._viewer.trackedEntity = picked.id;
        this._onFocusChange?.(picked.id.id ?? picked.id.name ?? null);
      } else {
        // Double-click empty space or globe → unfocus and center on Earth
        this.unfocus();
        this._viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(0, 20, 20_000_000),
          duration: 1.5,
        });
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  }

  onFocusChange(callback: (entityId: string | null) => void): void {
    this._onFocusChange = callback;
  }

  focusEntity(entity: any, options?: FlyToOptions): void {
    const Cesium = this._Cesium;
    const duration = options?.duration ?? 2.5;
    const shouldTrack = options?.track ?? true;
    // Default offset: 2,000 km for spacecraft, 500 km for ground stations
    const offset = options?.offset ?? (shouldTrack ? 2_000_000 : 500_000);

    this._flyingTo = true;
    this._viewer.trackedEntity = undefined;

    this._viewer.flyTo(entity, {
      duration,
      offset: new Cesium.HeadingPitchRange(0, -0.4, offset),
    }).then(() => {
      this._flyingTo = false;
      this._onFocusChange?.(entity.id ?? entity.name ?? null);
    }).catch(() => {
      this._flyingTo = false;
    });
  }

  focusById(entityId: string, options?: FlyToOptions): void {
    const entity = this._viewer.entities.getById(entityId);
    if (entity) this.focusEntity(entity, options);
  }

  /** No-op — trackedEntity handles camera updates natively. */
  update(): void {}

  unfocus(): void {
    this._viewer.trackedEntity = undefined;
    this._flyingTo = false;
    this._onFocusChange?.(null);
  }

  get isFlying(): boolean {
    return this._flyingTo;
  }

  get trackedEntity(): any {
    return this._viewer.trackedEntity;
  }

  dispose(): void {
    this.unfocus();
    this._handler.destroy();
  }
}
