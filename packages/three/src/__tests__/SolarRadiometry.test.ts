import { expect, it } from 'vitest';
import { solarIrradiance, SOLAR_CENTER_RADIANCE, SOLAR_REFERENCE_DISTANCE_KM, SOLAR_RADIUS_KM } from '../SolarRadiometry.js';
import { normalizeAtmosphere, transmittanceToSpace } from '../AtmosphereModel.js';
import { getAtmospherePreset } from '../AtmosphereMesh.js';

it('relates irradiance to the integral of the limb-darkened physical disk', () => {
  // Independent equal-area integration of the photospheric profile.
  let average = 0;
  for (let i = 0; i < 10000; i++) average += (0.4 + 0.6 * Math.sqrt(1 - (i + 0.5) / 10000)) / 10000;
  const omega = Math.PI * (SOLAR_RADIUS_KM / SOLAR_REFERENCE_DISTANCE_KM) ** 2;
  const irradiance = solarIrradiance(SOLAR_REFERENCE_DISTANCE_KM);
  irradiance.forEach((value, i) => expect(value / omega).toBeCloseTo(SOLAR_CENTER_RADIANCE[i] * average, 5));
  expect(solarIrradiance(SOLAR_REFERENCE_DISTANCE_KM * 2)[0]).toBeCloseTo(irradiance[0] / 4, 10);
});

it('extinction alone does not introduce a reference-sphere horizon', () => {
  const model = normalizeAtmosphere({ ...getAtmospherePreset('Earth')!,
    rayleighCoeff: [0,0,0], mieCoeff: 0, absorptionCoeff: [0,0,0] });
  const origin: [number,number,number] = [6371.001,0,0];
  const ray: [number,number,number] = [-0.01, Math.sqrt(1-0.01**2),0];
  expect(transmittanceToSpace(model,6371,origin,ray)).toEqual([0,0,0]);
  expect(transmittanceToSpace(model,6371,origin,ray,128,false)).toEqual([1,1,1]);
});

it.each(['Earth','Venus','Titan'])('%s does not turn a grazing direct solar source blue', name => {
  const radius = name === 'Earth' ? 6371 : name === 'Venus' ? 6052 : 2575;
  const model = normalizeAtmosphere(getAtmospherePreset(name)!);
  const t = transmittanceToSpace(model,radius,[radius+10,0,0],[0,1,0],1024,false);
  expect(t[0]).toBeGreaterThan(t[2]);
  expect(t.every(v=>Number.isFinite(v)&&v>=0&&v<=1)).toBe(true);
});

it('Mars dust produces the expected modest blue direct-light filtering', () => {
  const t = transmittanceToSpace(normalizeAtmosphere(getAtmospherePreset('Mars')!),3390,[3400,0,0],[0,1,0],1024,false);
  expect(t[2]).toBeGreaterThan(t[0]);
  expect(t[0]).toBeGreaterThan(0);
});
