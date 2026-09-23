/**
 * Catalog sources and catalog indexes (issue #93).
 *
 * A deployment advertises the catalogs it offers through zero or more
 * *sources*. Each source points at an *index*: a small, versioned JSON file
 * of discovery metadata whose entries point at ordinary Cosmographia-style
 * catalog JSON. The index is not a scene format — it names top-level choices
 * and nothing else. Each catalog still owns its dependency graph through its
 * own `require` array, and loading an entry is exactly the same as loading
 * that catalog directly.
 *
 * Cosmographia has no equivalent of this layer (it opens individual catalog
 * files), so it is Cosmolabe-specific and additive. Nothing here reaches the
 * renderer or the core catalog semantics: the viewer turns an entry into a
 * catalog URL and hands that to the normal loader.
 *
 * Format reference: docs/catalog-sources.md.
 */

/** The index format this viewer reads. Bumped only for incompatible changes. */
export const CATALOG_INDEX_VERSION = 1;

/** One deployment-configured source. */
export interface CatalogSourceConfig {
  /** Stable identifier, unique among the deployment's sources. */
  id: string;
  /** Display name. */
  name: string;
  /** URL of the source's index. Relative URLs resolve against the viewer's base URL. */
  indexUrl: string;
}

/** One entry of an index, after validation, with its catalog URL made absolute. */
export interface CatalogEntry {
  /** Identifier, unique within its index. */
  id: string;
  /** Display name. */
  name: string;
  /** Absolute URL of the entry-point catalog, resolved against the index URL. */
  catalogUrl: string;
  /** Optional one-line description. */
  description?: string;
  /** Optional heading the entry is listed under. */
  group?: string;
  /** Listed on the home screen's short "start with" list. */
  featured?: boolean;
}

/** A validated index. */
export interface CatalogIndex {
  version: number;
  name?: string;
  description?: string;
  catalogs: CatalogEntry[];
}

/**
 * The state of one source as the UI sees it. A source that failed carries its
 * error and nothing else: one bad source never takes the others, or direct and
 * local loading, down with it.
 */
