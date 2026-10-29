/** Replace only a root property's value, retaining all other JSON bytes. */
export function replaceRootProperty(text, key, value) {
  const catalog = JSON.parse(text);
  if (!catalog || Array.isArray(catalog) || typeof catalog !== 'object') throw new Error('Expected a catalog object');
  const replacement = JSON.stringify(value, null, 2).replace(/\n/g, '\n  ');
  // JSON strings are atomic tokens: braces, commas and escaped quotes inside them
  // must never affect nesting or root-property recognition.
  const tokens = [...text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i][0];
    if (depth === 1 && token.startsWith('"') && tokens[i + 1]?.[0] === ':' && JSON.parse(token) === key) {
      const start = tokens[i + 2].index;
      let nested = 0;
      let j = i + 2;
      for (; j < tokens.length; j++) {
        const t = tokens[j][0];
        if (nested === 0 && (t === ',' || t === '}')) break;
        if (t === '{' || t === '[') nested++;
        if (t === '}' || t === ']') nested--;
      }
      const last = tokens[j - 1];
      return text.slice(0, start) + replacement + text.slice(last.index + last[0].length);
    }
    if (token === '{' || token === '[') depth++;
    if (token === '}' || token === ']') depth--;
  }
  const end = text.lastIndexOf('}');
  return text.slice(0, end).trimEnd() + (Object.keys(catalog).length ? ',' : '') + `\n  ${JSON.stringify(key)}: ${replacement}\n` + text.slice(end);
}
