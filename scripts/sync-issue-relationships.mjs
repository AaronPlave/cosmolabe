#!/usr/bin/env node
/**
 * Add audited GitHub issue dependencies and parent/sub-issue relationships.
 *
 * Usage:
 *   node scripts/sync-issue-relationships.mjs --validate
 *   node scripts/sync-issue-relationships.mjs --dry-run
 *   GITHUB_TOKEN=... node scripts/sync-issue-relationships.mjs --apply
 *
 * Additive only: never delete existing edges or replace an existing parent.
 */
import { readFile, appendFile } from 'node:fs/promises';

const path = '.github/issue-relationships.json';
const manifest = JSON.parse(await readFile(path, 'utf8'));
const args = new Set(process.argv.slice(2));
const mode = args.has('--apply') ? 'apply' : args.has('--validate') ? 'validate' : 'dry-run';
const repo = process.env.GITHUB_REPOSITORY || 'AaronPlave/cosmolabe';
const token = process.env.GITHUB_TOKEN;
const base = `https://api.github.com/repos/${repo}`;
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const issueCache = new Map();
const planned = [];

function validNumber(x) { return Number.isSafeInteger(Number(x)) && Number(x) > 0; }
function validate() {
  if (manifest.version !== 1) throw Error('Unsupported manifest version');
  const graph = new Map();
  for (const [blocked, blockers] of Object.entries(manifest.blockedBy)) {
    if (!validNumber(blocked) || !Array.isArray(blockers) || new Set(blockers).size !== blockers.length) throw Error(`Invalid blockers for #${blocked}`);
    for (const b of blockers) {
      if (!validNumber(b) || +blocked === b) throw Error(`Invalid dependency #${blocked} -> #${b}`);
    }
    graph.set(+blocked, blockers);
  }
  const owners = new Map();
  for (const [parent, children] of Object.entries(manifest.subIssues)) {
    if (!validNumber(parent) || !Array.isArray(children) || new Set(children).size !== children.length) throw Error(`Invalid children for #${parent}`);
    for (const child of children) {
      if (!validNumber(child) || +parent === child || owners.has(child)) throw Error(`Invalid/duplicate parent for #${child}`);
      owners.set(child, +parent);
    }
  }
  for (const [n, next] of graph) for (const b of next) if (graph.get(b)?.includes(n)) throw Error(`Direct dependency cycle #${n} <-> #${b}`);
  const visit = (n, path = new Set(), done = new Set()) => {
    if (path.has(n)) throw Error(`Dependency cycle at #${n}`);
    if (done.has(n)) return;
    path.add(n);
    for (const b of graph.get(n) || []) visit(b, path, done);
    path.delete(n);
    done.add(n);
  };
  const done = new Set();
  for (const n of graph.keys()) visit(n, new Set(), done);
  console.log(`Validated: ${[...graph.values()].flat().length} dependency edges, ${owners.size} sub-issue links`);
}
validate();
if (mode === 'validate') process.exit(0);
if (!token) throw Error('GITHUB_TOKEN is required for live read/write. Use --validate without credentials.');

async function api(method, resource, body, optional404 = false) {
  const response = await fetch(base + resource, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (optional404 && response.status === 404) return null;
  if (!response.ok) {
    const details = (await response.text()).slice(0, 600);
    throw Error(`${method} ${resource}: HTTP ${response.status} ${details}`);
  }
  if (response.status === 204) return null;
  return response.json();
}
async function issue(number) {
  if (!issueCache.has(number)) {
    const item = await api('GET', `/issues/${number}`);
    if (item.pull_request) throw Error(`#${number} is a PR, not an issue`);
    issueCache.set(number, item);
  }
  return issueCache.get(number);
}
async function paginate(path) {
  let page = 1, all = [];
  while (true) {
    const separator = path.includes('?') ? '&' : '?';
    const items = await api('GET', `${path}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(items)) throw Error(`Expected array from ${path}`);
    all.push(...items);
    if (items.length < 100) return all;
    page++;
  }
}
async function change(description, resource, payload) {
  planned.push(description);
  console.log(`${mode === 'apply' ? 'ADD' : 'WOULD ADD'} ${description}`);
  if (mode === 'apply') {
    await wait(1100); // Respect GitHub secondary rate limits on relationship mutations.
    await api('POST', resource, payload);
  }
}
for (const [blockedStr, blockers] of Object.entries(manifest.blockedBy)) {
  const blocked = +blockedStr;
  const target = await issue(blocked);
  if (target.state !== 'open') {
    console.log(`SKIP closed target #${blocked}`);
    continue;
  }
  const existing = new Set((await paginate(`/issues/${blocked}/dependencies/blocked_by`)).map(x => x.id));
  for (const blocker of blockers) {
    const source = await issue(blocker);
    if (source.state !== 'open') {
      console.log(`SKIP closed blocker #${blocker} for #${blocked}`);
      continue;
    }
    if (existing.has(source.id)) continue;
    await change(`#${blocked} blocked by #${blocker}`, `/issues/${blocked}/dependencies/blocked_by`, { issue_id: source.id });
    existing.add(source.id);
  }
}
for (const [parentStr, children] of Object.entries(manifest.subIssues)) {
  const parent = +parentStr;
  await issue(parent);
  for (const child of children) {
    const record = await issue(child);
    const existing = await api('GET', `/issues/${child}/parent`, undefined, true);
    if (existing) {
      if (existing.id !== (await issue(parent)).id) {
        console.log(`SKIP #${child}: already belongs to #${existing.number || existing.issue_number}; refusing to replace parent`);
      }
      continue;
    }
    await change(`#${parent} parent of #${child}`, `/issues/${parent}/sub_issues`, { sub_issue_id: record.id });
  }
}
console.log(`${mode === 'apply' ? 'Created' : 'Proposed'} ${planned.length} missing relationships.`);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `## Issue relationships (${mode})\\n\\nValidated manifest; ${planned.length} missing links.\\n\\n` +
    planned.map(s => `- ${s}`).join('\\n') + '\\n');
}
