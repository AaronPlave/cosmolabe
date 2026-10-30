/**
 * The Cosmolabe workspace as a library: the standalone viewer's own shell —
 * renderer, tool rail, timeline, panels, event finder, measurements — mounted
 * into any element of any page. The host needs no Svelte and no access to the
 * viewer's stores; it holds a `ViewerControl`, a mission-state manager and an
 * activity owner, all of which outlive catalog loads.
 *
 * One workspace per page: the viewer's stores are module singletons, so a
 * second concurrent mount is refused. `dispose()` releases everything — the
 * renderer and its WebGL context, workers, SPICE, subscriptions, panels,
 * selection, activities — and a later mount starts clean.
 *
 * Isolation: the workspace renders into a shadow root, so its reset and
 * component styles never reach the host page and the host's never reach it.
 * Only `@font-face` and `@property` rules go to the document (`embed-css.ts`).
 */
import { mount, unmount } from 'svelte';
import App from './App.svelte';
import css from './app.css?inline';
import cspiceWasmUrl from 'cspice-wasm/wasm/cspice.wasm?url';
import starsUrl from '../public/stars.bin?url';
import { MissionStateManager, parseMissionActivities, type CatalogJson, type MissionActivity } from '@cosmolabe/core';
import type { ViewerControl } from '@cosmolabe/control';
import type { ActivityConflict, CosmolabeViewer, MountOptions, WorkspaceUi } from './embed-api';
import type * as Declared from './embed-types';
import { workspace, ALL_UI } from './lib/workspace.svelte';
import { setSceneHooks, disposeSession, getSpice } from './lib/loader';
import { createViewerControl } from './lib/viewer-control';
import { emit, extendTimelineBase, getRenderer, getSceneUniverse, onViewerEvent } from './lib/viewer-state.svelte';
import { resetStores } from './lib/session.svelte';
import { splitShadowCss } from './lib/embed-css';

interface AppExports {
  loadForHost(entryUrl: string, name: string, fetcher?: (url: string) => Promise<CatalogJson>): Promise<void>;
}

/** `loadCatalog` loaded the scene, but some host owners' activities clash with its records and are not shown in it. */
class ActivityConflictError extends Error {
  override readonly name = 'ActivityConflictError';
  constructor(readonly conflicts: readonly ActivityConflict[]) {
    super(`Host activities not shown in this scene: ${conflicts.map((c) => `${c.owner} (${c.message})`).join('; ')}`);
  }
}
ActivityConflictError satisfies typeof Declared.ActivityConflictError;

const EMBED_DEFAULT_UI: WorkspaceUi = { ...ALL_UI, catalogBrowser: false, homeScreen: false };
const HOST_OWNER = (owner: string) => `host:${owner}`;

let active: CosmolabeViewer | null = null;

/**
 * Mount the complete workspace into `container`, which it fills. The
 * container should have a size; the workspace follows it as it resizes.
 */
