// A BodyMesh is drawn only when the user has it shown AND the body is in the
// scene now. The two are kept apart so a body leaving its existence window and
// coming back does not undo the user's hide, and the other way round.

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { UniverseRenderer } from '../UniverseRenderer.js';
import { Body } from '@cosmolabe/core';
import { BodyMesh } from '../BodyMesh.js';

const fixedPoint = { stateAt: () => ({ position: [0, 0, 0], velocity: [0, 0, 0] }) } as never;

describe('BodyMesh presence', () => {
  it('combines the user\'s choice with presence, and each survives the other', () => {
    const bm = new BodyMesh(new Body({ name: 'Philae', trajectory: fixedPoint }));
    expect(bm.visible).toBe(true);

    bm.present = false;
    expect(bm.visible).toBe(false);
    expect(bm.userVisible).toBe(true);

    bm.userVisible = false;
    bm.present = true;
    // Back in the scene, but the user hid it while it was away.
    expect(bm.visible).toBe(false);

    bm.userVisible = true;
    expect(bm.visible).toBe(true);
  });

});

describe('custom visual presence', () => {
  it('hides across existence transitions and preserves user hiding on re-entry', () => {
    const body = new Body({ name: 'Custom', trajectory: fixedPoint, geometryType: 'Custom' });
    const bm = new BodyMesh(body);
    const object = new THREE.Group();
    const updateVisual = vi.fn();
    const renderer = Object.assign(Object.create(UniverseRenderer.prototype), {
      universe: { getBody: () => body }, bodyMeshes: new Map([[body.name, bm]]),
      _customVisuals: new Map([[body.name, object]]),
      _visualizers: new Map([['Custom', { updateVisual }]]), _sensorObservations: new Map(), scaleFactor: 1, _ctx: {},
    }) as { updateCustomVisuals(et: number): void };
    renderer.updateCustomVisuals(0);
    expect(object.visible).toBe(true);
    expect(updateVisual).toHaveBeenCalledTimes(1);
    bm.present = false;
    renderer.updateCustomVisuals(1);
    expect(object.visible).toBe(false);
    expect(updateVisual).toHaveBeenCalledTimes(1);
    bm.userVisible = false;
    bm.present = true;
    renderer.updateCustomVisuals(2);
    expect(object.visible).toBe(false);
    bm.userVisible = true;
    renderer.updateCustomVisuals(3);
    expect(object.visible).toBe(true);
    expect(updateVisual).toHaveBeenCalledTimes(2);
  });

  it('a visualizer can keep a visual while its body is absent, but not past the user hiding it', () => {
    const body = new Body({ name: 'Obs', trajectory: fixedPoint, geometryType: 'Observations' });
    const bm = new BodyMesh(body);
    const object = new THREE.Group();
    const updateVisual = vi.fn();
    let keep = true;
    const renderer = Object.assign(Object.create(UniverseRenderer.prototype), {
      universe: { getBody: () => body }, bodyMeshes: new Map([[body.name, bm]]),
      _customVisuals: new Map([[body.name, object]]),
      _visualizers: new Map([['Observations', { updateVisual, showsWhenAbsent: () => keep }]]),
      _sensorObservations: new Map(), scaleFactor: 1, _ctx: {},
    }) as { updateCustomVisuals(et: number): void };
    bm.present = false;
    renderer.updateCustomVisuals(0);
    expect(object.visible).toBe(true);
    expect(updateVisual).toHaveBeenCalledTimes(1);
    keep = false;
    renderer.updateCustomVisuals(1);
    expect(object.visible).toBe(false);
    keep = true;
    bm.userVisible = false;
    renderer.updateCustomVisuals(2);
    expect(object.visible).toBe(false);
    expect(updateVisual).toHaveBeenCalledTimes(1);
  });
});
