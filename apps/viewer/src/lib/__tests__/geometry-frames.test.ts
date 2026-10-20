import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Body, FixedPointTrajectory, FixedRotation, Universe } from '@cosmolabe/core';
import { createHeritageSpice } from '@cosmolabe/frames';
import { geometryFrameOptions, textKernelFrameNames } from '../geometry-frames';

describe('reference geometry frame choices', () => {
  it('ignores documentation and binary kernels, and reads names across data blocks', () => {
    const text = String.raw`KPL/FK
FRAME_1_NAME = 'DOCUMENTATION'
\begindata
FRAME_-1_NAME = 'MISSION'
\begintext
FRAME_2_NAME = 'EXAMPLE'
\begindata
FRAME_-2_NAME = ( 'INSTRUMENT' )`;
    expect(textKernelFrameNames(new TextEncoder().encode(text).buffer)).toEqual(['INSTRUMENT', 'MISSION']);
    expect(textKernelFrameNames(new TextEncoder().encode('DAF/SPK').buffer)).toEqual([]);
  });

  it('surfaces furnished Clipper frames without CK coverage alongside catalog and inertial frames', async () => {
    const spice = await createHeritageSpice();
    const bytes = readFileSync(new URL('../../../test-catalogs/kernels/europa-clipper/clipper_v16.tf', import.meta.url));
    const buffer = Uint8Array.from(bytes).buffer;
    await spice.furnish({ type: 'buffer', data: buffer, filename: 'clipper_v16.tf' });
    const names = textKernelFrameNames(buffer);
    expect(names).toContain('EUROPAM_SPACECRAFT');
    expect(names).toContain('EUROPAM_EIS_NAC');
    const universe = new Universe(spice);
    universe.addBody(new Body({ name: 'Europa Clipper', trajectory: new FixedPointTrajectory([0, 0, 0]), rotation: new FixedRotation([1, 0, 0, 0]) }));
    universe.frames.defineFixedFrame({ name: 'CATALOG_FRAME', base: 'J2000', quaternion: [1, 0, 0, 0] });
    const choices = geometryFrameOptions(universe, [...names, 'NOT_A_FRAME'], 0, 'Europa Clipper');
    expect(choices.filter(c => c.group === 'Inertial frames').slice(0, 4).map(c => c.name)).toEqual(['J2000', 'ECLIPJ2000', 'ICRF', 'GALACTIC']);
    expect(choices.find(c => c.group === 'Body / catalog attitude')?.name).toBe('IAU_EUROPA_CLIPPER');
    expect(choices.find(c => c.name === 'J2000')).toMatchObject({ group: 'Inertial frames', availability: 'available' });
    expect(choices.find(c => c.name === 'CATALOG_FRAME')).toBeDefined();
    expect(choices.find(c => c.name === 'IAU_EUROPA_CLIPPER')).toMatchObject({ label: 'Europa Clipper body axes (catalog attitude)', availability: 'available' });
    for (const name of ['EUROPAM_SPACECRAFT', 'EUROPAM_EIS_NAC']) {
      expect(choices.find(c => c.name === name)).toMatchObject({ group: 'SPICE / mission frames', availability: 'unavailable' });
    }
    expect(choices.some(c => c.name === 'NOT_A_FRAME')).toBe(false);
    spice.clear();
  });
});
