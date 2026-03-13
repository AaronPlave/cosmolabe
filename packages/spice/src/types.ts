// 3D vector [x, y, z]
export type Vec3 = [number, number, number];

// 6-element state vector [x, y, z, vx, vy, vz]
export type StateVector = [number, number, number, number, number, number];

// 3x3 rotation matrix (row-major, 9 elements)
export type RotationMatrix = [number, number, number, number, number, number, number, number, number];

// 6x6 state transformation matrix (row-major, 36 elements)
export type StateTransformMatrix = number[];

// Orbital elements [rp, ecc, inc, lnode, argp, m0, t0, mu]
export type OrbitalElements = {
  rp: number;      // Perifocal distance
  ecc: number;     // Eccentricity
  inc: number;     // Inclination (radians)
  lnode: number;   // Longitude of ascending node (radians)
  argp: number;    // Argument of periapsis (radians)
  m0: number;      // Mean anomaly at epoch (radians)
  t0: number;      // Epoch (ephemeris seconds past J2000)
  mu: number;      // Gravitational parameter (km^3/s^2)
};

// Illumination angles
export type IlluminationAngles = {
  phaseAngle: number;    // radians
  solarIncidence: number; // radians
  emission: number;       // radians
};

// Sub-point result
export type SubPoint = {
  point: Vec3;       // Surface point in body-fixed frame (km)
  altitude: number;  // Altitude above surface (km)
  longitude: number; // Geodetic longitude (radians)
  latitude: number;  // Geodetic latitude (radians)
};

// Surface intercept result
export type SurfaceIntercept = {
  point: Vec3;     // Intercept point in body-fixed frame (km)
  found: boolean;
  trgepc: number;  // Target epoch
  srfvec: Vec3;    // Observer to intercept vector
};

// Geometry finder time window
export type TimeWindow = {
  start: number;  // ET start
  end: number;    // ET end
};

// Aberration correction
export type AberrationCorrection = 'NONE' | 'LT' | 'LT+S' | 'CN' | 'CN+S' | 'XLT' | 'XLT+S' | 'XCN' | 'XCN+S';

// FOV shape types returned by getfov_c
export type FovShape = 'POLYGON' | 'RECTANGLE' | 'CIRCLE' | 'ELLIPSE';

// Instrument field of view definition
export interface InstrumentFov {
  shape: FovShape;
  frame: string;
  boresight: Vec3;
  bounds: Vec3[];
}
