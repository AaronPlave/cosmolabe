import type { AtmosphereParams } from './AtmosphereMesh.js';

export type RGB = [number, number, number];

/** Renderer-internal parameters in km and inverse km. Catalogs keep their legacy shape. */
export interface AtmosphereModel {
  heightKm: number;
  rayleigh: { scattering: RGB; scaleHeightKm: number };
  mie: { scattering: RGB; extinction: RGB; scaleHeightKm: number; g: number };
  absorption: { extinction: RGB; profile:
    | { type: 'exponential'; scaleHeightKm: number }
    | { type: 'tent'; peakKm: number; halfWidthKm: number } };
  groundAlbedo: RGB;
  planetCapBias: number;
}

type AtmosphereModelInput = AtmosphereParams & {
  heightKm?: number;
  rayleighScaleHeightKm?: number;
  mieExtinctionCoeff?: RGB;
  absorptionProfile?: AtmosphereModel['absorption']['profile'];
  groundAlbedo?: RGB;
};

const DENSITY_CUTOFF = -Math.log(0.0005);

export function normalizeAtmosphere(params: AtmosphereModelInput): AtmosphereModel {
  const mie: RGB = typeof params.mieCoeff === 'number'
    ? [params.mieCoeff, params.mieCoeff, params.mieCoeff]
    : [...params.mieCoeff];
  const rayleighScaleHeightKm = params.rayleighScaleHeightKm ?? params.mieScaleHeight;
  const absorption = params.absorptionProfile ??
    { type: 'exponential' as const, scaleHeightKm: params.mieScaleHeight };
  return {
    heightKm: params.heightKm ?? Math.max(params.mieScaleHeight, rayleighScaleHeightKm) * DENSITY_CUTOFF,
    rayleigh: { scattering: [...params.rayleighCoeff], scaleHeightKm: rayleighScaleHeightKm },
    mie: {
      scattering: mie,
      extinction: params.mieExtinctionCoeff ? [...params.mieExtinctionCoeff] : [...mie],
      scaleHeightKm: params.mieScaleHeight,
      g: params.miePhaseAsymmetry,
    },
    absorption: { extinction: [...params.absorptionCoeff], profile: absorption },
    groundAlbedo: params.groundAlbedo ? [...params.groundAlbedo] : [0.1, 0.1, 0.1],
    planetCapBias: params.planetCapBias ?? 0,
  };
}

export function profileDensity(profile: AtmosphereModel['absorption']['profile'], altitudeKm: number): number {
  const h = Math.max(0, altitudeKm);
  if (profile.type === 'tent') {
    return Math.max(0, 1 - Math.abs(h - profile.peakKm) / profile.halfWidthKm);
  }
  return Math.exp(-h / profile.scaleHeightKm);
}

export function extinctionAt(model: AtmosphereModel, altitudeKm: number): RGB {
  const ray = Math.exp(-Math.max(0, altitudeKm) / model.rayleigh.scaleHeightKm);
  const mie = Math.exp(-Math.max(0, altitudeKm) / model.mie.scaleHeightKm);
  const absorption = profileDensity(model.absorption.profile, altitudeKm);
  return [0, 1, 2].map((i) =>
    model.rayleigh.scattering[i] * ray + model.mie.extinction[i] * mie +
    model.absorption.extinction[i] * absorption) as RGB;
}

/** Forward ray interval through a sphere. Null means the sphere is missed. */
export function raySphereInterval(origin: RGB, direction: RGB, radius: number): [number, number] | null {
  const b = origin[0] * direction[0] + origin[1] * direction[1] + origin[2] * direction[2];
  const c = origin[0] ** 2 + origin[1] ** 2 + origin[2] ** 2 - radius ** 2;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  if (-b + root <= 0) return null;
  return [Math.max(0, -b - root), -b + root];
}

/** Direct RGB transmittance from a point to the shell exit; a solid-planet hit is dark. */
export function transmittanceToSpace(
  model: AtmosphereModel,
  planetRadiusKm: number,
  origin: RGB,
  direction: RGB,
  steps = 128,
): RGB {
  const shell = raySphereInterval(origin, direction, planetRadiusKm + model.heightKm);
  if (!shell) return [1, 1, 1];
  const solid = raySphereInterval(origin, direction, planetRadiusKm);
  if (solid && solid[0] < shell[1] - 1e-7) return [0, 0, 0];
  const stepKm = (shell[1] - shell[0]) / steps;
  const opticalDepth: RGB = [0, 0, 0];
  for (let j = 0; j < steps; j++) {
    const t = shell[0] + (j + 0.5) * stepKm;
    const x = origin[0] + direction[0] * t;
    const y = origin[1] + direction[1] * t;
    const z = origin[2] + direction[2] * t;
    const altitude = Math.max(0, Math.hypot(x, y, z) - planetRadiusKm);
    const extinction = extinctionAt(model, altitude);
    for (let i = 0; i < 3; i++) opticalDepth[i] += extinction[i] * stepKm;
  }
  return opticalDepth.map((depth) => Math.exp(-depth)) as RGB;
}
