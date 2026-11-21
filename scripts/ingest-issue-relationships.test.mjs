import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIssueRelationships as parse } from './ingest-issue-relationships.mjs';

test('explicitly independent issue', () => {
  assert.deepEqual(parse('## Issue relationships\n- Parent issue: None\n- Blocked by: None', 324), { parent: null, blockedBy: [] });
});
test('parent and blockers are separate from related prose', () => {
  assert.deepEqual(parse('Related #3 and #1.\n\n## Issue relationships\n- Parent issue: #316\n- Blocked by: #307, #285\n- Related: #2', 324), { parent: 316, blockedBy: [307, 285] });
});
test('no implicit relationships from issue mentions', () => {
  assert.throws(() => parse('This uses #316 and #307', 324), /Missing/);
});
test('legacy template wording remains accepted', () => {
  assert.deepEqual(parse('## Issue relationships\n- Hard blockers: #308\n- Parent initiative / sub-issue, if any: #315', 324), { parent: 315, blockedBy: [308] });
});
test('incomplete fields require attention', () => {
  assert.throws(() => parse('## Issue relationships\n- Parent issue:\n- Blocked by: None', 324), /explicit/);
});
test('unambiguous number syntax only', () => {
  assert.throws(() => parse('## Issue relationships\n- Parent issue: see #315\n- Blocked by: None', 324), /one #number/);
});
test('reject self and duplicate relations', () => {
  assert.throws(() => parse('## Issue relationships\n- Parent issue: #324\n- Blocked by: None', 324), /itself/);
  assert.throws(() => parse('## Issue relationships\n- Parent issue: None\n- Blocked by: #307, #307', 324), /Duplicate/);
});
