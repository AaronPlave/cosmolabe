import * as THREE from 'three';

export const REGOLITH_REFLECTANCE_MODELS = ['legacy', 'lambert', 'lunar-lambert', 'hapke'] as const;
export type RegolithReflectanceModel = typeof REGOLITH_REFLECTANCE_MODELS[number];

const lunarWeight = 0.65;
const backscatter = 0.23;
const oppositionAmplitude = 0.55;
const oppositionWidth = 0.055;
const gamma = Math.sqrt(1 - 0.25);
const h = (mu: number) => (1 + 2 * mu) / (1 + 2 * gamma * mu);
const phasePeak = (1 + backscatter) / (1 - backscatter) ** 2;
const hapkeReference = (1 + oppositionAmplitude) * phasePeak + h(1) ** 2 - 1;
const epsilon = 1e-5;

/** Direct diffuse angular factor relative to normal incidence at opposition. Angles are supplied as cosines. */
export function regolithAngularFactor(
  model: Exclude<RegolithReflectanceModel, 'legacy'>, incidenceCosine: number, emissionCosine: number, phaseCosine: number,
): number {
  if (![incidenceCosine, emissionCosine, phaseCosine].every(Number.isFinite) || incidenceCosine <= 0 || emissionCosine < 0) return 0;
  const mu0 = Math.min(incidenceCosine, 1);
  const mu = Math.min(emissionCosine, 1);
  const phase = THREE.MathUtils.clamp(phaseCosine, -1, 1);
  if (model === 'lambert') return mu0;
  const lommelSeeliger = 2 * mu0 / Math.max(mu0 + mu, epsilon);
  if (model === 'lunar-lambert') return (1 - lunarWeight) * mu0 + lunarWeight * lommelSeeliger;
  const particle = (1 - backscatter ** 2) / (1 + backscatter ** 2 - 2 * backscatter * phase) ** 1.5;
  // Equivalent to h / (h + tan(phase/2)), well defined at phase = pi.
  const opposition = oppositionAmplitude * oppositionWidth / (oppositionWidth + Math.sqrt((1 - phase) / Math.max(1 + phase, epsilon)));
  return lommelSeeliger * ((1 + opposition) * particle + h(mu0) * h(mu) - 1) / hapkeReference;
}

export function createRegolithUniforms() {
  return { model: { value: 0 }, sunWorld: { value: new THREE.Vector3() } };
}

export type RegolithUniforms = ReturnType<typeof createRegolithUniforms>;

const directCall = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
const beginLights = '#include <lights_fragment_begin>';
const glsl = (n: number) => n.toFixed(10);

const functions = /* glsl */ `
uniform int uRegolithModel;
uniform vec3 uRegolithSunWorld;
float regolithH(float mu) { return (1.0 + 2.0 * mu) / (1.0 + ${glsl(2 * gamma)} * mu); }
float regolithAngularFactor(float mu0, float mu, float phase) {
  if (mu0 <= 0.0 || mu < 0.0) return 0.0;
  if (uRegolithModel == 1) return mu0;
  float ls = 2.0 * mu0 / max(mu0 + mu, ${glsl(epsilon)});
  if (uRegolithModel == 2) return mix(mu0, ls, ${glsl(lunarWeight)});
  float particle = ${glsl(1 - backscatter ** 2)} * pow(${glsl(1 + backscatter ** 2)} - ${glsl(2 * backscatter)} * phase, -1.5);
  float opposition = ${glsl(oppositionAmplitude * oppositionWidth)} /
    (${glsl(oppositionWidth)} + sqrt((1.0 - phase) / max(1.0 + phase, ${glsl(epsilon)})));
  return ls * ((1.0 + opposition) * particle + regolithH(mu0) * regolithH(mu) - 1.0) / ${glsl(hapkeReference)};
}
`;

/** Replace the Sun's direct response on reflectance pixels. Three's shadow-map attenuation is already in directLight.color. */
export function injectRegolithReflectance(
  shader: { fragmentShader: string; uniforms: Record<string, unknown> }, uniforms: RegolithUniforms,
): void {
  const lights = THREE.ShaderChunk.lights_fragment_begin;
  const directionalStart = lights.indexOf('getDirectionalLightInfo( directionalLight, directLight );');
  const directIndex = lights.indexOf(directCall, directionalStart);
  if (!shader.fragmentShader.includes(beginLights) || directionalStart < 0 || directIndex < 0) {
    throw new Error('Regolith reflectance: Three.js directional lighting hook changed.');
  }
  const directionalCall = /* glsl */ `
  #if UNROLLED_LOOP_INDEX == 0 && !defined( REGOLITH_HILLSHADE )
    if (uRegolithModel != 0 && surfaceReflectance > 0.0 && dot(uRegolithSunWorld, uRegolithSunWorld) > 0.0) {
      // The first directional light is the scene Sun. Its color already includes
      // raster shadowing. The experimental models use the receiver-relative Sun direction.
      vec3 sunDir = mat3(viewMatrix) * uRegolithSunWorld;
      float angular = regolithAngularFactor(clamp(dot(geometryNormal, sunDir), -1.0, 1.0),
        clamp(dot(geometryNormal, geometryViewDir), -1.0, 1.0), clamp(dot(sunDir, geometryViewDir), -1.0, 1.0));
      vec3 regolithDiffuse = directLight.color * angular * BRDF_Lambert(material.diffuseColor);
      float relitCoverage = 1.0 - surfaceAsIs;
      if (surfaceReflectance >= relitCoverage) {
        reflectedLight.directDiffuse += regolithDiffuse;
      } else {
        // The as-is compositor will later remove baked RGB and coverage. Mix
        // the two direct responses in proportion to the remaining relit RGB.
        vec3 reflectanceShare = clamp(surfaceReflectanceRgb / max(surfaceRelitRgb, vec3(1e-6)), 0.0, 1.0);
        ReflectedLight legacyLight = ReflectedLight(vec3(0.0), vec3(0.0), vec3(0.0), vec3(0.0));
        RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, legacyLight );
        reflectedLight.directDiffuse += mix(legacyLight.directDiffuse, regolithDiffuse, reflectanceShare);
        reflectedLight.directSpecular += legacyLight.directSpecular * (1.0 - surfaceReflectance / relitCoverage);
      }
    } else
  #endif
  { ${directCall} }
  `;
  shader.uniforms.uRegolithModel = uniforms.model;
  shader.uniforms.uRegolithSunWorld = uniforms.sunWorld;
  shader.fragmentShader = functions + shader.fragmentShader.replace(beginLights,
    lights.slice(0, directIndex) + directionalCall + lights.slice(directIndex + directCall.length));
}