export async function mountCosmolabe(container: HTMLElement, options: MountOptions = {}): Promise<CosmolabeViewer> {
  if (active) throw new Error('A Cosmolabe workspace is already mounted on this page; dispose it before mounting another.');
  if (!(container instanceof HTMLElement)) throw new TypeError('mountCosmolabe needs a container element');
  let viewer!: CosmolabeViewer;
  active = { dispose: async () => {} } as CosmolabeViewer; // claimed while mounting
  // What a mount that fails part-way must release, newest first.
  const undo: (() => unknown)[] = [];

  try {
    // Sources first: an invalid one fails the mount before the page is touched
    // (an earlier valid source's subscription is released by `undo`).
    const manager = new MissionStateManager();
    undo.push(() => manager.dispose());
    for (const source of options.missionState ?? []) manager.addSource(source);
    const shadow = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
    shadow.replaceChildren();
    const styles = splitShadowCss(css);
    const sheet = document.createElement('style');
    sheet.textContent = styles.shadow;
    const fill = document.createElement('style');
    fill.textContent = ':host { display: block; position: relative; overflow: hidden; } .cosmolabe-mount { position: absolute; inset: 0; }';
    shadow.append(fill, sheet);
    const globals = document.createElement('style');
    globals.dataset.cosmolabe = '';
    globals.textContent = styles.document;
    document.head.append(globals);
    const target = document.createElement('div');
    target.className = 'cosmolabe-mount';
    shadow.append(target);

    const assetBase = options.assetBaseUrl ? new URL(options.assetBaseUrl, document.baseURI) : null;
    const hostActivities = new Map<string, readonly MissionActivity[]>();

    // Owners whose records clash with the scene just bound: each owner is all
    // in or all out (the store's atomic replace), and `loadCatalog` rejects
    // naming them rather than resolving with records silently missing.
    let conflicts: ActivityConflict[] = [];
    const applyHostActivities = (u: NonNullable<ReturnType<typeof getSceneUniverse>>) => {
      conflicts = [];
      for (const [owner, records] of hostActivities) {
        try {
          u.activities.replace(HOST_OWNER(owner), records);
        } catch (err) {
          conflicts.push({ owner, message: err instanceof Error ? err.message : String(err) });
          console.warn(`[Cosmolabe] host activities "${owner}" could not be shown in this scene:`, err);
        }
      }
    };

    setSceneHooks({
      cspiceWasmUrl: assetBase ? new URL('cspice.wasm', assetBase).href : new URL(cspiceWasmUrl, import.meta.url).href,
      starsUrl: assetBase ? new URL('stars.bin', assetBase).href : new URL(starsUrl, import.meta.url).href,
      universeOptions: { trajectoryFactories: manager.trajectoryFactories, rotationFactories: manager.rotationFactories },
      bindUniverse: (u) => {
        manager.bind(u);
        if (!u) return;
        applyHostActivities(u);
        manager.focus(u.time);
      },
    });

    // Data is fetched around the playhead, wherever the clock goes.
    const offFocus = onViewerEvent('time', (et) => manager.focus(et));
    undo.push(offFocus);
    // Sources whose coverage grows (a live feed) grow the navigable timeline.
    const offCoverage = manager.onChange(({ sourceId }) => {
      if (!getRenderer()) return;
      for (const channel of ['position', 'attitude'] as const) {
        const extent = manager.extent(sourceId, channel);
        if (extent) extendTimelineBase(extent.start, extent.end);
      }
    });
    undo.push(offCoverage);

    workspace.embedded = true;
    workspace.ui = { ...EMBED_DEFAULT_UI, ...options.ui };
    const app = mount(App, { target }) as unknown as AppExports;
    undo.push(() => unmount(app as unknown as Record<string, never>));

    let disposed = false;
    const live = () => {
      if (disposed) throw new Error('This Cosmolabe workspace has been disposed');
    };
    // Every handle this mount gives out dies with it: the viewer's state is
    // module-wide, so an old handle left alive would drive the next mount.
    const guarded = <T extends object>(api: T): T =>
      Object.fromEntries(Object.entries(api).map(([k, v]) => [k, typeof v === 'function'
        ? (...args: unknown[]) => { live(); return (v as (...a: unknown[]) => unknown)(...args); }
        : v])) as T;

    const baseControl = createViewerControl({ getSpice, host: true });
    const subscriptions = new Set<() => void>();
    const control: Required<ViewerControl> = guarded({
      ...baseControl,
      on: (event, cb) => {
        const off = baseControl.on(event, cb);
        const dispose = () => {
          off();
          subscriptions.delete(dispose);
        };
        subscriptions.add(dispose);
        return dispose;
      },
    });

    viewer = {
      control,
      missionState: guarded({
        addSource: (s) => manager.addSource(s),
        replaceSource: (s) => manager.replaceSource(s),
        removeSource: (id) => manager.removeSource(id),
        sourceIds: () => manager.sourceIds(),
        status: (id) => manager.status(id),
        onChange: (listener) => manager.onChange(listener),
      }),
      activities: guarded({
        replace: (owner, specs) => {
          if (typeof owner !== 'string' || !owner.trim()) throw new Error('activity owner is required');
          const records = parseMissionActivities(specs);
          // Into the scene first: a clash with another owner's ID throws
          // there, before this owner's previous records are forgotten.
          getSceneUniverse()?.activities.replace(HOST_OWNER(owner), records);
          hostActivities.set(owner, records);
          return records;
        },
        remove: (owner) => {
          if (!hostActivities.delete(owner)) return false;
          getSceneUniverse()?.activities.replace(HOST_OWNER(owner), [], false);
          return true;
        },
        owners: () => [...hostActivities.keys()],
      }),
      loadCatalog: async (catalog) => {
        live();
        const load = async (entry: string, name: string, fetcher?: (url: string) => Promise<CatalogJson>) => {
          conflicts = [];
          await app.loadForHost(entry, name, fetcher);
          live();
          if (conflicts.length) throw new ActivityConflictError(conflicts);
        };
        if (typeof catalog === 'string' || catalog instanceof URL) {
          const url = new URL(catalog, document.baseURI).href;
          return load(url, decodeURIComponent(url.split('/').pop() ?? url).replace(/\.json$/i, ''));
        }
        if (!catalog || typeof catalog.json !== 'object') throw new TypeError('loadCatalog takes a URL or { json, baseUrl? }');
        // A catalog given as data still resolves its `require`s and relative
        // assets: it is served to the ordinary resolver under a URL of its own.
        const entry = new URL(`cosmolabe-host-catalog-${Date.now()}.json`, new URL(catalog.baseUrl ?? document.baseURI, document.baseURI)).href;
        const json = structuredClone(catalog.json);
        const fetcher = async (url: string): Promise<CatalogJson> => {
          if (url === entry) return json;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Failed to fetch catalog: ${url} (${res.status})`);
          return res.json() as Promise<CatalogJson>;
        };
        return load(entry, catalog.name ?? json.name ?? 'Catalog', fetcher);
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        for (const off of [...subscriptions]) off();
        offFocus();
        offCoverage();
        manager.dispose();
        // The scene first — renderer, WebGL context, workers, SPICE — then the
        // component tree, then every store back to its initial state, and the
        // scene-scoped modules told the scene is now empty.
        disposeSession();
        await unmount(app as unknown as Record<string, never>);
        resetStores();
        emit('load', []);
        setSceneHooks({});
        workspace.embedded = false;
        workspace.ui = { ...ALL_UI };
        workspace.width = 0;
        workspace.height = 0;
        shadow.replaceChildren();
        globals.remove();
        if (active === viewer) active = null;
      },
    };
    active = viewer;
    return viewer;
  } catch (err) {
    // A mount that failed part-way leaves nothing behind.
    for (const release of undo.reverse()) {
      try { void release(); } catch (cleanupErr) { console.warn('[Cosmolabe] cleanup after a failed mount:', cleanupErr); }
    }
    setSceneHooks({});
    workspace.embedded = false;
    workspace.ui = { ...ALL_UI };
    container.shadowRoot?.replaceChildren();
    document.head.querySelector('style[data-cosmolabe]')?.remove();
    active = null;
    throw err;
  }
}

export { ActivityConflictError };
export {
  HostDataAdapter, exploratoryData, parseMissionActivities, etFromCalendarString, etToDate, StateUnavailableError,
} from '@cosmolabe/core';
export type * from './embed-types';

// The published declarations (`embed-types.ts`) must describe this function.
mountCosmolabe satisfies typeof Declared.mountCosmolabe;
