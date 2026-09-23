/**
 * The catalogs the viewer can open, as the home screen and the in-viewer
 * catalog switcher both see them (issue #94).
 *
 * One store rather than props threaded through the rail, because two surfaces
 * that never share a parent — the home screen and the switcher in the rail —
 * list the same sources, and a source added at runtime has to appear in both.
 */

import { fetchCatalogSource, loadCatalogSources, type CatalogSourceState } from './catalog-sources';
import {
  catalogSourceDeployment, nextSourceParam, sourceParamValues, withSourceParams,
} from './deployment';

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
    for (const state of states) {
      if (state.status === 'loading') continue;
      settled.get(state.source.id)?.(state);
      settled.delete(state.source.id);
    }
  }).then((states) => {
    for (const s of states) {
      if (s.status === 'error') console.warn(`[Cosmolabe] Catalog source "${s.source.id}" unavailable: ${s.error}`);
      else if (s.status === 'ready') for (const w of s.warnings) console.warn(`[Cosmolabe] Catalog source "${s.source.id}": ${w}`);
    }
    return states;
  });
  return started;
}

const settled = new Map<string, (state: CatalogSourceState) => void>();

/**
 * One configured source's state once it has loaded or failed — without
 * waiting on any other source, so a slow or hung source elsewhere never holds
 * up a link into this one. Null for an id the deployment does not configure.
 * Call after `initCatalogSources`.
 */
export function sourceSettled(id: string): Promise<CatalogSourceState | null> {
  const current = catalogs.sources.find((s) => s.source.id === id);
  if (current && current.status !== 'loading') return Promise.resolve(current);
  if (!deployment.sources.some((s) => s.id === id)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const prev = settled.get(id);
    settled.set(id, (state) => {
      prev?.(state);
      resolve(state);
    });
  });
}

/**
 * The `?source=` values this session's param sources were derived from —
 * those in the URL at startup, plus any added since. Their ids come from this
 * list alone (`sourcesFromParams`), and `syncSourceParams` keeps every URL the
 * viewer lands on carrying it, so a reload always rebuilds the same ids.
 */
let sourceParams: string[] = deployment.allowSourceParam ? sourceParamValues(location.search) : [];

/**
 * Put this session's `?source=` values back on the current URL if it lacks
 * them — as a history entry from before a source was added does. Call on
 * every history navigation, before reading the URL.
 */
export function syncSourceParams(): void {
  if (!deployment.allowSourceParam) return;
  if (JSON.stringify(sourceParamValues(location.search)) === JSON.stringify(sourceParams)) return;
  history.replaceState(history.state, '', `${location.pathname}${withSourceParams(location.search, sourceParams)}${location.hash}`);
}

/**
 * Add a source at runtime, where the deployment permits it. Recorded as
 * `?source=` so a reload — or a shared link — keeps it, which is the same
 * parameter a deployment that allows it already reads at startup, and with
 * the id startup will give it, so an `?entry=` link into it survives.
 *
 * A source that fails to load is dropped again rather than kept: it is never
 * written to the URL or the list ids derive from, so keeping it would leave a
 * live source a reload does not have. The switcher reports the error.
 */
export function addCatalogSource(indexUrl: string): Promise<CatalogSourceState> {
  // One at a time: each addition's id depends on the list the one before it
  // leaves, so two in flight at once would both claim the same next id.
  const run = adding.then(() => addOne(indexUrl));
  adding = run.catch(() => undefined);
  return run;
}

let adding: Promise<unknown> = Promise.resolve();

async function addOne(indexUrl: string): Promise<CatalogSourceState> {
  const url = indexUrl.trim();
  const next = nextSourceParam(deployment.configuredIds, sourceParams, url);
  const { source } = next;
  catalogs.sources = [...catalogs.sources, { source, status: 'loading' }];
  const state = await fetchCatalogSource(source, deployment.baseUrl);
  if (state.status === 'ready') {
    catalogs.sources = catalogs.sources.map((s) => (s.source.id === source.id ? state : s));
    sourceParams = next.values;
    syncSourceParams();
  } else {
    catalogs.sources = catalogs.sources.filter((s) => s.source.id !== source.id);
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
