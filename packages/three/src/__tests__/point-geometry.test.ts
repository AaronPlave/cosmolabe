// A `Point` body (a ground station, a waypoint) has a position and no physical
// extent: it is marked by its position glyph at every distance and never
// resolves into a sphere, however close the camera gets.

import { describe, expect, it } from 'vitest';
import { Body, validateCatalog } from '@cosmolabe/core';
import { BodyMesh } from '../BodyMesh.js';
import { glyphReplacesPlaceholder, isNaturalBody, wantsPointMarker } from '../PositionGlyphs.js';
import { CameraController } from '../controls/CameraController.js';

const fixedPoint = { stateAt: () => ({ position: [0, 0, 0], velocity: [0, 0, 0] }) } as never;
const station = () => new BodyMesh(new Body({
  name: 'Goldstone', classification: 'other', trajectory: fixedPoint, geometryType: 'Point', geometryData: { type: 'Point', surfaceLock: true },
}));

describe('Point geometry', () => {
  it('has no extent, so its glyph stands in at every distance', () => {
    const bm = station();
    expect(bm.isPoint).toBe(true);
    expect(bm.displayRadius).toBe(0);
    expect(isNaturalBody(bm)).toBe(false);
    expect(wantsPointMarker(bm, false)).toBe(true);
    // Projected radius is 0 px however near the camera is.
    expect(glyphReplacesPlaceholder(true, true, 0)).toBe(true);
  });

  it('is framed at a nominal radius rather than from inside it', () => {
    const controller = Object.create(CameraController.prototype) as CameraController;
    Object.assign(controller, { camera: { fov: 60, aspect: 1.6 } });
    expect(controller.framingDistance(station(), 1)).toBeGreaterThan(CameraController.POINT_FRAMING_KM);
  });

  it('is a known geometry type with surfaceLock, and nothing physical', () => {
    const catalog = (geometry: object) => ({ name: 't', items: [{ name: 'Goldstone', class: 'other', geometry }] });
    expect(validateCatalog(catalog({ type: 'Point', surfaceLock: true }))).toEqual([]);
    expect(validateCatalog(catalog({ type: 'Point', radius: 1 })).map((d) => d.path)).toEqual(['$.items[0].geometry.radius']);
  });
});
