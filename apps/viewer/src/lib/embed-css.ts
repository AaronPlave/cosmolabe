/**
 * Split the workspace stylesheet for a shadow root.
 *
 * Everything stays inside the shadow root — Tailwind's reset included, which
 * is the point: it must not restyle the host page — except the two rule kinds
 * that only work at document level: `@font-face` (fonts declared in a shadow
 * root are not loaded) and `@property` (custom-property registration is
 * document-global; Tailwind's shadows, rings and transforms rely on the
 * initial values it registers). Neither selects an element, so moving them
 * to the document changes nothing on the host page.
 */
export function splitShadowCss(css: string): { document: string; shadow: string } {
  const global: string[] = [];
  let shadow = '';
  let i = 0;
  while (i < css.length) {
    const start = i;
    const end = topLevelRuleEnd(css, i);
    const rule = css.slice(start, end);
    const bare = rule.replace(/^\s*(\/\*[\s\S]*?\*\/\s*)*/, '');
    if (/^@(font-face|property)\b/.test(bare)) global.push(bare.trim());
    else shadow += rule;
    i = end;
  }
  return { document: global.join('\n'), shadow };
}

/** Index just past the top-level rule (or statement) starting at `i`. */
function topLevelRuleEnd(css: string, i: number): number {
  let depth = 0;
  for (; i < css.length; i++) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close < 0 ? css.length : close + 1;
    } else if (c === '"' || c === "'") {
      for (i++; i < css.length && css[i] !== c; i++) if (css[i] === '\\') i++;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    } else if (c === ';' && depth === 0) {
      return i + 1;
    }
  }
  return css.length;
}
