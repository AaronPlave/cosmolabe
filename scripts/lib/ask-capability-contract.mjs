import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Deliberate public operation/effect contract. Change only with an API review;
// unlike a generated report, this also catches renamed or removed operations.
const expected = JSON.parse(readFileSync(new URL('../ask-capability-contract.json', import.meta.url), 'utf8'));
const sorted = values => [...values].sort();
export function assertAskCapabilityCoverage({ definitions, defaults, verbs, coverage, gaps, members }) {
  const effects = Object.entries(expected.effects).flatMap(([effect, names]) => names.map(name => [name, effect]));
  assert.deepEqual(sorted(definitions.map(d => d.name)), sorted(effects.map(([name]) => name)), 'Public operation names changed');
  assert.equal(new Set(definitions.map(d => d.name)).size, definitions.length, 'Duplicate operation');
  assert.deepEqual(sorted(definitions.filter(d => d.requiresAuthoring).map(d => d.name)), sorted(expected.hostAuthoring), 'Host authoring policy changed');
  const registered = coverage.filter(r => r.status === 'registered');
  assert.equal(registered.length, definitions.length);
  assert.equal(new Set(registered.map(r => r.operation)).size, definitions.length);
  for (const [name, effect] of effects) {
    const def = definitions.find(d => d.name === name);
    assert.equal(def.effect, effect, `${name}: effect changed`);
    const row = registered.find(r => r.operation === `${r.feature}.${name}`);
    assert.ok(row?.ui && row.discovery, `${name}: UI/discovery classification missing`);
    assert.equal(row.effect, effect, `${name}: coverage effect mismatch`);
    assert.equal(row.permission, effect === 'authoring' ? 'approve-authoring' : effect === 'export' ? 'approve-external' : expected.hostAuthoring.includes(name) ? 'host-authoring' : 'direct', `${name}: permission mismatch`);
    assert.equal(row.defaultAsk, defaults.some(d => d.name === name) ? 'direct' : 'discovery');
  }
  for (const def of defaults) assert.ok(definitions.some(d => d.name === def.name && d.effect === def.effect), `${def.name}: orphaned default Ask tool`);
  for (const verb of verbs) {
    const def = definitions.find(d => d.name === verb.name);
    assert.equal(def?.method, verb.method, `${verb.name}: missing or misrouted verb`);
    assert.equal(registered.find(r => r.script === verb.name)?.semantic, verb.method, `${verb.name}: script exposure missing`);
    assert.equal(!!verb.sceneEdit, expected.hostAuthoring.includes(verb.name), `${verb.name}: host permission changed`);
  }
  const classified = new Set([...definitions.map(d => d.method), ...Object.keys(gaps)]);
  for (const name of members) assert.ok(classified.has(name), `${name}: unclassified ViewerControl member`);
  for (const [name, reason] of Object.entries(gaps)) assert.ok(members.includes(name) && reason.trim(), `${name}: invalid contract exclusion`);
}
