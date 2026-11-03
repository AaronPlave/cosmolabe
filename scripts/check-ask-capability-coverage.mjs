/** Verify #297 registration, routing and permissions without a generated report. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { agentDefinitions, VERB_LIST, capabilityCoverage, CONTROL_CONTRACT_GAPS } from '../packages/control/dist/index.js';
import { defaultAskDefinitions } from '../packages/control/dist/capabilities.js';
import { assertAskCapabilityCoverage } from './lib/ask-capability-contract.mjs';

const source = ts.createSourceFile('contracts.ts', readFileSync(new URL('../packages/control/src/contracts.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const port = source.statements.find(n => ts.isInterfaceDeclaration(n) && n.name.text === 'ViewerControl');
assert.ok(port, 'ViewerControl contract must exist');
const members = port.members.map(m => m.name.getText(source));
assertAskCapabilityCoverage({ definitions: agentDefinitions(), defaults: defaultAskDefinitions(), verbs: VERB_LIST,
  coverage: capabilityCoverage(), gaps: CONTROL_CONTRACT_GAPS, members });
console.log(`${agentDefinitions().length} shared operations: registration, routing, effects and host permissions verified`);
