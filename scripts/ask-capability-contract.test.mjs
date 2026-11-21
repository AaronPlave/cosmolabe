import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { agentDefinitions, VERB_LIST, capabilityCoverage, CONTROL_CONTRACT_GAPS } from '../packages/control/src/index.ts';
import { defaultAskDefinitions } from '../packages/control/src/capabilities.ts';
import { assertAskCapabilityCoverage } from './lib/ask-capability-contract.mjs';

const source = ts.createSourceFile('contracts.ts', readFileSync(new URL('../packages/control/src/contracts.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const members = source.statements.find(n => ts.isInterfaceDeclaration(n) && n.name.text === 'ViewerControl').members.map(m => m.name.getText(source));
const fixture = () => ({ definitions: agentDefinitions().map(d => ({ ...d })), defaults: defaultAskDefinitions(), verbs: VERB_LIST,
  coverage: capabilityCoverage().map(r => ({ ...r })), gaps: CONTROL_CONTRACT_GAPS, members });
describe('Ask capability contract gate', () => {
  it('checks the live source registry without a generated snapshot', () => assertAskCapabilityCoverage(fixture()));
  it.each(['removed', 'renamed', 'unexposed', 'effect', 'permission', 'host-policy', 'unclassified'])('rejects a %s contract regression', change => {
    const f = fixture();
    if (change === 'removed') f.definitions.pop();
    if (change === 'renamed') f.definitions[0].name = 'renamed';
    if (change === 'unexposed') f.coverage.find(r => r.status === 'registered').discovery = false;
    if (change === 'effect') f.definitions[0].effect = 'export';
    if (change === 'permission') f.coverage.find(r => r.status === 'registered').permission = 'approve-external';
    if (change === 'host-policy') f.definitions.find(d => d.requiresAuthoring).requiresAuthoring = false;
    if (change === 'unclassified') f.members = [...f.members, 'unclassifiedNewMethod'];
    expect(() => assertAskCapabilityCoverage(f)).toThrow();
  });
});
