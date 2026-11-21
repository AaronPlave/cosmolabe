#!/usr/bin/env node
/**
 * Convert explicit relationship declarations on newly created issues into
 * native GitHub parent/sub-issue and blocked-by relationships.
 *
 * No inferred edges from generic issue mentions. Additive only.
 * Run on issues.opened/edited/reopened and as a scheduled audit for issues
 * created after #323 (the 2026-10-30 hierarchy backfill).
 */
import { readFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '<!-- cosmolabe-relationship-review -->';
const LEGACY_PARENT = ['Parent issue', 'Parent initiative / sub-issue, if any'];
const LEGACY_BLOCKER = ['Blocked by', 'Hard blockers', 'Hard blockers (or None)'];

function findField(section, names) {
  for (const name of names) {
    const line = section.split('\n').find(x => x.trimStart().toLowerCase().startsWith('- ' + name.toLowerCase() + ':'));
    if (line) return line.slice(line.indexOf(':') + 1).replace(/<!--.*?-->/g, '').trim();
  }
  return undefined;
}

function refs(value, field, limit) {
  if (value === undefined || !value) throw Error(field + ' must be explicit (#123 or None)');
  if (/^none$/i.test(value)) return [];
  const parts = value.split(/[\s,]+/).filter(Boolean);
  if (parts.length > limit || !parts.every(x => /^#[1-9]\d*$/.test(x))) {
    throw Error(field + ' must be ' + (limit === 1 ? 'one #number' : 'comma-separated #numbers') + ' or None');
  }
  const numbers = parts.map(x => Number(x.slice(1)));
  if (new Set(numbers).size !== numbers.length) throw Error('Duplicate ' + field + ' number');
  return numbers;
}

export function parseIssueRelationships(body, issueNumber) {
  const content = (body || '').replace(/\r\n/g, '\n');
  const sectionStart = content.search(/^## Issue relationships\s*$/im);
  if (sectionStart === -1) throw Error('Missing ## Issue relationships section');
  const remaining = content.slice(sectionStart).split(/\n(?=##\s)/)[0];
  const parents = refs(findField(remaining, LEGACY_PARENT), 'Parent issue', 1);
  const blockers = refs(findField(remaining, LEGACY_BLOCKER), 'Blocked by', 10);
  if (parents.includes(issueNumber) || blockers.includes(issueNumber)) throw Error('An issue cannot refer to itself');
  return { parent: parents[0] || null, blockedBy: blockers };
}

async function run() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !/^[-\w.]+\/[-\w.]+$/.test(repo || '')) throw Error('Expected GITHUB_TOKEN and GITHUB_REPOSITORY');
  const base = 'https://api.github.com/repos/' + repo;
  const mode = process.argv.includes('--audit') ? 'audit' : 'event';
  const summary = [];
  async function api(method, path, body, allow404 = false) {
    const response = await fetch(base + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw Error(method + ' ' + path + ': HTTP ' + response.status + ' ' + (await response.text()).slice(0, 300));
    return response.status === 204 ? null : response.json();
  }
  async function pages(path) {
    const all = [];
    for (let p = 1; ; p++) {
      const sep = path.includes('?') ? '&' : '?';
      const batch = await api('GET', path + sep + 'per_page=100&page=' + p);
      if (!Array.isArray(batch)) throw Error('Expected a collection for ' + path);
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  }
  async function notifyOnce(number, message) {
    const comments = await pages('/issues/' + number + '/comments');
    if (comments.some(c => (c.body || '').includes(MARKER))) return;
    await api('POST', '/issues/' + number + '/comments', { body: MARKER + '\n' + message });
  }
  async function process(issue) {
    if (issue.pull_request || issue.number <= 323) return;
    let declaration;
    try {
      declaration = parseIssueRelationships(issue.body, issue.number);
    } catch (error) {
      summary.push('#' + issue.number + ': relationship review required (' + error.message + ')');
      await notifyOnce(issue.number, 'Please complete the **Issue relationships** section with explicit Parent issue: #number (or None) and Blocked by: #number, #number (or None). Only true prerequisites are blockers; related work is not. Edit the issue body to trigger native-link synchronization.\n\nReason: ' + error.message + '. [Guidance](https://github.com/' + repo + '/blob/main/docs/issue-dependencies.md).');
      return;
    }
    if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(issue.author_association)) {
      summary.push('#' + issue.number + ': external reporter; relationship declarations require maintainer review');
      await notifyOnce(issue.number, 'The issue has a relationship declaration, but native relationships must be reviewed/applied by a repository maintainer. An external reporter cannot create parent or blocker links automatically.');
      return;
    }
    const number = issue.number;
    const parent = declaration.parent;
    if (parent) {
      const target = await api('GET', '/issues/' + parent);
      if (target.pull_request) throw Error('Parent #' + parent + ' is a PR');
      const existing = await api('GET', '/issues/' + number + '/parent', undefined, true);
      if (existing && existing.number !== parent) {
        summary.push('#' + number + ': already parented to #' + existing.number + ', requested #' + parent);
        await notifyOnce(number, 'Parent mismatch: issue already belongs to #' + existing.number + ', but the declaration requests #' + parent + '. Please reconcile the native relationship in GitHub; this workflow does not reparent automatically.');
        return;
      }
      if (!existing) {
        await api('POST', '/issues/' + parent + '/sub_issues', { sub_issue_id: issue.id });
        summary.push('#' + number + ': parent set to #' + parent);
      }
    }
    const existingBlockers = new Set((await pages('/issues/' + number + '/dependencies/blocked_by')).map(x => x.number));
    for (const blocker of declaration.blockedBy) {
      const source = await api('GET', '/issues/' + blocker);
      if (source.pull_request) throw Error('Blocker #' + blocker + ' is a PR');
      if (source.state !== 'open') {
        summary.push('#' + number + ': ignored closed blocker #' + blocker);
        continue;
      }
      if (!existingBlockers.has(blocker)) {
        await api('POST', '/issues/' + number + '/dependencies/blocked_by', { issue_id: source.id });
        summary.push('#' + number + ': blocked by #' + blocker);
      }
    }
    if (!parent && !declaration.blockedBy.length) summary.push('#' + number + ': explicitly independent (None / None)');
  }
  if (mode === 'audit') {
    const issues = await pages('/issues?state=open');
    for (const issue of issues) await process(issue);
  } else {
    const payload = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (payload.issue) await process(payload.issue);
  }
  console.log(summary.join('\n') || 'No relationship changes needed.');
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, '## Issue relationship hygiene\n\n' + (summary.length ? summary.map(s => '- ' + s).join('\n') : 'No changes needed.') + '\n');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run().catch(error => { console.error(error); process.exitCode = 1; });
}
