import { describe, expect, it } from 'vitest';
import { parseAnswer, parseInline } from '../ask/answer-text';

describe('the Ask answer as safe blocks', () => {
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
