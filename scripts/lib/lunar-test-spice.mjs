import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHeritageSpice } from '../../packages/frames/dist/index.js';

/** Real FK/PCK coverage for DE421 surface tests; never substitute IAU_MOON. */
export async function lunarTestSpice() {
  const spice = await createHeritageSpice();
  for (const name of ['naif0012.tls', 'pck00011.tpc', 'de440s.bsp', 'lro/moon_080317.tf', 'lro/moon_pa_de421_1900_2050.bpc']) {
    const url = new URL(`../../apps/viewer/test-catalogs/kernels/${name}`, import.meta.url);
    let bytes;
    try { bytes = readFileSync(url); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      bytes = gunzipSync(readFileSync(new URL(`${url.href}.gz`)));
    }
    await spice.furnish({ type: 'buffer', data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), filename: name.split('/').at(-1) });
  }
  return spice;
}
