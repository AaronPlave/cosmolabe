#!/usr/bin/env node
/** Regenerate explicitly estimated Ingenuity trajectories from pinned sources.
 * Usage: node scripts/build-ingenuity-flights.mjs --fusion DIR --areoid MEGA90N000EB.LBL
 * Original MMGIS observations and mission event epochs are preserved. The Python
 * worker records the coordinate evidence, model assumptions and log conflicts.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const worker = fileURLToPath(new URL('./terrain/reconstruct_ingenuity.py', import.meta.url));
const result = spawnSync('python3', [worker, ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
