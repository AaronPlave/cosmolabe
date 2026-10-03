import * as THREE from 'three';
import type { AtmosphereModel } from './AtmosphereModel.js';

/** Shared profile and direct-Sun equations for shell, multi-scatter, and terrain shaders. */
export const ATMOSPHERE_PROFILES_GLSL = /* glsl */ `
uniform float uAtmPlanetR;
uniform float uAtmShellR;
uniform vec3 uAtmRayleighScattering;
uniform vec3 uAtmMieScattering;
uniform vec3 uAtmMieExtinction;
uniform vec3 uAtmAbsorptionExtinction;
uniform float uAtmRayleighInvH;
uniform float uAtmMieInvH;
uniform float uAtmAbsorptionInvH;
uniform float uAtmAbsorptionType;
uniform float uAtmAbsorptionPeak;
uniform float uAtmAbsorptionHalfWidth;
uniform sampler2D uAtmTransmittanceLUT;

vec3 atmDensities(float altitude) {
  float h = max(0.0, altitude);
  float absorption = uAtmAbsorptionType > 0.5
    ? max(0.0, 1.0 - abs(h - uAtmAbsorptionPeak) / max(1e-6, uAtmAbsorptionHalfWidth))
    : exp(-h * uAtmAbsorptionInvH);
  return vec3(exp(-h * uAtmRayleighInvH), exp(-h * uAtmMieInvH), absorption);
}

vec3 atmExtinction(vec3 density) {
  return uAtmRayleighScattering * density.x +
    uAtmMieExtinction * density.y + uAtmAbsorptionExtinction * density.z;
}

vec3 atmScattering(vec3 density, float rayleighPhase, float miePhase) {
  // Phase shapes integrate to 4π; convert them to probability per steradian.
  return (rayleighPhase * uAtmRayleighScattering * density.x +
    miePhase * uAtmMieScattering * density.y) / (4.0 * 3.14159265358979);
}

vec3 atmScatteringSum(vec3 density) {
  return uAtmRayleighScattering * density.x + uAtmMieScattering * density.y;
}

// Exact attenuation integral for a segment with constant sampled density.
vec3 atmSegmentWeight(vec3 extinction, float distance) {
  vec3 depth = extinction * distance;
  vec3 weight = vec3(distance);
  // Avoid cancellation in 1-exp(-depth) for nearly transparent segments.
  if (depth.r > 0.001) weight.r = (1.0 - exp(-depth.r)) / extinction.r;
  if (depth.g > 0.001) weight.g = (1.0 - exp(-depth.g)) / extinction.g;
  if (depth.b > 0.001) weight.b = (1.0 - exp(-depth.b)) / extinction.b;
  return weight;
}

bool atmSunBlocked(vec3 point, vec3 sunDir) {
  float b = dot(point, sunDir);
  float c = dot(point, point) - uAtmPlanetR * uAtmPlanetR;
  return b < 0.0 && b * b > c;
}

vec3 atmSunTransmittance(vec3 point, vec3 sunDir) {
  if (atmSunBlocked(point, sunDir)) return vec3(0.0);
  float altitude = clamp((length(point) - uAtmPlanetR) /
    max(1e-6, uAtmShellR - uAtmPlanetR), 0.0, 1.0);
  float mu = dot(normalize(point), sunDir);
  return texture2D(uAtmTransmittanceLUT, vec2(mu * 0.5 + 0.5, altitude)).rgb;
}
`;

export function makeAtmosphereProfileUniforms(
  model: AtmosphereModel,
  kmPerUnit: number,
  planetRadius: number,
  shellRadius: number,
  transmittanceLUT: THREE.Texture | null,
) {
  const vec = (rgb: [number, number, number]) =>
    new THREE.Vector3(rgb[0], rgb[1], rgb[2]).multiplyScalar(kmPerUnit);
  const profile = model.absorption.profile;
  return {
    uAtmPlanetR: { value: planetRadius },
    uAtmShellR: { value: shellRadius },
    uAtmRayleighScattering: { value: vec(model.rayleigh.scattering) },
    uAtmMieScattering: { value: vec(model.mie.scattering) },
    uAtmMieExtinction: { value: vec(model.mie.extinction) },
    uAtmAbsorptionExtinction: { value: vec(model.absorption.extinction) },
    uAtmRayleighInvH: { value: kmPerUnit / model.rayleigh.scaleHeightKm },
    uAtmMieInvH: { value: kmPerUnit / model.mie.scaleHeightKm },
    uAtmAbsorptionInvH: { value: profile.type === 'exponential' ? kmPerUnit / profile.scaleHeightKm : 0 },
    uAtmAbsorptionType: { value: profile.type === 'tent' ? 1 : 0 },
    uAtmAbsorptionPeak: { value: profile.type === 'tent' ? profile.peakKm / kmPerUnit : 0 },
    uAtmAbsorptionHalfWidth: { value: profile.type === 'tent' ? profile.halfWidthKm / kmPerUnit : 1 },
    uAtmTransmittanceLUT: { value: transmittanceLUT },
  };
}

export type AtmosphereProfileUniforms = ReturnType<typeof makeAtmosphereProfileUniforms>;
