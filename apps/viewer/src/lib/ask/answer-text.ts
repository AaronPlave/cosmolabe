/**
 * The model's answer as a few safe blocks, for the Ask panel (#311).
 *
 * Models write Markdown whatever they are asked, so the panel reads a small
 * subset of it — paragraphs, `-` bullets, `**bold**`, `code` — and shows
 * everything else as the text it is. Nothing here produces HTML: the result is
 * data the panel renders as text nodes, so an answer can never inject markup,
 * links or images.
 */
export interface AnswerSpan { readonly text: string; readonly bold?: boolean; readonly code?: boolean }
export type AnswerBlock =
  | { readonly kind: 'p'; readonly spans: readonly AnswerSpan[] }
  | { readonly kind: 'ul'; readonly items: readonly (readonly AnswerSpan[])[] };

/** `**bold**` and `code` within one line. A marker with no partner stays as typed. */
export function parseInline(line: string): AnswerSpan[] {
  const spans: AnswerSpan[] = [];
  const pattern = /\*\*([^*\n]+?)\*\*|`([^`\n]+)`/g;
  let last = 0;
  for (let m = pattern.exec(line); m; m = pattern.exec(line)) {
    if (m.index > last) spans.push({ text: line.slice(last, m.index) });
    spans.push(m[1] !== undefined ? { text: m[1], bold: true } : { text: m[2], code: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) spans.push({ text: line.slice(last) });
  return spans;
}

// A bullet is `-` or `•` (with or without the space models sometimes drop) or `* `.
const BULLET = /^\s*(?:[-•]\s*|\*\s+)(\S.*)$/;
const HEADING = /^\s*#{1,6}\s+(\S.*)$/;

export function parseAnswer(text: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let paragraph: string[] = [];
  let items: AnswerSpan[][] = [];
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ kind: 'p', spans: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };
  const endList = () => {
    if (items.length) blocks.push({ kind: 'ul', items });
    items = [];
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') { endParagraph(); endList(); continue; }
    const bullet = BULLET.exec(line);
    if (bullet) { endParagraph(); items.push(parseInline(bullet[1])); continue; }
    const heading = HEADING.exec(line);
    endList();
    if (heading) { endParagraph(); blocks.push({ kind: 'p', spans: [{ text: heading[1], bold: true }] }); continue; }
    paragraph.push(line);
  }
  endParagraph();
  endList();
  return blocks;
}
