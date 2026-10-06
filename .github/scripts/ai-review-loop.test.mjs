import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMarker, reconcile, requestBody } from './ai-review-loop.mjs';

const sha = (digit) => digit.repeat(40);
const trusted = { chatgpt: 'chatgpt-bot', claude: 'claude-bot', orchestrator: 'github-actions[bot]' };
const pr = (labels = ['review:chatgpt', 'agent:claude'], head = sha('a')) => ({
  state: 'open', draft: false, labels: labels.map((name) => ({ name })),
  head: { sha: head, repo: { full_name: 'AaronPlave/cosmolabe' } },
  base: { repo: { full_name: 'AaronPlave/cosmolabe' } },
});
const comment = (body, login, id = 1) => ({ body, id, user: { login } });
const review = (head, round, status) => `<!-- ai-loop:review {"schema":1,"head":"${head}","round":${round},"status":"${status}"} -->`;

test('parses only valid exact JSON protocol markers', () => {
  assert.deepEqual(parseMarker(requestBody(sha('a'), 1, 2)), {
    type: 'request', schema: 1, head: sha('a'), round: 1, attempt: 2,
  });
  assert.equal(parseMarker('<!-- ai-loop:review not-json -->'), null);
  assert.equal(parseMarker(`<!-- ai-loop:review {"schema":1,"head":"short","round":1,"status":"clean"} -->`), null);
  assert.equal(parseMarker(`quoted output\n${requestBody(sha('a'), 1, 2)}`), null);
});

test('requests each eligible head once and retries by attempt without consuming a round', () => {
  const first = reconcile({ pr: pr(), comments: [], trusted });
  assert.deepEqual({ action: first.action, round: first.round, attempt: first.attempt }, { action: 'request', round: 1, attempt: 1 });
  const comments = [comment(requestBody(sha('a'), 1, 1), trusted.orchestrator)];
  assert.equal(reconcile({ pr: pr(), comments, trusted }).action, 'none');
  assert.deepEqual(reconcile({ pr: pr(), comments, trusted, retry: true }).attempt, 2);
});

test('ignores marker-shaped comments from untrusted authors', () => {
  const result = reconcile({
    pr: pr(), comments: [comment(review(sha('a'), 1, 'clean'), 'attacker')], trusted,
  });
  assert.equal(result.action, 'request');
});

test('direction gate removes queue and test labels without requesting review', () => {
  const result = reconcile({ pr: pr(['review:direction', 'review:chatgpt', 'ready:test', 'agent:claude']), comments: [], trusted });
  assert.equal(result.action, 'labels');
  assert.deepEqual(new Set(result.remove), new Set(['review:chatgpt', 'ready:test']));
});

test('clean review moves a PR to human test', () => {
  const result = reconcile({ pr: pr(), comments: [comment(review(sha('a'), 1, 'clean'), trusted.chatgpt)], trusted });
  assert.equal(result.action, 'labels');
  assert.deepEqual(result.add, ['ready:test']);
  assert.deepEqual(result.remove, ['review:chatgpt']);
});

test('blocking Claude review starts remediation exactly once', () => {
  const comments = [comment(review(sha('a'), 1, 'changes_requested'), trusted.chatgpt, 7)];
  const result = reconcile({ pr: pr(), comments, trusted });
  assert.deepEqual({ action: result.action, round: result.round, reviewCommentId: result.reviewCommentId },
    { action: 'remediate', round: 1, reviewCommentId: 7 });
  comments.push(comment(`<!-- ai-loop:remediation {"schema":1,"reviewed_head":"${sha('a')}","round":1,"status":"started"} -->`, trusted.orchestrator));
  assert.equal(reconcile({ pr: pr(), comments, trusted }).action, 'none');
});

test('Codex blockers and a third review stop for a human', () => {
  const codex = reconcile({ pr: pr(['review:chatgpt', 'agent:codex']), comments: [comment(review(sha('a'), 1, 'changes_requested'), trusted.chatgpt)], trusted });
  assert.equal(codex.action, 'stop');
  const third = reconcile({ pr: pr(), comments: [comment(review(sha('a'), 3, 'changes_requested'), trusted.chatgpt)], trusted });
  assert.equal(third.action, 'stop');
  assert.deepEqual(third.add, ['needs:human']);
});

test('a new commit invalidates ready:test and queues its next round', () => {
  const comments = [comment(review(sha('a'), 1, 'clean'), trusted.chatgpt)];
  const result = reconcile({ pr: pr(['ready:test', 'agent:claude'], sha('b')), comments, trusted });
  assert.equal(result.action, 'request');
  assert.equal(result.round, 2);
  assert.deepEqual(result.add, ['review:chatgpt']);
  assert.deepEqual(result.remove, ['ready:test']);
});

test('resume creates a new episode boundary', () => {
  const comments = [1, 2, 3].map((round, index) => comment(review(sha(String(round)), round, 'changes_requested'), trusted.chatgpt, index));
  const stopped = reconcile({ pr: pr(['review:chatgpt', 'agent:claude'], sha('4')), comments, trusted });
  assert.equal(stopped.action, 'stop');
  assert.equal(reconcile({ pr: pr(['needs:human', 'agent:claude'], sha('4')), comments, trusted, resume: true }).action, 'resume');
});

test('needs:human is stable until explicit resume', () => {
  const result = reconcile({
    pr: pr(['needs:human', 'agent:claude']),
    comments: [comment(review(sha('a'), 3, 'changes_requested'), trusted.chatgpt)],
    trusted,
  });
  assert.equal(result.action, 'none');
});
