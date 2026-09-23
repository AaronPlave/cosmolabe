/**
 * The catalogs the viewer can open, as the home screen and the in-viewer
 * catalog switcher both see them (issue #94).
 *
 * One store rather than props threaded through the rail, because two surfaces
 * that never share a parent — the home screen and the switcher in the rail —
 * list the same sources, and a source added at runtime has to appear in both.
 */

import { fetchCatalogSource, loadCatalogSources, type CatalogSourceState } from './catalog-sources';
import { catalogSourceDeployment } from './deployment';

const deployment = catalogSourceDeployment();

export const catalogs = $state({
  /** The deployment's catalog sources — possibly none. */
  sources: [] as CatalogSourceState[],
  /** Problems with the deployment's source configuration itself. */
  configErrors: deployment.errors,
  /** Whether this deployment lets a visitor add a source at runtime. */
  allowAddSource: deployment.allowSourceParam,
  /** Catalog URL of the scene that is up, when it came from a URL rather than dropped files. */
  currentUrl: null as string | null,
  /** The last load that failed, for whichever surface is on screen to say so. */
  loadError: null as string | null,
});

let started: Promise<CatalogSourceState[]> | null = null;

/** Fetch the configured sources, once. Resolves when every one has settled. */
export function initCatalogSources(): Promise<CatalogSourceState[]> {
  started ??= loadCatalogSources(deployment.sources, deployment.baseUrl, (states) => {
    catalogs.sources = states;
  }).then((states) => {
    for (const s of states) {
      if (s.status === 'error') console.warn(`[Cosmolabe] Catalog source "${s.source.id}" unavailable: ${s.error}`);
      else if (s.status === 'ready') for (const w of s.warnings) console.warn(`[Cosmolabe] Catalog source "${s.source.id}": ${w}`);
    }
    return states;
  });
  return started;
}

/**
 * Add a source at runtime, where the deployment permits it. Recorded as
 * `?source=` so a reload — or a shared link — keeps it, which is the same
 * parameter a deployment that allows it already reads at startup.
 */
export async function addCatalogSource(indexUrl: string): Promise<CatalogSourceState> {
  const url = indexUrl.trim();
  const ids = new Set(catalogs.sources.map((s) => s.source.id));
  let id = `url-${catalogs.sources.length + 1}`;
  while (ids.has(id)) id = `${id}-`;
  const source = { id, name: url, indexUrl: url };
  catalogs.sources = [...catalogs.sources, { source, status: 'loading' }];
  const state = await fetchCatalogSource(source, deployment.baseUrl);
  catalogs.sources = catalogs.sources.map((s) => (s.source.id === id ? state : s));
  if (state.status === 'ready') {
    const params = new URLSearchParams(location.search);
    params.append('source', url);
    history.replaceState(history.state, '', `${location.pathname}?${params}${location.hash}`);
  }
  return state;
}

/**
 * Show the browser's file dialog and hand back what was chosen. A detached
 * input, so neither surface that offers "Open local catalog…" needs to own one.
 * No `accept` filter: a catalog comes with its kernels, data files, models and
 * textures, and the loader already sorts them and skips what it can't use.
 */
export function pickLocalFiles(onFiles: (files: File[]) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.addEventListener('change', () => {
    if (input.files && input.files.length > 0) onFiles(Array.from(input.files));
  });
  input.click();
}
