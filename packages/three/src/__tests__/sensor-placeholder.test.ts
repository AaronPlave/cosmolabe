// A Sensor is a field of view, not a sized body. A sensor whose catalog item
// declares no `class` used to fall through to BodyMesh's unclassified 100 km
// placeholder sphere (MoonFall's survey cameras: enormous opaque spheres over
// the drones), because only `class: "instrument"` hid it.
import { describe, expect, it } from 'vitest';
import { Universe, type CatalogJson } from '@cosmolabe/core';
import { BodyMesh } from '../BodyMesh.js';
import { sensorHasPlaceholder } from '../SensorFrustum.js';

function load(sensorClass?: string) {
  const u = new Universe();
  u.loadCatalog({
    name: 'sensor-placeholder',
    items: [
      { name: 'Moon', class: 'moon', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
      {
        name: 'Drone', center: 'Moon', class: 'spacecraft', trajectory: { type: 'FixedPoint', position: [1737.6, 0, 0] },
        items: [{
          name: 'Drone Camera', ...(sensorClass ? { class: sensorClass } : {}),
          trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
          geometry: { type: 'Sensor', target: 'Moon', shape: 'rectangular', horizontalFov: 40, verticalFov: 30, mounting: { boresight: [0, 0, -1], up: [1, 0, 0] } },
        }],
      },
    ],
  } as unknown as CatalogJson);
  return u.getBody('Drone Camera')!;
}

describe('sensor placeholder geometry', () => {
  it('classifies an unclassified Sensor as an instrument, with no 100 km stand-in', () => {
    const sensor = load();
    expect(sensor.classification).toBe('instrument');
    expect(sensor.parentName).toBe('Drone');
    expect(new BodyMesh(sensor).displayRadius).toBe(1);
  });

  it('keeps an explicit classification (a spacecraft that is its own sensor)', () => {
    const sensor = load('spacecraft');
    expect(sensor.classification).toBe('spacecraft');
    expect(new BodyMesh(sensor).displayRadius).toBe(10);
  });

  it('draws a placeholder only for a sensor explicitly classified as something else', () => {
    expect(sensorHasPlaceholder(load())).toBe(false);
    expect(sensorHasPlaceholder({ classification: undefined })).toBe(false); // a Body built outside the loader
    expect(sensorHasPlaceholder(load('spacecraft'))).toBe(true);
  });
});
