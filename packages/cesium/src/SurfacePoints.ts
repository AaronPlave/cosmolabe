/**
 * Renders a set of surface-fixed points (ground stations, landing sites, POIs)
 * on a Cesium globe.
 *
 * Each point is defined by a SpiceCraft Body with lat/lon/alt in its geometryData.
 * Points can be grouped (e.g., by network) and colored by group.
 *
 * Usable standalone with any Cesium Viewer.
 */

import type { Body } from '@spicecraft/core';

/** Options for surface point rendering. */
export interface SurfacePointsOptions {
  /** Default color for points without a group color. Default: '#ffffff'. */
  defaultColor?: string;
  /** Map from group name to CSS color string. */
  groupColors?: Record<string, string>;
  /** Default point pixel size. Default: 8. */
  pointSize?: number;
  /** Show labels. Default: true. */
  showLabels?: boolean;
  /** Label font. Default: '12px sans-serif'. */
  labelFont?: string;
}

/** Metadata expected in Body.geometryData for surface points. */
interface SurfacePointData {
  lat: number;
  lon: number;
  alt?: number;
  group?: string;
}

/**
 * Renders bodies as labeled surface points on a Cesium globe.
 *
 * Usage:
 * ```ts
 * const points = new SurfacePoints(viewer, bodies, Cesium, {
 *   groupColors: { 'DSN': '#00ffff', 'ESTRACK': '#ffbf00' },
 * });
 * points.dispose();
 * ```
 */
export class SurfacePoints {
  private readonly _viewer: any;
  private readonly _Cesium: any;
  private readonly _entities: any[] = [];
  private readonly _entityMap = new Map<string, any>();

  constructor(
    viewer: any,
    bodies: Body[],
    Cesium: any,
    options?: SurfacePointsOptions,
  ) {
    this._viewer = viewer;
    this._Cesium = Cesium;

    const defaultColor = options?.defaultColor ?? '#ffffff';
    const groupColors = options?.groupColors ?? {};
    const pointSize = options?.pointSize ?? 8;
    const showLabels = options?.showLabels ?? true;
    const labelFont = options?.labelFont ?? '14px sans-serif';

    for (const body of bodies) {
      const data = extractSurfaceData(body);
      if (!data) continue;

      const colorStr = data.group ? (groupColors[data.group] ?? defaultColor) : defaultColor;
      const color = Cesium.Color.fromCssColorString(colorStr);

      const entity = viewer.entities.add({
        id: `spicecraft-surface-${body.name}`,
        name: body.name,
        position: Cesium.Cartesian3.fromDegrees(data.lon, data.lat, (data.alt ?? 0) * 1000),
        point: new Cesium.PointGraphics({
          pixelSize: pointSize,
          color,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
        }),
        label: showLabels
          ? new Cesium.LabelGraphics({
              text: body.name,
              font: '28px sans-serif',
              scale: 0.5,
              fillColor: color,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              outlineWidth: 4,
              outlineColor: Cesium.Color.BLACK,
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              pixelOffset: new Cesium.Cartesian2(0, -12),
            })
          : undefined,
      });

      this._entities.push(entity);
      this._entityMap.set(body.name, entity);
    }
  }

  /** Get a surface point entity by body name. */
  getEntity(bodyName: string): any | undefined {
    return this._entityMap.get(bodyName);
  }

  /** Remove all surface point entities from the viewer. */
  dispose(): void {
    for (const entity of this._entities) {
      this._viewer.entities.remove(entity);
    }
    this._entities.length = 0;
  }
}

function extractSurfaceData(body: Body): SurfacePointData | undefined {
  const geo = body.geometryData as Record<string, unknown> | undefined;
  if (!geo) return undefined;

  const lat = geo.lat as number | undefined;
  const lon = geo.lon as number | undefined;
  if (lat == null || lon == null) return undefined;

  return {
    lat,
    lon,
    alt: geo.alt as number | undefined,
    group: geo.group as string | undefined,
  };
}
