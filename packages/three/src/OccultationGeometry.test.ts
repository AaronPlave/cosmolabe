import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { OccultationGeometry } from './OccultationGeometry.js';
import type { BodyMesh } from './BodyMesh.js';

function body(name: string, position: [number, number, number], radius = 1): BodyMesh {
  const object = new THREE.Object3D() as BodyMesh;
  object.position.set(...position);
  Object.assign(object, {
    body: { name },
    displayRadius: radius,
    scaleFactor: 1,
  });
  return object;
}

const EVENT_WINDOW = { startEt: 10, endEt: 20 };

function positions(object: THREE.Object3D): Float32Array {
  const geometry = (object as THREE.LineSegments).geometry;
  const values = (geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
  const vertexCount = geometry.index
    ? Math.max(...Array.from(
      (geometry.index.array as Uint16Array).slice(0, geometry.drawRange.count),
    )) + 1
    : geometry.drawRange.count;
  return values.slice(0, vertexCount * 3);
}

function maxRadiusAtX(values: Float32Array, x: number): number {
  const radii: number[] = [];
  for (let i = 0; i < values.length; i += 3) {
    if (Math.abs(values[i] - x) < 1e-5) radii.push(Math.hypot(values[i + 1], values[i + 2]));
  }
  return Math.max(...radii);
}

describe('OccultationGeometry', () => {
  it('derives solar umbra and penumbra radii from the source geometry', () => {
    const overlay = new OccultationGeometry({
      back: body('Sun', [-100, 0, 0], 10),
      front: body('Planet', [0, 0, 0], 2),
      observer: body('Spacecraft', [20, 0, 0]),
      state: 'partial',
      ...EVENT_WINDOW,
    });

    const umbra = overlay.getObjectByName('occultation-umbra') as THREE.LineSegments;
    const penumbra = overlay.getObjectByName('occultation-penumbra') as THREE.LineSegments;
    const viewCone = overlay.getObjectByName('occultation-view-cone')!;
    const umbraFill = overlay.getObjectByName('occultation-umbra-fill') as THREE.Mesh;
    expect(umbra.visible).toBe(true);
    expect(penumbra.visible).toBe(true);
    expect(viewCone.visible).toBe(false);
    expect(umbraFill.visible).toBe(true);
    expect(umbraFill.geometry.drawRange.count).toBe(64 * 6);
    expect((umbraFill.material as THREE.MeshBasicMaterial).depthTest).toBe(true);
    expect((umbra.material as THREE.LineBasicMaterial).color.getHex()).toBe(0x8c72d8);
    expect((penumbra.material as THREE.LineBasicMaterial).color.getHex()).toBe(0xe0a84c);

    // At the observer plane: umbra = 2 - (10 - 2) * 20 / 100 = 0.4;
    // penumbra = 2 + (10 + 2) * 20 / 100 = 4.4.
    const umbraValues = positions(umbra);
    const penumbraValues = positions(penumbra);
    expect(maxRadiusAtX(umbraValues, 20)).toBeCloseTo(0.4);
    expect(maxRadiusAtX(penumbraValues, 20)).toBeCloseTo(4.4);
  });

  it('continues the inner boundary as an antumbra beyond its apex', () => {
    const overlay = new OccultationGeometry({
      back: body('Sun', [-100, 0, 0], 10),
      front: body('Planet', [0, 0, 0], 2),
      observer: body('Spacecraft', [40, 0, 0]),
      state: 'annular',
      ...EVENT_WINDOW,
    });

    const values = positions(overlay.getObjectByName('occultation-umbra')!);
    expect(Math.max(...values.filter((_, i) => i % 3 === 0))).toBeCloseTo(40);
    expect(maxRadiusAtX(values, 40)).toBeCloseTo(1.2);
  });

  it('uses an observer tangent cone instead of shadow volumes for a non-solar occultation', () => {
    const overlay = new OccultationGeometry({
      observer: body('Observer', [0, 0, 0]),
      front: body('Moon', [10, 0, 0], 2),
      back: body('Planet', [20, 0, 0], 4),
      state: 'partial',
      ...EVENT_WINDOW,
    });

    expect(overlay.getObjectByName('occultation-light-axis')!.visible).toBe(false);
    expect(overlay.getObjectByName('occultation-umbra')!.visible).toBe(false);
    expect(overlay.getObjectByName('occultation-penumbra')!.visible).toBe(false);
    expect(overlay.getObjectByName('occultation-umbra-fill')!.visible).toBe(false);
    expect(overlay.getObjectByName('occultation-penumbra-fill')!.visible).toBe(false);
    const viewCone = overlay.getObjectByName('occultation-view-cone')!;
    expect(viewCone.visible).toBe(true);
    const viewConeFill = overlay.getObjectByName('occultation-view-cone-fill') as THREE.Mesh;
    expect(viewConeFill.visible).toBe(true);
    expect((positions(viewCone).length / 3)).toBeGreaterThan(8);

    // Tangent guides start at the observer, while the shaded occulted region
    // begins at the exact tangency ring: x = d - r^2/d = 9.6 and
    // ring radius = r*sqrt(1-r^2/d^2).
    const fillPositions = positions(viewConeFill);
    const tangentDistance = 9.6;
    expect(Math.min(...fillPositions.filter((_, i) => i % 3 === 0))).toBeCloseTo(tangentDistance);
    expect(Math.max(...fillPositions.filter((_, i) => i % 3 === 0))).toBeCloseTo(20);
    expect(maxRadiusAtX(fillPositions, tangentDistance)).toBeCloseTo(2 * Math.sqrt(0.96));

    const sightline = overlay.getObjectByName('occultation-observer-sightline') as THREE.Line;
    const sightlinePositions = positions(sightline);
    expect(sightlinePositions[0]).toBeCloseTo(0);
    expect(sightlinePositions[3]).toBeCloseTo(20);
  });

  it('terminates eclipse geometry at the observer plane instead of extending it decoratively', () => {
    const overlay = new OccultationGeometry({
      back: body('Sun', [-100, 0, 0], 10),
      front: body('Planet', [0, 0, 0], 20),
      observer: body('Spacecraft', [5, 1, 0]),
      state: 'full',
      ...EVENT_WINDOW,
    });

    const values = positions(overlay.getObjectByName('occultation-penumbra')!);
    expect(Math.max(...values.filter((_, i) => i % 3 === 0))).toBeCloseTo(5);
  });

  it('shows the selected event geometry only inside its own interval', () => {
    const overlay = new OccultationGeometry({
      back: body('Sun', [-100, 0, 0], 10),
      front: body('Planet', [0, 0, 0], 2),
      observer: body('Spacecraft', [20, 0, 0]),
      state: 'full',
      ...EVENT_WINDOW,
    });

    expect(overlay.visible).toBe(true);
    overlay.update(20.001);
    expect(overlay.visible).toBe(false);
    overlay.update(15);
    expect(overlay.visible).toBe(true);
    overlay.update(9.999);
    expect(overlay.visible).toBe(false);
  });

  it('reuses dynamic attributes across frame updates', () => {
    const overlay = new OccultationGeometry({
      back: body('Sun', [-100, 0, 0], 10),
      front: body('Planet', [0, 0, 0], 2),
      observer: body('Spacecraft', [20, 0, 0]),
      state: 'full',
      ...EVENT_WINDOW,
    });
    const umbra = overlay.getObjectByName('occultation-umbra') as THREE.LineSegments;
    const fill = overlay.getObjectByName('occultation-umbra-fill') as THREE.Mesh;
    const linePositions = umbra.geometry.getAttribute('position') as THREE.BufferAttribute;
    const fillPositions = fill.geometry.getAttribute('position');
    const fillIndex = fill.geometry.getIndex();

    overlay.update(15);

    expect(umbra.geometry.getAttribute('position')).toBe(linePositions);
    expect(fill.geometry.getAttribute('position')).toBe(fillPositions);
    expect(fill.geometry.getIndex()).toBe(fillIndex);
    expect(linePositions.usage).toBe(THREE.DynamicDrawUsage);
  });
});
