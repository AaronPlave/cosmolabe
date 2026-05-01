/**
 * Resolve a catalog URL into a topologically ordered list of catalogs by
 * walking the `require` graph, fetching each unique URL exactly once, and
 * resolving relative paths against each catalog's own URL.
 *
 * The order is parents-before-children — i.e. dependencies appear before the
 * catalogs that require them. Combined with `Universe.loadCatalog`'s
 * last-wins-by-name semantics, this lets a consumer's catalog override any
 * body brought in via `require` simply by declaring an item with the same name.
 *
 * Kernel refs (`spiceKernels`) are collected during the same walk and returned
 * with absolute URLs, de-duplicated. The viewer pipeline furnishes them.
 */

import type { CatalogJson, KernelRef } from './CatalogLoader.js';
import { collectKernelRefs } from './CatalogLoader.js';

export interface ResolvedCatalog {
  /** Absolute URL the catalog was fetched from. */
  url: string;
  /** Parsed catalog JSON. */
  json: CatalogJson;
}

export interface ResolvedKernel {
  /** Absolute URL of the kernel. */
  url: string;
  /** Optional size hint (bytes) for progress reporting. */
  size?: number;
  /** Optional human-readable label. */
  label?: string;
}

export interface ResolvedCatalogGraph {
  /** Catalogs ordered parents-first (`require` dependencies before dependents). */
  catalogs: ResolvedCatalog[];
  /** Unique kernels across all catalogs, in first-seen order. */
  kernels: ResolvedKernel[];
}

export type CatalogFetcher = (url: string) => Promise<CatalogJson>;

const defaultFetcher: CatalogFetcher = async (url) => {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch catalog: ${url} (${resp.status})`);
  return resp.json() as Promise<CatalogJson>;
};

/**
 * Fetch a catalog by URL and recursively resolve its `require` dependencies.
 *
 * @param entryUrl Absolute or relative URL of the entry-point catalog.
 *                 If relative, resolved against `globalThis.location.href`
 *                 (browser) or the current working directory in Node tests
 *                 (caller should pass an absolute URL there).
 * @param fetcher  Optional injectable fetcher (for tests). Defaults to `fetch`.
 */
export async function loadCatalogFromUrl(
  entryUrl: string,
  fetcher: CatalogFetcher = defaultFetcher,
): Promise<ResolvedCatalogGraph> {
  const baseHref = typeof location !== 'undefined' ? location.href : 'file:///';
  const entryAbs = new URL(entryUrl, baseHref).href;

  const catalogs: ResolvedCatalog[] = [];
  const visited = new Set<string>();
  const stack = new Set<string>(); // for cycle detection

  async function visit(absUrl: string, requirePath: string[]): Promise<void> {
    if (visited.has(absUrl)) return;
    if (stack.has(absUrl)) {
      throw new Error(
        `Catalog require cycle detected: ${[...requirePath, absUrl].join(' -> ')}`,
      );
    }
    stack.add(absUrl);

    const json = await fetcher(absUrl);

    if (json.require) {
      for (const req of json.require) {
        const reqAbs = new URL(req, absUrl).href;
        await visit(reqAbs, [...requirePath, absUrl]);
      }
    }

    stack.delete(absUrl);
    visited.add(absUrl);
    catalogs.push({ url: absUrl, json });
  }

  await visit(entryAbs, []);

  // Aggregate kernels from every catalog, resolving paths relative to that
  // catalog's URL, de-duplicating by absolute URL (first-seen wins for metadata).
  const kernels: ResolvedKernel[] = [];
  const seenKernels = new Set<string>();
  for (const { url: catalogUrl, json } of catalogs) {
    for (const ref of collectKernelRefs(json)) {
      const resolved = resolveKernelRef(ref, catalogUrl);
      if (seenKernels.has(resolved.url)) continue;
      seenKernels.add(resolved.url);
      kernels.push(resolved);
    }
  }

  return { catalogs, kernels };
}

function resolveKernelRef(ref: KernelRef, baseUrl: string): ResolvedKernel {
  if (typeof ref === 'string') {
    return { url: new URL(ref, baseUrl).href };
  }
  return {
    url: new URL(ref.url, baseUrl).href,
    size: ref.size,
    label: ref.label,
  };
}
