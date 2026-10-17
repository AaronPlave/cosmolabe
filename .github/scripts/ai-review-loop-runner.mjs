import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { allComments, github, main, parseMarker, remediationBody, trustedMarkers } from './ai-review-loop.mjs';

export function verifyReview(comment, { login, head, round }) {
  const marker = parseMarker(comment.body);
  if (!login || comment.user?.login !== login || marker?.type !== 'review'
    || marker.head !== head || marker.round !== round || marker.status !== 'changes_requested') {
    throw new Error('The selected review no longer matches the trusted blocking verdict');
  }
  return comment.body;
}

export function verifyRemediationPR(pr, head, files) {
  const labels = new Set(pr.labels.map(({ name }) => name));
  if (pr.state !== 'open' || pr.draft || pr.head.sha !== head || !pr.head.repo
    || pr.head.repo.full_name !== pr.base.repo.full_name
    || !labels.has('agent:claude') || labels.has('agent:codex') || !labels.has('review:chatgpt')
    || ['needs:human', 'ready:test', 'review:direction'].some((label) => labels.has(label))) {
    throw new Error('PR is no longer eligible for the selected remediation');
  }
  if (files.length !== pr.changed_files || files.some(({ filename, previous_filename }) =>
    [filename, previous_filename].some((path) => path === '.github' || path?.startsWith('.github/')))) {
    throw new Error('Remediation refuses incomplete file lists and changes touching .github/');
  }
}

// workflow_run pull_requests can be empty. Fall back to the API using the
// upstream run's branch and repository; never trust downloaded wake artifacts.
export async function resolvePR(event, request = github) {
  const number = event.issue?.pull_request ? event.issue.number : event.workflow_run?.pull_requests?.[0]?.number;
  if (number) return number;
  const run = event.workflow_run;
  if (!run?.head_repository?.full_name || !run.head_branch) throw new Error('Wake has no PR identity');
  const repository = event.repository.full_name;
  if (run.head_repository.full_name !== repository) throw new Error('Fork wakes are not eligible');
  const owner = repository.split('/')[0];
  const prs = await request(`/repos/${repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${run.head_branch}`)}&per_page=100`);
  const matches = prs.filter((pr) => pr.head.repo?.full_name === repository && pr.head.ref === run.head_branch);
  if (matches.length !== 1) throw new Error('Wake must resolve to exactly one PR');
  return matches[0].number;
}

export async function run(mode = process.argv[2]) {
  if (mode === 'resolve') {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const number = process.env.DISPATCH_PR ? Number(process.env.DISPATCH_PR) : await resolvePR(event);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Invalid PR number');
    writeFileSync(process.env.GITHUB_OUTPUT, `number=${number}\n`, { flag: 'a' });
    return;
  }
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  const number = Number(process.env.PR_NUMBER);
  const head = process.env.EXPECTED_HEAD;
  const round = Number(process.env.EXPECTED_ROUND);
  if (!Number.isSafeInteger(number) || number <= 0 || !/^[a-f0-9]{40}$/.test(head)
    || !Number.isSafeInteger(round) || round < 1 || round > 3) throw new Error('Invalid remediation context');
  const root = `/repos/${owner}/${repo}`;
  const pr = await github(`${root}/pulls/${number}`);
  if (mode === 'prepare') {
    const files = [];
    for (let page = 1; ; page += 1) {
      const batch = await github(`${root}/pulls/${number}/files?per_page=100&page=${page}`);
      files.push(...batch);
      if (batch.length < 100 || page === 30) break;
    }
    verifyRemediationPR(pr, head, files);
    const review = await github(`${root}/issues/comments/${process.env.REVIEW_COMMENT_ID}`);
    if (!review.issue_url?.endsWith(`/issues/${number}`)) throw new Error('Review belongs to another PR');
    const body = verifyReview(review, { login: process.env.CHATGPT_REVIEW_LOGIN, head, round });
    const checkout = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (checkout !== head) throw new Error('Checked-out commit differs from the reviewed head');
    const fresh = await github(`${root}/pulls/${number}`);
    verifyRemediationPR(fresh, head, files);
    // Keep feedback out of the working tree and ignore PR-supplied instructions
    // when choosing which comment constitutes the trusted review.
    writeFileSync('.git/trusted-ai-review.md', body);
  } else if (mode === 'finalize') {
    const comments = await allComments(owner, repo, number);
    const markers = trustedMarkers(comments, {
      chatgpt: process.env.CHATGPT_REVIEW_LOGIN,
      claude: process.env.CLAUDE_BOT_LOGIN,
      orchestrator: 'github-actions[bot]',
    });
    if (pr.head.sha === head && !markers.some((marker) => marker.type === 'remediation'
      && marker.status === 'blocked' && marker.reviewed_head === head && marker.round === round)) {
      await github(`${root}/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({
        body: remediationBody(head, round, 'blocked', 'Remediation finished without a new commit; human intervention is required.'),
      }) });
    }
    // GITHUB_TOKEN comments/pushes do not wake Actions. Reconcile explicitly,
    // including after a successful push, instead of relying on another event.
    await main();
  } else {
    throw new Error('Expected resolve, prepare, or finalize mode');
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  run().catch((error) => { console.error(error); process.exitCode = 1; });
}
