/**
 * Deployment configuration for catalog discovery (issue #93).
 *
 * Everything a deployment decides about which catalogs the welcome screen
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
 * When `VITE_CATALOG_SOURCES` is unset, this repository's own examples index
 * is used so `npm run dev` has something to show. That default is the only
 * place the examples are named; nothing else in the viewer knows about them.
 * See docs/catalog-sources.md.
 */

import { parseSourceConfig, type CatalogSourceConfig } from './catalog-sources';

/** The repository's example catalogs, indexed in test-catalogs/index.json. */
const REPOSITORY_DEFAULT_SOURCES: CatalogSourceConfig[] = [
  { id: 'examples', name: 'Examples', indexUrl: 'index.json' },
];

export interface CatalogSourceDeployment {
  sources: CatalogSourceConfig[];
  /** Configuration problems, surfaced on the welcome screen rather than thrown. */
  errors: string[];
  /** URL relative `indexUrl`s resolve against. */
  baseUrl: string;
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
  const configured =
    env.VITE_CATALOG_SOURCES === undefined
      ? { sources: [...REPOSITORY_DEFAULT_SOURCES], errors: [] }
      : parseSourceConfig(env.VITE_CATALOG_SOURCES);
  const sources = configured.sources;
  const errors = [...configured.errors];

  if (env.VITE_ALLOW_CATALOG_SOURCE_PARAM === 'true') {
    const ids = new Set(sources.map((s) => s.id));
    new URLSearchParams(search).getAll('source').forEach((indexUrl, i) => {
      if (indexUrl.trim() === '') return;
      let id = `url-${i + 1}`;
      while (ids.has(id)) id = `${id}-`;
      ids.add(id);
      sources.push({ id, name: indexUrl, indexUrl });
    });
  }

  return { sources, errors, baseUrl };
}

export function catalogSourceDeployment(): CatalogSourceDeployment {
  return resolveCatalogSourceDeployment(
    import.meta.env as DeploymentEnv,
    location.search,
    new URL(import.meta.env.BASE_URL, location.href).href,
  );
}
