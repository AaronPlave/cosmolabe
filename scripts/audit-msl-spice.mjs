#!/usr/bin/env node
// Export unchanged NAIF states and attitudes. Does not use terrain or mesh data.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createSpiceEngine } from '../packages/cspice-wasm/dist/index.js';

const output = process.argv[2];
if (!output) throw new Error('Usage: node scripts/audit-msl-spice.mjs OUTPUT.json');
const root = 'apps/viewer/test-catalogs/kernels/';
const names = ['naif0012.tls', 'pck00011.tpc', 'msl/msl.tf',
  'msl/msl_tp_ops120808_iau2000_v1.tf', 'msl/MSL_76_SCLKSCET.00012.tsc',
  'msl/msl_ls_ops120808_iau2000_v1.bsp', 'msl/msl_surf_rover_loc_0000_2003_v1.bsp',
  'msl/msl_surf_rover_tlm_0449_0583_v1.bsp', 'msl/msl_surf_rover_tlm_0449_0583_v1.bc'];
const engine = await createSpiceEngine(), kernels = [];
for (const name of names) {
  const bytes = await readFile(root + name);
  kernels.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  await engine.furnsh(name.split('/').at(-1), bytes);
}
// UTC samples exercise several operational rover poses without a terrain input.
const rows = [];
for (const utc of ['2014-01-29T12:00:00Z', '2014-02-01T12:00:00Z', '2014-02-05T12:00:00Z', '2014-02-08T12:00:00Z']) {
  const et = await engine.str2et(utc.replace(/Z$/, ''));
  rows.push({ utc, et, positionKm: (await engine.spkpos('-76', et, 'IAU_MARS', 'NONE', '499')).position,
    roverToBody: await engine.pxform('MSL_ROVER', 'IAU_MARS', et) });
}
await writeFile(output, JSON.stringify({ version: 1, frame: 'IAU_MARS',
  frameKernel: 'pck00011.tpc (current catalog)', kernels, rows }, null, 2) + '\n');
