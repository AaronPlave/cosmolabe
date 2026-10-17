import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyReview, verifyRemediationPR, resolvePR } from './ai-review-loop-runner.mjs';

const head = 'a'.repeat(40);
const expected = { login: 'reviewer', head, round: 1 };
const comment = { user: { login: 'reviewer' }, body: `<!-- ai-loop:review {"schema":1,"head":"${head}","round":1,"status":"changes_requested"} -->\nFinding` };
const pr = () => ({
  number: 133, state: 'open', draft: false, changed_files: 1,
  head: { sha: head, ref: 'topic', repo: { full_name: 'owner/repo' } },
  base: { repo: { full_name: 'owner/repo' } },
  labels: [{ name: 'agent:claude' }, { name: 'review:chatgpt' }],
});

test('exact review verification rejects edited markers, other authors, heads, rounds, and statuses', () => {
  assert.equal(verifyReview(comment, expected), comment.body);
  for (const invalid of [
    { ...comment, user: { login: 'attacker' } },
    { ...comment, body: comment.body.replace(head, 'b'.repeat(40)) },
    { ...comment, body: comment.body.replace('"round":1', '"round":2') },
    { ...comment, body: comment.body.replace('changes_requested', 'clean') },
    { ...comment, body: 'Quoted\n' + comment.body },
    { ...comment, body: comment.body.replace('"schema":1', '"schema":2') },
  ]) assert.throws(() => verifyReview(invalid, expected));
});

test('remediation guard rejects protected paths, renamed protected paths, incomplete lists, and changed eligibility', () => {
  const ordinary = [{ filename: 'src/example.ts' }];
  assert.doesNotThrow(() => verifyRemediationPR(pr(), head, ordinary));
  for (const files of [[], [{ filename: '.github/workflows/ci.yml' }],
    [{ filename: 'moved.yml', previous_filename: '.github/workflows/ci.yml' }]]) {
    assert.throws(() => verifyRemediationPR(pr(), head, files));
  }
  for (const candidate of [
    { ...pr(), draft: true }, { ...pr(), state: 'closed' },
    { ...pr(), labels: [...pr().labels, { name: 'review:direction' }] },
    { ...pr(), labels: [...pr().labels, { name: 'agent:codex' }] },
    { ...pr(), head: { ...pr().head, repo: null } },
  ]) assert.throws(() => verifyRemediationPR(candidate, head, ordinary));
  assert.throws(() => verifyRemediationPR(pr(), 'b'.repeat(40), ordinary));
});

test('PR resolution uses event identity and safely falls back when workflow_run metadata is empty', async () => {
  assert.equal(await resolvePR({ issue: { number: 133, pull_request: {} } }), 133);
  assert.equal(await resolvePR({ workflow_run: { pull_requests: [{ number: 133 }] } }), 133);
  const event = { repository: { full_name: 'owner/repo' }, workflow_run: {
    pull_requests: [], head_repository: { full_name: 'owner/repo' }, head_branch: 'topic',
  } };
  assert.equal(await resolvePR(event, async (path) => {
    assert.match(path, /head=owner%3Atopic/);
    return [pr()];
  }), 133);
  await assert.rejects(resolvePR(event, async () => []));
  await assert.rejects(resolvePR(event, async () => [pr(), pr()]));
  await assert.rejects(resolvePR({ ...event, workflow_run: { ...event.workflow_run, head_repository: { full_name: 'other/fork' } } }));
});

test('finalizer reconciles directly after failure, no-push success, existing blocked result, and a push', async (t) => {
  const { run } = await import('./ai-review-loop-runner.mjs');
  const { requestBody, remediationBody, WORKFLOW_LABELS } = await import('./ai-review-loop.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const directory = mkdtempSync('/tmp/ai-loop-test-');
  const saved = { ...process.env };
  Object.assign(process.env, {
    GITHUB_REPOSITORY: 'owner/repo', PR_NUMBER: '133', EXPECTED_HEAD: head, EXPECTED_ROUND: '1',
    CHATGPT_REVIEW_LOGIN: 'reviewer', CLAUDE_BOT_LOGIN: 'claude',
    GITHUB_OUTPUT: `${directory}/output`,
  });
  try {
    for (const scenario of ['failure', 'no-push', 'blocked', 'pushed']) {
      const current = pr();
      if (scenario === 'pushed') current.head.sha = 'b'.repeat(40);
      const comments = [
        { id: 1, user: { login: 'github-actions[bot]' }, body: requestBody(head, 1, 1) },
        { ...comment, id: 2 },
        { id: 3, user: { login: 'github-actions[bot]' }, body: remediationBody(head, 1, 'started') },
      ];
      if (scenario === 'blocked') comments.push({ id: 4, user: { login: 'claude' }, body: remediationBody(head, 1, 'blocked') });
      const posted = [];
      const added = [];
      const fetch = t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
        const path = new URL(url).pathname;
        let data;
        if (path.endsWith('/pulls/133')) data = current;
        else if (path.endsWith('/comments')) {
          if (options.method === 'POST') {
            const body = JSON.parse(options.body).body;
            posted.push(body);
            comments.push({ id: comments.length + 1, body, user: { login: 'github-actions[bot]' } });
            data = {};
          } else data = comments;
        } else if (path.endsWith('/issues/133/labels')) {
          added.push(...JSON.parse(options.body).labels); data = [];
        } else if (path.endsWith('/labels')) data = Object.keys(WORKFLOW_LABELS).map((name) => ({ name }));
        else if (options.method === 'DELETE') return new Response(null, { status: 204 });
        else throw new Error(`Unexpected API call: ${path}`);
        return Response.json(data);
      });
      await run('finalize');
      const blocked = posted.filter((body) => body.startsWith('<!-- ai-loop:remediation'));
      if (scenario === 'pushed') {
        assert.equal(blocked.length, 0);
        assert.equal(posted.some((body) => body.startsWith('<!-- ai-loop:request') && body.includes('"round":2')), true);
      } else {
        assert.equal(blocked.length, scenario === 'blocked' ? 0 : 1);
        assert.equal(added.includes('needs:human'), true);
      }
      fetch.mock.restore();
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
});
