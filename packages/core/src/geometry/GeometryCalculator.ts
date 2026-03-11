import type { SpiceInstance, Vec3, OrbitalElements, IlluminationAngles } from '@spicecraft/spice';

export interface BodyGeometry {
  // Position & velocity
  range?: number;             // km — SC-to-body distance
  rangeRate?: number;         // km/s — radial velocity (positive = receding)
  speed?: number;             // km/s — relative speed (velocity magnitude)
  altitude?: number;          // km — above surface (range - local radius)
  angularSize?: number;       // deg — body apparent half-angle from observer
  lightTime?: number;         // s — one-way light time to body

  // Sub-observer (sub-spacecraft) point
  subSCLatitude?: number;     // deg
  subSCLongitude?: number;    // deg

  // Sub-solar point
  subSolarLatitude?: number;  // deg
  subSolarLongitude?: number; // deg

  // Local solar time at sub-SC point
  lst?: number;               // hours (0–24)

  // Angles
  sunBodySCAngle?: number;    // deg — Sun-Body-SC (phase angle at body center)
  sunSCBodyAngle?: number;    // deg — Sun-SC-Body (sun angle from SC perspective)
  earthSCBodyAngle?: number;  // deg — Earth-SC-Body (earth angle from SC)
  betaAngle?: number;         // deg — orbit beta angle (sun elevation above orbit plane)

  // Illumination at sub-SC point
  illumination?: IlluminationAngles;
  solarIncidenceDeg?: number; // deg — solar incidence at sub-SC point

  // RA/Dec of SC as seen from Earth
  spacecraftRA?: number;      // deg — right ascension
  spacecraftDec?: number;     // deg — declination

  // Orbital elements (SC about body)
  orbitalElements?: OrbitalElements;
  orbitPeriod?: number;       // s — (only for ecc < 1)
  orbitInclination?: number;  // deg
  semiMajorAxis?: number;    // km — (only for ecc < 1)
}

export interface GeometryConfig {
  bodyName: string;
  bodyFrame: string;
  naifId: number;
  observerName: string;
  abcorr?: 'LT+S' | 'LT' | 'CN+S' | 'NONE';
  computeSubPoints?: boolean;
  computeIllumination?: boolean;
  computeOrbitalElements?: boolean;
  computeRange?: boolean;
  computeAngles?: boolean;
  computeEarthAngles?: boolean;
  computeBetaAngle?: boolean;
  computeRADec?: boolean;
  computeLST?: boolean;
  mu?: number; // Override gravitational parameter (km³/s²) when not in kernel pool
}

const DEG = 180 / Math.PI;

export class GeometryCalculator {
  constructor(private readonly spice: SpiceInstance) {}

