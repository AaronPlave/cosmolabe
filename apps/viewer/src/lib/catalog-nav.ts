/**
 * Catalog navigation (issue #94): what the home screen and the catalog
 * switcher list, and how a chosen catalog is written into — and read back
 * out of — the page URL.
 *
 * Pure over its inputs, so it can be tested without a browser. Nothing here
 * knows about a source called "Examples": every list is derived from whatever
 * sources the deployment configured (#93), including none.
 */

import type { CatalogEntry, CatalogSourceState } from './catalog-sources';

/** An entry together with the source it came from. */
export interface SourcedEntry {
  sourceId: string;
  entry: CatalogEntry;
}

/** Every entry of every source that has loaded, in configuration order. */
export function allEntries(states: readonly CatalogSourceState[]): SourcedEntry[] {
  const out: SourcedEntry[] = [];
  for (const s of states) {
    if (s.status !== 'ready') continue;
    for (const entry of s.index.catalogs) out.push({ sourceId: s.source.id, entry });
  }
  return out;
}

/**
 * The home screen's short list. Entries a source marks `featured` if there are
 * any; otherwise the first few, which for a mission deployment with a handful
 * of catalogs is simply all of them.
 */
export function featuredEntries(states: readonly CatalogSourceState[], limit = 6): SourcedEntry[] {
  const all = allEntries(states);
  const featured = all.filter((e) => e.entry.featured);
  return (featured.length > 0 ? featured : all).slice(0, limit);
}

/**
 * Label for the home screen's browse action, or null when there is nothing to
 * browse. A single source is named after itself ("Browse examples"); several
 * are just catalogs.
 */
export function browseLabel(states: readonly CatalogSourceState[]): string | null {
  if (states.length === 0) return null;
  if (states.length === 1) return `Browse ${states[0].source.name.toLowerCase()}`;
  return 'Browse catalogs';
}

/**
 * Where a loaded catalog lives in the URL.
 *
 * A same-origin catalog is written as `?catalog=<path>` — the existing deep
 * link, resolved as `./<path>.json` against the page — so choosing an example
 * produces the same URL anyone would have linked by hand. A catalog on another
 * origin cannot be expressed that way, and `?catalog=` deliberately never
 * reaches off-origin, so it is written as `?entry=<sourceId>/<entryId>` and
 * only resolves against a source the deployment actually configured.
 */
export type CatalogLocation = { catalog: string } | { entry: string };

export function catalogLocation(item: SourcedEntry, pageUrl: string): CatalogLocation {
  const page = new URL(pageUrl);
  const target = new URL(item.entry.catalogUrl);
  if (target.origin === page.origin && target.pathname.endsWith('.json') && !target.search && !target.hash) {
    const rel = relativePath(page.pathname, target.pathname).replace(/\.json$/, '');
    // Round-trips through `loadDemo`'s `./<name>.json`.
    if (new URL(`./${rel}.json`, page).href === target.href) return { catalog: rel };
  }
  return { entry: `${item.sourceId}/${item.entry.id}` };
}

/** `to` relative to the directory of `from`, both absolute URL paths. */
function relativePath(from: string, to: string): string {
  const fromDir = from.split('/').slice(0, -1);
  const toParts = to.split('/');
  let i = 0;
  while (i < fromDir.length && i < toParts.length - 1 && fromDir[i] === toParts[i]) i++;
  return [...Array(fromDir.length - i).fill('..'), ...toParts.slice(i)].join('/');
}

/**
 * Find the entry an `?entry=<sourceId>/<entryId>` parameter names. Entry ids
 * may themselves contain `/` (`base/solarsys`), so the split is at the first.
 */
export function findEntry(states: readonly CatalogSourceState[], param: string): SourcedEntry | null {
  const slash = param.indexOf('/');
  if (slash <= 0) return null;
  const sourceId = param.slice(0, slash);
  const entryId = param.slice(slash + 1);
  const state = states.find((s) => s.source.id === sourceId);
  if (state?.status !== 'ready') return null;
  const entry = state.index.catalogs.find((e) => e.id === entryId);
  return entry ? { sourceId, entry } : null;
}

/** The catalog a URL asks for, if any. `?catalog=` wins over `?entry=`. */
export function requestedCatalog(search: string): CatalogLocation | null {
  const params = new URLSearchParams(search);
  const catalog = params.get('catalog');
  if (catalog) return { catalog };
  const entry = params.get('entry');
  if (entry) return { entry };
  return null;
}

/**
 * `search` with the catalog parameters replaced by `loc` — or removed, for a
 * scene the URL cannot name (dropped files). Every other parameter (`test`,
 * `source`, …) is kept.
 */
export function withCatalogLocation(search: string, loc: CatalogLocation | null): string {
  const params = new URLSearchParams(search);
  params.delete('catalog');
  params.delete('entry');
  if (loc && 'catalog' in loc) params.set('catalog', loc.catalog);
  else if (loc) params.set('entry', loc.entry);
  // `/` is legal in a query; leaving it unescaped keeps `?catalog=base/solarsys`
  // looking like the link someone would have typed.
  const s = params.toString().replace(/%2F/gi, '/');
  return s ? `?${s}` : '';
}
