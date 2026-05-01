/**
 * Minimal SPICE meta-kernel (.tm) parser.
 *
 * Meta-kernels are text files with `\begindata` ... `\begintext` blocks.
 * We extract three keywords from the data block:
 *   - PATH_VALUES   = ( 'foo', 'bar' )
 *   - PATH_SYMBOLS  = ( 'KERNELS', 'EXTRA' )
 *   - KERNELS_TO_LOAD = ( '$KERNELS/lsk/naif0012.tls', ... )
 *
 * After parsing, `$SYMBOL` references in KERNELS_TO_LOAD are substituted by
 * looking up the matching PATH_VALUE. The result is a flat list of relative
 * paths (resolved against the meta-kernel's URL by the caller).
 *
 * What we don't do: comments inside data blocks, line-continuation rules
 * beyond what SPICE actually requires, KEEP / EXCLUDE directives. These are
 * rare in practice and yield warnings if encountered.
 */

export interface MetaKernel {
  pathValues: string[];
  pathSymbols: string[];
  kernels: string[];
}

export function parseMetaKernel(text: string): MetaKernel {
  // Restrict to `\begindata` ... `\begintext` (or end-of-file) regions only.
  // SPICE allows multiple data blocks; concatenate them.
  const dataChunks: string[] = [];
  const re = /\\begindata([\s\S]*?)(?=\\begintext|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    dataChunks.push(match[1]);
  }
  const data = dataChunks.length > 0 ? dataChunks.join('\n') : text;

  const pathValues = extractStringList(data, 'PATH_VALUES');
  const pathSymbols = extractStringList(data, 'PATH_SYMBOLS');
  const rawKernels = extractStringList(data, 'KERNELS_TO_LOAD');

  const subst = new Map<string, string>();
  const n = Math.min(pathValues.length, pathSymbols.length);
  for (let i = 0; i < n; i++) subst.set(pathSymbols[i], pathValues[i]);

  const kernels = rawKernels.map(k => substituteSymbols(k, subst));

  return { pathValues, pathSymbols, kernels };
}

function extractStringList(data: string, keyword: string): string[] {
  // KEYWORD = ( 'a' 'b' ... ) — strings can be on multiple lines, use single quotes.
  const re = new RegExp(String.raw`${keyword}\s*=\s*\(([\s\S]*?)\)`, 'i');
  const m = data.match(re);
  if (!m) return [];
  const body = m[1];
  const items: string[] = [];
  const strRe = /'([^']*)'/g;
  let sm: RegExpExecArray | null;
  while ((sm = strRe.exec(body))) items.push(sm[1]);
  return items;
}

function substituteSymbols(s: string, subst: Map<string, string>): string {
  return s.replace(/\$([A-Z_][A-Z0-9_]*)/gi, (whole, name) => subst.get(name) ?? whole);
}
