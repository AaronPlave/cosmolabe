/**
 * Deployment configuration for catalog discovery (issue #93).
 *
 * Everything a deployment decides about which catalogs the home screen
 * offers lives here, read from build-time environment variables:
 *
 * - `VITE_CATALOG_SOURCES` — JSON array of `{ id, name, indexUrl }`. `[]`
 *   configures no sources at all (a bare viewer or embed that relies on
 *   dropped files and `?catalog=`). Relative `indexUrl`s resolve against the
 *   viewer's base URL.
 * - `VITE_ALLOW_CATALOG_SOURCE_PARAM` — `true` lets a visitor add sources at
 *   runtime with `?source=<indexUrl>` (repeatable). Off unless enabled, since
 *   whether arbitrary external sources are acceptable is the deployment's
 *   call, not the viewer's.
 *
 * Unset is the same as `[]`: the viewer assumes no source exists, Examples
 * included. The repository's examples are listed only where a deployment
 * asks for them — the Pages workflow, and `.env.development` for
 * `npm run dev`.
 * See docs/catalog-sources.md.
 */

import { parseSourceConfig, type CatalogSourceConfig } from './catalog-sources';

export interface CatalogSourceDeployment {
  sources: CatalogSourceConfig[];
  /** Configuration problems, surfaced on the home screen rather than thrown. */
  errors: string[];
  /** URL relative `indexUrl`s resolve against. */
  baseUrl: string;
  /** Whether visitors may add sources at runtime (`?source=`, or the switcher's "Add catalog source…"). */
  allowSourceParam: boolean;
  /** Ids of the sources the deployment configured, which `?source=` ids must not clash with. */
  configuredIds: string[];
}

export interface DeploymentEnv {
  VITE_CATALOG_SOURCES?: string;
  VITE_ALLOW_CATALOG_SOURCE_PARAM?: string;
}

/**
 * Resolve the deployment's sources. Pure over its inputs so it can be tested
 * without a browser; `catalogSourceDeployment()` supplies the real ones.
 */
export function resolveCatalogSourceDeployment(
  env: DeploymentEnv,
  search: string,
  baseUrl: string,
): CatalogSourceDeployment {
  const configured = parseSourceConfig(env.VITE_CATALOG_SOURCES);
  const sources = configured.sources;
  const errors = [...configured.errors];

  const allowSourceParam = env.VITE_ALLOW_CATALOG_SOURCE_PARAM === 'true';
  const configuredIds = sources.map((s) => s.id);
  if (allowSourceParam) sources.push(...sourcesFromParams(configuredIds, sourceParamValues(search)));

  return { sources, errors, baseUrl, allowSourceParam, configuredIds };
}

/**
 * The sources a list of `?source=` values adds, with their ids.
 *
 * The one place those ids are derived. An `?entry=<sourceId>/…` link names a
 * source by id, so a source added at runtime must get exactly the id a reload
 * gives it; startup and `nextSourceParam` both call this on the same list of
 * values, so they cannot disagree. An id is `url-<n>`, `n` the value's
 * position in the list (empty values, which add nothing, still count),
 * suffixed until it clashes with no configured source or earlier value.
 */
export function sourcesFromParams(configuredIds: readonly string[], values: readonly string[]): CatalogSourceConfig[] {
  const ids = new Set(configuredIds);
  const out: CatalogSourceConfig[] = [];
  values.forEach((indexUrl, i) => {
    if (indexUrl.trim() === '') return;
    let id = `url-${i + 1}`;
    while (ids.has(id)) id = `${id}-`;
    ids.add(id);
    out.push({ id, name: indexUrl, indexUrl });
  });
  return out;
}

/** The `?source=` values of a query string, in order. */
export function sourceParamValues(search: string): string[] {
  return new URLSearchParams(search).getAll('source');
}

/** The source `indexUrl` becomes when appended to `values`, and the list it makes. */
export function nextSourceParam(
  configuredIds: readonly string[],
  values: readonly string[],
  indexUrl: string,
): { source: CatalogSourceConfig; values: string[] } {
  const next = [...values, indexUrl];
  return { source: sourcesFromParams(configuredIds, next).at(-1)!, values: next };
}

/** `search` with its `?source=` values replaced by `values`; every other parameter is kept. */
export function withSourceParams(search: string, values: readonly string[]): string {
  const params = new URLSearchParams(search);
  params.delete('source');
  for (const v of values) params.append('source', v);
  const s = params.toString().replace(/%2F/gi, '/');
  return s ? `?${s}` : '';
}

export function catalogSourceDeployment(): CatalogSourceDeployment {
  return resolveCatalogSourceDeployment(
    import.meta.env as DeploymentEnv,
    location.search,
    new URL(import.meta.env.BASE_URL, location.href).href,
  );
}
