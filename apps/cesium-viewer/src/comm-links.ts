/**
 * Comm Links — draws real-time line-of-sight links between ISS and
 * visible TDRS relay satellites / ground stations on a Cesium globe.
 *
 * Uses Cesium PolylineCollection (scene primitive) instead of entities
 * to avoid interfering with entity picking/tracking.
 *
 * Visibility is computed geometrically each tick:
 *   - Relay satellites: ray-sphere intersection (Earth occultation)
 *   - Ground stations: elevation angle above local horizon (min 5°)
 */

const EARTH_RADIUS_M = 6_371_000;
const MIN_ELEVATION_DEG = 5;
const DEG = 180 / Math.PI;

interface LinkDef {
  type: 'relay' | 'ground';
  targetEntityId: string;
  color: any;               // Cesium.Color
  precomputedEcef?: any;    // for ground stations (fixed)
  polyline: any;            // Cesium.Polyline in the collection
}

export class CommLinks {
  private readonly _viewer: any;
  private readonly _Cesium: any;
  private readonly _issEntityId: string;
  private readonly _collection: any; // Cesium.PolylineCollection
  private readonly _links: LinkDef[] = [];

  visibleRelays = 0;
  visibleStations = 0;

  constructor(
    viewer: any,
    Cesium: any,
    issBodyName: string,
    relayNames: { name: string; group: string }[],
    groundStations: { name: string; lat: number; lon: number; group: string }[],
    networkColors: Record<string, string>,
  ) {
    this._viewer = viewer;
    this._Cesium = Cesium;
    this._issEntityId = `spicecraft-body-${issBodyName}`;

    // Create a PolylineCollection primitive — doesn't interfere with entity picking
    this._collection = viewer.scene.primitives.add(
      new Cesium.PolylineCollection(),
    );

    // ── Relay links ──────────────────────────────────────────────────
    for (const relay of relayNames) {
      const color = Cesium.Color.fromCssColorString(networkColors[relay.group] ?? '#ffffff').withAlpha(0.25);
      const polyline = this._collection.add({
        positions: [Cesium.Cartesian3.ZERO, Cesium.Cartesian3.ZERO],
        width: 1,
        material: Cesium.Material.fromType('Color', { color }),
        show: false,
      });
      this._links.push({
        type: 'relay',
        targetEntityId: `spicecraft-body-${relay.name}`,
        color,
        polyline,
      });
    }

    // ── Ground station links ─────────────────────────────────────────
    for (const gs of groundStations) {
      const color = Cesium.Color.fromCssColorString(networkColors[gs.group] ?? '#ffffff').withAlpha(0.35);
      const polyline = this._collection.add({
        positions: [Cesium.Cartesian3.ZERO, Cesium.Cartesian3.ZERO],
        width: 1,
        material: Cesium.Material.fromType('Color', { color }),
        show: false,
      });
      this._links.push({
        type: 'ground',
        targetEntityId: `spicecraft-surface-${gs.name}`,
        color,
        polyline,
        precomputedEcef: Cesium.Cartesian3.fromDegrees(gs.lon, gs.lat, 0),
      });
    }
  }

  update(julianDate: any): void {
    const Cesium = this._Cesium;
    const viewer = this._viewer;

    const issEntity = viewer.entities.getById(this._issEntityId);
    const issEcef = issEntity?.position?.getValue(julianDate, new Cesium.Cartesian3());
    if (!issEcef) return;

    let relayCount = 0;
    let stationCount = 0;

    for (const link of this._links) {
      let targetEcef: any;
      if (link.type === 'ground' && link.precomputedEcef) {
        targetEcef = link.precomputedEcef;
      } else {
        const targetEntity = viewer.entities.getById(link.targetEntityId);
        targetEcef = targetEntity?.position?.getValue(julianDate, new Cesium.Cartesian3());
      }

      if (!targetEcef) {
        link.polyline.show = false;
        continue;
      }

      const visible = link.type === 'relay'
        ? this._checkLos(issEcef, targetEcef)
        : this._computeElevation(targetEcef, issEcef) > MIN_ELEVATION_DEG;

      link.polyline.show = visible;
      if (visible) {
        link.polyline.positions = [
          Cesium.Cartesian3.clone(issEcef),
          Cesium.Cartesian3.clone(targetEcef),
        ];
        if (link.type === 'relay') relayCount++;
        else stationCount++;
      }
    }

    this.visibleRelays = relayCount;
    this.visibleStations = stationCount;
  }

  private _checkLos(posA: any, posB: any): boolean {
    const R = EARTH_RADIUS_M;
    const dx = posB.x - posA.x;
    const dy = posB.y - posA.y;
    const dz = posB.z - posA.z;

    const a = dx * dx + dy * dy + dz * dz;
    const b = 2 * (posA.x * dx + posA.y * dy + posA.z * dz);
    const c = posA.x * posA.x + posA.y * posA.y + posA.z * posA.z - R * R;
    const disc = b * b - 4 * a * c;

    if (disc < 0) return true;
    const sqrtDisc = Math.sqrt(disc);
    const t1 = (-b - sqrtDisc) / (2 * a);
    const t2 = (-b + sqrtDisc) / (2 * a);
    return t1 > 1 || t2 < 0;
  }

  private _computeElevation(stationEcef: any, issEcef: any): number {
    const dx = issEcef.x - stationEcef.x;
    const dy = issEcef.y - stationEcef.y;
    const dz = issEcef.z - stationEcef.z;

    const sr = Math.sqrt(
      stationEcef.x * stationEcef.x +
      stationEcef.y * stationEcef.y +
      stationEcef.z * stationEcef.z,
    );

    const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (range < 1) return 90;

    const sinElev = (dx * stationEcef.x / sr + dy * stationEcef.y / sr + dz * stationEcef.z / sr) / range;
    return Math.asin(Math.max(-1, Math.min(1, sinElev))) * DEG;
  }

  dispose(): void {
    this._viewer.scene.primitives.remove(this._collection);
    this._links.length = 0;
  }
}
