/**
 * ISS Telemetry Panel — live orbital metrics computed from TLE state vectors.
 *
 * Renders a compact HUD overlay with altitude, speed, sub-satellite point,
 * inclination, and orbital period. No SPICE kernels required — all values
 * derived from the TLE trajectory's position/velocity state.
 */

const EARTH_RADIUS_KM = 6371;
const EARTH_MU = 398600.4418; // km³/s²
const DEG = 180 / Math.PI;

export interface TelemetryState {
  altitude: number;    // km
  speed: number;       // km/s
  lat: number;         // degrees
  lon: number;         // degrees
  inclination: number; // degrees
  period: number;      // minutes
}

/**
 * Creates and manages a telemetry HUD panel that updates each tick.
 */
export class TelemetryPanel {
  private readonly _el: HTMLElement;
  private readonly _Cesium: any;
  /** Expose the last computed state so other modules can read it. */
  last: TelemetryState | null = null;

  constructor(parentEl: HTMLElement, Cesium: any) {
    this._Cesium = Cesium;
    this._el = document.createElement('div');
    this._el.id = 'telemetry-panel';
    this._el.innerHTML = '<div class="telem-row"><span class="telem-val">—</span></div>';
    parentEl.appendChild(this._el);
  }

  /**
   * Recompute telemetry from ECI state vector and update the DOM.
   * @param posEci  km (TEME/J2000)
   * @param velEci  km/s
   * @param julianDate  Cesium.JulianDate for ICRF→Fixed conversion
   */
  update(posEci: number[], velEci: number[], julianDate: any): void {
    const Cesium = this._Cesium;

    // ── Altitude & speed ────────────────────────────────────────────
    const r = Math.sqrt(posEci[0] ** 2 + posEci[1] ** 2 + posEci[2] ** 2);
    const altitude = r - EARTH_RADIUS_KM;
    const speed = Math.sqrt(velEci[0] ** 2 + velEci[1] ** 2 + velEci[2] ** 2);

    // ── Sub-satellite point (ECI → ECEF → geodetic) ────────────────
    let lat = 0;
    let lon = 0;
    const icrfToFixed = Cesium.Transforms.computeIcrfToFixedMatrix(julianDate);
    if (icrfToFixed) {
      const eciCart = new Cesium.Cartesian3(
        posEci[0] * 1000, posEci[1] * 1000, posEci[2] * 1000,
      );
      const ecef = Cesium.Matrix3.multiplyByVector(icrfToFixed, eciCart, new Cesium.Cartesian3());
      const carto = Cesium.Cartographic.fromCartesian(ecef);
      lat = Cesium.Math.toDegrees(carto.latitude);
      lon = Cesium.Math.toDegrees(carto.longitude);
    }

    // ── Orbital elements from state vector ──────────────────────────
    // Angular momentum h = r × v
    const hx = posEci[1] * velEci[2] - posEci[2] * velEci[1];
    const hy = posEci[2] * velEci[0] - posEci[0] * velEci[2];
    const hz = posEci[0] * velEci[1] - posEci[1] * velEci[0];
    const h = Math.sqrt(hx * hx + hy * hy + hz * hz);
    const inclination = Math.acos(hz / h) * DEG;

    // Semi-major axis from vis-viva: v² = μ(2/r − 1/a)
    const a = 1 / (2 / r - speed * speed / EARTH_MU);
    const period = (2 * Math.PI * Math.sqrt(a * a * a / EARTH_MU)) / 60; // minutes

    const state: TelemetryState = { altitude, speed, lat, lon, inclination, period };
    this.last = state;
    this._render(state);
  }

  private _render(d: TelemetryState): void {
    const latDir = d.lat >= 0 ? 'N' : 'S';
    const lonDir = d.lon >= 0 ? 'E' : 'W';
    this._el.innerHTML = `
      <div class="telem-row"><span class="telem-label">ALT</span><span class="telem-val">${d.altitude.toFixed(1)} km</span></div>
      <div class="telem-row"><span class="telem-label">SPD</span><span class="telem-val">${d.speed.toFixed(2)} km/s</span></div>
      <div class="telem-row"><span class="telem-label">LAT</span><span class="telem-val">${Math.abs(d.lat).toFixed(1)}° ${latDir}</span></div>
      <div class="telem-row"><span class="telem-label">LON</span><span class="telem-val">${Math.abs(d.lon).toFixed(1)}° ${lonDir}</span></div>
      <div class="telem-row"><span class="telem-label">INC</span><span class="telem-val">${d.inclination.toFixed(1)}°</span></div>
      <div class="telem-row"><span class="telem-label">PER</span><span class="telem-val">${d.period.toFixed(1)} min</span></div>
    `;
  }

  dispose(): void {
    this._el.remove();
  }
}
