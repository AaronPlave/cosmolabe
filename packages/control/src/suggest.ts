/**
 * "did you mean …?" — the only place a case-folded comparison happens.
 *
 * Verb names are case-sensitive and object names are passed verbatim, because
 * `Universe.getBody` is an exact-match lookup on a `Map` and a case-folding
 * resolver here would invent one that does not exist anywhere else. The fold
 * runs only to build the suggestion after the exact lookup has already failed,
 * which is why `gotoobject` reports a typo rather than silently working.
 */

/** Levenshtein distance, capped: anything past `max` is reported as `max + 1`. */
function distance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[b.length];
}

/**
 * The closest candidate to `input`, or undefined if nothing is close enough.
 *
 * "Close enough" scales with the length of what was typed: one edit for a short
 * name, up to three for a long one. A suggestion that is not actually the word
 * the author meant is worse than none — it sends them looking for a verb that
 * does something else.
 */
export function suggest(input: string, candidates: Iterable<string>): string | undefined {
  const max = Math.min(3, Math.max(1, Math.floor(input.length / 3)));
  const lower = input.toLowerCase();

  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    // A pure case difference is the commonest miss (`gotoobject`), and it should
    // always win over a same-distance edit elsewhere in the word.
    const score =
      candidate.toLowerCase() === lower ? 0 : distance(lower, candidate.toLowerCase(), max);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore <= max ? best : undefined;
}

/** ` (did you mean "gotoObject"?)`, or the empty string when nothing is close. */
export function suggestionSuffix(input: string, candidates: Iterable<string>): string {
  const hit = suggest(input, candidates);
  return hit === undefined ? '' : ` (did you mean ${JSON.stringify(hit)}?)`;
}
