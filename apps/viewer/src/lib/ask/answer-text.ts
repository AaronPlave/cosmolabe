/**
 * The model's answer as a few safe blocks, for the Ask panel (#311).
 *
 * Models write Markdown whatever they are asked, so the panel reads a small
 * subset of it — paragraphs, `-` bullets, `**bold**`, `code`, disclosures — and shows
 * everything else as the text it is. Nothing here produces HTML: the result is
 * data the panel renders as text nodes, so an answer can never inject markup,
 * links or images.
 */
export interface AnswerSpan { readonly text: string; readonly bold?: boolean; readonly code?: boolean }
export type AnswerBlock =
  | { readonly kind: 'p'; readonly spans: readonly AnswerSpan[] }
  | { readonly kind: 'ul'; readonly items: readonly (readonly AnswerSpan[])[] }
  | { readonly kind: 'details'; readonly summary: readonly AnswerSpan[]; readonly blocks: readonly AnswerBlock[] };

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

export function parseAnswer(text: string, depth = 0): AnswerBlock[] {
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
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    }
    // Recognize only an exact, balanced disclosure envelope. Its content is
    // still parsed into text nodes, never trusted or inserted as HTML.
    if (!fence && depth < 8 && /^\s*<details>\s*$/i.test(line)) {
      let summaryIndex = i + 1;
      while (summaryIndex < lines.length && !lines[summaryIndex].trim()) summaryIndex++;
      const summary = /^\s*<summary>(.+)<\/summary>\s*$/i.exec(lines[summaryIndex] ?? '');
      let end = summaryIndex + 1, nesting = 1;
      if (summary) {
        for (; end < lines.length; end++) {
          if (/^\s*<details>\s*$/i.test(lines[end])) nesting++;
          if (/^\s*<\/details>\s*$/i.test(lines[end]) && --nesting === 0) break;
        }
        if (nesting === 0) {
          endParagraph(); endList();
          blocks.push({ kind: 'details', summary: parseInline(summary[1]), blocks: parseAnswer(lines.slice(summaryIndex + 1, end).join('\n'), depth + 1) });
          i = end;
          continue;
        }
      }
    }
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
