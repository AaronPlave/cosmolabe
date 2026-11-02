/** Regenerate or verify the #297 machine-readable Ask routing/permission matrix. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { capabilityCoverage, CONTROL_CONTRACT_GAPS } from '../packages/control/dist/index.js';
const file = new URL('../docs/validation/297-ask-parity/capability-matrix.json', import.meta.url);
const expected = { version: 1, registry: 'ViewerControl / VERBS / agentDefinitions / capabilityCoverage',
  routes: capabilityCoverage(), trustedHostOrProjectedReads: CONTROL_CONTRACT_GAPS };
if (process.argv.includes('--write')) writeFileSync(file, JSON.stringify(expected, null, 2) + '\n');
else assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), expected, 'Rebuild control and regenerate the capability matrix');
console.log(`${expected.routes.filter(r => r.status === 'registered').length} shared operations classified for default Ask`);
