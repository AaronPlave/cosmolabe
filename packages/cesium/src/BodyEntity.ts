/**
 * Maps a SpiceCraft Body to a Cesium Entity using SampledPositionProperty
 * in the INERTIAL reference frame.
 *
 * For equatorial-frame bodies (TLE), samples are stored in ICRF and Cesium
 * automatically handles the ICRF→Fixed transformation for rendering.
 * This produces correct circular orbits and smooth camera tracking.
 */

import type { Body } from '@spicecraft/core';
import type { EntityStyleOptions, ResolvedEntityStyle } from './EntityStyle.js';
import { resolveEntityStyle } from './EntityStyle.js';

/** Options for creating a BodyEntity. */
export interface BodyEntityOptions extends EntityStyleOptions {
  positionResolver?: (body: Body, et: number) => [number, number, number];
  /** How far ahead/behind to pre-sample, in seconds. Default: 5400 (90 min). */
  sampleWindow?: number;
  /** Seconds between samples. Default: 10. */
  sampleStep?: number;
}

/** Convert ET (seconds past J2000 TDB) to JS Date. */
function etToJsDate(et: number): Date {
  const J2000_UNIX_MS = Date.UTC(2000, 0, 1, 11, 58, 55, 816);
  return new Date(J2000_UNIX_MS + et * 1000);
}

/** km → meters */
const KM_TO_M = 1000;

export class BodyEntity {
  readonly body: Body;
  readonly entity: any; // Cesium.Entity
  private readonly _viewer: any;
  private readonly _Cesium: any;
  private readonly _style: ResolvedEntityStyle;
  private readonly _positionResolver?: (body: Body, et: number) => [number, number, number];
  private readonly _sampleWindow: number;
  private readonly _sampleStep: number;
  private _positionProperty: any; // Cesium.SampledPositionProperty
  private _sampledRangeStart = 0;
  private _sampledRangeEnd = 0;

  private _pulseStart = 0;
  private _isPulsing = false;
  private _onResample?: (positionProperty: any) => void;

  constructor(viewer: any, body: Body, Cesium: any, options?: BodyEntityOptions) {
    this.body = body;
    this._viewer = viewer;
    this._Cesium = Cesium;
    this._style = resolveEntityStyle(options);
    this._positionResolver = options?.positionResolver;
    this._sampleWindow = options?.sampleWindow ?? 5400;
    this._sampleStep = options?.sampleStep ?? 10;

    // Use INERTIAL reference frame for equatorial/TLE bodies.
    // Cesium handles ICRF→Fixed transformation automatically.
    const refFrame = body.trajectoryFrame === 'equatorial'
      ? Cesium.ReferenceFrame.INERTIAL
      : Cesium.ReferenceFrame.FIXED;

    this._positionProperty = new Cesium.SampledPositionProperty(refFrame);
    this._positionProperty.setInterpolationOptions({
      interpolationDegree: 5,
      interpolationAlgorithm: Cesium.LagrangePolynomialApproximation,
    });

    const color = Cesium.Color.fromCssColorString(this._style.color);

    this.entity = viewer.entities.add({
      id: `spicecraft-body-${body.name}`,
      name: body.name,
      position: this._positionProperty,
      point: new Cesium.PointGraphics({
        pixelSize: this._style.pointSize,
        color,
        outlineColor: color.withAlpha(0.4),
        outlineWidth: 2,
      }),
      label: this._style.showLabel
        ? new Cesium.LabelGraphics({
            text: body.name,
            font: '28px sans-serif',
            scale: 0.5,
            fillColor: Cesium.Color.WHITE,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            outlineWidth: 4,
            outlineColor: Cesium.Color.BLACK,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, this._style.labelOffset),
          })
        : undefined,
    });
  }

  update(et: number): void {
    const margin = this._sampleWindow * 0.1;
    if (et < this._sampledRangeStart + margin || et > this._sampledRangeEnd - margin || this._sampledRangeStart === 0) {
      this._resample(et);
    }

    if (this._isPulsing) {
      const elapsed = performance.now() - this._pulseStart;
      const t = Math.min(elapsed / this._style.pulseDuration, 1);
      const size = this._style.pulseMaxSize - (this._style.pulseMaxSize - this._style.pointSize) * t;
      this.entity.point.pixelSize = size;
      if (t >= 1) this._isPulsing = false;
    }
  }

  /** Register a callback invoked when the position property is replaced (resample). */
  onResample(cb: (positionProperty: any) => void): void {
    this._onResample = cb;
  }

  pulse(): void {
    if (!this._style.pulseOnEvent) return;
    this._isPulsing = true;
    this._pulseStart = performance.now();
  }

  dispose(): void {
    this._viewer.entities.remove(this.entity);
  }

  private _resample(centerEt: number): void {
    const Cesium = this._Cesium;
    const startEt = centerEt - this._sampleWindow;
    const endEt = centerEt + this._sampleWindow;

    const refFrame = this.body.trajectoryFrame === 'equatorial'
      ? Cesium.ReferenceFrame.INERTIAL
      : Cesium.ReferenceFrame.FIXED;

    const newProp = new Cesium.SampledPositionProperty(refFrame);
    newProp.setInterpolationOptions({
      interpolationDegree: 5,
      interpolationAlgorithm: Cesium.LagrangePolynomialApproximation,
    });

    let sampleCount = 0;
    for (let et = startEt; et <= endEt; et += this._sampleStep) {
      const pos = this._getPosition(et);
      if (!pos) continue;

      // Positions are in the trajectory's native frame (km).
      // For equatorial (TLE/TEME ≈ ICRF): store directly in INERTIAL frame.
      // For ecliptic (SPICE): would need ecliptic→equatorial rotation.
      const cartesian = new Cesium.Cartesian3(
        pos[0] * KM_TO_M,
        pos[1] * KM_TO_M,
        pos[2] * KM_TO_M,
      );

      const julianDate = Cesium.JulianDate.fromDate(etToJsDate(et));
      newProp.addSample(julianDate, cartesian);
      sampleCount++;
    }

    this._positionProperty = newProp;
    this.entity.position = newProp;
    this._sampledRangeStart = startEt;
    this._sampledRangeEnd = endEt;
    this._onResample?.(newProp);
  }

  private _getPosition(et: number): [number, number, number] | undefined {
    if (this._positionResolver) {
      return this._positionResolver(this.body, et);
    }
    const trajectory = this.body.trajectory;
    if (!trajectory) return undefined;
    try {
      const state = trajectory.stateAt(et);
      return [state.position[0], state.position[1], state.position[2]];
    } catch {
      return undefined;
    }
  }
}