  compute(config: GeometryConfig, et: number): BodyGeometry {
    const result: BodyGeometry = {};
    const abcorr = config.abcorr ?? 'LT+S';

    // --- Range, speed, range rate ---
    if (config.computeRange !== false) {
      const { state, lightTime } = this.spice.spkezr(
        config.bodyName, et, 'J2000', abcorr, config.observerName,
      );
      const [x, y, z, vx, vy, vz] = state;
      const range = Math.sqrt(x * x + y * y + z * z);
      result.range = range;
      result.speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      result.rangeRate = (x * vx + y * vy + z * vz) / range;
      result.lightTime = lightTime;

      const bodyRadius = this.getBodyRadius(config.naifId);
      result.altitude = range - bodyRadius;
      if (bodyRadius > 0 && range > bodyRadius) {
        result.angularSize = Math.asin(bodyRadius / range) * DEG;
      }
    }

    // --- Sun-SC-Body and Sun-Body-SC angles ---
    if (config.computeAngles !== false && config.bodyName !== 'SUN') {
      try {
        const scToBody = this.spice.spkpos(
          config.bodyName, et, 'J2000', abcorr, config.observerName,
        );
        const bodyToSun = this.spice.spkpos(
          'SUN', et, 'J2000', abcorr, config.bodyName,
        );

        // Sun-SC-Body: angle at SC between Sun and Body
        // Sun position from SC = body position + body-to-sun position
        const sunFromSC: Vec3 = this.spice.vadd(scToBody.position, bodyToSun.position);
        result.sunSCBodyAngle = this.spice.vsep(sunFromSC, scToBody.position) * DEG;

        // Sun-Body-SC: angle at Body between Sun and SC
        const bodyToSC: Vec3 = this.spice.vscl(-1, scToBody.position);
        result.sunBodySCAngle = this.spice.vsep(bodyToSC, bodyToSun.position) * DEG;
      } catch { /* angles may not be computable */ }
    }

    // --- Earth-SC-Body angle ---
    if (config.computeEarthAngles !== false) {
      try {
        const scToEarth = this.spice.spkpos(
          'EARTH', et, 'J2000', abcorr, config.observerName,
        );
        const scToBody = this.spice.spkpos(
          config.bodyName, et, 'J2000', abcorr, config.observerName,
        );
        result.earthSCBodyAngle = this.spice.vsep(scToEarth.position, scToBody.position) * DEG;
      } catch { /* may not have Earth data */ }
    }

    // --- RA/Dec of SC from Earth ---
    if (config.computeRADec !== false) {
      try {
        const earthToSC = this.spice.spkpos(
          config.observerName, et, 'J2000', abcorr, 'EARTH',
        );
        const { ra, dec } = this.spice.recrad(earthToSC.position);
        result.spacecraftRA = ra * DEG;
        result.spacecraftDec = dec * DEG;
      } catch { /* may not have Earth data */ }
    }

    // --- Sub-spacecraft and sub-solar points ---
    if (config.computeSubPoints !== false) {
      try {
        const subSC = this.spice.subpnt(
          'NEAR POINT/ELLIPSOID', config.bodyName, et,
          config.bodyFrame, abcorr, config.observerName,
        );
        result.subSCLatitude = subSC.latitude * DEG;
        result.subSCLongitude = subSC.longitude * DEG;

        // LST at sub-SC point
        if (config.computeLST !== false) {
          try {
            const lst = this.spice.et2lst(et, config.naifId, subSC.longitude, 'PLANETOCENTRIC');
            result.lst = lst.hr + lst.mn / 60 + lst.sc / 3600;
          } catch { /* LST may not be available */ }
        }
      } catch { /* body may not support sub-point */ }

      try {
        const subSolar = this.spice.subslr(
          'NEAR POINT/ELLIPSOID', config.bodyName, et,
          config.bodyFrame, abcorr, config.observerName,
        );
        result.subSolarLatitude = subSolar.latitude * DEG;
        result.subSolarLongitude = subSolar.longitude * DEG;
      } catch { /* body may not support sub-solar */ }
    }

    // --- Illumination angles at sub-SC point ---
    if (config.computeIllumination !== false && result.subSCLatitude != null) {
      try {
        const subSC = this.spice.subpnt(
          'NEAR POINT/ELLIPSOID', config.bodyName, et,
          config.bodyFrame, abcorr, config.observerName,
        );
        const illum = this.spice.ilumin(
          'ELLIPSOID', config.bodyName, et, config.bodyFrame,
          abcorr, config.observerName, subSC.point,
        );
        result.illumination = illum;
        result.solarIncidenceDeg = illum.solarIncidence * DEG;
      } catch { /* illumination may not be computable */ }
    }

    // --- Beta angle ---
    if (config.computeBetaAngle !== false && config.bodyName !== 'SUN') {
      try {
        const { state } = this.spice.spkezr(
          config.observerName, et, 'J2000', 'NONE', config.bodyName,
        );
        const pos: Vec3 = [state[0], state[1], state[2]];
        const vel: Vec3 = [state[3], state[4], state[5]];
        const orbitNormal = this.spice.vhat(this.spice.vcrss(pos, vel));

        const bodyToSun = this.spice.spkpos('SUN', et, 'J2000', abcorr, config.bodyName);
        const sunDir = this.spice.vscl(-1, bodyToSun.position); // direction from sun to body doesn't matter for angle with normal
        // Beta = 90° - angle(orbitNormal, sunDirection)
        result.betaAngle = this.spice.vsep(orbitNormal, bodyToSun.position) * DEG - 90;
      } catch { /* beta angle may not be computable */ }
    }

    // --- Orbital elements ---
    if (config.computeOrbitalElements !== false) {
      try {
        const { state } = this.spice.spkezr(
          config.observerName, et, 'J2000', 'NONE', config.bodyName,
        );
        const mu = config.mu ?? this.getBodyMu(config.naifId);
        const elements = this.spice.oscelt(state, et, mu);
        result.orbitalElements = elements;
        result.orbitInclination = elements.inc * DEG;

        if (elements.ecc < 1 && mu > 0) {
          const sma = elements.rp / (1 - elements.ecc);
          result.semiMajorAxis = sma;
          result.orbitPeriod = 2 * Math.PI * Math.sqrt(sma * sma * sma / mu);
        }
      } catch { /* may not have enough data */ }
    }

    return result;
  }

  private getBodyRadius(naifId: number): number {
    try {
      const radii = this.spice.bodvcd(naifId, 'RADII');
      return radii[0]; // equatorial radius
    } catch {
      return 0;
    }
  }

  private getBodyMu(naifId: number): number {
    try {
      const gm = this.spice.bodvcd(naifId, 'GM');
      return gm[0];
    } catch {
      return 0;
    }
  }
}
