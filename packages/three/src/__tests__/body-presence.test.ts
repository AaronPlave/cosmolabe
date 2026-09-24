// A BodyMesh is drawn only when the user has it shown AND the body is in the
// scene now. The two are kept apart so a body leaving its existence window and
// coming back does not undo the user's hide, and the other way round.

import { describe, expect, it } from 'vitest';
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
