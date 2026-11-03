import { describe, expect, it } from 'vitest';
import { parseAnswer, parseInline } from '../ask/answer-text';

describe('the Ask answer as safe blocks', () => {
  it('renders a balanced details envelope as a disclosure with safe text content', () => {
    expect(parseAnswer("No eclipse coverage.\n<details>\n<summary>Details</summary>\nQueried **Psyche**.\n\n- No search ran.\n</details>\nEarlier result stands.")).toEqual([
      { kind: 'p', spans: [{ text: 'No eclipse coverage.' }] },
      { kind: 'details', summary: [{ text: 'Details' }], blocks: [
        { kind: 'p', spans: [{ text: 'Queried ' }, { text: 'Psyche', bold: true }, { text: '.' }] },
        { kind: 'ul', items: [[{ text: 'No search ran.' }]] },
      ] },
      { kind: 'p', spans: [{ text: 'Earlier result stands.' }] },
    ]);
  });

  it('keeps arbitrary HTML and attributes inert inside and outside disclosures', () => {
    const body = '<img src=x onerror=alert(1)><script>bad()</script>';
    const blocks = parseAnswer(`<details>\n<summary>${body}</summary>\n${body}\n</details>`);
    expect(blocks).toEqual([{ kind: 'details', summary: [{ text: body }], blocks: [{ kind: 'p', spans: [{ text: body }] }] }]);
    for (const text of [
      '<details onclick="bad()">\n<summary>Details</summary>\nText\n</details>',
      '<details>\n<summary onclick="bad()">Details</summary>\nText\n</details>',
      '<details>\n<summary>Details</summary>\nUnclosed',
      '```html\n<details>\n<summary>Details</summary>\nExample\n</details>\n```',
    ]) expect(parseAnswer(text).every(b => b.kind !== 'details')).toBe(true);
  });

  it('balances nested disclosures and accepts surrounding blank lines', () => {
    const blocks = parseAnswer('<details>\n\n<summary>Outer</summary>\n<details>\n<summary>Inner</summary>\nText\n</details>\n</details>');
    expect(blocks).toEqual([{ kind: 'details', summary: [{ text: 'Outer' }], blocks: [
      { kind: 'details', summary: [{ text: 'Inner' }], blocks: [{ kind: 'p', spans: [{ text: 'Text' }] }] },
    ] }]);
  });

  it('reads bold and code, and leaves an unmatched marker as typed', () => {
    expect(parseInline('Flew to **Airfield B** at `ingenuity:flight:5`.')).toEqual([
      { text: 'Flew to ' }, { text: 'Airfield B', bold: true }, { text: ' at ' }, { text: 'ingenuity:flight:5', code: true }, { text: '.' },
    ]);
    expect(parseInline('2 ** 3 and a lone `tick')).toEqual([{ text: '2 ** 3 and a lone `tick' }]);
  });

  it('turns the bullets a model packs together into a list, even without the space after the dash', () => {
    const blocks = parseAnswer('Four layers:\n-**Global · Viking**: base, 232 m/px\n- **CTX**: overlay\n* HiRISE');
    expect(blocks).toEqual([
      { kind: 'p', spans: [{ text: 'Four layers:' }] },
      { kind: 'ul', items: [
        [{ text: 'Global · Viking', bold: true }, { text: ': base, 232 m/px' }],
        [{ text: 'CTX', bold: true }, { text: ': overlay' }],
        [{ text: 'HiRISE' }],
      ] },
    ]);
  });

  it('keeps a line that merely starts with bold as a paragraph, and headings as bold text', () => {
    expect(parseAnswer('**Note** this is estimated.')).toEqual([{ kind: 'p', spans: [{ text: 'Note', bold: true }, { text: ' this is estimated.' }] }]);
    expect(parseAnswer('## Imagery\nThree layers.')).toEqual([{ kind: 'p', spans: [{ text: 'Imagery', bold: true }] }, { kind: 'p', spans: [{ text: 'Three layers.' }] }]);
  });

  it('separates paragraphs on blank lines and never produces markup', () => {
    const blocks = parseAnswer('One.\n\nTwo <img src=x onerror=alert(1)> [link](http://evil)\r\nstill two.');
    expect(blocks).toHaveLength(2);
    // Markup, links and images stay text: the panel renders spans as text nodes.
    expect(JSON.stringify(blocks)).toContain('<img src=x onerror=alert(1)> [link](http://evil)');
    expect(parseAnswer('')).toEqual([]);
  });
});
