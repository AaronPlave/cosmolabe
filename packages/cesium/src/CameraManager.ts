/**
 * Camera management for Cesium: focus, track, flyTo.
 *
 * Uses Cesium's native `viewer.trackedEntity` for tracking, which handles
 * both the fly animation and continuous tracking in one step with consistent zoom.
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

    this._flyingTo = true;
    this._viewer.trackedEntity = undefined;

    // For tracked entities, let Cesium compute the default offset from the
    // entity's bounding sphere — this is the same offset trackedEntity will
    // use, so there's no zoom jump when tracking takes over.
    const flyOpts: any = { duration };
    if (!shouldTrack && options?.offset != null) {
      flyOpts.offset = new Cesium.HeadingPitchRange(0, -0.4, options.offset);
    }

    this._viewer.flyTo(entity, flyOpts).then(() => {
      this._flyingTo = false;
      if (shouldTrack) {
        this._viewer.trackedEntity = entity;
      }
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
