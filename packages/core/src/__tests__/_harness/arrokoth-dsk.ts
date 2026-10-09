/**
 * A real CSPICE scene over a real irregular shape: the committed New Horizons
 * Arrokoth (2014 MU69) low-poly DSK (`kernels/fixtures/mu69_lopoly.bds`),
 * with everything around it synthetic but made of real kernels — SPKs
 * written by CSPICE (spkw13) for the body, a camera 100 km off it and the
 * Sun, a text FK for the DSK segment's own frame (code 10111, read from the
 * segment descriptor), and a text IK for a small rectangular camera.
 *
 * It exists so the DSK surface-intersection path can be exercised end to end
 * offline; the Rosetta/67P acceptance case of issue #28 needs mission kernels
 * this repository does not carry.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSpiceBindings } from 'cspice-wasm';
import { createHeritageSpice } from '@cosmolabe/frames';
import type { SpiceInstance } from '../../spice-injection.js';

const FIXTURES = join(__dirname, '../../../../../kernels/fixtures');

export const ARROKOTH = 2486958;
export const CAMERA_CRAFT = -998;
export const CAMERA = -998001;
export const EPOCH = '2019-01-01T05:33:00';

const FK = `KPL/FK
\\begindata
NAIF_BODY_NAME += ( 'ARROKOTH', 'DSK_TEST_CRAFT' )
NAIF_BODY_CODE += ( ${ARROKOTH}, ${CAMERA_CRAFT} )
FRAME_MU69_FIXED      = 10111
FRAME_10111_NAME      = 'MU69_FIXED'
FRAME_10111_CLASS     = 4
FRAME_10111_CLASS_ID  = 10111
FRAME_10111_CENTER    = ${ARROKOTH}
TKFRAME_10111_RELATIVE = 'J2000'
TKFRAME_10111_SPEC     = 'MATRIX'
TKFRAME_10111_MATRIX   = ( 1 0 0  0 1 0  0 0 1 )
BODY${ARROKOTH}_RADII  = ( 18.0 10.0 8.0 )
\\begintext
`;

// Looks along J2000 +Z from 100 km below Arrokoth: a 2° × 1.5° half-angle
// frame, about 7 × 5 km at the body — inside its silhouette.
const IK = `KPL/IK
\\begindata
INS${CAMERA}_FOV_SHAPE        = 'RECTANGLE'
INS${CAMERA}_FOV_FRAME        = 'J2000'
INS${CAMERA}_BORESIGHT        = ( 0.0, 0.0, 1.0 )
INS${CAMERA}_FOV_CLASS_SPEC   = 'ANGLES'
INS${CAMERA}_FOV_REF_VECTOR   = ( 1.0, 0.0, 0.0 )
INS${CAMERA}_FOV_REF_ANGLE    = ( 2.0 )
INS${CAMERA}_FOV_CROSS_ANGLE  = ( 1.5 )
INS${CAMERA}_FOV_ANGLE_UNITS  = 'DEGREES'
\\begintext
`;

const text = (s: string) => new TextEncoder().encode(s);
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** A heritage engine furnished with the Arrokoth scene, and its epoch in ET. */
export async function arrokothDskScene(): Promise<{ spice: SpiceInstance; et: number }> {
  const lsk = new Uint8Array(readFileSync(join(FIXTURES, 'naif0012.tls')));

  // Write the SPK with a scratch engine: the camera and the Sun, both at rest
  // relative to Arrokoth for an hour either side of the epoch.
  const writer = await createSpiceBindings();
  writer.furnsh('naif0012.tls', lsk);
  const et0 = writer.str2et(EPOCH);
  const n = 9;
  const epochs = new Float64Array(n);
  for (let i = 0; i < n; i++) epochs[i] = et0 - 3600 + (7200 * i) / (n - 1);
  const at = (p: [number, number, number]) => {
    const s = new Float64Array(n * 6);
    for (let i = 0; i < n; i++) s.set([...p, 0, 0, 0], i * 6);
    return s;
  };
  writer.writeSpkType13('dsk-scene.bsp', CAMERA_CRAFT, ARROKOTH, 'J2000', 'CAMERA', 3, epochs, at([0, 0, -100]));
  // Arrokoth itself, for the chain to the barycentre sincpt walks.
  writer.writeSpkType13('dsk-body.bsp', ARROKOTH, 0, 'J2000', 'ARROKOTH', 3, epochs, at([6.6e9, 0, 0]));
  writer.writeSpkType13('dsk-sun.bsp', 10, ARROKOTH, 'J2000', 'SUN', 3, epochs, at([4e9, 0, -4e9]));

  const spice = (await createHeritageSpice()) as unknown as SpiceInstance;
  const furnish = (filename: string, data: Uint8Array) => spice.furnish({ type: 'buffer', data: ab(data), filename });
  await furnish('naif0012.tls', lsk);
  await furnish('dsk-scene.tf', text(FK));
  await furnish('dsk-scene.ti', text(IK));
  await furnish('mu69_lopoly.bds', new Uint8Array(readFileSync(join(FIXTURES, 'mu69_lopoly.bds'))));
  await furnish('dsk-scene.bsp', writer.readKernelBytes('dsk-scene.bsp'));
  await furnish('dsk-body.bsp', writer.readKernelBytes('dsk-body.bsp'));
  await furnish('dsk-sun.bsp', writer.readKernelBytes('dsk-sun.bsp'));
  return { spice, et: spice.str2et(EPOCH) };
}
