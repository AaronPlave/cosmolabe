/** Usage: node scripts/summarize-ask-benchmark.mjs report.json [reviews.json]
 * Prints a compact report and summary to stdout; never overwrites evidence.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compactReport, summarizeReport, reportDigest } from './ask-benchmark/report.mjs';
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const reviewFile = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : {};
const reviews = reviewFile.reviews ?? {};
if (Object.keys(reviews).length) assert.equal(reviewFile.reportSha256, reportDigest(report), 'Reviews must match the exact evidence digest; do not reuse reviews from another run');
console.log(JSON.stringify({ ...compactReport(report), review: reviewFile, summary: summarizeReport(report, reviews) }, null, 2));
