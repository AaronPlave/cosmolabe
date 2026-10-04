#!/usr/bin/env node

/**
 * Pure state-machine helpers for the AI review pilot. The CLI at the bottom is
 * deliberately small: GitHub events are only wake-ups, and every invocation
 * rebuilds the decision from the current PR and its trusted marker comments.
 */

export const WORKFLOW_LABELS = Object.freeze({
  'review:direction': ['B60205', 'Waiting for human product, UX, or architecture direction'],
  'review:chatgpt': ['0969DA', 'Eligible for the bounded ChatGPT implementation review'],
  'ready:test': ['0E8A16', 'Automated review is clean; ready for human testing'],
  'needs:human': ['D93F0B', 'The automated loop stopped and needs human judgment'],
  'agent:claude': ['6F42C1', 'Claude owns implementation and remediation'],
  'agent:codex': ['1D76DB', 'Codex owns implementation and remediation'],
});

const SHA = /^[0-9a-f]{40}$/;
const TYPES = new Set(['request', 'review', 'remediation', 'resume']);
const REVIEW_STATUSES = new Set(['clean', 'changes_requested', 'needs_human']);
const REMEDIATION_STATUSES = new Set(['started', 'blocked']);
const MARKER = /^<!-- ai-loop:(request|review|remediation|resume) (\{[^\r\n]*\}) -->(?:\r?\n|$)/;

export function parseMarker(body) {
  if (typeof body !== 'string') return null;
  const match = body.match(MARKER);
  if (!match || !TYPES.has(match[1])) return null;

  let data;
  try {
    data = JSON.parse(match[2]);
  } catch {
    return null;
  }
  if (!data || data.schema !== 1) return null;

  const type = match[1];
  if (type === 'request') {
    if (!SHA.test(data.head) || !positiveInteger(data.round) || !positiveInteger(data.attempt)) return null;
  } else if (type === 'review') {
    if (!SHA.test(data.head) || !positiveInteger(data.round) || !REVIEW_STATUSES.has(data.status)) return null;
  } else if (type === 'remediation') {
    if (!SHA.test(data.reviewed_head) || !positiveInteger(data.round) || !REMEDIATION_STATUSES.has(data.status)) return null;
  } else if (!SHA.test(data.head)) {
    return null;
  }
  return { type, ...data };
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function trustedMarkers(comments, trusted) {
  return comments.flatMap((comment) => {
    const marker = parseMarker(comment.body);
    if (!marker) return [];
    const login = comment.user?.login;
    const accepted = marker.type === 'review'
      ? [trusted.chatgpt]
      : marker.type === 'remediation'
        ? marker.status === 'started' ? [trusted.orchestrator] : [trusted.claude]
        : [trusted.orchestrator];
    return accepted.includes(login) ? [{ ...marker, commentId: comment.id }] : [];
  });
}

export function reconcile({ pr, comments, trusted, retry = false, resume = false }) {
  const labels = new Set(pr.labels.map((label) => typeof label === 'string' ? label : label.name));
  const remove = new Set();
  const add = new Set();
  const owners = ['agent:claude', 'agent:codex'].filter((label) => labels.has(label));

  if (pr.state !== 'open') return decision('none', add, remove, 'PR is not open');
  if (labels.has('review:direction')) {
    remove.add('review:chatgpt');
    remove.add('ready:test');
    return decision('labels', add, remove, 'direction gate is active');
  }
  if (pr.draft) return decision('none', add, remove, 'PR is draft');
  if (pr.head.repo.full_name !== pr.base.repo.full_name) {
    return decision('none', add, remove, 'fork PRs are not eligible');
  }
  if (owners.length !== 1) {
    return decision('none', add, remove, 'exactly one agent owner label is required');
  }

  const markers = trustedMarkers(comments, trusted);
  const lastResume = markers.reduce((index, marker, i) => marker.type === 'resume' ? i : index, -1);
  const episode = markers.slice(lastResume + 1);
  const reviews = episode.filter((marker) => marker.type === 'review');
  const currentReview = reviews.find((marker) => marker.head === pr.head.sha);
  const blockedRemediation = episode.find((marker) => marker.type === 'remediation'
    && marker.status === 'blocked' && marker.reviewed_head === pr.head.sha);

  if (resume) {
    remove.add('needs:human');
    remove.add('ready:test');
    add.add('review:chatgpt');
    return { ...decision('resume', add, remove, 'human resumed the loop'), head: pr.head.sha, round: 1, attempt: 1 };
  }
  if (blockedRemediation) return stop(add, remove, 'Claude reported remediation blocked');
  if (labels.has('needs:human')) return decision('none', add, remove, 'human intervention is required');

  if (currentReview) {
    if (currentReview.status === 'clean') {
      remove.add('review:chatgpt');
      add.add('ready:test');
      return decision('labels', add, remove, 'review is clean');
    }
    if (currentReview.status === 'needs_human' || currentReview.round >= 3) {
      return stop(add, remove, currentReview.status === 'needs_human'
        ? 'review requested human judgment' : 'three completed review rounds reached');
    }
    if (owners[0] === 'agent:codex') return stop(add, remove, 'Codex remediation requires a human choice');

    const started = episode.some((marker) => marker.type === 'remediation'
      && marker.status === 'started'
      && marker.reviewed_head === pr.head.sha
      && marker.round === currentReview.round);
    if (started) return decision('none', add, remove, 'remediation already started');
    if (!labels.has('review:chatgpt') || labels.has('needs:human') || labels.has('ready:test')) {
      return decision('none', add, remove, 'PR is not eligible for remediation');
    }
    return { ...decision('remediate', add, remove, 'blocking review is ready for Claude'),
      head: pr.head.sha, round: currentReview.round, reviewCommentId: currentReview.commentId };
  }

  if (labels.has('ready:test')) {
    remove.add('ready:test');
    add.add('review:chatgpt');
  }
  if (!labels.has('review:chatgpt') && !add.has('review:chatgpt')) {
    return decision(remove.size || add.size ? 'labels' : 'none', add, remove, 'review label is absent');
  }
  if (reviews.length >= 3) return stop(add, remove, 'three completed review rounds reached');

  const requests = episode.filter((marker) => marker.type === 'request' && marker.head === pr.head.sha);
  if (requests.length && !retry) return decision('none', add, remove, 'current head was already requested');
  const round = reviews.length + 1;
  const attempt = requests.reduce((maximum, marker) => Math.max(maximum, marker.attempt), 0) + 1;
  return { ...decision('request', add, remove, 'eligible head needs review'), head: pr.head.sha, round, attempt };
}

function stop(add, remove, reason) {
  remove.add('review:chatgpt');
  remove.add('ready:test');
  add.add('needs:human');
  return decision('stop', add, remove, reason);
}

function decision(action, add, remove, reason) {
  return { action, add: [...add], remove: [...remove], reason };
}

export function requestBody(head, round, attempt) {
  return `<!-- ai-loop:request ${JSON.stringify({ schema: 1, head, round, attempt })} -->\nChatGPT implementation review requested for ${head.slice(0, 7)} (round ${round}/3).`;
}

export function remediationBody(head, round, status, reason = '') {
  const suffix = reason ? `\n${reason}` : '';
  return `<!-- ai-loop:remediation ${JSON.stringify({ schema: 1, reviewed_head: head, round, status })} -->${suffix}`;
}

export function resumeBody(head) {
  return `<!-- ai-loop:resume ${JSON.stringify({ schema: 1, head })} -->\nA human started a new three-round review episode.`;
}

async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function allComments(owner, repo, number) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const batch = await github(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
}

async function ensureLabels(owner, repo) {
  for (const [name, [color, description]] of Object.entries(WORKFLOW_LABELS)) {
    try {
      await github(`/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`);
    } catch (error) {
      if (!String(error).includes(': 404 ')) throw error;
      await github(`/repos/${owner}/${repo}/labels`, {
        method: 'POST', body: JSON.stringify({ name, color, description }),
      });
    }
  }
}

async function mutateLabels(owner, repo, number, result) {
  for (const label of result.remove) {
    try {
      await github(`/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`, { method: 'DELETE' });
    } catch (error) {
      if (!String(error).includes(': 404 ')) throw error;
    }
  }
  if (result.add.length) {
    await github(`/repos/${owner}/${repo}/issues/${number}/labels`, {
      method: 'POST', body: JSON.stringify({ labels: result.add }),
    });
  }
}

async function comment(owner, repo, number, body) {
  await github(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: 'POST', body: JSON.stringify({ body }),
  });
}