export type CatalogSourceState =
  | { source: CatalogSourceConfig; status: 'loading' }
  | { source: CatalogSourceConfig; status: 'ready'; index: CatalogIndex; indexUrl: string; warnings: string[] }
  | { source: CatalogSourceConfig; status: 'error'; indexUrl: string; error: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * Validate a deployment's source list.
 *
 * Accepts either the parsed array or the raw JSON text (as it arrives from an
 * environment variable). An invalid source is dropped with an error rather
 * than failing the list, for the same reason a failed index is isolated.
 */
export function parseSourceConfig(raw: unknown): { sources: CatalogSourceConfig[]; errors: string[] } {
  const errors: string[] = [];
  let value = raw;
  if (typeof value === 'string') {
    if (value.trim() === '') return { sources: [], errors };
    try {
      value = JSON.parse(value);
    } catch (err) {
      return { sources: [], errors: [`Catalog source configuration is not valid JSON: ${(err as Error).message}`] };
    }
  }
  if (value == null) return { sources: [], errors };
  if (!Array.isArray(value)) {
    return { sources: [], errors: ['Catalog source configuration must be an array of sources'] };
  }

  const sources: CatalogSourceConfig[] = [];
  const ids = new Set<string>();
  value.forEach((s, i) => {
    if (!isObject(s) || !isNonEmptyString(s.id) || !isNonEmptyString(s.indexUrl)) {
      errors.push(`Catalog source #${i + 1} needs a string "id" and "indexUrl"`);
      return;
    }
    if (ids.has(s.id)) {
      errors.push(`Catalog source id "${s.id}" is used more than once`);
      return;
    }
    ids.add(s.id);
    sources.push({ id: s.id, name: isNonEmptyString(s.name) ? s.name : s.id, indexUrl: s.indexUrl });
  });
  return { sources, errors };
}

/**
 * Validate a parsed index and resolve its catalog URLs against `indexUrl`.
 *
 * Whole-index problems (not an object, missing or unsupported `version`, no
 * `catalogs` array) throw. A single malformed or duplicate entry is dropped
 * with a warning, so one typo doesn't hide a source's other catalogs.
 */
export function parseCatalogIndex(json: unknown, indexUrl: string): { index: CatalogIndex; warnings: string[] } {
  if (!isObject(json)) throw new Error('Catalog index must be a JSON object');
  if (json.version === undefined) throw new Error('Catalog index is missing "version"');
  if (json.version !== CATALOG_INDEX_VERSION) {
    throw new Error(
      `Unsupported catalog index version ${JSON.stringify(json.version)} (this viewer reads version ${CATALOG_INDEX_VERSION})`,
    );
  }
  if (!Array.isArray(json.catalogs)) throw new Error('Catalog index is missing a "catalogs" array');

  const warnings: string[] = [];
  const catalogs: CatalogEntry[] = [];
  const ids = new Set<string>();
  json.catalogs.forEach((e, i) => {
    if (!isObject(e) || !isNonEmptyString(e.id) || !isNonEmptyString(e.catalog)) {
      warnings.push(`Entry #${i + 1} needs a string "id" and "catalog"; skipped`);
      return;
    }
    if (ids.has(e.id)) {
      warnings.push(`Entry id "${e.id}" is used more than once; later one skipped`);
      return;
    }
    let catalogUrl: string;
    try {
      catalogUrl = new URL(e.catalog, indexUrl).href;
    } catch {
      warnings.push(`Entry "${e.id}" has an invalid catalog URL; skipped`);
      return;
    }
    ids.add(e.id);
    const entry: CatalogEntry = { id: e.id, name: isNonEmptyString(e.name) ? e.name : e.id, catalogUrl };
    if (isNonEmptyString(e.description)) entry.description = e.description;
    if (isNonEmptyString(e.group)) entry.group = e.group;
    if (e.featured === true) entry.featured = true;
    catalogs.push(entry);
  });

  const index: CatalogIndex = { version: json.version, catalogs };
  if (isNonEmptyString(json.name)) index.name = json.name;
  if (isNonEmptyString(json.description)) index.description = json.description;
  return { index, warnings };
}

export type IndexFetcher = (url: string) => Promise<unknown>;

const defaultFetcher: IndexFetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // A missing file often comes back 200 as an HTML fallback page; say that
  // plainly rather than surfacing the JSON parser's complaint about `<`.
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('response is not JSON');
  }
};

/**
 * Fetch and validate one source's index. Never rejects: any failure becomes
 * an `error` state, which is what keeps sources independent of each other.
 */
export async function fetchCatalogSource(
  source: CatalogSourceConfig,
  baseUrl: string,
  fetcher: IndexFetcher = defaultFetcher,
): Promise<CatalogSourceState> {
  let indexUrl = source.indexUrl;
  try {
    indexUrl = new URL(source.indexUrl, baseUrl).href;
    const json = await fetcher(indexUrl);
    const { index, warnings } = parseCatalogIndex(json, indexUrl);
    return { source, status: 'ready', index, indexUrl, warnings };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { source, status: 'error', indexUrl, error: message };
  }
}

/**
 * Load every source concurrently, reporting each one as it settles so a slow
 * source doesn't hold back a fast one. Resolves with the final states, in
 * configuration order.
 */
export async function loadCatalogSources(
  sources: CatalogSourceConfig[],
  baseUrl: string,
  onUpdate?: (states: CatalogSourceState[]) => void,
  fetcher?: IndexFetcher,
): Promise<CatalogSourceState[]> {
  const states: CatalogSourceState[] = sources.map((source) => ({ source, status: 'loading' }));
  onUpdate?.([...states]);
  await Promise.all(
    sources.map(async (source, i) => {
      states[i] = await fetchCatalogSource(source, baseUrl, fetcher);
      onUpdate?.([...states]);
    }),
  );
  return states;
}

/** An index's entries grouped by `group`, in first-appearance order. Ungrouped entries share one untitled group. */
export function groupEntries(entries: CatalogEntry[]): { heading?: string; entries: CatalogEntry[] }[] {
  const groups = new Map<string | undefined, CatalogEntry[]>();
  for (const e of entries) {
    const list = groups.get(e.group);
    if (list) list.push(e);
    else groups.set(e.group, [e]);
  }
  return [...groups].map(([heading, list]) => ({ heading, entries: list }));
}
