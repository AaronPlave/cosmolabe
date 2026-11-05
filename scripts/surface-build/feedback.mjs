#!/usr/bin/env node
// Derive planner feedback from a matching, content-pinned publication receipt.
import { readFile, writeFile } from 'node:fs/promises';
import { publishedFeedback } from './report.mjs';
const [report, receipt, output]=process.argv.slice(2);
if(!output)throw new Error('Usage: feedback.mjs REPORT.json PUBLICATION-RECEIPT.json NEW-OUTPUT.json');
const feedback=publishedFeedback(JSON.parse(await readFile(report)),JSON.parse(await readFile(receipt)));
await writeFile(output,JSON.stringify(feedback,null,2)+'\n',{flag:'wx'});