async function main() {
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  const number = Number(process.env.PR_NUMBER);
  if (!number) throw new Error('PR_NUMBER must identify a pull request');
  await ensureLabels(owner, repo);
  const pr = await github(`/repos/${owner}/${repo}/pulls/${number}`);
  const comments = await allComments(owner, repo, number);
  const trusted = {
    chatgpt: process.env.CHATGPT_REVIEW_LOGIN,
    claude: process.env.CLAUDE_BOT_LOGIN,
    orchestrator: 'github-actions[bot]',
  };
  if (!trusted.chatgpt || !trusted.claude) {
    throw new Error('CHATGPT_REVIEW_LOGIN and CLAUDE_BOT_LOGIN repository variables are required');
  }
  const result = reconcile({
    pr, comments, trusted,
    retry: process.env.RETRY_CURRENT_HEAD === 'true',
    resume: process.env.RESUME_AFTER_HUMAN === 'true',
  });

  // Refetch immediately before every state-changing operation. Concurrency is
  // serialized per PR, but a human or app can still push while a run waits.
  const fresh = await github(`/repos/${owner}/${repo}/pulls/${number}`);
  if (fresh.head.sha !== pr.head.sha) return writeOutputs({ action: 'none', reason: 'head changed during reconciliation' });
  await mutateLabels(owner, repo, number, result);
  if (result.action === 'resume') {
    await comment(owner, repo, number, resumeBody(result.head));
    await comment(owner, repo, number, requestBody(result.head, result.round, result.attempt));
  }
  if (result.action === 'request') await comment(owner, repo, number, requestBody(result.head, result.round, result.attempt));
  if (result.action === 'stop') await comment(owner, repo, number, `AI review loop stopped: ${result.reason}.`);
  if (result.action === 'remediate') {
    await comment(owner, repo, number, remediationBody(result.head, result.round, 'started'));
  }
  result.headRef = pr.head.ref;
  writeOutputs(result);
}

function writeOutputs(result) {
  const lines = Object.entries(result).filter(([, value]) => !Array.isArray(value))
    .map(([key, value]) => `${key}=${String(value).replaceAll('\n', ' ')}`);
  if (process.env.GITHUB_OUTPUT) {
    return import('node:fs').then(({ appendFileSync }) => appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`));
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
