/** Selected files retain their paths; lookup never manufactures basename aliases. */
const droppedPaths = new WeakMap<File, string>();
export function rememberLocalFilePath(file: File, path: string): void { droppedPaths.set(file, path); }

/** Selection-wide provenance survives partitioning catalogs and assets into separate maps.
 * Synthetic identities for duplicate flat filenames are not physical directory paths.
 */
export class LocalFileMap<T> extends Map<string, T> {
  constructor(readonly hasDirectoryPaths: boolean) { super(); }
}

export function normalizeLocalPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part !== '..' || !path.startsWith('/')) parts.push(part);
  }
  return parts.join('/');
}

/** Flat multi-file selections can contain the same filename twice. Give both unique identities. */
export function selectedFilePaths(files: readonly File[]): { paths: string[]; hasDirectoryPaths: boolean } {
  const hasDirectoryPaths = files.some(file => normalizeLocalPath(droppedPaths.get(file) || file.webkitRelativePath || '').includes('/'));
  const paths = files.map(file => normalizeLocalPath(droppedPaths.get(file) || file.webkitRelativePath || file.name));
  const counts = new Map<string, number>();
  for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);
  const used = new Set(paths);
  const identities = paths.map((path, index) => {
    if (counts.get(path) === 1) return path;
    let unique = `@selection/${index}/${path}`;
    while (used.has(unique)) unique = `@${unique}`;
    used.add(unique);
    return unique;
  });
  return { paths: identities, hasDirectoryPaths };
}

export function resolveLocalFile<T>(
  files: ReadonlyMap<string, T>, reference: string, declaringCatalog = '',
): { path: string; value: T } {
  const directory = declaringCatalog.split('/').slice(0, -1).join('/');
  const target = normalizeLocalPath(reference.startsWith('/') ? reference : `${directory}/${reference}`);
  if (files.has(target)) return { path: target, value: files.get(target)! };
  // Plain maps remain accepted for callers outside the categorizer. Directory
  // keys or a directory-scoped catalog provide path information in that case.
  const hasDirectoryPaths = files instanceof LocalFileMap ? files.hasDirectoryPaths
    : declaringCatalog.includes('/') || [...files.keys()].some(path => path.includes('/'));
  if (hasDirectoryPaths) {
    throw new Error(`Local source missing: "${target}" (requested "${reference}" from "${declaringCatalog || 'selected files'}"); basename fallback is disabled for directory selections`);
  }
  const basename = reference.split('/').at(-1);
  const matches = [...files].filter(([path]) => path.split('/').at(-1) === basename);
  if (matches.length === 1) return { path: matches[0][0], value: matches[0][1] };
  throw new Error(`Local source ${matches.length ? 'ambiguous' : 'missing'}: "${reference}" from "${declaringCatalog || 'selected files'}"`);
}
