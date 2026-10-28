#!/usr/bin/env node
/** Reproduce #238 control comparisons using bundled NAIF/LRO kernels.
 * npm run build && node scripts/audit-lunar-frames.mjs > report.json */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createHeritageSpice } from '@cosmolabe/frames';
import { Universe, LUNAR_SURFACE_FRAME } from '@cosmolabe/core';
const root = new URL('../apps/viewer/test-catalogs/', import.meta.url);
const spice = await createHeritageSpice();
const kernels = [];
for (const name of ['naif0012.tls', 'pck00011.tpc', 'de440s.bsp', 'lro/moon_080317.tf.gz', 'lro/moon_pa_de421_1900_2050.bpc.gz', 'lro/lrorg_2024350_2025074_v01.bsp.gz']) {
  const file = readFileSync(new URL(`kernels/${name}`, root));
  const data = name.endsWith('.gz') ? gunzipSync(file) : file;
  kernels.push({ name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  await spice.furnish({ type: 'buffer', data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), filename: name.split('/').at(-1).replace(/\.gz$/, '') });
}
const mul = (m, v) => [0, 1, 2].map(i => m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2]);
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const sites = [['Shackleton', -89.67, 129.78], ['south-pole', -90, 0], ['equator-prime', 0, 0], ['equator-east', 0, 90], ['mid-latitude', 45, 45]];
const comparisons = ['2000-01-01T12:00:00', '2010-06-01T00:00:00', '2025-01-15T00:03:00', '2028-12-15T10:04:00'].map(utc => {
  const et = spice.str2et(utc);
  const m = spice.pxform(LUNAR_SURFACE_FRAME, 'IAU_MOON', et);
  const sin = Math.hypot(m[7] - m[5], m[2] - m[6], m[3] - m[1]) / 2;
  const angle = Math.atan2(sin, (m[0] + m[4] + m[8] - 1) / 2);
  return { utc, et, meToIau: m, rotationArcsec: angle * 180 / Math.PI * 3600,
    maximumSurfaceDisplacementM: 2 * 1737400 * Math.sin(angle / 2), sites: sites.map(([name, lat, lon]) => {
      const phi = lat * Math.PI / 180, lambda = lon * Math.PI / 180;
      const v = [1737.4 * Math.cos(phi) * Math.cos(lambda), 1737.4 * Math.cos(phi) * Math.sin(lambda), 1737.4 * Math.sin(phi)];
      const displacementM = distance(v, mul(m, v)) * 1000;
      return { name, lat, lon, displacementM, centralAngleArcsec: 2 * Math.asin(displacementM / (2 * 1737400)) * 180 / Math.PI * 3600 };
    }) };
});
const universe = new Universe(spice);
universe.loadCatalog({ items: [{ name: 'Moon', trajectory: { type: 'FixedPoint', position: [0, 0, 0] }, rotationModel: { type: 'Spice', bodyFrame: LUNAR_SURFACE_FRAME }, items: [
  { name: 'LRO', trajectory: { type: 'Spice', target: 'LRO', center: 'MOON' }, trajectoryFrame: LUNAR_SURFACE_FRAME },
] }] });
const lro = ['2025-01-15T00:03:00', '2025-01-16T12:00:00', '2025-02-01T00:00:00'].map(utc => {
  const et = spice.str2et(utc);
  const me = spice.spkpos('LRO', et, LUNAR_SURFACE_FRAME, 'NONE', 'MOON').position;
  const expected = spice.spkpos('LRO', et, 'ECLIPJ2000', 'NONE', 'MOON').position;
  const world = universe.absolutePositionOf('LRO', et);
  return { utc, et, meKm: me, worldKm: world, roundTripResidualM: distance(world, expected) * 1000 };
});
process.stdout.write(JSON.stringify({ frame: LUNAR_SURFACE_FRAME, comparisonFrame: 'IAU_MOON', referenceRadiusKm: 1737.4, kernels, comparisons, lro,
  limits: 'Transform closure only; not an independent orbit reconstruction or a source geolocation accuracy bound.' }, null, 2) + '\n');
